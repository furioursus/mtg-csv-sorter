"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../sorter.js");
const { fakeFetch, fakeClock, CARDS } = require("./fake-scryfall.js");

const byName = (name) => CARDS.find((c) => c.name === name);
const fast = { sleep: async () => {} };

test("parseCsv handles quotes, escaped quotes, newlines in fields, CRLF and a BOM", () => {
  const text = '﻿Name,Note\r\n"Fire // Ice","say ""hi""\r\nthere"\r\nOpt,\r\n\r\n';
  const { rows, newline } = S.parseCsv(text);
  assert.equal(newline, "\r\n");
  assert.deepEqual(rows, [["Name", "Note"], ["Fire // Ice", 'say "hi"\r\nthere'], ["Opt", ""]]);
});

test("parseCsv keeps a last row with no newline", () => {
  assert.deepEqual(S.parseCsv("a,b\n1,2").rows, [["a", "b"], ["1", "2"]]);
});

test("toCsv round-trips through parseCsv", () => {
  const rows = [["Name", "Note"], ["Lim-Dûl's Vault", 'a, "b"'], ["Opt", "line\nbreak"], [" padded", ""]];
  for (const d of [",", ";", "\t"]) assert.deepEqual(S.parseCsv(S.toCsv(rows, d), d).rows, rows);
});

test("detectDelimiter reads the header line only, outside quotes", () => {
  assert.equal(S.detectDelimiter("Name;Set;Number\nA,B;x;1"), ";");
  assert.equal(S.detectDelimiter("Name\tSet\n"), "\t");
  assert.equal(S.detectDelimiter('"a;b;c",Set\n'), ",");
  assert.equal(S.detectDelimiter("Name\n"), ",");
});

test("findColumns reads the common exports' headers", () => {
  const cases = {
    manabox: ["Binder Name,Binder Type,Name,Set code,Set name,Collector number,Foil,Rarity,Quantity,ManaBox ID,Scryfall ID", { name: 2, set: 3, collector_number: 5, scryfall_id: 10 }],
    moxfield: ["Count,Tradelist Count,Name,Edition,Condition,Language,Foil,Tags,Last Modified,Collector Number,Alter,Proxy,Purchase Price", { name: 2, set: 3, collector_number: 9, scryfall_id: -1 }],
    deckbox: ["Count,Tradelist Count,Name,Edition,Edition Code,Card Number,Condition,Language,Foil", { name: 2, set: 4, collector_number: 5, scryfall_id: -1 }],
    tcgplayer: ["Quantity,Name,Simple Name,Set,Card Number,Set Code,Printing,Condition,Language,Rarity,Product ID,SKU", { name: 1, set: 5, collector_number: 4, scryfall_id: -1 }],
  };
  for (const [what, [header, want]] of Object.entries(cases)) {
    assert.deepEqual(S.findColumns(header.split(",")), want, what);
  }
});

test("group puts each layout where a seller would file it", () => {
  const want = {
    "Swords to Plowshares": "W", Opt: "U", Thoughtseize: "B", "Lightning Bolt": "R", "Llanowar Elves": "G",
    "Fire // Ice": "M", "Lim-Dûl's Vault": "M", "Figure of Destiny": "M",
    "Delver of Secrets // Insectile Aberration": "U", // transform: front face
    "Agadeem's Awakening // Agadeem, the Undercrypt": "B", // modal DFC with a land back: front face
    "Bonecrusher Giant // Stomp": "R",
    "Lovestruck Beast // Heart's Desire": "G", // adventure: the frame's color, from the front's cost
    "Kitsune Mystic // Autumn-Tail, Kitsune Sage": "W", // flip
    "Propaganda // Propaganda": "U", // reversible: no top-level colors or type line
    "Ancestral Vision": "U", // color indicator, no mana cost
    "Sol Ring": "C", "Eldrazi Displacer": "C", // devoid is colorless
    "Dryad Arbor": "L", "Breeding Pool": "L", Forest: "L",
    Treasure: "T",
    "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki": "R",
  };
  for (const [name, g] of Object.entries(want)) assert.equal(S.group(byName(name)), g, name);
  assert.equal(S.group(null), "X");
});

