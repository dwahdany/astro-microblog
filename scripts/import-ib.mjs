#!/usr/bin/env node
/**
 * Turn Interactive Brokers *Activity Statement* CSVs into weight-based
 * decision log entries.
 *
 * WHAT GOES IN vs WHAT COMES OUT
 * ------------------------------
 * In: your activity statements, which contain share counts, cost basis,
 * position values, your name and your account number. All private. Keep them
 * in `private/` — it is gitignored.
 *
 * Out: weights, and nothing else. No quantity, no price, no value, no account
 * id ever reaches a file this script writes. That asymmetry is the point: the
 * published log describes the shape of the book, never its size.
 *
 * WHY ACTIVITY STATEMENTS AND NOT THE TRADE EXPORT
 * ------------------------------------------------
 * A weight is value_i / sum_j value_j, so it needs *every* holding on the day
 * it is computed. A trade list alone cannot supply that: positions transferred
 * in from another broker never appear as a purchase, so reconstructing from
 * trades silently produces wrong weights. Activity statements carry the
 * Transfers and Open Positions sections that close the gap, and their
 * period-end snapshots let this script *prove* the reconstruction is right
 * instead of assuming it.
 *
 * They also report IB's own time-weighted return per period, which is used
 * here as an independent check on the site's return engine.
 *
 * USAGE
 *   node scripts/import-ib.mjs private/U*.csv                 # inspect + verify
 *   node scripts/import-ib.mjs private/U*.csv --write         # emit draft entries
 *   node scripts/import-ib.mjs private/U*.csv --map-suggest   # print a symbol map
 *
 *   --write         Write draft entries to src/content/portfolio/.
 *   --map-suggest   Print a scripts/ib-symbol-map.json skeleton and exit.
 *   --map <json>    Symbol map (default scripts/ib-symbol-map.json).
 *   --prices <json> Price cache (default src/data/prices.json).
 *   --force         Emit entries even when verification failed.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

// --------------------------------------------------------------- csv reader
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); if (row.some((f) => f !== '')) rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

/**
 * An activity statement is many tables stacked in one file. Column 0 is the
 * section name and column 1 is the row kind; a section may restart with a new
 * Header row when the columns change (Trades does this between Stocks and
 * Forex), so the active header is tracked per section.
 */
function readStatement(path) {
  const rows = parseCsv(readFileSync(path, 'utf8'));
  const headers = new Map();
  const out = new Map();
  for (const r of rows) {
    const section = (r[0] ?? '').replace(/^﻿/, '').trim();
    const kind = (r[1] ?? '').trim();
    if (!section) continue;
    if (kind === 'Header') { headers.set(section, r.slice(2).map((h) => h.trim())); continue; }
    if (kind !== 'Data') continue; // skip SubTotal / Total / Notes
    const header = headers.get(section);
    if (!header) continue;
    const rec = Object.fromEntries(header.map((h, i) => [h, (r[i + 2] ?? '').trim()]));
    if (!out.has(section)) out.set(section, []);
    out.get(section).push(rec);
  }
  return out;
}

const num = (s) => {
  const v = Number(String(s ?? '').replace(/,/g, ''));
  return Number.isFinite(v) ? v : NaN;
};
const dateOf = (s) => String(s ?? '').trim().split(',')[0].trim(); // "2025-01-31, 05:33:05" -> date

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * `August 11, 2026` -> `2026-08-11`, without going through `new Date(string)`.
 * That parses to LOCAL midnight, and `toISOString()` then shifts it back a day
 * anywhere east of UTC — which dated every statement snapshot one day early.
 * Harmless until a trade lands in the gap, then it reads as a position
 * mismatch against the broker.
 */
