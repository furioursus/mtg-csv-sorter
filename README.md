# MTG CSV sorter

Sort a Magic: The Gathering card list the way most sellers file a binder or a box:

**White → Blue → Black → Red → Green → Multicolor → Colorless → Lands**

Give it a CSV from ManaBox, Moxfield, Deckbox, TCGplayer, or a spreadsheet you made yourself. It looks every card up on [Scryfall](https://scryfall.com), so the list doesn't need colors (or Scryfall IDs) in it, and hands back the same file with its rows reordered. Every column you had is kept, as it was. It adds three columns:

- **Scryfall ID**: filled in for any row that didn't have one (an existing `Scryfall ID` column is filled where it's blank, never overwritten)
- **Color Group**: White, Blue, Black, Red, Green, Multicolor, Colorless, Lands, Tokens & other, or Not found
- **Card Type**: Planeswalker, Creature, Instant, Enchantment, Sorcery, Equipment, Vehicle, Spacecraft, Artifact, Land, or the card's own type (Battle)

No dependencies, no build, no server. It runs as a web page or from the command line. [DESIGN.md](DESIGN.md) explains the choices behind it.

**Use it now: [furioursus.github.io/mtg-csv-sorter](https://furioursus.github.io/mtg-csv-sorter/)**

## In a browser

Use [the hosted page](https://furioursus.github.io/mtg-csv-sorter/), or download this repo and open `index.html` (it loads `sorter.js` from the same folder, so keep the two together). Double-clicking it works, and so does any static host. Choose or drop a CSV, press **Sort**, then **Download the sorted CSV**.

The file stays in your browser. Only the card identifiers go to Scryfall.

While it works, a panel shows what it's doing (reading the file, looking cards up, trying misses again, sorting) with a progress bar, how many cards it has found, and about how long is left. If Scryfall asks it to slow down, it counts down the wait. **Stop** cancels the run at any point.

## From the command line

Node 18 or newer:

```sh
node cli.js my-cards.csv -o my-cards-sorted.csv
```

```text
Options:
  -o, --output <file>   where to write the sorted CSV (default: stdout)
  --by <how>            within a group: name (default), set, cmc, original
  --identity            group by color identity instead of the card's color
  --order <groups>      group order, e.g. WUBRGMCL (default) or LWUBRGMC
  --no-types            within a color, don't file by card type first
  --no-columns          don't add the Scryfall ID, Color Group and Card Type columns
  --bulk <file>         look cards up in a Scryfall bulk file (see below); anything
                        it doesn't have still goes to the API
  --offline             with --bulk, never ask the API
```

Progress, group counts, and any cards it couldn't find go to stderr. On a terminal the progress is one line that updates in place; piped to a log, you get one line per stage.

## Big inventory? Use a Scryfall bulk file

If you’re sorting thousands of cards, or doing this every week, grab Scryfall’s bulk data once and every card gets looked up right on your computer instead of asked for over the internet.

1) Go to [Scryfall’s bulk data page](https://scryfall.com/docs/api/bulk-data).
2) Download **Default Cards**. It’s every printing, in English where there is one, and it’s a few hundred MB. Not Oracle Cards (one printing per card, so your exact printings won’t match), and not Rulings.
3) In the browser, open **Big inventory? Use a Scryfall bulk file** and pick it. From the command line, pass `--bulk` and the file. Either of Scryfall's formats works (one card per line, `.jsonl`, or one JSON array, `.json`), gzipped or not.

Scryfall rebuilds these every day. Anything printed after your download still gets looked up the normal way, so you only need a fresh copy when a new set drops. Tick **Only use the bulk file** (or pass `--offline`) to never touch the API.

A 330 MB file with 110,000 printings reads in about four seconds and sorts a 9,000-row collection with no requests at all. The page keeps the file it read, so sorting again is instant. Non-English printings that aren't in Default Cards are still found, by set and collector number.

## In your own code

```js
const { sortCsv } = require("./sorter.js"); // in a page: <script src="sorter.js"> gives you window.MtgSort

const { csv, groups, notFound } = await sortCsv(text, { by: "name" });
```

