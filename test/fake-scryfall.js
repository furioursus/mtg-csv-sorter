// A stand-in for POST https://api.scryfall.com/cards/collection over test/cards.json.
// Matches like Scryfall: names any case (full name or any face's), set codes any case,
// and found cards in `data`, misses in `not_found`.
"use strict";
const CARDS = require("./cards.json");

function match(ident, cards) {
  const lower = (s) => String(s).toLowerCase();
  const names = (c) => [c.name, ...(c.card_faces || []).map((f) => f.name)].map(lower);
  if (ident.id) return cards.find((c) => c.id === ident.id);
  if (ident.set && ident.collector_number) {
    return cards.find((c) => c.set === lower(ident.set) && c.collector_number === lower(ident.collector_number));
  }
  if (ident.name) {
    return cards.find((c) => names(c).includes(lower(ident.name)) && (!ident.set || c.set === lower(ident.set)));
  }
  return undefined;
}

const headers = (h = {}) => ({ get: (name) => h[name.toLowerCase()] ?? null });

/** A fetch that answers like Scryfall. `calls` records each request's identifiers. */
function fakeFetch({ cards = CARDS, failFirst = 0, status = 429, retryAfter = null } = {}) {
  const calls = [];
  let failures = failFirst;
  const fetch = async (url, init) => {
    if (url !== "https://api.scryfall.com/cards/collection" || init.method !== "POST") {
      throw new Error(`unexpected request ${init.method} ${url}`);
    }
    const { identifiers } = JSON.parse(init.body);
    calls.push(identifiers);
    if (failures > 0) {
      failures--;
      return {
        ok: false, status, headers: headers(retryAfter == null ? {} : { "retry-after": String(retryAfter) }),
        json: async () => ({ object: "error", status, details: "Too many requests" }),
      };
    }
    if (identifiers.length > 75) {
      return { ok: false, status: 422, headers: headers(), json: async () => ({ object: "error", details: "Too many identifiers" }) };
    }
    const data = [], notFound = [];
    for (const ident of identifiers) {
      const card = match(ident, cards);
      if (card) data.push(card); else notFound.push(ident);
    }
    return { ok: true, status: 200, headers: headers(), json: async () => ({ object: "list", not_found: notFound, data }) };
  };
  return { fetch, calls };
}

/** A clock for the sorter's `sleep` and `now`: sleeping moves time on at once, and every sleep is logged. */
function fakeClock() {
  const clock = { t: 0, sleeps: [] };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => { clock.sleeps.push(ms); clock.t += ms; };
  return clock;
}

module.exports = { fakeFetch, fakeClock, CARDS };