function parseLongDate(s) {
  const m = String(s ?? '').trim().match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (!m) return null;
  const month = MONTH_NAMES.indexOf(m[1].toLowerCase());
  if (month < 0) return null;
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

// ------------------------------------------------------------- symbol map
/**
 * IB reports the local symbol of the venue you traded on. The same fund on
 * SIX, Xetra and NASDAQ has three different IB symbols and three different
 * Yahoo tickers, so guessing is how you end up charting the wrong instrument.
 * Suggestions are derived from the listing exchange and must be confirmed
 * against the ISIN before use.
 */
const EXCHANGE_SUFFIX = {
  NASDAQ: '', NYSE: '', ARCA: '', AMEX: '', BATS: '', PINK: '', VALUE: '',
  IBIS: '.DE', IBIS2: '.DE', GETTEX: '.DE', SWB: '.DE',
  LSE: '.L', LSEETF: '.L',
  EBS: '.SW', SWX: '.SW',
  AEB: '.AS', SBF: '.PA', BVME: '.MI', BM: '.MC',
};

function suggestYahoo(info) {
  const suffix = EXCHANGE_SUFFIX[info.exchange];
  if (suffix === undefined) return null;
  return `${info.symbol}${suffix}`;
}

function loadSymbolMap(path) {
  const p = path ? resolve(path) : join(HERE, 'ib-symbol-map.json');
  if (!existsSync(p)) return {};
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  delete raw._README;
  return raw;
}

// ------------------------------------------------------------------ prices
function loadPrices(path) {
  const p = path ? resolve(path) : join(REPO, 'src/data/prices.json');
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function asOfIndex(series, date) {
  let lo = 0, hi = series.dates.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.dates[mid] <= date) { idx = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return idx;
}

/**
 * Adjusted close in base currency. Yahoo quotes London listings in PENCE
 * (currency "GBp"), which is a factor-100 trap that would make a holding look
 * 99% smaller than it is; normalise it here.
 */
function levelInBase(prices, symbol, date, base) {
  const s = prices?.series?.[symbol];
  if (!s) return null;
  const i = asOfIndex(s, date);
  if (i < 0 || s.adjClose[i] == null) return null;
  let px = s.adjClose[i];
  let ccy = s.currency;
  if (ccy === 'GBp' || ccy === 'GBX') { px /= 100; ccy = 'GBP'; }
  if (ccy === base) return px;
  const direct = prices.series[`${ccy}${base}=X`];
  if (direct) {
    const j = asOfIndex(direct, date);
    if (j >= 0 && direct.adjClose[j] != null) return px * direct.adjClose[j];
  }
  const inverse = prices.series[`${base}${ccy}=X`];
  if (inverse) {
    const j = asOfIndex(inverse, date);
    if (j >= 0 && inverse.adjClose[j]) return px / inverse.adjClose[j];
  }
  return null;
}

// -------------------------------------------------------------------- main
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : null;
};
const files = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.match(/^--(map|prices)$/));

if (!files.length) {
  console.error('Usage: node scripts/import-ib.mjs private/U*.csv [--write] [--map-suggest]');
  process.exit(2);
}

// ---- read every statement ------------------------------------------------
const instruments = new Map(); // ibSymbol -> {symbol, description, isin, exchange, category}
const events = [];             // {date, symbol, dq, kind}

/**
 * Statements overlap: a year-to-date export re-reports every trade already in
 * the previous one. Executions are identified by their full row — IB stamps
 * Date/Time to the second, so two genuine fills are never identical — and a
 * repeat is dropped rather than counted twice.
 */
const seenRows = new Set();
const firstSighting = (section, rec) => {
  const key = `${section} ${JSON.stringify(rec)}`;
  if (seenRows.has(key)) return false;
  seenRows.add(key);
  return true;
};
let duplicateRows = 0;
const snapshots = [];          // {date, positions: Map<ibSymbol,{qty,currency,value}>}
let periods = [];            // {start, end, twr}
let baseCurrency = 'EUR';