test("group by color identity files devoid and colored abilities under their colors", () => {
  assert.equal(S.group(byName("Eldrazi Displacer"), { identity: true }), "W");
  assert.equal(S.group(byName("Sol Ring"), { identity: true }), "C");
  assert.equal(S.group(byName("Breeding Pool"), { identity: true }), "L"); // lands stay lands
});

test("groupOrder fills in what's left out and keeps tokens and misses last", () => {
  assert.deepEqual(S.groupOrder(), ["W", "U", "B", "R", "G", "M", "C", "L", "T", "X"]);
  assert.deepEqual(S.groupOrder("L c, w x"), ["L", "C", "W", "U", "B", "R", "G", "M", "T", "X"]);
  assert.deepEqual(S.groupOrder(["G", "G", "Q"]), ["G", "W", "U", "B", "R", "M", "C", "L", "T", "X"]);
});

const MANABOX = [
  "Binder Name,Name,Set code,Collector number,Quantity,Scryfall ID",
  ...[
    "Forest", "Sol Ring", "Treasure", "Fire // Ice", "Lightning Bolt", "Llanowar Elves",
    "Thoughtseize", "Opt", "Swords to Plowshares", "Delver of Secrets // Insectile Aberration",
    "Agadeem's Awakening // Agadeem, the Undercrypt", "Breeding Pool",
  ].map((n) => {
    const c = byName(n);
    return ["Main", n.includes(",") || n.includes("'") ? `"${n}"` : n, c.set.toUpperCase(), c.collector_number, "1", c.id].join(",");
  }),
].join("\n") + "\n";

test("sortCsv sorts a ManaBox export W/U/B/R/G/Multi/Colorless/Lands, then by name", async () => {
  const { fetch, calls } = fakeFetch();
  const out = await S.sortCsv(MANABOX, { fetch, ...fast });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].every((i) => i.id), "looks up by Scryfall ID when there is one");
  const rows = S.parseCsv(out.csv).rows;
  assert.deepEqual(rows[0], ["Binder Name", "Name", "Set code", "Collector number", "Quantity", "Scryfall ID", "Color Group", "Card Type"]);
  assert.deepEqual(rows.slice(1).map((r) => [r[1], r[6]]), [
    ["Swords to Plowshares", "White"],
    ["Delver of Secrets // Insectile Aberration", "Blue"],
    ["Opt", "Blue"],
    ["Agadeem's Awakening // Agadeem, the Undercrypt", "Black"],
    ["Thoughtseize", "Black"],
    ["Lightning Bolt", "Red"],
    ["Llanowar Elves", "Green"],
    ["Fire // Ice", "Multicolor"],
    ["Sol Ring", "Colorless"],
    ["Breeding Pool", "Lands"],
    ["Forest", "Lands"],
    ["Treasure", "Tokens & other"],
  ]);
  assert.deepEqual(out.groups.map((g) => [g.code, g.count]), [
    ["W", 1], ["U", 2], ["B", 2], ["R", 1], ["G", 1], ["M", 1], ["C", 1], ["L", 2], ["T", 1],
  ]);
  assert.deepEqual(out.notFound, []);
});

test("sortCsv finds Scryfall IDs for a list without them and adds the column", async () => {
  const { fetch, calls } = fakeFetch();
  const text = "Count,Name,Edition,Collector Number\n2,Opt,dmr,56\n1,Lightning Bolt,,\n4,Sol Ring,c21,263\n";
  const out = await S.sortCsv(text, { fetch, ...fast });
  assert.deepEqual(calls[0], [
    { set: "dmr", collector_number: "56" }, { name: "Lightning Bolt" }, { set: "c21", collector_number: "263" },
  ]);
  const rows = S.parseCsv(out.csv).rows;
  assert.deepEqual(rows, [
    ["Count", "Name", "Edition", "Collector Number", "Scryfall ID", "Color Group", "Card Type"],
    ["2", "Opt", "dmr", "56", "d0e1f2a3-b4c5-4d6e-7f8a-9b0c1d2e3f02", "Blue", "Instant"], // DMR's Opt, not XLN's
    ["1", "Lightning Bolt", "", "", byName("Lightning Bolt").id, "Red", "Instant"],
    ["4", "Sol Ring", "c21", "263", byName("Sol Ring").id, "Colorless", "Artifact"],
  ]);
});

