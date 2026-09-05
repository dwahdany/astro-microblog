# The decision log

One file per decision. The frontmatter says **what it did to the book**, the
body says **why**. Both are published; the body is the point.

Files whose name starts with `_` are ignored by the loader, so this one is
not an entry and neither is any scratch draft you leave here.

Filenames are free-form (`2025-03-14-trimmed-nvda.md` sorts nicely); the URL
comes from `slug`, not the filename: `/portfolio/<slug>/`.

## The one rule

**No amounts, ever.** No share counts, no prices paid, no fees in currency, no
account totals. The repository source is public, and shares × price
reconstructs a balance. A decision records only the *weights* it produced.

That is not a compromise on the numbers: time-weighted return depends only on
the weight path, so the published track record is the real one. What genuinely
cannot be published is anything denominated in money — realised P&L in euros,
and money-weighted return (XIRR).

## Template

Copy this whole block, delete what you do not need.

```markdown
---
slug: trimmed-nvda                # required. URL is /portfolio/<slug>/
title: Trimmed NVDA back to 6%    # required. Shown in the log and the feed
created: 2025-03-14               # required. The decision date (YYYY-MM-DD)
tags: [semis, risk]               # optional. Same tag space as the rest of the blog
excerpt: Position size outran the thesis.   # optional. One line, used in previews
is_draft: false                   # optional. true = invisible everywhere
move: trim                        # optional. Derived from `legs` when omitted
conviction: medium                # optional. low | medium | high
cost_bps: 10                      # optional. Overrides the config default
legs:
  - ticker: NVDA                  # Yahoo Finance symbol, or CASH
    name: NVIDIA                  # optional. Falls back to the price feed's name
    weight: 0.06                  # the post-trade weight of the book, 0..1
  - ticker: CASH
    weight: 0.09
---

Why, in your own words. Markdown, as long or short as you like. This is the
part that gets judged when the chart catches up with it.
```

## Fields

| Field | Meaning |
|---|---|
| `slug` | URL segment. Keep it stable — it is the permalink and the feed id. |
| `title` | Imperative and specific beats clever. It is the whole line in the log. |
| `created` | The date the decision was executed. Drives ordering and the chart marker. |
| `tags` | Shared with the rest of the blog, so `#risk` works site-wide. |
| `excerpt` | Optional one-liner for the card. |
| `is_draft` | `true` hides the entry from the page, the feed and the return engine. |
| `move` | `open` · `add` · `trim` · `exit` · `rebalance` · `note`. Derived from the legs when omitted; set it only to override the badge. |
| `conviction` | `low` · `medium` · `high`. Self-reported, rendered as a small meter. Honesty here is what makes it worth anything. |
| `cost_bps` | Round-trip trading cost for *this* decision, in basis points of the weight actually moved. Defaults to `costBps` in `src/data/portfolio.config.ts`. Use it when a trade was unusually expensive (illiquid, wide spread). |
| `legs` | What changed. Empty (`legs: []`) means commentary only — a `note`. |

## Legs

A leg is one holding's new size. Give **exactly one** sizing field per leg, or
none for a full exit:

| Form | Means | Example |
|---|---|---|
| `weight: 0.08` | After this trade the holding is 8% of the book. The primary, explicit form. | `weight: 0.08` |
| `portion: 0.5` | Sold half of whatever the position was. | `portion: 0.5` |
| `scale: 2` | Doubled the position's weight. `scale: 0.5` halves it. | `scale: 2` |
| *(nothing)* + `action: sell` | Closed the position entirely. | see below |

```yaml
legs:
  - ticker: IBM
    action: sell        # no size + sell = full exit
  - ticker: CASH
    weight: 0.14        # where the proceeds went
```

Weights are the **actual** post-trade weights, not targets. Rounding to the
nearest half percent is fine and keeps the log tidy — the engine drifts weights
with prices between decisions and snaps them to the declared values on the
decision date.

Two more optional per-leg fields:

- `action: buy | sell` — normally derived by comparing to the pre-trade weight.
  Only needed for a sizeless full exit, or to disambiguate.
- `date: 2025-03-17` — if a leg executed on a different day from the entry's
  `created`. Defaults to `created`.

### CASH

`CASH` is a reserved pseudo-ticker for the uninvested remainder. It accrues the
configured risk-free rate daily, so "I went 30% cash" is expressible and gets
scored fairly instead of vanishing from the denominator. Give it a `weight`
like any other leg. If you never mention it, the engine treats the rest of the
book as the whole book.

### Weights should sum to 1

Across all holdings on any given day, including `CASH`. You only need to state
the ones you touched — the engine carries the rest forward — but if the total
after a decision cannot reach 100% it will say so in a build warning (visible
in `npm run dev` only).

## Workflow

### 1. Import from the broker (optional but preferred)

