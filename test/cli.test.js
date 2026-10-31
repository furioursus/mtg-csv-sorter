"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { main, parseArgs } = require("../cli.js");
const zlib = require("node:zlib");
const { fakeFetch, CARDS } = require("./fake-scryfall.js");

const sink = () => { const s = { text: "", write: (t) => { s.text += t; } }; return s; };

test("parseArgs reads options and rejects unknown ones", () => {
  assert.deepEqual(parseArgs(["in.csv", "-o", "out.csv", "--by", "set", "--identity", "--order", "LWUBRG", "--no-columns"]), {
    by: "set", identity: true, order: "LWUBRG", addColumns: false, input: "in.csv", output: "out.csv",
    bulk: null, offline: false,
  });
  assert.deepEqual(parseArgs(["in.csv", "--bulk", "default-cards.json", "--offline"]).bulk, "default-cards.json");
  assert.throws(() => parseArgs(["in.csv", "--offline"]), /--offline needs --bulk/);
  assert.throws(() => parseArgs(["--bogus"]), /Unknown option/);
  assert.throws(() => parseArgs(["-o"]), /needs a value/);
});

test("main sorts a file, writes it, and reports groups, misses and its User-Agent", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sorter-"));
  const input = path.join(dir, "in.csv"), output = path.join(dir, "out.csv");
  fs.writeFileSync(input, "Name\nForest\nOpt\nNope\n");
  const { fetch } = fakeFetch();
  let headers;
  const spy = (url, init) => { headers = init.headers; return fetch(url, init); };
  const stdout = sink(), stderr = sink();
  assert.equal(await main([input, "-o", output], { fetch: spy, stdout, stderr }), 0);
  assert.match(headers["User-Agent"], /^mtg-csv-sorter\/\d/);
  assert.equal(fs.readFileSync(output, "utf8").split("\n").map((l) => l.split(",")[0]).join("|"), "Name|Opt|Forest|Nope|");
  assert.equal(stdout.text, "");
  assert.match(stderr.text, /Blue\s+1\n/);
  assert.match(stderr.text, /1 row\(s\) not found.*\n  row 4: Nope/);
});

test("main prints to stdout without -o, and usage without an input", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sorter-"));
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "Name\nOpt\n");
  const stdout = sink();
  assert.equal(await main([input, "--no-columns"], { fetch: fakeFetch().fetch, stdout, stderr: sink() }), 0);
  assert.equal(stdout.text, "Name\nOpt\n");
  const stderr = sink();
  assert.equal(await main([], { stdout: sink(), stderr }), 2);
  assert.match(stderr.text, /^Usage/);
});

test("main reads a gzipped bulk file and sorts offline, logging stages without carriage returns", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sorter-"));
  const input = path.join(dir, "in.csv"), bulk = path.join(dir, "default-cards.json.gz");
  fs.writeFileSync(input, "Name\nForest\nOpt\nNope\n");
  fs.writeFileSync(bulk, zlib.gzipSync(JSON.stringify(CARDS)));
  const stdout = sink(), stderr = sink();
  const noApi = async () => { throw new Error("asked Scryfall"); };
  assert.equal(await main([input, "--bulk", bulk, "--offline", "--no-columns"], { fetch: noApi, stdout, stderr }), 0);
  assert.equal(stdout.text, "Name\nOpt\nForest\nNope\n");
  assert.doesNotMatch(stderr.text, /\r/);
  assert.match(stderr.text, new RegExp(`^Reading default-cards.json.gz \\(0 MB\\)\n  ${CARDS.length} cards ready\nRead 3 rows from in.csv; finding cards by name\nSorting\n`));
  assert.match(stderr.text, /1 row\(s\) not found in the bulk file/);
});

test("main rewrites one progress line on a terminal", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sorter-"));
  const input = path.join(dir, "in.csv");
  fs.writeFileSync(input, "Name\nOpt\n");
  const stderr = Object.assign(sink(), { isTTY: true });
  assert.equal(await main([input], { fetch: fakeFetch().fetch, stdout: sink(), stderr }), 0);
  assert.match(stderr.text, /Looking up 1 card on Scryfall\n\r  0 of 1 found, 0\/1 requests, ~1 s left\x1b\[K\r  1 of 1 found, 1\/1 requests\x1b\[K\nSorting\n/);
});