test("sortCsv falls back to the name when the set column holds something Scryfall doesn't know", async () => {
  const { fetch, calls } = fakeFetch();
  const text = "Name,Set,Number\nOpt,Ixalan,999\nNot A Real Card,xln,1\nThoughtseize,,\n";
  const out = await S.sortCsv(text, { fetch, ...fast });
  // "Ixalan" looks enough like a set code to try, misses, then name + set misses, then the name alone hits.
  assert.deepEqual(calls, [
    [{ set: "ixalan", collector_number: "999" }, { set: "xln", collector_number: "1" }, { name: "Thoughtseize" }],
    [{ name: "Opt", set: "ixalan" }, { name: "Not A Real Card", set: "xln" }],
    [{ name: "Opt" }, { name: "Not A Real Card" }],
  ]);
  assert.deepEqual(S.parseCsv(out.csv).rows.slice(1).map((r) => [r[0], r[4]]), [
    ["Opt", "Blue"], ["Thoughtseize", "Black"], ["Not A Real Card", "Not found"],
  ]);
  assert.deepEqual(out.notFound, [{ row: 3, name: "Not A Real Card" }]);
});

test("sortCsv asks once per distinct card, in batches of 75", async () => {
  const many = Array.from({ length: 160 }, (_, i) => ({ ...byName("Opt"), id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name: `Card ${i}` }));
  const { fetch, calls } = fakeFetch({ cards: many });
  const lines = many.flatMap((c) => [`${c.name},${c.id}`, `${c.name},${c.id}`]);
  const out = await S.sortCsv(["Name,Scryfall ID", ...lines].join("\n"), { fetch, ...fast });
  assert.deepEqual(calls.map((c) => c.length), [75, 75, 10]);
  assert.equal(out.groups[0].count, 320);
  assert.equal(out.sorted[0].card.name, "Card 0");
  assert.equal(out.sorted[319].card.name, "Card 159", "numeric name order, 2 before 10");
});

test("requests start half a second apart, Scryfall's limit for /cards/collection", async () => {
  const many = Array.from({ length: 160 }, (_, i) => ({ ...byName("Opt"), id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }));
  const clock = fakeClock();
  const starts = [];
  const { fetch } = fakeFetch({ cards: many });
  const timed = (url, init) => { starts.push(clock.t); return fetch(url, init); };
  await S.sortCsv(["Scryfall ID", ...many.map((c) => c.id)].join("\n"), { fetch: timed, sleep: clock.sleep, now: clock.now });
  assert.deepEqual(starts, [0, 500, 1000]);
});

test("a 429 waits as long as Retry-After says, then slows every later request", async () => {
  const many = Array.from({ length: 80 }, (_, i) => ({ ...byName("Opt"), id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }));
  const clock = fakeClock();
  const starts = [], waits = [];
  const { fetch } = fakeFetch({ cards: many, failFirst: 1, retryAfter: 7 });
  const timed = (url, init) => { starts.push(clock.t); return fetch(url, init); };
  const out = await S.sortCsv(["Scryfall ID", ...many.map((c) => c.id)].join("\n"), {
    fetch: timed, sleep: clock.sleep, now: clock.now, onWait: (w) => waits.push(w),
  });
  assert.deepEqual(waits, [{ ms: 7000, attempt: 1, retries: 4, reason: "limited" }]);
  // Retry-After's 7 s, then the delay doubled to 1 s for the next batch.
  assert.deepEqual(starts, [0, 7000, 8000]);
  assert.equal(out.groups[0].count, 80);
});