for (const file of files) {
  if (!existsSync(file)) { console.error(`! missing: ${file}`); continue; }
  const st = readStatement(file);

  for (const r of st.get('Account Information') ?? []) {
    if (r['Field Name'] === 'Base Currency' && r['Field Value']) baseCurrency = r['Field Value'];
  }

  for (const r of st.get('Financial Instrument Information') ?? []) {
    const sym = r.Symbol;
    if (!sym) continue;
    instruments.set(sym, {
      symbol: sym,
      description: r.Description ?? '',
      isin: r['Security ID'] ?? '',
      exchange: r['Listing Exch'] ?? '',
      category: r['Asset Category'] ?? '',
    });
  }

  for (const r of st.get('Transfers') ?? []) {
    const sym = r.Symbol, qty = num(r.Qty);
    if (!sym || !Number.isFinite(qty) || qty === 0) continue;
    if (!firstSighting('Transfers', r)) { duplicateRows++; continue; }
    const sign = (r.Direction ?? 'In').toLowerCase() === 'out' ? -1 : 1;
    events.push({ date: r.Date, symbol: sym, dq: sign * Math.abs(qty), kind: 'transfer' });
  }

  for (const r of st.get('Trades') ?? []) {
    if ((r['Asset Category'] ?? '').startsWith('Forex')) continue; // FX is cash, not a position
    if (r.DataDiscriminator && r.DataDiscriminator !== 'Order') continue;
    const sym = r.Symbol, qty = num(r.Quantity);
    if (!sym || !Number.isFinite(qty) || qty === 0) continue;
    if (!firstSighting('Trades', r)) { duplicateRows++; continue; }
    events.push({ date: dateOf(r['Date/Time']), symbol: sym, dq: qty, kind: 'trade' });
  }

  const positions = new Map();
  for (const r of st.get('Open Positions') ?? []) {
    if (r.DataDiscriminator !== 'Summary') continue;
    const sym = r.Symbol, qty = num(r.Quantity), value = num(r.Value);
    if (!sym || !Number.isFinite(qty)) continue;
    positions.set(sym, { qty, currency: r.Currency ?? '', value });
  }

  // The statement period end is the snapshot date; take it from the last event
  // or the filename when the Statement section is not machine-friendly.
  const stmt = st.get('Statement') ?? [];
  const periodRow = stmt.find((r) => r['Field Name'] === 'Period');
  let start = null, end = null;
  if (periodRow) {
    const m = String(periodRow['Field Value']).match(
      /(\w+ \d+, \d{4})\s*-\s*(\w+ \d+, \d{4})/
    );
    if (m) { start = parseLongDate(m[1]); end = parseLongDate(m[2]); }
    else {
      const one = String(periodRow['Field Value']).match(/(\w+ \d+, \d{4})/);
      if (one) { start = end = parseLongDate(one[1]); }
    }
  }
  if (!end) {
    const m = file.match(/_(\d{8})_(\d{8})\.csv$/) || file.match(/_(\d{4})_(\d{4})\.csv$/);
    if (m && m[1].length === 8) { start = `${m[1].slice(0,4)}-${m[1].slice(4,6)}-${m[1].slice(6)}`; end = `${m[2].slice(0,4)}-${m[2].slice(4,6)}-${m[2].slice(6)}`; }
    else if (m) { start = `${m[1]}-01-01`; end = `${m[2]}-12-31`; }
  }
  if (positions.size && end) snapshots.push({ date: end, positions, file });

  // The TWR lives in its own one-column sub-table at the end of the NAV section.
  const navRows = st.get('Net Asset Value') ?? [];
  const twrRow = navRows.find((r) => r['Time Weighted Rate of Return']);
  const twr = twrRow ? num(String(twrRow['Time Weighted Rate of Return']).replace('%', '')) / 100 : null;
  if (end) periods.push({ start, end, twr, file: file.split('/').pop() });
}

events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === 'transfer' ? -1 : 1));
snapshots.sort((a, b) => (a.date < b.date ? -1 : 1));

