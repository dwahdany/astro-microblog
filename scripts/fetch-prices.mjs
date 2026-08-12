#!/usr/bin/env node
/**
 * Build the daily total-return price cache the portfolio page runs on.
 *
 * Writes `src/data/prices.json`: dividend- and split-adjusted closes for every
 * ticker the decision log references, every configured benchmark, and whatever
 * FX pairs are needed to express them all in the base currency.
 *
 * Adjusted closes are used deliberately. The engine works in weights, so it
 * only ever needs *returns*, and an adjusted series already has distributions
 * folded in — no separate dividend bookkeeping, and no way to forget it.
 *
 * On rate limits: Yahoo throttles bursts hard. In CI this runs once a day
 * against ~10 symbols from a fresh IP and never notices, but running it
 * repeatedly from a laptop will earn a 429 within a handful of requests. Hence
 * one connection, one symbol at a time, a real pause between them, and long
 * backoff on 429 rather than more concurrency.
 *
 * Usage:
 *   node scripts/fetch-prices.mjs [--dry-run] [--only SYM,SYM] [--verbose]
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const OUT = join(REPO, 'src/data/prices.json');
const CONTENT = join(REPO, 'src/content/portfolio');
const CONFIG = join(REPO, 'src/data/portfolio.config.ts');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry-run');
const VERBOSE = argv.includes('--verbose');
const FORCE = argv.includes('--force');
const ONLY = (() => {
  const i = argv.indexOf('--only');
  return i >= 0 && argv[i + 1] ? new Set(argv[i + 1].split(',')) : null;
})();

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

const CASH = 'CASH';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Yahoo's throttle window is long; spacing requests out is the only thing
 *  that reliably avoids it. Overridable when you know the quota is fresh. */
const SYMBOL_GAP_MS = Number(process.env.PRICE_GAP_MS ?? 20_000);

// --------------------------------------------------------------- discovery
/** Pull `ticker:` values out of the log's frontmatter without a YAML parser. */
function tickersFromLog(dir) {
  const found = new Set();
  if (!existsSync(dir)) return found;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!name.endsWith('.md')) continue;
      const text = readFileSync(p, 'utf8');
      const fm = text.match(/^---\n([\s\S]*?)\n---/);
      if (!fm) continue;
      for (const m of fm[1].matchAll(/^\s*-?\s*ticker:\s*["']?([A-Za-z0-9.^=-]+)["']?\s*$/gm)) {
        if (m[1] !== CASH) found.add(m[1]);
      }
    }
  };
  walk(dir);
  return found;
}

/** Read the handful of config values we need without importing TypeScript. */
function readConfig() {
  const src = existsSync(CONFIG) ? readFileSync(CONFIG, 'utf8') : '';
  const body = src.slice(src.indexOf('export const portfolioConfig'));
  const base = body.match(/baseCurrency:\s*'([A-Z]{3})'/)?.[1] ?? 'EUR';
  const inception = body.match(/inception:\s*'(\d{4}-\d{2}-\d{2})'/)?.[1] ?? '2024-01-01';
  const benchmarks = [...body.matchAll(/\{\s*symbol:\s*'([^']+)',\s*label:\s*'([^']+)'/g)].map((m) => m[1]);
  return { baseCurrency: base, inception, benchmarks };
}

/** Symbols the importer maps to but that no log entry mentions yet. */
function tickersFromSymbolMap() {
  const p = join(HERE, 'ib-symbol-map.json');
  if (!existsSync(p)) return new Set();
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  delete raw._README;
  return new Set(Object.values(raw).filter((v) => typeof v === 'string'));
}

// ------------------------------------------------------------------- fetch
let cookie = '';

/** Yahoo hands out an A1/A3 cookie pair; requests carrying one are throttled
 *  noticeably less than anonymous ones. */
async function warmUp(needed) {
  // Only worth a request if Yahoo is actually going to be called. When every
  // symbol resolves through Nasdaq this would just stall on a host that is
  // currently refusing us.
  if (!needed) return;
  try {
    const res = await fetch('https://fc.yahoo.com/', {
      headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
      signal: AbortSignal.timeout(8000),
    });
    const jar = res.headers.getSetCookie?.() ?? [];
    cookie = jar.map((c) => c.split(';')[0]).join('; ');
    if (VERBOSE) console.log(`  session cookies: ${cookie ? cookie.slice(0, 60) + '…' : '(none)'}`);
  } catch {
    /* the chart endpoint works without one; carry on */
  }
}

/** query1 and query2 are throttled independently, so a 429 on one is usually
 *  served immediately by the other. Rotating beats backing off. */
const HOSTS = ['query2', 'query1'];

async function fetchChart(symbol, period1, period2, attempt = 0) {
  const host = HOSTS[attempt % HOSTS.length];
  const url =
    `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}` +
    `?period1=${period1}&period2=${period2}&interval=1d&events=div%2Csplit`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json,text/plain,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 429) { const e = new Error('rate limited'); e.rateLimited = true; throw e; }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  const err = json?.chart?.error;
  if (err) { const e = new Error(err.description || err.code); e.fatal = true; throw e; }
  return json.chart.result[0];
}