test("without Retry-After, a 429 waits 30, 60, 120, 240 seconds, then gives up", async () => {
  const clock = fakeClock();
  const waits = [];
  const busy = fakeFetch({ failFirst: 99 });
  await assert.rejects(
    S.sortCsv("Name\nOpt\n", { fetch: busy.fetch, sleep: clock.sleep, now: clock.now, onWait: (w) => waits.push(w.ms) }),
    /still limiting requests after 4 waits/,
  );
  assert.deepEqual(waits, [30000, 60000, 120000, 240000]);
  assert.equal(busy.calls.length, 5);

  const twice = fakeFetch({ failFirst: 2 });
  const out = await S.sortCsv("Name\nOpt\n", { fetch: twice.fetch, ...fast });
  assert.equal(twice.calls.length, 3);
  assert.equal(out.groups[0].code, "U");
});

test("progress goes read, lookup, retry passes, sort, with counts and a time estimate", async () => {
  const clock = fakeClock();
  const events = [];
  const text = "Name,Set,Number\nOpt,Ixalan,999\nNot A Real Card,xln,1\nThoughtseize,,\nThoughtseize,,\n";
  await S.sortCsv(text, { fetch: fakeFetch().fetch, sleep: clock.sleep, now: clock.now, onProgress: (e) => events.push(e) });
  assert.deepEqual(events.map(({ stage, pass, cards, found, done, total, rows, findBy }) =>
    [stage, pass ?? rows, cards ?? findBy, found, done, total].filter((x) => x !== undefined)), [
    ["read", 4, "set and collector number"],
    ["lookup", 1, 3, 0, 0, 1],
    ["lookup", 1, 3, 1, 1, 1], // Thoughtseize by name; the other two missed on set + number
    ["retry", 2, 2, 0, 1, 2],
    ["retry", 2, 2, 0, 2, 2],
    ["retry", 3, 2, 0, 2, 3],
    ["retry", 3, 2, 1, 3, 3], // Opt by name alone
    ["sort", 4],
  ]);
  const lookups = events.filter((e) => e.etaMs !== undefined);
  assert.equal(lookups[0].etaMs, 500, "before any request, one request at the pace");
  assert.equal(lookups.at(-1).etaMs, 0);
});

test("the time estimate counts every request left at the pace", async () => {
  const many = Array.from({ length: 300 }, (_, i) => ({ ...byName("Opt"), id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }));
  const clock = fakeClock();
  const etas = [];
  await S.sortCsv(["Scryfall ID", ...many.map((c) => c.id)].join("\n"), {
    fetch: fakeFetch({ cards: many }).fetch, sleep: clock.sleep, now: clock.now,
    onProgress: (e) => { if (e.stage === "lookup") etas.push(e.etaMs); },
  });
  assert.deepEqual(etas, [2000, 1500, 1000, 500, 0]); // 4 requests, 500 ms apart
});

