#!/usr/bin/env node
// Sort an MTG card CSV by color: node cli.js cards.csv -o sorted.csv
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const { sortCsv, readBulk, GROUPS } = require("./sorter.js");

const USAGE = `Usage: node cli.js <input.csv> [options]

Sorts a card list White / Blue / Black / Red / Green / Multicolor / Colorless / Lands,
looking each card up on Scryfall. Writes to stdout unless -o is given.

  -o, --output <file>   where to write the sorted CSV
  --by <how>            within a group: name (default), set, cmc, original
  --identity            group by color identity instead of the card's color
  --order <groups>      group order, e.g. WUBRGMCL (default) or LWUBRGMC
  --no-columns          don't add the Scryfall ID and Color Group columns
  --bulk <file>         look cards up in a Scryfall bulk file (Default Cards, .json or
                        .json.gz) instead of the API; anything it doesn't have still
                        goes to the API
  --offline             with --bulk, never ask the API
  -h, --help            show this
`;

function parseArgs(argv) {
  const opts = {
    by: "name", identity: false, order: undefined, addColumns: true, input: null, output: null,
    bulk: null, offline: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "-o" || a === "--output") opts.output = value();
    else if (a === "--by") opts.by = value();
    else if (a === "--order") opts.order = value();
    else if (a === "--identity") opts.identity = true;
    else if (a === "--no-columns") opts.addColumns = false;
    else if (a === "--bulk") opts.bulk = value();
    else if (a === "--offline") opts.offline = true;
    else if (a.startsWith("-")) throw new Error(`Unknown option ${a}`);
    else if (!opts.input) opts.input = a;
    else throw new Error(`One input file at a time (got ${opts.input} and ${a})`);
  }
  if (opts.offline && !opts.bulk) throw new Error("--offline needs --bulk");
  return opts;
}

const n = (x) => x.toLocaleString("en-US");
const cards = (x) => `${n(x)} card${x === 1 ? "" : "s"}`;
const mb = (bytes) => `${(bytes / 1e6).toFixed(0)} MB`;
const secs = (ms) => (ms < 60000 ? `${Math.max(1, Math.round(ms / 1000))} s` : `${Math.round(ms / 60000)} min`);

/**
 * Progress on stderr: one line rewritten in place on a terminal; on a pipe or a log file,
 * only the lines that start a stage, so logs don't fill with carriage returns.
 */
function reporter(stderr) {
  const tty = Boolean(stderr.isTTY);
  let live = false;
  return {
    line(text) { // a stage starting: always printed
      if (live) stderr.write("\n");
      live = false;
      stderr.write(`${text}\n`);
    },
    update(text) { // a counter moving: terminals only
      if (!tty) return;
      stderr.write(`\r${text}\x1b[K`);
      live = true;
    },
    done() { if (live) stderr.write("\n"); live = false; },
  };
}

/** The bulk file as text chunks, gunzipped if it ends in .gz, with its read position for progress. */
function bulkChunks(file) {
  const raw = fs.createReadStream(file, { highWaterMark: 1 << 20 });
  const text = file.endsWith(".gz") ? raw.pipe(zlib.createGunzip()) : raw;
  text.setEncoding("utf8");
  raw.on("error", (e) => text.destroy(e));
  return { chunks: text, read: () => raw.bytesRead };
}

async function main(argv, { fetch = globalThis.fetch, stdout = process.stdout, stderr = process.stderr } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { stderr.write(`${e.message}\n\n${USAGE}`); return 2; }
  if (opts.help || !opts.input) { (opts.help ? stdout : stderr).write(USAGE); return opts.help ? 0 : 2; }
  const say = reporter(stderr);

  let bulk;
  if (opts.bulk) {
    const size = fs.statSync(opts.bulk).size;
    say.line(`Reading ${path.basename(opts.bulk)} (${mb(size)})`);
    const { chunks, read } = bulkChunks(opts.bulk);
    bulk = await readBulk(chunks, {
      onProgress: (e) => say.update(`  ${cards(e.cards)}, ${Math.round((100 * read()) / size)}%`),
    });
    say.done();
    say.line(`  ${cards(bulk.size)} ready`);
  }

  const text = fs.readFileSync(opts.input, "utf8");
  const pkg = require("./package.json");
  let lastPass = 0;
  const result = await sortCsv(text, {
    ...opts, bulk, fetch,
    // Scryfall asks every API client to say who it is.
    headers: { "User-Agent": `mtg-csv-sorter/${pkg.version}` },
    onProgress: (e) => {
      if (e.stage === "read") say.line(`Read ${n(e.rows)} rows from ${path.basename(opts.input)}; finding cards by ${e.findBy}`);
      else if (e.stage === "sort") say.line("Sorting");
      else if (e.stage === "lookup" || e.stage === "retry") {
        if (e.pass !== lastPass) {
          lastPass = e.pass;
          say.line(e.stage === "lookup"
            ? `Looking up ${cards(e.cards)} on Scryfall${bulk ? " that the bulk file doesn't have" : ""}`
            : `Trying ${cards(e.cards)} again a different way`);
        }
        const left = e.etaMs > 0 ? `, ~${secs(e.etaMs)} left` : "";
        say.update(`  ${n(e.found)} of ${n(e.cards)} found, ${e.done}/${e.total} requests${left}`);
      }
    },
    onWait: ({ ms, attempt, retries }) =>
      say.line(`  Scryfall asked to slow down; waiting ${secs(ms)} (${attempt} of ${retries})`),
  });
  say.done();

  if (opts.output) fs.writeFileSync(opts.output, result.csv);
  else stdout.write(result.csv);

  const width = Math.max(...result.groups.map((g) => g.label.length));
  for (const g of result.groups) stderr.write(`  ${g.label.padEnd(width)}  ${n(g.count)}\n`);
  if (result.notFound.length) {
    stderr.write(`${n(result.notFound.length)} row(s) not found${opts.offline ? " in the bulk file" : " on Scryfall"}, sorted last as "${GROUPS.X}":\n`);
    for (const m of result.notFound.slice(0, 20)) stderr.write(`  row ${m.row}: ${m.name}\n`);
    if (result.notFound.length > 20) stderr.write(`  …and ${n(result.notFound.length - 20)} more\n`);
  }
  if (opts.output) stderr.write(`Wrote ${path.resolve(opts.output)}\n`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    process.stderr.write(`\n${e.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { main, parseArgs };