/**
 * A year-to-date statement covers the same ground as the one before it, so
 * chaining both would compound the same months twice — 2026 counted once at
 * 20.8% and again at 19.6% turned a 52% record into 82%. Keep one period per
 * start date: the one that runs furthest.
 */
{
  const byStart = new Map();
  for (const p of periods) {
    const held = byStart.get(p.start);
    if (!held || p.end > held.end) byStart.set(p.start, p);
  }
  const superseded = periods.length - byStart.size;
  periods = [...byStart.values()];
  if (superseded > 0) {
    console.log(`Superseded statement period(s) ignored for the return chain: ${superseded}`);
  }
}
periods.sort((a, b) => (a.end < b.end ? -1 : 1));

/**
 * Brokers rename tickers (FAZEW became FAZEW.OLD after a corporate action) but
 * the ISIN is stable, so the ledger is keyed by ISIN. Keying by symbol would
 * split one holding into two and report a phantom mismatch against the
 * snapshot.
 */
const keyOf = (ibSymbol) => instruments.get(ibSymbol)?.isin || ibSymbol;
const aliasesOfKey = new Map(); // ISIN -> Set<ibSymbol>
for (const [sym] of instruments) {
  const k = keyOf(sym);
  if (!aliasesOfKey.has(k)) aliasesOfKey.set(k, new Set());
  aliasesOfKey.get(k).add(sym);
}
const labelOfKey = (key) => [...(aliasesOfKey.get(key) ?? [key])].sort()[0];

for (const e of events) e.key = keyOf(e.symbol);
for (const snap of snapshots) {
  const byKey = new Map();
  for (const [sym, pos] of snap.positions) {
    const k = keyOf(sym);
    const prev = byKey.get(k);
    byKey.set(k, prev ? { ...prev, qty: prev.qty + pos.qty, value: prev.value + pos.value } : pos);
  }
  snap.positions = byKey;
}

console.log(`Base currency: ${baseCurrency}`);
if (duplicateRows) console.log(`Overlapping statements: ${duplicateRows} repeated row(s) ignored.`);
console.log(`Instruments: ${instruments.size} (${aliasesOfKey.size} distinct by ISIN), events: ${events.length}, snapshots: ${snapshots.length}`);
console.log(`Track record starts: ${events[0]?.date ?? '—'} (first transfer or trade)`);

// ---- symbol map ----------------------------------------------------------
if (flags.has('--map-suggest')) {
  const out = {
    _README: [
      'Maps Interactive Brokers local symbols to Yahoo Finance tickers.',
      'Suggestions below are derived from the listing exchange and are NOT',
      'verified — confirm each against the ISIN before trusting it. Set a value',
      'to null to exclude an instrument from the book.',
    ],
  };
  for (const [sym, info] of [...instruments].sort()) {
    out[sym] = suggestYahoo(info);
  }
  console.log('\n' + JSON.stringify(out, null, 2));
  console.log('\n// reference:');
  for (const [sym, i] of [...instruments].sort()) {
    console.log(`//   ${sym.padEnd(12)} ${i.isin.padEnd(14)} ${i.exchange.padEnd(8)} ${i.category.padEnd(9)} ${i.description}`);
  }
  process.exit(0);
}

const symbolMap = loadSymbolMap(opt('map'));
const excluded = new Set();
const unmapped = new Set();

const yahooOf = (key) => {
  for (const alias of aliasesOfKey.get(key) ?? [key]) {
    if (alias in symbolMap) {
      const v = symbolMap[alias];
      if (v === null) { excluded.add(labelOfKey(key)); return null; }
      return v;
    }
  }
  unmapped.add(labelOfKey(key));
  return null;
};

// ---- reconstruct the quantity ledger ------------------------------------
const ledger = new Map(); // ibSymbol -> qty
const timeline = [];      // {date, before: Map, after: Map, touched: Set}
const problems = [];

