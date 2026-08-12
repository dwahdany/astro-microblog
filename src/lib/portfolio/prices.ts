/**
 * Price lookup over the on-disk cache (`src/data/prices.json`).
 *
 * Everything the engine needs from market data goes through here: a trading-day
 * calendar, forward-fill, currency conversion into the base currency, and the
 * total return between two arbitrary dates.
 *
 * Three things this file exists to get right:
 *
 *  1. **Adjusted closes are levels, not prices.** They are only defined up to a
 *     scale factor, so only *ratios* between two dates are ever exposed.
 *  2. **London listings are quoted in pence.** Yahoo reports the currency of a
 *     `.L` listing as `GBp` (sometimes `GBX`) and the close as pence. Applying
 *     a GBP→EUR rate to a pence figure makes the holding read ~99% too small,
 *     so pence are divided by 100 and treated as GBP before any FX is applied.
 *  3. **FX comes in two orientations.** The cache may hold `USDEUR=X` (base per
 *     unit of the quote currency) or only the inverse `EURUSD=X`. Both are
 *     accepted; the inverse is reciprocated. Neither present means the symbol
 *     cannot be expressed in the base currency at all, which the engine turns
 *     into a warning rather than a silent `X = 1`.
 *
 * All lookups are forward-filled: the value on a date is the value of the last
 * genuine observation on or before it, and `null` before the first one. Index
 * maps are built once in the constructor so a lookup is a hash hit plus a
 * binary search over a sorted date array.
 */

import type {
  CurrencyCode,
  IsoDate,
  PriceData,
  PriceLookup,
  PriceSeries,
} from './types.ts';

/** Yahoo's pence-denominated currency codes for London listings. */
// `GBp`/`GBX` are pence; plain `GBP` is pounds, so the check is case-sensitive
// on the first three letters and only lenient about the pence marker itself.
const PENCE_CODES = new Set(['GBp', 'GBX', 'GBx']);

/** Symbols matching this are FX pairs, not instruments. */
const FX_SYMBOL = /=X$/;

/**
 * The lookup the engine actually consumes. `PriceLookup` (the shared contract
 * in `types.ts`) is the read-only core; these extras expose the provenance
 * fields and the *genuine* observation dates, which the return engine needs to
 * build its day grid and to join a benchmark's calendar to the portfolio's.
 */
export interface PortfolioPrices extends PriceLookup {
  readonly fetchedAt: string;
  readonly source: string;
  readonly baseCurrency: CurrencyCode;
  /** Every symbol in the cache, including benchmarks and FX pairs. */
  readonly symbols: string[];
  has(symbol: string): boolean;
  /** Genuine observation dates for `symbol`, ascending. Never mutate. */
  observations(symbol: string): readonly IsoDate[];
  /** Last genuine observation, ignoring forward-fill. */
  lastObservation(symbol: string): IsoDate | null;
  /** Quote currency after pence normalisation (`GBp` reads back as `GBP`). */
  currencyOf(symbol: string): CurrencyCode | null;
  /** Whether this currency can be converted to the base currency. */
  hasFx(currency: CurrencyCode): boolean;
}

interface NormalisedSeries {
  symbol: string;
  name?: string;
  instrumentType?: string;
  /** Post-pence-normalisation quote currency. */
  currency: CurrencyCode;
  dates: IsoDate[];
  /** Adjusted close in `currency` (pence already divided out). */
  level: number[];
  /** date -> position, for O(1) exact-date hits. */
  index: Map<IsoDate, number>;
}

interface FxSeries {
  dates: IsoDate[];
  /** Units of base currency per 1 unit of the quote currency. */
  rate: number[];
}

/** Greatest index whose date is <= `date`, or -1. Dates sort lexicographically. */
function lastAtOrBefore(dates: readonly IsoDate[], date: IsoDate): number {
  let lo = 0;
  let hi = dates.length - 1;
  let out = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= date) {
      out = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return out;
}

/** Smallest index whose date is >= `date`, or -1. */
function firstAtOrAfter(dates: readonly IsoDate[], date: IsoDate): number {
  let lo = 0;
  let hi = dates.length - 1;
  let out = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] >= date) {
      out = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return out;
}

/** Pence -> pounds. Returns the scale to apply and the currency to report. */
function normaliseCurrency(currency: CurrencyCode): { currency: CurrencyCode; scale: number } {
  if (PENCE_CODES.has(currency)) {
    return { currency: 'GBP', scale: 0.01 };
  }
  return { currency, scale: 1 };
}

function normaliseSeries(raw: PriceSeries): NormalisedSeries {
  const { currency, scale } = normaliseCurrency(raw.currency ?? 'USD');
  const n = Math.min(raw.dates?.length ?? 0, raw.adjClose?.length ?? 0);
  const dates: IsoDate[] = [];
  const level: number[] = [];
  const index = new Map<IsoDate, number>();
  for (let i = 0; i < n; i++) {
    const v = raw.adjClose[i];
    if (v == null || !Number.isFinite(v)) continue; // a hole, not a zero
    const d = raw.dates[i];
    if (index.has(d)) {
      level[index.get(d)!] = v * scale; // duplicate stamp: the later bar wins
      continue;
    }
    index.set(d, dates.length);
    dates.push(d);
    level.push(v * scale);
  }
  return {
    symbol: raw.symbol,
    name: raw.name,
    instrumentType: raw.instrumentType,
    currency,
    dates,
    level,
    index,
  };
}

