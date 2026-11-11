/*
 * MTG CSV sorter: reorders a card list the way sellers sort a binder or a box,
 * White / Blue / Black / Red / Green / Multicolor / Colorless / Lands by default.
 *
 * Colors and types come from Scryfall (POST /cards/collection), so the CSV only needs
 * something to find each card by: a Scryfall ID, a set code and collector number, or a name.
 *
 * One file, no dependencies. In a browser it defines `MtgSort` on the page; in Node it's
 * `require("./sorter.js")`.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MtgSort = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const GROUPS = {
    W: "White", U: "Blue", B: "Black", R: "Red", G: "Green",
    M: "Multicolor", C: "Colorless", L: "Lands",
    T: "Tokens & other", X: "Not found",
  };
  // T and X always come last, after whatever order is asked for.
  const DEFAULT_ORDER = ["W", "U", "B", "R", "G", "M", "C", "L"];
  const COLORS = ["W", "U", "B", "R", "G"];

  // Checked in order; the first header that matches wins. Covers ManaBox, Moxfield,
  // Deckbox, TCGplayer and most hand-made lists.
  const COLUMN_ALIASES = {
    scryfall_id: ["scryfall id", "scryfall_id", "scryfallid", "scryfall uuid", "scryfall card id"],
    name: ["name", "card name", "card", "card_name", "product name", "cardname"],
    set: ["set code", "set_code", "setcode", "edition code", "set", "edition", "expansion code"],
    collector_number: [
      "collector number", "collector_number", "collectornumber", "collector #",
      "card number", "number", "cn", "no.",
    ],
  };

  // Scryfall layouts that aren't playing cards a seller sorts by color.
  const NON_CARD_LAYOUTS = new Set(["token", "double_faced_token", "emblem", "art_series", "vanguard", "scheme", "planar"]);
  // Layouts whose halves sit side by side on one frame, so the card is both halves' colors.
  const SIDE_BY_SIDE_LAYOUTS = new Set(["split", "aftermath"]);

  const SCRYFALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const SET_CODE = /^[a-z0-9]{2,6}$/i;
  const BATCH = 75; // Scryfall's limit per /cards/collection request
  const API = "https://api.scryfall.com/cards/collection";

  // ---------- CSV ----------

  function detectDelimiter(text) {
    const counts = { ",": 0, ";": 0, "\t": 0 };
    let quoted = false;
    for (const ch of text) {
      if (ch === '"') quoted = !quoted;
      else if (!quoted && (ch === "\n" || ch === "\r")) break;
      else if (!quoted && ch in counts) counts[ch]++;
    }
    return Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a), ",");
  }

  /** RFC 4180 with any delimiter. Returns rows of strings, and the line ending the file used. */
  function parseCsv(text, delimiter = ",") {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const newline = /\r\n/.test(text) ? "\r\n" : "\n";
    const rows = [];
    let row = [], field = "", quoted = false, i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (quoted) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          quoted = false;
        } else field += ch;
        i++;
        continue;
      }
      if (ch === '"') quoted = true;
      else if (ch === delimiter) { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        row.push(field); rows.push(row); row = []; field = "";
        if (ch === "\r" && text[i + 1] === "\n") i++;
      } else field += ch;
      i++;
    }
    if (field !== "" || row.length) { row.push(field); rows.push(row); }
    return { rows: rows.filter((r) => r.some((f) => f.trim() !== "")), newline };
  }

  function toCsv(rows, delimiter = ",", newline = "\n") {
    const needsQuotes = new RegExp(`["\\r\\n${delimiter === "\t" ? "\\t" : delimiter}]|^\\s|\\s$`);
    const cell = (v) => (needsQuotes.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    return rows.map((r) => r.map((v) => cell(v == null ? "" : String(v))).join(delimiter)).join(newline) + newline;
  }

  // ---------- columns and identifiers ----------

  const norm = (s) => String(s).trim().toLowerCase().replace(/\s+/g, " ");

  /** Header index for each field, or -1. */
  function findColumns(header) {
    const byNorm = new Map();
    header.forEach((h, i) => { if (!byNorm.has(norm(h))) byNorm.set(norm(h), i); });
    const cols = {};
    for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
      cols[field] = -1;
      for (const a of aliases) if (byNorm.has(a)) { cols[field] = byNorm.get(a); break; }
    }
    return cols;
  }

  /** A name as Scryfall would match it: no accents, any case, single spaces. */
  function nameKey(name) {
    return norm(String(name).normalize("NFD").replace(/[̀-ͯ]/g, ""));
  }

  /**
   * The ways to look one row up, best first: Scryfall ID, then set + collector number,
   * then name + set, then name alone. Each is a Scryfall identifier with a key to match it back.
   * A "Front // Back" name goes by its front face: Scryfall matches face names, never the full name.
   */
  function candidates(row, cols) {
    const get = (f) => (cols[f] >= 0 ? (row[cols[f]] || "").trim() : "");
    const id = get("scryfall_id"), cn = get("collector_number");
    const name = get("name").split(/\s*\/\/\s*/)[0] || get("name");
    const set = SET_CODE.test(get("set")) ? get("set").toLowerCase() : "";
    const out = [];
    if (SCRYFALL_ID.test(id)) out.push({ key: `id:${id.toLowerCase()}`, ident: { id: id.toLowerCase() } });
    if (set && cn) out.push({ key: `sc:${set}|${cn.toLowerCase()}`, ident: { set, collector_number: cn } });
    if (name && set) out.push({ key: `ns:${nameKey(name)}|${set}`, ident: { name, set } });
    if (name) out.push({ key: `n:${nameKey(name)}`, ident: { name } });
    return out;
  }

  /** Every candidate key a Scryfall card answers to. */
  function keysFor(card) {
    const names = new Set([nameKey(card.name)]);
    for (const f of card.card_faces || []) names.add(nameKey(f.name));
    const set = String(card.set).toLowerCase();
    const keys = [`id:${String(card.id).toLowerCase()}`, `sc:${set}|${String(card.collector_number).toLowerCase()}`];
    for (const n of names) keys.push(`ns:${n}|${set}`, `n:${n}`);
    return keys;
  }

  // ---------- Scryfall ----------

  /** The error a canceled run throws (name "AbortError", like fetch's). */
  function stopped() {
    const e = new Error("Stopped.");
    e.name = "AbortError";
    return e;
  }

  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(stopped());
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(t); reject(stopped()); }, { once: true });
  });

  // Scryfall limits /cards/collection to about 2 requests a second, well under the
  // 10 a second its other endpoints allow, and answers 429 to anything faster.
  const DELAY_MS = 500;
  const MAX_DELAY_MS = 4000;
  const RETRIES = 4;
  const RETRY_MS = 30000; // the first wait when Scryfall doesn't say how long: its documented lockout

  const browserOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

  /**
   * Spaces requests `delay` ms apart, start to start, and slows down for good after a 429.
   * `sleep` and `now` are swappable so tests don't wait.
   */
  function pacer({ delayMs = DELAY_MS, sleep: sleepFn = sleep, now = Date.now, signal } = {}) {
    let delay = delayMs, last = -Infinity;
    const wait = async (ms) => {
      await sleepFn(ms, signal);
      if (signal && signal.aborted) throw stopped();
    };
    return {
      wait, now,
      get delay() { return delay; },
      async turn() {
        const gap = last + delay - now();
        if (gap > 0) await wait(gap);
        last = now();
      },
      slowDown() { delay = Math.min(MAX_DELAY_MS, Math.max(delay * 2, DELAY_MS)); },
    };
  }

  /** Retry-After in ms, if the response has one we can read (browsers hide it cross-origin). */
  function retryAfter(res) {
    const value = res.headers && typeof res.headers.get === "function" ? res.headers.get("Retry-After") : null;
    const seconds = Number(value);
    return value != null && value !== "" && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
  }

  async function postBatch(identifiers, { fetch, headers, pace, signal, retries = RETRIES, retryMs = RETRY_MS, onWait }) {
    for (let attempt = 0; ; attempt++) {
      await pace.turn();
      if (signal && signal.aborted) throw stopped();
      let res;
      try {
        res = await fetch(API, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
          body: JSON.stringify({ identifiers }),
          signal,
        });
      } catch (e) {
        if (signal && signal.aborted) throw stopped();
        const why = (e && e.cause ? e.cause.message || e.cause.code : e && e.message) || "network error";
        if (browserOffline()) throw new Error(`Couldn't reach Scryfall (${why}). Check the connection and try again.`);
        // A browser reports Scryfall's 429 as a failed fetch, since the 429 has no CORS header: see DESIGN.md#hidden-429
        if (attempt >= retries) {
          throw new Error(`Couldn't reach Scryfall (${why}), even after ${retries} waits. Scryfall may be limiting requests, `
            + "which a browser can't tell from a dropped connection. Check the connection, give it a few minutes, and try again.");
        }
        pace.slowDown();
        const ms = retryMs * 2 ** attempt;
        if (onWait) onWait({ ms, attempt: attempt + 1, retries, reason: "unreachable" });
        await pace.wait(ms);
        continue;
      }
      if (res.status === 429) {
        if (attempt >= retries) {
          throw new Error(`Scryfall is still limiting requests after ${retries} waits. Give it a few minutes and try again.`);
        }
        pace.slowDown();
        const ms = retryAfter(res) ?? retryMs * 2 ** attempt;
        if (onWait) onWait({ ms, attempt: attempt + 1, retries, reason: "limited" });
        await pace.wait(ms);
        continue;
      }
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(`Scryfall answered ${res.status}${body && body.details ? `: ${body.details}` : ""}`);
      }
      return body.data || [];
    }
  }

  /**
   * Finds the Scryfall card for every data row. Rows that miss on their best identifier
   * try the next one (a "set" column holding a set's name instead of its code, say).
   * Returns an array parallel to `rows`, with null for rows Scryfall couldn't find.
   *
   * opts.fetch: a fetch implementation (default: the global one).
   * opts.headers: extra request headers (Node should send a User-Agent; browsers can't).
   * opts.delayMs: time between request starts (default 500, Scryfall's 2 a second for this endpoint).
   *   It doubles, up to 4 s, after each 429.
   * opts.retryMs: first wait after a 429 with no Retry-After, or a fetch that fails outright
   *   (default 30 s, Scryfall's lockout; doubling; four waits before giving up).
   * opts.onProgress({ stage, pass, cards, found, done, total, etaMs }): called as each pass
   *   starts and after each request. stage is "lookup" for the first pass and "retry" for the
   *   passes that try missed cards by their next identifier; cards is how many distinct cards
   *   this pass looks up and found how many of them it has found so far; done and total count
   *   requests over the whole run (total grows when a retry pass starts); etaMs is a guess at
   *   the time left for the passes planned so far.
   * opts.onWait({ ms, attempt, retries, reason }): called before each wait. reason is "limited"
   *   for a 429, "unreachable" for a fetch that failed outright (how a browser sees a 429).
   * opts.bulk: an index from readBulk. Cards in it are found without asking Scryfall;
   *   the rest still go to the API, unless opts.offline is set.
   * opts.signal: an AbortSignal; aborting stops the run with an AbortError.
   * opts.sleep, opts.now: swap out the clock (tests).
   */
  async function resolve(rows, cols, opts = {}) {
    const fetchImpl = opts.fetch || globalThis.fetch;
    const signal = opts.signal;
    const pace = pacer({ delayMs: opts.delayMs ?? DELAY_MS, sleep: opts.sleep, now: opts.now, signal });
    const found = new Map(); // candidate key -> card
    const missed = new Set(); // candidate keys Scryfall didn't find
    const options = rows.map((r) => candidates(r, cols));
    const step = rows.map(() => 0); // which candidate each row is on
    let done = 0, total = 0, pass = 0;
    const started = pace.now();
    const progress = (cards, foundNow) => {
      if (!opts.onProgress) return;
      const left = total - done;
      const per = done ? (pace.now() - started) / done : pace.delay;
      opts.onProgress({
        stage: pass === 1 ? "lookup" : "retry", pass, cards, found: foundNow, done, total,
        etaMs: Math.max(0, Math.round(left * Math.max(per, pace.delay))),
      });
    };

    for (;;) {
      if (signal && signal.aborted) throw stopped();
      const want = new Map();
      rows.forEach((_, i) => {
        while (step[i] < options[i].length && missed.has(options[i][step[i]].key)) step[i]++;
        const c = options[i][step[i]];
        if (c && !found.has(c.key)) want.set(c.key, c.ident);
      });
      if (!want.size) break;
      if (opts.bulk) {
        let settled = false;
        for (const k of [...want.keys()]) {
          const card = opts.bulk.get(k);
          if (card) found.set(k, card);
          else if (opts.offline) missed.add(k);
          else continue;
          want.delete(k);
          settled = true;
        }
        if (!want.size) {
          if (settled) continue; // every row moved on: found, or onto its next identifier
          break;
        }
      }
      const keys = [...want.keys()];
      pass++;
      total += Math.ceil(keys.length / BATCH);
      let foundHere = 0;
      progress(keys.length, 0);
      for (let b = 0; b < keys.length; b += BATCH) {
        const chunk = keys.slice(b, b + BATCH);
        const cards = await postBatch(chunk.map((k) => want.get(k)), {
          fetch: fetchImpl, headers: opts.headers, pace, signal, retryMs: opts.retryMs, onWait: opts.onWait,
        });
        const asked = new Set(chunk);
        for (const card of cards) for (const k of keysFor(card)) if (asked.has(k) && !found.has(k)) found.set(k, card);
        for (const k of chunk) if (found.has(k)) foundHere++; else missed.add(k);
        done++;
        progress(keys.length, foundHere);
      }
    }
    return rows.map((_, i) => {
      const c = options[i][step[i]];
      return (c && found.get(c.key)) || null;
    });
  }

  // ---------- Scryfall bulk files ----------

  // Only what grouping, sorting and the output need; a bulk card is ~5 KB, this is ~300 bytes.
  const CARD_FIELDS = ["id", "name", "set", "collector_number", "layout", "type_line", "colors",
    "color_identity", "mana_cost", "cmc", "released_at"];
  const FACE_FIELDS = ["name", "type_line", "colors", "mana_cost"];

  function pick(obj, fields) {
    const out = {};
    for (const f of fields) if (obj[f] !== undefined) out[f] = obj[f];
    return out;
  }

  function slim(card) {
    const out = pick(card, CARD_FIELDS);
    if (card.card_faces) out.card_faces = card.card_faces.map((f) => pick(f, FACE_FIELDS));
    return out;
  }

  /**
   * Splits a bulk file, fed as text in chunks of any size, into its cards, calling onItem
   * with each one parsed. Lets a file of hundreds of megabytes be read without holding it,
   * or one string of it, in memory. Takes both of Scryfall's formats, told apart by the
   * first character that isn't whitespace: JSON Lines (one card per line, what Scryfall
   * serves now) and a single JSON array (its older format, still offered).
   */
  function arraySplitter(onItem) {
    // base: the depth a card's own braces open from; 1 inside an array, 0 for JSON Lines.
    let base = -1, depth = 0, inStr = false, esc = false, pending = "";
    return {
      push(chunk) {
        const text = pending + chunk;
        let start = pending ? 0 : -1;
        let i = pending.length;
        pending = "";
        for (; i < text.length; i++) {
          const c = text.charCodeAt(i);
          if (base < 0) {
            // Skip a byte-order mark and whitespace, then decide the format.
            if (c === 0xfeff || c === 32 || c === 9 || c === 10 || c === 13) continue;
            base = c === 91 ? 1 : 0; // [
          }
          if (inStr) {
            if (esc) esc = false;
            else if (c === 92) esc = true; // backslash
            else if (c === 34) inStr = false; // quote
            continue;
          }
          if (c === 34) inStr = true;
          else if (c === 123 || c === 91) { // { [
            depth++;
            if (depth === base + 1) start = i;
          } else if (c === 125 || c === 93) { // } ]
            if (depth === base + 1) { onItem(JSON.parse(text.slice(start, i + 1))); start = -1; }
            depth--;
          }
        }
        if (start >= 0) pending = text.slice(start);
      },
      end() {
        if (depth !== 0 || pending) throw new Error("The bulk file stops partway through. Download it again.");
      },
    };
  }

  /**
   * Reads a Scryfall bulk card file (Default Cards, or All Cards) into an index the lookups
   * can use instead of the API. `chunks` is an async iterable of text.
   * opts.onProgress({ stage: "bulk", cards, chars }) every 5,000 cards.
   * Returns { get(key), size }, where size is the number of cards read.
   */
  async function readBulk(chunks, opts = {}) {
    const map = new Map();
    let cards = 0, other = 0, chars = 0;
    const splitter = arraySplitter((item) => {
      if (!item || item.object !== "card") { other++; return; }
      const card = slim(item);
      for (const k of keysFor(card)) if (!map.has(k)) map.set(k, card);
      cards++;
      if (opts.onProgress && cards % 5000 === 0) opts.onProgress({ stage: "bulk", cards, chars });
    });
    // A file on disk reads faster than anything awaits, so without a pause now and then a
    // page wouldn't repaint (or show progress, or take a click on Stop) until the end.
    let lastBreak = Date.now();
    for await (const chunk of chunks) {
      if (opts.signal && opts.signal.aborted) throw stopped();
      chars += chunk.length;
      splitter.push(chunk);
      if (Date.now() - lastBreak > 50) {
        await new Promise((r) => setTimeout(r));
        lastBreak = Date.now();
      }
    }
    if (opts.signal && opts.signal.aborted) throw stopped(); // the source may just stop early when aborted
    splitter.end();
    if (!cards) {
      throw new Error(other
        ? "That bulk file has no cards in it. Use Default Cards (or All Cards), not Rulings."
        : "That file isn't a Scryfall bulk card file.");
    }
    if (opts.onProgress) opts.onProgress({ stage: "bulk", cards, chars });
    return { get: (key) => map.get(key), size: cards };
  }

  // ---------- grouping and sorting ----------

  function manaColors(cost) {
    const out = new Set();
    for (const [, sym] of String(cost).matchAll(/\{([^}]+)\}/g)) for (const ch of sym) if (COLORS.includes(ch)) out.add(ch);
    return [...out];
  }

  /**
   * The colors a seller sees on the card's frame: the front face's for double-faced,
   * adventure and flip cards, both halves' for split cards.
   */
  function frameColors(card) {
    const faces = card.card_faces;
    if (!faces || !faces.length || SIDE_BY_SIDE_LAYOUTS.has(card.layout)) return card.colors || [];
    const front = faces[0];
    if (Array.isArray(front.colors)) return front.colors;
    if (front.mana_cost != null && front.mana_cost !== "") return manaColors(front.mana_cost);
    return card.colors || [];
  }

  function frontTypeLine(card) {
    const faces = card.card_faces;
    const line = (faces && faces.length && faces[0].type_line) || card.type_line || "";
    return line.split(" // ")[0];
  }

  // The order cards are filed in within a color group. A card with two types goes under the
  // first one here, so an artifact creature is a creature and an enchantment creature too.
  const TYPES = [
    ["planeswalker", "Planeswalker"], ["creature", "Creature"], ["instant", "Instant"],
    ["enchantment", "Enchantment"], ["sorcery", "Sorcery"],
    ["equipment", "Equipment"], ["vehicle", "Vehicle"], ["artifact", "Artifact"],
    ["other", "Other"],
  ];
  const TYPE_RANK = Object.fromEntries(TYPES.map(([k], i) => [k, i]));

  /**
   * The card's place in TYPES, from its front face's type line ("Legendary Artifact — Vehicle"):
   * card types before the " — ", subtypes after. Equipment, then Vehicles and Spacecraft,
   * then other artifacts. Battles and anything else not listed are "other"; lands have
   * their own color group, so they're "land" and keep their order.
   * Returns { key, label }; label is what the Card Type column says.
   */
  function cardType(card) {
    if (!card) return { key: "other", label: "" };
    const [types, subtypes = ""] = frontTypeLine(card).split(" — ");
    const t = new Set(types.split(/\s+/));
    const sub = new Set(subtypes.split(/\s+/));
    if (t.has("Land")) return { key: "land", label: "Land" };
    for (const [key, label] of TYPES.slice(0, 5)) if (t.has(label)) return { key, label };
    if (t.has("Artifact")) {
      if (sub.has("Equipment")) return { key: "equipment", label: "Equipment" };
      if (sub.has("Spacecraft")) return { key: "vehicle", label: "Spacecraft" };
      if (sub.has("Vehicle")) return { key: "vehicle", label: "Vehicle" };
      return { key: "artifact", label: "Artifact" };
    }
    const named = types.split(/\s+/).filter((w) => /^[A-Z]/.test(w) && !["Legendary", "Basic", "Snow", "World", "Ongoing", "Token"].includes(w));
    return { key: "other", label: named.pop() || "Other" };
  }

  /**
   * One of W U B R G M C L T X (see GROUPS).
   * opts.identity: sort by color identity (commander style) instead of the frame's color,
   * which puts devoid cards and artifacts with colored abilities under a color.
   */
  function group(card, opts = {}) {
    if (!card) return "X";
    if (NON_CARD_LAYOUTS.has(card.layout)) return "T";
    if (/\bLand\b/.test(frontTypeLine(card))) return "L";
    const colors = (opts.identity ? card.color_identity : frameColors(card)) || [];
    const distinct = COLORS.filter((c) => colors.includes(c));
    if (distinct.length === 0) return "C";
    if (distinct.length > 1) return "M";
    return distinct[0];
  }

  /** "WUBRGMCL" or ["W", ...] -> a full order with every group in it once. */
  function groupOrder(order) {
    const asked = (Array.isArray(order) ? order : String(order || "").split(/[\s,]*/))
      .map((s) => s.trim().toUpperCase()).filter((s) => s in GROUPS && s !== "T" && s !== "X");
    const out = [...new Set(asked)];
    for (const g of DEFAULT_ORDER) if (!out.includes(g)) out.push(g);
    return [...out, "T", "X"];
  }

  const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
  const BY = {
    name: (a, b) => collator.compare(a.name, b.name),
    set: (a, b) => collator.compare(a.released, b.released) || collator.compare(a.set, b.set)
      || collator.compare(a.number, b.number) || collator.compare(a.name, b.name),
    cmc: (a, b) => a.cmc - b.cmc || collator.compare(a.name, b.name),
    original: () => 0,
  };

  /**
   * Sorts data rows by group, then by card type (unless opts.types is false: Planeswalker,
   * Creature, Instant, Enchantment, Sorcery, Equipment, Vehicle/Spacecraft, Artifact, other), then by `opts.by` (name, set, cmc or original) within each group.
   * `cards` is parallel to `rows` (from resolve). Ties keep the file's order.
   * Returns [{ row, card, group }] in the new order.
   */
  function sortRows(rows, cards, cols, opts = {}) {
    const types = opts.types !== false;
    const order = groupOrder(opts.order);
    const rank = Object.fromEntries(order.map((g, i) => [g, i]));
    const by = BY[opts.by || "name"];
    if (!by) throw new Error(`Unknown sort "${opts.by}"; use name, set, cmc or original`);
    const cell = (row, f) => (cols[f] >= 0 ? (row[cols[f]] || "").trim() : "");
    const items = rows.map((row, i) => {
      const card = cards[i];
      return {
        row, card, i, group: group(card, opts), type: cardType(card),
        name: card ? card.name : cell(row, "name"),
        set: card ? card.set : cell(row, "set").toLowerCase(),
        number: card ? card.collector_number : cell(row, "collector_number"),
        released: (card && card.released_at) || "",
        cmc: card && typeof card.cmc === "number" ? card.cmc : Infinity,
      };
    });
    const typeRank = (item) => (types ? TYPE_RANK[item.type.key] ?? 0 : 0); // lands all share one rank
    items.sort((a, b) => rank[a.group] - rank[b.group] || typeRank(a) - typeRank(b) || by(a, b) || a.i - b.i);
    return items.map(({ row, card, group: g, type }) => ({ row, card, group: g, type: type.label }));
  }

  // ---------- the whole job ----------

  /**
   * CSV text in, sorted CSV text out.
   * opts: by, identity, order, types (see sortRows/group), addColumns (default true: fills or
   * adds a "Scryfall ID" column and adds "Color Group" and "Card Type" ones), plus resolve's fetch, headers,
   * delayMs, retryMs, onProgress, onWait and signal. onProgress also gets
   * { stage: "read", rows, findBy } once the file is read (findBy: "Scryfall ID",
   * "set and collector number" or "name", what most rows will be looked up by) and
   * { stage: "sort", rows } once every card is looked up.
   * Returns { csv, groups: [{ code, label, count }], notFound: [{ row, name }], columns, sorted },
   * where `row` is the spreadsheet row (header = 1) and `sorted` is sortRows' result.
   */
  async function sortCsv(text, opts = {}) {
    const bom = text.charCodeAt(0) === 0xfeff ? "\ufeff" : ""; // Excel reads UTF-8 by it; keep it if it was there
    const delimiter = opts.delimiter || detectDelimiter(text);
    const { rows, newline } = parseCsv(text, delimiter);
    if (!rows.length) throw new Error("The file is empty.");
    const header = rows[0], data = rows.slice(1);
    const cols = findColumns(header);
    if (cols.scryfall_id < 0 && cols.name < 0 && (cols.set < 0 || cols.collector_number < 0)) {
      throw new Error("Couldn't find a Scryfall ID, Name, or Set code + Collector number column in the header.");
    }
    const width = data.reduce((w, r) => Math.max(w, r.length), header.length);
    const padded = data.map((r) => (r.length < width ? [...r, ...Array(width - r.length).fill("")] : r));

    if (opts.onProgress) {
      const findBy = cols.scryfall_id >= 0 ? "Scryfall ID"
        : cols.set >= 0 && cols.collector_number >= 0 ? "set and collector number" : "name";
      opts.onProgress({ stage: "read", rows: padded.length, findBy });
    }
    const cards = await resolve(padded, cols, opts);
    if (opts.onProgress) opts.onProgress({ stage: "sort", rows: padded.length });
    const sorted = sortRows(padded, cards, cols, opts);

    let outHeader = [...header, ...Array(width - header.length).fill("")];
    let outRows = sorted.map((s) => [...s.row]);
    if (opts.addColumns !== false) {
      let idCol = cols.scryfall_id;
      if (idCol < 0) { idCol = outHeader.length; outHeader.push("Scryfall ID"); outRows.forEach((r) => r.push("")); }
      let groupCol = outHeader.findIndex((h) => norm(h) === "color group");
      if (groupCol < 0) { groupCol = outHeader.length; outHeader.push("Color Group"); outRows.forEach((r) => r.push("")); }
      let typeCol = outHeader.findIndex((h) => norm(h) === "card type");
      if (typeCol < 0) { typeCol = outHeader.length; outHeader.push("Card Type"); outRows.forEach((r) => r.push("")); }
      sorted.forEach((s, i) => {
        if (s.card && !SCRYFALL_ID.test(outRows[i][idCol].trim())) outRows[i][idCol] = s.card.id;
        outRows[i][groupCol] = GROUPS[s.group];
        outRows[i][typeCol] = s.type;
      });
    }

    const counts = {};
    for (const s of sorted) counts[s.group] = (counts[s.group] || 0) + 1;
    const groups = groupOrder(opts.order).filter((g) => counts[g]).map((g) => ({ code: g, label: GROUPS[g], count: counts[g] }));
    const rowOf = new Map(padded.map((r, i) => [r, i + 2])); // the header is row 1
    const notFound = sorted.filter((s) => !s.card).map((s) => ({
      row: rowOf.get(s.row),
      name: (cols.name >= 0 && s.row[cols.name]) || (cols.scryfall_id >= 0 && s.row[cols.scryfall_id]) || "",
    }));
    return {
      csv: bom + toCsv([outHeader, ...outRows], delimiter, newline),
      groups, notFound, columns: cols, sorted,
    };
  }

  return {
    GROUPS, DEFAULT_ORDER, COLUMN_ALIASES,
    detectDelimiter, parseCsv, toCsv, findColumns, candidates, keysFor, arraySplitter, readBulk,
    resolve, frameColors, group, cardType, groupOrder, sortRows, sortCsv,
  };
});
