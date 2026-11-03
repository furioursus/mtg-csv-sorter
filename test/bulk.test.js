"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const S = require("../sorter.js");
const { fakeFetch, CARDS } = require("./fake-scryfall.js");

const BULK_TEXT = fs.readFileSync(path.join(__dirname, "cards.json"), "utf8");
const byName = (name) => CARDS.find((c) => c.name === name);
async function* chunked(text, size) { for (let i = 0; i < text.length; i += size) yield text.slice(i, i + size); }
const split = (text, cuts) => {
  const items = [];
  const s = S.arraySplitter((x) => items.push(x));
  let at = 0;
  for (const c of [...cuts, text.length]) { s.push(text.slice(at, c)); at = c; }
  s.end();
  return items;
};
const noApi = async () => { throw new Error("asked Scryfall"); };

test("arraySplitter finds every element whatever the chunk boundaries", () => {
  const tricky = '[\n {"name": "a } [ \\" {", "x": [1, {"y": "]"}]},\n{"name":"\\\\"} , {"e":{}}\n]\n';
  const want = JSON.parse(tricky);
  for (let i = 0; i <= tricky.length; i++) {
    for (let j = i; j <= tricky.length; j++) assert.deepEqual(split(tricky, [i, j]), want, `cut at ${i} and ${j}`);
  }
  assert.deepEqual(split(tricky, [...tricky].map((_, i) => i)), want, "one character at a time");
  const cards = JSON.parse(BULK_TEXT);
  for (let i = 0; i < BULK_TEXT.length; i += 97) assert.deepEqual(split(BULK_TEXT, [i]), cards);
});

test("arraySplitter reads JSON Lines, Scryfall's current format, whatever the chunk boundaries", () => {
  const items = [{ name: "a } [ \" {", x: [1, { y: "]" }] }, { name: "\\" }, { e: {} }];
  for (const text of [
    items.map((x) => JSON.stringify(x)).join("\n") + "\n",
    "\ufeff" + items.map((x) => JSON.stringify(x)).join("\r\n") + "\r\n", // BOM and CRLF
    "\n\n" + items.map((x) => JSON.stringify(x)).join("\n"), // leading blank lines, no final newline
  ]) {
    for (let i = 0; i <= text.length; i++) {
      for (let j = i; j <= text.length; j++) assert.deepEqual(split(text, [i, j]), items, `cut at ${i} and ${j}`);
    }
  }
  const cards = JSON.parse(BULK_TEXT);
  const lines = cards.map((c) => JSON.stringify(c)).join("\n") + "\n";
  for (let i = 0; i < lines.length; i += 97) assert.deepEqual(split(lines, [i]), cards);
});

test("readBulk takes a JSON Lines file and finds the same cards as the array", async () => {
  const lines = JSON.parse(BULK_TEXT).map((c) => JSON.stringify(c)).join("\n") + "\n";
  const fromLines = await S.readBulk(chunked(lines, 1000));
  const fromArray = await S.readBulk(chunked(BULK_TEXT, 1000));
  assert.equal(fromLines.size, CARDS.length);
  for (const c of CARDS) assert.deepEqual(fromLines.get(`id:${c.id}`), fromArray.get(`id:${c.id}`), c.name);
});

test("arraySplitter says so when the file stops partway", () => {
  assert.throws(() => split(BULK_TEXT.slice(0, BULK_TEXT.length / 2), []), /stops partway through/);
  assert.throws(() => split('{"object": "card", "name": "Op', []), /stops partway through/);
});

test("readBulk indexes every printing by ID, set and number, and name, keeping only what's needed", async () => {
  const withExtras = BULK_TEXT.replace('"name": "Opt", "layout"', '"name": "Opt", "oracle_text": "Scry 1.", "layout"')
    .replace(/^\[/, '[{"object": "ruling", "comment": "not a card"},');
  const events = [];
  const index = await S.readBulk(chunked(withExtras, 1000), { onProgress: (e) => events.push(e) });
  assert.equal(index.size, CARDS.length);
  const opt = byName("Opt");
  assert.equal(index.get(`id:${opt.id}`).name, "Opt");
  assert.equal(index.get("sc:dmr|56").id, "d0e1f2a3-b4c5-4d6e-7f8a-9b0c1d2e3f02");
  assert.equal(index.get("n:delver of secrets").layout, "transform");
  assert.equal(index.get("ns:fire|mh2").name, "Fire // Ice");
  assert.equal(index.get(`id:${opt.id}`).oracle_text, undefined);
  assert.deepEqual(Object.keys(index.get("n:delver of secrets").card_faces[0]).sort(), ["colors", "mana_cost", "name", "type_line"]);
  assert.deepEqual(events.at(-1), { stage: "bulk", cards: CARDS.length, chars: withExtras.length });
});

test("readBulk refuses files that aren't card bulk files", async () => {
  await assert.rejects(S.readBulk(chunked('[{"object": "ruling"}]', 5)), /Rulings/);
  await assert.rejects(S.readBulk(chunked("[1, 2]", 5)), /isn't a Scryfall bulk card file/);
  await assert.rejects(S.readBulk(chunked("", 5)), /isn't a Scryfall bulk card file/);
});

test("with a bulk file and offline, nothing goes to Scryfall and the result matches the API's", async () => {
  const bulk = await S.readBulk(chunked(BULK_TEXT, 4096));
  const text = "Name,Set,Number\nForest,dsk,286\nOpt,Ixalan,999\nFire // Ice,,\nLightning Bolt,2xm,141\nNot A Real Card,,\n";
  const api = await S.sortCsv(text, { fetch: fakeFetch().fetch, sleep: async () => {} });
  const local = await S.sortCsv(text, { fetch: noApi, bulk, offline: true });
  assert.equal(local.csv, api.csv);
  assert.deepEqual(local.notFound, [{ row: 6, name: "Not A Real Card" }]);
});

test("with a bulk file, only the cards it doesn't have go to Scryfall", async () => {
  const partial = JSON.stringify(CARDS.filter((c) => c.name !== "Thoughtseize" && c.name !== "Sol Ring"));
  const bulk = await S.readBulk(chunked(partial, 4096));
  const { fetch, calls } = fakeFetch();
  const text = "Name\nThoughtseize\nOpt\nSol Ring\nForest\nThoughtseize\n";
  const out = await S.sortCsv(text, { fetch, sleep: async () => {}, bulk });
  assert.deepEqual(calls, [[{ name: "Thoughtseize" }, { name: "Sol Ring" }]]);
  assert.deepEqual(out.groups.map((g) => [g.code, g.count]), [["U", 1], ["B", 2], ["C", 1], ["L", 1]]);
});

test("readBulk stops with an AbortError, not a truncated-file error, when aborted mid-read", async () => {
  const stop = new AbortController();
  async function* source() { // like the page's reader: ends quietly once aborted
    yield BULK_TEXT.slice(0, 500);
    stop.abort();
    if (stop.signal.aborted) return;
    yield BULK_TEXT.slice(500);
  }
  await assert.rejects(S.readBulk(source(), { signal: stop.signal }), { name: "AbortError" });
});