const eventsByDate = new Map();
for (const e of events) {
  if (!eventsByDate.has(e.date)) eventsByDate.set(e.date, []);
  eventsByDate.get(e.date).push(e);
}

for (const date of [...eventsByDate.keys()].sort()) {
  const before = new Map(ledger);
  const touched = new Set();
  for (const e of eventsByDate.get(date)) {
    const cur = ledger.get(e.key) ?? 0;
    const next = cur + e.dq;
    if (next < -1e-9) problems.push(`${date}: ${labelOfKey(e.key)} would go to ${next} — history is incomplete.`);
    if (Math.abs(next) < 1e-9) ledger.delete(e.key); else ledger.set(e.key, next);
    touched.add(e.key);
  }
  timeline.push({ date, before, after: new Map(ledger), touched });
}

// ---- verify against every snapshot --------------------------------------
console.log('\nVerifying reconstruction against IB Open Positions snapshots:');
let verified = problems.length === 0;
for (const snap of snapshots) {
  // Replay to the snapshot date.
  const q = new Map();
  for (const date of [...eventsByDate.keys()].sort()) {
    if (date > snap.date) break;
    for (const e of eventsByDate.get(date)) {
      const next = (q.get(e.key) ?? 0) + e.dq;
      if (Math.abs(next) < 1e-9) q.delete(e.key); else q.set(e.key, next);
    }
  }
  const all = new Set([...q.keys(), ...snap.positions.keys()]);
  const bad = [];
  for (const key of all) {
    const got = q.get(key) ?? 0;
    const want = snap.positions.get(key)?.qty ?? 0;
    if (Math.abs(got - want) > 1e-6) bad.push(`${labelOfKey(key)}: reconstructed ${got}, IB says ${want}`);
  }
  if (bad.length) { verified = false; console.log(`  ${snap.date}  MISMATCH`); for (const b of bad) console.log(`      ${b}`); }
  else console.log(`  ${snap.date}  ok — ${all.size} positions agree`);
}
if (problems.length) { console.log('\n!! Ledger problems:'); for (const p of problems) console.log(`   ${p}`); }

// ---- IB's own return, as a check on ours --------------------------------
if (periods.length) {
  console.log("\nIB's reported time-weighted return (use this to validate the engine):");
  let cum = 1;
  for (const p of periods) {
    if (p.twr == null) continue;
    cum *= 1 + p.twr;
    console.log(`  ${p.start} .. ${p.end}   ${(p.twr * 100).toFixed(4).padStart(9)}%   (cumulative ${((cum - 1) * 100).toFixed(2)}%)`);
  }
  console.log(`  => since inception: ${((cum - 1) * 100).toFixed(2)}%`);
  console.log('  Note: IB includes cash and instruments this importer may exclude, so expect');
  console.log('  a small gap rather than an exact match.');
}

// ---- unmapped / excluded -------------------------------------------------
for (const ev of events) yahooOf(ev.key);
if (unmapped.size) {
  console.log('\n! Unmapped IB symbols — run with --map-suggest, then edit scripts/ib-symbol-map.json:');
  for (const s of [...unmapped].sort()) {
    const i = instruments.get(s);
    console.log(`    ${s.padEnd(12)} ${i?.isin?.padEnd(14) ?? ''} ${i?.exchange?.padEnd(8) ?? ''} ${i?.description ?? ''}`);
  }
}
if (excluded.size) console.log(`\nExcluded by the map (weights are taken over the rest): ${[...excluded].join(', ')}`);

// ---- weights -------------------------------------------------------------
const prices = loadPrices(opt('prices'));
if (!prices) {
  console.log('\n! No price cache at src/data/prices.json — run `npm run prices` first.');
  console.log('  Weights are computed from the price cache, so nothing can be emitted yet.');
  process.exit(verified ? 0 : 1);
}