`scripts/import-ib.mjs` turns Interactive Brokers activity data into draft
entries. Statements contain share counts, cost basis and your account number —
keep them in `private/`, which is gitignored. Nothing but weights comes out the
other end. Two input formats are accepted and may be mixed; overlapping files
deduplicate by trade timestamp:

- **Activity Statement CSV**, downloaded by hand from Client Portal
  (Performance & Reports > Statements > Activity, CSV).
- **Activity Flex Query XML**, fetched for you by the IBKR connector below.

```sh
node scripts/import-ib.mjs private/*                     # inspect + verify, writes nothing
node scripts/import-ib.mjs private/* --map-suggest       # print a symbol map skeleton
node scripts/import-ib.mjs private/* --write             # write draft entries here
```

Drafts land in this directory with `is_draft: true`. Write the *why*, then flip
the flag. Verification compares the reconstruction against the statement's own
period-end snapshot; `--force` writes anyway if you know better.

Unmapped or oddly-named symbols go in `scripts/ib-symbol-map.json`
(broker symbol → Yahoo Finance symbol).

#### The IBKR connector

`scripts/ibkr-flex-mcp.py` pulls reports straight from IBKR through the
[Flex Web Service](https://www.ibkrguides.com/clientportal/performanceandstatements/flex-web-service.htm)
— token-based, no gateway, no browser login — and saves them to `private/`. It
is registered in `.mcp.json`, so Claude Code can call it as the `ibkr` MCP
server (`flex_status`, `fetch_activity`, `summarize_statement`, `run_import`),
and it doubles as a CLI:

```sh
uv run --script scripts/ibkr-flex-mcp.py status                    # config + which dates private/ covers
uv run --script scripts/ibkr-flex-mcp.py fetch                     # from the day after the last file, to yesterday
uv run --script scripts/ibkr-flex-mcp.py fetch --from 2024-08-21   # full history, in one-year chunks
uv run --script scripts/ibkr-flex-mcp.py import --write            # = node scripts/import-ib.mjs private/* --write
```

One-time setup in Client Portal (the script header has the long version):

1. Performance & Reports > Flex Queries > **Flex Web Service Configuration**
   (gear icon): enable, generate a token, and set *Should Expire After* to
   1 year — the default is 6 hours.
2. Performance & Reports > Flex Queries > **Activity Flex Query** > create one
   with sections Account Information, Change in NAV, Open Positions (Summary),
   Trades (Orders), Transfers, Financial Instrument Information; format XML.
   The Query ID is in the (i) pop-over next to the saved query.
3. Save both, outside git, in `private/ibkr.env`:

   ```
   IBKR_FLEX_TOKEN=...
   IBKR_FLEX_QUERY_ID=...
   IBKR_FLEX_TOKEN_CREATED=2026-09-05   # optional, enables the expiry warning
   ```

4. First run, interactively: fetch `--from 2026-01-01 --to 2026-08-11` and run
   the import. The Flex report must verify against the same snapshot as the
   hand-downloaded CSV for that period, its TWR must match the CSV's, and a
   trade's Date/Time must agree to the second in both files (the deduplication
   relies on it).

IBKR finalises activity data once a day after the close, so fetch the morning
after a trade. The connector reads that file (or the same names from the
environment) and never returns either value. What it does return to the model is shapes only —
dates, symbols, buy/sell, row counts, IBKR's period TWR — never quantities or
values; those stay in `private/` for the importer.

### 2. Refresh prices

```sh
npm run prices                     # or: node scripts/fetch-prices.mjs
node scripts/fetch-prices.mjs --only NVDA,VWCE.DE --verbose
node scripts/fetch-prices.mjs --dry-run
```

This writes `src/data/prices.json`: dividend- and split-adjusted daily closes
for every ticker the log mentions, every configured benchmark, and the FX pairs
needed to express them in the base currency. Adjusted closes mean distributions
are already included — never model dividends separately.

Yahoo rate-limits bursts hard, so the script is deliberately slow and serial.
If you get a 429, wait it out rather than re-running in a loop.

The portfolio page builds fine without `prices.json` — it renders the log and
says performance figures are unavailable — so a fresh clone is never broken by
a missing cache.

### 3. Check it

```sh
npm run dev      # engine warnings render on /portfolio/ in dev only
npm run build
```

## Turning off demo mode

`src/data/portfolio.config.ts`:

```ts
export const portfolioConfig: PortfolioConfig = {
  enabled: true,   // false → /portfolio/ redirects home and no decision pages build
  demo: false,     // false → drops the "example data" banner
  ...
};
```

`demo: true` renders an "example data" banner above the fold. Flip it to
`false` once the entries here are your own. The same file holds the inception
date, the base currency, the benchmark list, the risk-free rate and the default
`costBps` — all documented inline.