test("aborting stops the run between requests", async () => {
  const many = Array.from({ length: 160 }, (_, i) => ({ ...byName("Opt"), id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` }));
  const stop = new AbortController();
  const { fetch, calls } = fakeFetch({ cards: many });
  await assert.rejects(
    S.sortCsv(["Scryfall ID", ...many.map((c) => c.id)].join("\n"), {
      fetch, ...fast, signal: stop.signal, onProgress: (e) => { if (e.done === 1) stop.abort(); },
    }),
    (e) => e.name === "AbortError" && e.message === "Stopped.",
  );
  assert.equal(calls.length, 1);
});

test("aborting ends a 429 wait at once, with the real timer", async () => {
  const stop = new AbortController();
  const t = Date.now();
  const run = S.sortCsv("Name\nOpt\n", {
    fetch: fakeFetch({ failFirst: 1 }).fetch, signal: stop.signal, onWait: () => setTimeout(() => stop.abort(), 20),
  });
  await assert.rejects(run, { name: "AbortError" });
  assert.ok(Date.now() - t < 2000, "didn't sit out the 30 s wait");
});

test("sortCsv reports Scryfall errors and an unreachable Scryfall", async () => {
  const text = "Name\nOpt\n";
  const down = fakeFetch({ failFirst: 1, status: 503 });
  await assert.rejects(S.sortCsv(text, { fetch: down.fetch, ...fast }), /Scryfall answered 503/);
  let tries = 0;
  const offline = async () => { tries++; throw Object.assign(new TypeError("fetch failed"), { cause: new Error("getaddrinfo ENOTFOUND api.scryfall.com") }); };
  await assert.rejects(S.sortCsv(text, { fetch: offline, ...fast }), /Couldn't reach Scryfall \(getaddrinfo ENOTFOUND api.scryfall.com\), even after 4 waits/);
  assert.equal(tries, 5);
});

test("a fetch that fails outright, as a browser sees a 429, waits and tries again", async () => {
  const clock = fakeClock();
  const waits = [];
  const { fetch, calls } = fakeFetch();
  let failures = 2;
  const blocked = async (url, init) => {
    if (failures-- > 0) throw new TypeError("Failed to fetch");
    return fetch(url, init);
  };
  const out = await S.sortCsv("Name\nOpt\n", { fetch: blocked, sleep: clock.sleep, now: clock.now, onWait: (w) => waits.push(w) });
  assert.deepEqual(waits, [
    { ms: 30000, attempt: 1, retries: 4, reason: "unreachable" },
    { ms: 60000, attempt: 2, retries: 4, reason: "unreachable" },
  ]);
  assert.equal(calls.length, 1);
  assert.equal(out.groups[0].code, "U");
});

test("a browser that says it's offline fails at once instead of waiting", async () => {
  const had = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true, writable: true });
  try {
    let tries = 0;
    const down = async () => { tries++; throw new TypeError("Failed to fetch"); };
    await assert.rejects(S.sortCsv("Name\nOpt\n", { fetch: down, ...fast }), /^Error: Couldn't reach Scryfall \(Failed to fetch\)\. Check the connection/);
    assert.equal(tries, 1);
  } finally {
    if (had) Object.defineProperty(globalThis, "navigator", had);
    else delete globalThis.navigator;
  }
});

test("sortCsv sorts within a group by set, mana value, or the file's order", async () => {
  const text = "Name,Scryfall ID\n" + ["Lightning Bolt", "Bonecrusher Giant // Stomp", "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki"]
    .map((n) => `"${n}",${byName(n).id}`).join("\n");
  const names = async (by) => (await S.sortCsv(text, { fetch: fakeFetch().fetch, ...fast, by, types: false })).sorted.map((s) => s.card.name);
  assert.deepEqual(await names("set"), ["Bonecrusher Giant // Stomp", "Lightning Bolt", "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki"]);
  assert.deepEqual(await names("cmc"), ["Lightning Bolt", "Bonecrusher Giant // Stomp", "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki"]);
  assert.deepEqual(await names("original"), ["Lightning Bolt", "Bonecrusher Giant // Stomp", "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki"]);
  await assert.rejects(names("price"), /Unknown sort/);
});

test("cardType files each card under its front face's first type in the seller's order", () => {
  const want = {
    "Jace Beleren": "Planeswalker", "Llanowar Elves": "Creature", "Solemn Simulacrum": "Creature", // artifact creature
    "Delver of Secrets // Insectile Aberration": "Creature", "Bonecrusher Giant // Stomp": "Creature",
    Opt: "Instant", "Fire // Ice": "Instant", "Rhystic Study": "Enchantment", Bitterblossom: "Enchantment", // Kindred
    "Fable of the Mirror-Breaker // Reflection of Kiki-Jiki": "Enchantment", Thoughtseize: "Sorcery",
    "Agadeem's Awakening // Agadeem, the Undercrypt": "Sorcery", // the front, not the land back
    "Swiftfoot Boots": "Equipment", "Smuggler's Copter": "Vehicle", "Test Spacecraft": "Spacecraft", "Sol Ring": "Artifact",
    "Propaganda // Propaganda": "Enchantment", // reversible: no top-level type line
    "Invasion of Zendikar // Awakened Skyclave": "Battle", Forest: "Land", "Dryad Arbor": "Land",
  };
  for (const [name, label] of Object.entries(want)) assert.equal(S.cardType(byName(name)).label, label, name);
  assert.equal(S.cardType(null).label, "");
});

test("within a color, cards go Planeswalker, Creature, Instant, Enchantment, Sorcery, then artifacts: Equipment, Vehicles and Spacecraft, the rest", async () => {
  const names = ["Sol Ring", "Test Spacecraft", "Smuggler's Copter", "Swiftfoot Boots", "Solemn Simulacrum",
    "Opt", "Rhystic Study", "Jace Beleren", "Delver of Secrets // Insectile Aberration", "Invasion of Zendikar // Awakened Skyclave",
    "Thoughtseize", "Bitterblossom", "Agadeem's Awakening // Agadeem, the Undercrypt"];
  const text = "Name,Scryfall ID\n" + names.map((n) => `"${n}",${byName(n).id}`).join("\n");
  const out = await S.sortCsv(text, { fetch: fakeFetch().fetch, ...fast });
  assert.deepEqual(out.sorted.map((s) => [S.GROUPS[s.group], s.type, s.card.name]), [
    ["Blue", "Planeswalker", "Jace Beleren"],
    ["Blue", "Creature", "Delver of Secrets // Insectile Aberration"],
    ["Blue", "Instant", "Opt"],
    ["Blue", "Enchantment", "Rhystic Study"],
    ["Black", "Enchantment", "Bitterblossom"],
    ["Black", "Sorcery", "Agadeem's Awakening // Agadeem, the Undercrypt"],
    ["Black", "Sorcery", "Thoughtseize"],
    ["Green", "Battle", "Invasion of Zendikar // Awakened Skyclave"],
    ["Colorless", "Creature", "Solemn Simulacrum"],
    ["Colorless", "Equipment", "Swiftfoot Boots"],
    ["Colorless", "Vehicle", "Smuggler's Copter"], // Vehicles and Spacecraft share a place, by name
    ["Colorless", "Spacecraft", "Test Spacecraft"],
    ["Colorless", "Artifact", "Sol Ring"],
  ]);
  const plain = await S.sortCsv(text, { fetch: fakeFetch().fetch, ...fast, types: false });
  assert.deepEqual(plain.sorted.filter((s) => s.group === "U").map((s) => s.card.name),
    ["Delver of Secrets // Insectile Aberration", "Jace Beleren", "Opt", "Rhystic Study"], "types: false is name order");
  assert.equal(S.parseCsv(out.csv).rows[1][3], "Planeswalker", "Card Type column");
});

test("sortCsv takes a custom group order, keeps semicolons, and can leave columns alone", async () => {
  const text = "Name;Scryfall ID\nForest;" + byName("Forest").id + "\nOpt;" + byName("Opt").id + "\n";
  const out = await S.sortCsv(text, { fetch: fakeFetch().fetch, ...fast, order: "LWUBRGMC", addColumns: false });
  assert.equal(out.csv, "Name;Scryfall ID\nForest;" + byName("Forest").id + "\nOpt;" + byName("Opt").id + "\n");
});

test("sortCsv keeps a byte-order mark and CRLF when the file had them", async () => {
  const out = await S.sortCsv("\ufeffName\r\nOpt\r\n", { fetch: fakeFetch().fetch, ...fast, addColumns: false });
  assert.equal(out.csv, "\ufeffName\r\nOpt\r\n");
});

test("sortCsv refuses a file it can't find cards in", async () => {
  await assert.rejects(S.sortCsv("Qty,Condition\n1,NM\n", { fetch: fakeFetch().fetch }), /Couldn't find/);
  await assert.rejects(S.sortCsv("", { fetch: fakeFetch().fetch }), /empty/);
});