const missing = new Set();
function weightsAt(qtyMap, date) {
  const vals = new Map();
  let total = 0;
  for (const [key, q] of qtyMap) {
    const y = yahooOf(key);
    if (!y) continue;
    const lvl = levelInBase(prices, y, date, baseCurrency);
    if (lvl == null) { missing.add(`${labelOfKey(key)} -> ${y}`); continue; }
    const v = q * lvl;
    vals.set(y, v);
    total += v;
  }
  if (total <= 0) return new Map();
  const w = new Map();
  for (const [y, v] of vals) w.set(y, v / total);
  return w;
}

const roundW = (w) => Math.round(w * 200) / 200;

const planned = [];
for (const step of timeline) {
  const before = weightsAt(step.before, step.date);
  const after = weightsAt(step.after, step.date);
  const legs = [...step.touched]
    .map((key) => yahooOf(key))
    .filter(Boolean)
    .map((y) => ({ ticker: y, before: roundW(before.get(y) ?? 0), after: roundW(after.get(y) ?? 0) }))
    .filter((l) => Math.abs(l.after - l.before) > 1e-9 || l.after > 0);
  if (!legs.length) continue;
  const up = legs.some((l) => l.after > l.before + 1e-9);
  const down = legs.some((l) => l.after < l.before - 1e-9);
  const kind = up && down ? 'rebalance'
    : legs.every((l) => l.after < 1e-9) ? 'exit'
    : legs.every((l) => l.before < 1e-9) ? 'open'
    : up ? 'add' : 'trim';
  planned.push({ date: step.date, kind, legs });
}

if (missing.size) {
  console.log(`\n! No price series for: ${[...missing].join(', ')}`);
  console.log('  Those holdings are dropped from the weight base, which skews every weight.');
  verified = false;
}

console.log(`\nWeight timeline (${planned.length} decisions):`);
for (const p of planned) {
  const legs = p.legs.map((l) => `${l.ticker} ${(l.before * 100).toFixed(1)}%→${(l.after * 100).toFixed(1)}%`).join(', ');
  console.log(`  ${p.date}  ${p.kind.padEnd(9)} ${legs}`);
}

// ---- emit ----------------------------------------------------------------
const VERBS = { open: 'Opening', add: 'Adding to', trim: 'Trimming', exit: 'Exiting', rebalance: 'Rebalancing' };
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

if (!flags.has('--write')) {
  console.log('\nDry run — nothing written. Re-run with --write to create draft entries.');
  process.exit(verified ? 0 : 1);
}
if (!verified && !flags.has('--force')) {
  console.log('\nRefusing to write: the reconstruction did not verify (see above).');
  console.log('Fix the inputs, or pass --force if you are sure the weights are right.');
  process.exit(1);
}

let written = 0;
for (const p of planned) {
  const tickers = p.legs.map((l) => l.ticker);
  const title = `${VERBS[p.kind]} ${tickers.join(', ')}`;
  const slug = slugify(`${title}-${p.date}`);
  const dir = join(REPO, 'src/content/portfolio', p.date.slice(0, 4));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${slug}.md`);
  if (existsSync(file)) { console.log(`  skip (exists) ${file}`); continue; }
  const legYaml = p.legs
    .map((l) => `  - ticker: ${l.ticker}\n    weight: ${l.after.toFixed(3)}   # was ${(l.before * 100).toFixed(1)}%`)
    .join('\n');
  writeFileSync(file, `---
slug: ${slug}
created: ${p.date}
title: ${title}
tags: []
is_draft: true
move: ${p.kind}
legs:
${legYaml}
---

<!-- DRAFT, imported from a broker statement. The weights are real; the
     reasoning is not written yet. Replace the text below, set is_draft: false,
     and delete this comment. -->

**Why:** _(what was the thesis? what would prove it wrong? why this size?)_

**What changed:** _(what made you act now rather than earlier or later?)_
`);
  written++;
  console.log(`  wrote ${file}`);
}
console.log(`\n${written} draft entr${written === 1 ? 'y' : 'ies'} written, all is_draft: true.`);