`sortCsv(text, opts)` options: `by`, `identity`, `order`, `addColumns` (as above), plus `fetch` (your own fetch, for tests), `headers` (send a `User-Agent` from servers; Scryfall asks every API client to identify itself), `delayMs` (time between requests, default 500), `retryMs` (first wait after a 429 when Scryfall doesn't say, default 10,000), `onProgress(event)`, `onWait({ ms, attempt, retries })` (called when Scryfall makes it wait), `signal` (an `AbortSignal`; aborting rejects with an `AbortError`), and `bulk` plus `offline` (a bulk index from `readBulk(textChunks)`, see above). `onProgress` gets `{ stage: "read", rows, findBy }`, then `{ stage: "lookup" | "retry", pass, cards, found, done, total, etaMs }` as each pass starts and after each request, then `{ stage: "sort", rows }`; `readBulk` sends `{ stage: "bulk", cards, chars }`. It returns the new CSV text, a count per group, the rows Scryfall couldn't find, the columns it read, and the sorted rows with their Scryfall card objects. The pieces (`parseCsv`, `findColumns`, `resolve`, `readBulk`, `group`, `sortRows`) are exported too.

## How a card is found

The columns are found by their header, whatever order they're in and whatever their case:

| Looks for | Headers it knows |
|---|---|
| Scryfall ID | `Scryfall ID`, `scryfall_id`, `Scryfall UUID` |
| Set code | `Set code`, `Edition Code`, `Set`, `Edition` |
| Collector number | `Collector number`, `Card Number`, `Number`, `CN` |
| Name | `Name`, `Card Name`, `Card`, `Product Name` |

Each row is looked up by the best thing it has: its Scryfall ID, then its set code and collector number, then its name and set, then its name alone. A row that misses on one tries the next, so a set column holding a set's full name ("Ixalan") still finds the card by name. Rows asking for the same card share one lookup, and lookups go 75 to a request (Scryfall's `/cards/collection` limit), two a second (that endpoint's rate limit, tighter than the rest of Scryfall's API). A 10,000-row export with 8,000 different printings takes about 107 requests, roughly a minute.

If Scryfall still answers "slow down" (HTTP 429), the sorter says so, waits as long as Scryfall asks (10 seconds if it can't tell, which is always the case in a browser), then 20, 40, and 80, and slows every later request down. After four waits it stops and tells you to try again in a few minutes.

Comma, semicolon, and tab-separated files all work; the output keeps the input's separator, line endings, and byte-order mark.

## How a card is grouped

- **Lands** first: any card whose front face is a land, so Dryad Arbor and artifact lands are lands, but a modal double-faced card with a spell on the front (Agadeem's Awakening) goes with its spell's color.
- **Colors** come from what's printed on the frame. Double-faced, adventure, and flip cards go by their front face; split cards (Fire // Ice) count both halves, so they're multicolor. Hybrid cards are multicolor.
- **Colorless**: artifacts, Eldrazi, and devoid cards (which are colorless by the rules, whatever their cost).
- **Tokens & other**: tokens, emblems, art cards, and other non-playing cards, after everything else.
- **Not found**: rows Scryfall didn't have, last, in the file's order.

**Group by color identity** (`--identity`) groups by commander color identity instead: devoid cards go under the color in their cost, and an artifact with a `{W}` ability goes under white. Lands stay lands.

Within each color, cards are filed by type: **Planeswalker, Creature, Instant, Enchantment, Sorcery**, then **artifacts**, split into Equipment first, then Vehicles and Spacecraft, then everything else. Anything else (Battles, say) comes after. It goes by the front face, and a card with two types goes under the first one in that list, so an artifact creature or an enchantment creature files with the creatures. Untick **file by card type** (or pass `--no-types`) to skip this. A **Card Type** column says where each card went.

Within a type, cards are sorted by name (numbers in names in numeric order), or by set (oldest first) and collector number, or by mana value, or left in the file's order. Ties keep the file's order.

## Tests

```sh
npm test
```

The tests run against a stand-in for Scryfall (`test/fake-scryfall.js`) over Scryfall-shaped cards in `test/cards.json`, one for each layout that groups differently.

## License

MIT; see [LICENSE](LICENSE). The page's display font, Bricolage Grotesque, is under the SIL Open Font License; see [fonts/OFL.txt](fonts/OFL.txt).

The card art in `og-image.jpg` (the link preview) is from [*Hot Fix*](https://scryfall.com/card/ust/133/hot-fix) (Unstable) by David Sladek, copyright Wizards of the Coast, LLC, used as unofficial Fan Content under the [Wizards of the Coast Fan Content Policy](https://company.wizards.com/en/legal/fancontentpolicy). It isn't covered by the MIT license.

Card data comes from Scryfall. Not affiliated with Wizards of the Coast or Scryfall.