// ------------------------------------------------------------------ nasdaq
/**
 * Nasdaq's public quote API: keyless, unthrottled, and its closes reconcile to
 * the cent against the broker statements. It only covers US listings and serves
 * RAW closes, so European lines need a mapping and distributions are handled
 * separately. Preferred over Yahoo purely because Yahoo blocks us.
 */
function loadNasdaqMap() {
  const p = join(HERE, 'nasdaq-symbol-map.json');
  if (!existsSync(p)) return {};
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  delete raw._README;
  return raw;
}
const NASDAQ_MAP = loadNasdaqMap();

/** `$308.26` / `100.60` / `N/A` -> number | null */
function parseMoney(s) {
  const v = Number(String(s ?? '').replace(/[$,]/g, ''));
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** `08/10/2026` -> `2026-08-10` */
function parseUsDate(s) {
  const m = String(s ?? '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

async function fetchNasdaq(target, from, to) {
  const spec = NASDAQ_MAP[target];
  if (!spec) return null;
  // Without this the URL carries `assetclass=undefined`, which returns no rows
  // and quietly demotes the symbol to the Yahoo fallback — minutes of backoff
  // for what is really a one-line typo in the map.
  if (!spec.symbol || !spec.assetclass) {
    const e = new Error(`nasdaq-symbol-map.json: ${target} needs both "symbol" and "assetclass"`);
    e.fatal = true;
    throw e;
  }
  const url =
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(spec.symbol)}/historical` +
    `?assetclass=${spec.assetclass}&fromdate=${from}&todate=${to}&limit=9999`;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', Referer: 'https://www.nasdaq.com/' },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 429) { const e = new Error('rate limited'); e.rateLimited = true; throw e; }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = (await res.json())?.data?.tradesTable?.rows;
  if (!rows?.length) throw new Error('no rows');

  // Newest-first in the response; the cache is ascending.
  const points = [];
  for (const r of rows) {
    const d = parseUsDate(r.date);
    const c = parseMoney(r.close);
    if (d && c != null) points.push([d, c]);
  }
  points.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (!points.length) throw new Error('no parseable rows');

  return {
    symbol: target,
    // `note` is documentation for whoever maintains the mapping — it must never
    // reach this field, which is what the site prints next to the ticker.
    name: spec.name ?? spec.symbol,
    currency: 'USD',
    instrumentType: spec.assetclass === 'etf' ? 'ETF' : 'EQUITY',
    dates: points.map((p) => p[0]),
    adjClose: points.map((p) => round(p[1])),
  };
}

/**
 * A trading date is the exchange-local calendar day of the bar. Yahoo stamps
 * each bar with the session's *open* in UTC, so a European open (07:00Z) and a
 * US open (13:30Z) both land on the right day once the exchange's own UTC
 * offset is applied — but only if you shift before formatting, not after.
 */
function toLocalDate(epochSeconds, gmtoffset) {
  return new Date((epochSeconds + (gmtoffset ?? 0)) * 1000).toISOString().slice(0, 10);
}

function toSeries(symbol, result) {
  const meta = result.meta ?? {};
  const stamps = result.timestamp ?? [];
  const adj = result.indicators?.adjclose?.[0]?.adjclose;
  const close = result.indicators?.quote?.[0]?.close;
  const source = adj ?? close;
  if (!stamps.length || !source) return null;

  const dates = [];
  const adjClose = [];
  let lastDate = '';
  for (let i = 0; i < stamps.length; i++) {
    const v = source[i];
    if (v == null) continue; // a hole, not a zero — forward-fill happens downstream
    const d = toLocalDate(stamps[i], meta.gmtoffset);
    if (d === lastDate) { adjClose[adjClose.length - 1] = round(v); continue; } // keep the later bar
    dates.push(d);
    adjClose.push(round(v));
    lastDate = d;
  }
  return {
    symbol,
    name: meta.longName || meta.shortName || undefined,
    currency: meta.currency ?? 'USD',
    instrumentType: meta.instrumentType ?? undefined,
    dates,
    adjClose,
  };
}

/** Six significant figures keeps FX exact and the file small. */
function round(v) {
  return Number(v.toPrecision(8));
}

async function withRetry(symbol, fn) {
  // Try the other host once (free), then wait properly. Yahoo's throttle is a
  // sliding window, so retrying eagerly keeps you inside it — patience is what
  // actually clears a 429, not persistence.
  const delays = [0, 0, 30_000, 60_000, 120_000];
  let lastErr;
  for (let i = 0; i < delays.length; i++) {
    if (delays[i]) {
      process.stdout.write(` retry in ${delays[i] / 1000}s…`);
      await sleep(delays[i]);
    }
    try {
      return await fn(i);
    } catch (e) {
      lastErr = e;
      if (e.fatal) break; // unknown symbol — retrying will not help
      if (VERBOSE) process.stdout.write(` [${e.message}]`);
    }
  }
  throw lastErr;
}

// -------------------------------------------------------------------- main
const { baseCurrency, inception, benchmarks } = readConfig();

const wanted = new Set([...tickersFromLog(CONTENT), ...tickersFromSymbolMap(), ...benchmarks]);
if (ONLY) for (const s of [...wanted]) if (!ONLY.has(s)) wanted.delete(s);

const start = new Date(inception);
start.setUTCDate(start.getUTCDate() - 10); // slack so the first day has a prior close
const period1 = Math.floor(start.getTime() / 1000);
const from = start.toISOString().slice(0, 10);
const to = new Date().toISOString().slice(0, 10);
const period2 = Math.floor(Date.now() / 1000);

console.log(`Base currency : ${baseCurrency}`);
console.log(`Range         : ${start.toISOString().slice(0, 10)} .. today`);
console.log(`Instruments   : ${[...wanted].sort().join(', ') || '(none)'}`);

const SOURCE = 'Nasdaq (closes) and the ECB via Frankfurter (FX)';
const existing = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { series: {} };
// Seed from the cache so a partial run (--only, or one cut short by a throttle)
// merges into what is already there instead of replacing the whole file.
const series = { ...(existing.series ?? {}) };
const failed = [];

await warmUp([...wanted].some((s) => !NASDAQ_MAP[s]));

/** Persist after every symbol: a run that dies at symbol 8 must not throw away
 *  the first seven, which cost minutes of backoff to obtain. */
function persist() {
  if (DRY || !Object.keys(series).length) return;
  const sorted = {};
  for (const k of Object.keys(series).sort()) sorted[k] = series[k];
  writeFileSync(
    OUT,
    JSON.stringify(
      { fetchedAt: new Date().toISOString(), baseCurrency, source: SOURCE, series: sorted },
      null,
      0
    ) + '\n'
  );
}

/** Cached and recent enough to leave alone. Lets an interrupted run be resumed
 *  by simply running it again, which matters when the feed throttles you. */
function isFresh(symbol) {
  if (FORCE) return false;
  const s = existing.series?.[symbol];
  if (!s?.dates?.length) return false;
  const ageDays = (Date.now() - Date.parse(s.dates.at(-1))) / 86_400_000;
  return ageDays <= 4;
}

async function grab(symbol) {
  if (isFresh(symbol)) {
    const s = existing.series[symbol];
    series[symbol] = s;
    console.log(`  ${symbol.padEnd(12)} skip ${String(s.dates.length).padStart(4)} days cached to ${s.dates.at(-1)}`);
    return s;
  }
  process.stdout.write(`  ${symbol.padEnd(12)}`);
  try {
    let s = null;
    let via = 'yahoo';
    // Nasdaq first when it can serve the symbol: it is not rate-limiting us.
    if (NASDAQ_MAP[symbol]) {
      try {
        s = await fetchNasdaq(symbol, from, to);
        via = NASDAQ_MAP[symbol].fidelity === 'proxy' ? 'nasdaq~' : 'nasdaq';
      } catch (e) {
        if (VERBOSE) process.stdout.write(` [nasdaq: ${e.message}]`);
      }
    }
    if (!s) {
      const result = await withRetry(symbol, (attempt) => fetchChart(symbol, period1, period2, attempt));
      s = toSeries(symbol, result);
    }
    if (!s || !s.dates.length) throw new Error('empty series');
    series[symbol] = s;
    console.log(` ok  ${String(s.dates.length).padStart(4)} days  ${s.currency.padEnd(4)} ${via.padEnd(7)} ${s.dates[0]}..${s.dates.at(-1)}`);
    persist();
    return s;
  } catch (e) {
    const kept = existing.series?.[symbol];
    if (kept) {
      series[symbol] = kept;
      console.log(` FAILED (${e.message}) — keeping ${kept.dates.length} cached days`);
    } else {
      console.log(` FAILED (${e.message}) — no cached data`);
    }
    failed.push(symbol);
    return kept ?? null;
  }
}

console.log('\nInstruments:');
const quoteCurrencies = new Set();
for (const symbol of [...wanted].sort()) {
  const s = await grab(symbol);
  if (s) {
    // Yahoo quotes London listings in pence; the engine normalises, but the FX
    // pair it needs is still GBP.
    const ccy = s.currency === 'GBp' || s.currency === 'GBX' ? 'GBP' : s.currency;
    if (ccy !== baseCurrency) quoteCurrencies.add(ccy);
  }
  if (!NASDAQ_MAP[symbol]) await sleep(SYMBOL_GAP_MS); // only Yahoo needs the pause: bursts get this IP throttled for minutes
}

/**
 * FX comes from Frankfurter (ECB reference rates) rather than the price feed:
 * one keyless request covers every currency over the whole period, it is the
 * canonical source a European investor is marked against anyway, and it keeps
 * the flakiest part of the job off the rate-limited endpoint.
 *
 * ECB publishes base-per-EUR, so `EURUSD` is USD per 1 EUR. The engine wants
 * `USDEUR=X` (EUR per 1 USD), hence the reciprocal.
 */
async function fetchFx(currencies, from, to) {
  if (!currencies.length) return;
  const url = `https://api.frankfurter.dev/v1/${from}..${to}?base=${baseCurrency}&symbols=${currencies.join(',')}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`frankfurter HTTP ${res.status}`);
  const { rates } = await res.json();
  const dates = Object.keys(rates).sort();
  for (const ccy of currencies) {
    const symbol = `${ccy}${baseCurrency}=X`;
    const d = [], v = [];
    for (const day of dates) {
      const rate = rates[day]?.[ccy];
      if (rate) { d.push(day); v.push(round(1 / rate)); } // base per unit of ccy
    }
    if (!d.length) { failed.push(symbol); console.log(`  ${symbol.padEnd(12)} FAILED (no rates)`); continue; }
    series[symbol] = {
      symbol, name: `${ccy}/${baseCurrency} (ECB)`, currency: baseCurrency,
      instrumentType: 'CURRENCY', dates: d, adjClose: v,
    };
    console.log(`  ${symbol.padEnd(12)} ok  ${String(d.length).padStart(4)} days  ECB  ${d[0]}..${d.at(-1)}`);
  }
  persist();
}

const fxWanted = [...quoteCurrencies];
if (fxWanted.length) {
  console.log('\nFX (ECB via Frankfurter):');
  try {
    await fetchFx(fxWanted.sort(), from, to);
  } catch (e) {
    console.log(`  FAILED (${e.message})`);
    for (const c of fxWanted) failed.push(`${c}${baseCurrency}=X`);
  }
}

// Deterministic key order keeps the daily commit diff to the appended rows.
const sorted = {};
for (const k of Object.keys(series).sort()) sorted[k] = series[k];

const payload = { fetchedAt: new Date().toISOString(), baseCurrency, source: SOURCE, series: sorted };

console.log('\nSummary:');
for (const [k, v] of Object.entries(sorted)) {
  console.log(`  ${k.padEnd(12)} ${String(v.dates.length).padStart(4)} days  ${v.currency}`);
}
if (failed.length) console.log(`\n! failed: ${failed.join(', ')}`);

if (DRY) {
  console.log('\nDry run — not writing.');
  process.exit(failed.length === wanted.size + fxWanted.length ? 1 : 0);
}
if (!Object.keys(sorted).length) {
  console.error('\nNothing fetched and nothing cached — refusing to write an empty cache.');
  process.exit(1);
}

writeFileSync(OUT, JSON.stringify(payload, null, 0) + '\n');
console.log(`\nWrote ${OUT} (${(statSync(OUT).size / 1024).toFixed(0)} KB)`);
process.exit(failed.length ? 1 : 0);