const EMPTY_DATES: readonly IsoDate[] = Object.freeze([]);

/**
 * Build a lookup over a price cache. Tolerates a missing/empty cache: every
 * accessor then returns null or an empty list, so the page still renders.
 */
export function createPrices(
  data: PriceData | null | undefined,
  baseCurrencyOverride?: CurrencyCode
): PortfolioPrices {
  const baseCurrency = baseCurrencyOverride ?? data?.baseCurrency ?? 'EUR';

  const series = new Map<string, NormalisedSeries>();
  for (const [symbol, raw] of Object.entries(data?.series ?? {})) {
    if (!raw) continue;
    series.set(symbol, normaliseSeries({ ...raw, symbol: raw.symbol ?? symbol }));
  }

  // --- FX, resolved once per currency ------------------------------------
  const identity: FxSeries = { dates: [], rate: [] };
  const fxCache = new Map<CurrencyCode, FxSeries | null>();
  fxCache.set(baseCurrency, identity);

  function fxFor(currency: CurrencyCode): FxSeries | null {
    const hit = fxCache.get(currency);
    if (hit !== undefined) return hit;
    let out: FxSeries | null = null;
    const direct = series.get(`${currency}${baseCurrency}=X`);
    if (direct && direct.dates.length) {
      out = { dates: direct.dates, rate: direct.level };
    } else {
      const inverse = series.get(`${baseCurrency}${currency}=X`);
      if (inverse && inverse.dates.length) {
        // Cache holds base->quote; we need quote->base, so reciprocate.
        out = { dates: inverse.dates, rate: inverse.level.map((v) => (v ? 1 / v : NaN)) };
      }
    }
    fxCache.set(currency, out);
    return out;
  }

  // --- calendars ----------------------------------------------------------
  // The generic trading-day calendar is the union of every *instrument*
  // calendar; FX is forward-filled onto other symbols' days and never adds one.
  const allDaysSet = new Set<IsoDate>();
  let lastDate = '';
  let lastAnyDate = '';
  for (const s of series.values()) {
    if (!s.dates.length) continue;
    const end = s.dates[s.dates.length - 1];
    if (end > lastAnyDate) lastAnyDate = end;
    // FX is forward-filled onto other symbols' days and never adds one — an
    // `=X` pair quoting on a Sunday must not drag the whole horizon to Sunday.
    if (FX_SYMBOL.test(s.symbol)) continue;
    if (end > lastDate) lastDate = end;
    for (const d of s.dates) allDaysSet.add(d);
  }
  if (!lastDate) lastDate = lastAnyDate;
  const allDays = [...allDaysSet].sort();

  function levelInQuote(s: NormalisedSeries, date: IsoDate): number | null {
    const exact = s.index.get(date);
    if (exact !== undefined) return s.level[exact];
    const i = lastAtOrBefore(s.dates, date); // forward-fill
    return i < 0 ? null : s.level[i];
  }

  function levelInBase(symbol: string, date: IsoDate): number | null {
    const s = series.get(symbol);
    if (!s) return null;
    const px = levelInQuote(s, date);
    if (px == null) return null;
    if (s.currency === baseCurrency) return px;
    const fx = fxFor(s.currency);
    if (!fx) return null;
    if (fx === identity) return px;
    const j = lastAtOrBefore(fx.dates, date);
    if (j < 0) return null;
    const rate = fx.rate[j];
    return Number.isFinite(rate) ? px * rate : null;
  }

  return {
    fetchedAt: data?.fetchedAt ?? '',
    source: data?.source ?? '',
    baseCurrency,
    lastDate,
    symbols: [...series.keys()],

    has(symbol) {
      return series.has(symbol);
    },

    tradingDays(from, to) {
      const end = to ?? lastDate;
      const a = firstAtOrAfter(allDays, from);
      if (a < 0) return [];
      const out: IsoDate[] = [];
      for (let i = a; i < allDays.length && allDays[i] <= end; i++) out.push(allDays[i]);
      return out;
    },

    observations(symbol) {
      return series.get(symbol)?.dates ?? EMPTY_DATES;
    },

    lastObservation(symbol) {
      const s = series.get(symbol);
      return s && s.dates.length ? s.dates[s.dates.length - 1] : null;
    },

    firstDate(symbol) {
      const s = series.get(symbol);
      return s && s.dates.length ? s.dates[0] : null;
    },

    currencyOf(symbol) {
      return series.get(symbol)?.currency ?? null;
    },

    hasFx(currency) {
      return currency === baseCurrency || fxFor(currency) != null;
    },

    levelInBase,

    /**
     * Joint return of price and currency — the ratio of two base-currency
     * levels, never the sum of a price return and an FX return (that drops the
     * cross term, which is worth basis points a day).
     */
    returnBetween(symbol, from, to) {
      const a = levelInBase(symbol, from);
      const b = levelInBase(symbol, to);
      if (a == null || b == null || a === 0) return null;
      return b / a - 1;
    },

    meta(symbol) {
      const s = series.get(symbol);
      if (!s) return null;
      // `currency` is the normalised one: levels handed out for a `.L` listing
      // are GBP, not pence, so reporting `GBp` here would mislabel them.
      return { name: s.name, currency: s.currency, instrumentType: s.instrumentType };
    },
  };
}
