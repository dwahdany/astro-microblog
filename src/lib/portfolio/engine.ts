/**
 * The return engine: a decision log plus a price cache in, a `PortfolioSnapshot`
 * out. Pure — no I/O, no clock at module scope, `asOf` is an argument.
 *
 * THE MODEL IN ONE PARAGRAPH
 * -------------------------
 * State is a weight vector over tickers plus the pseudo-ticker `CASH`, summing
 * to 1. Each day the weights *drift* with prices and are renormalised; on a
 * decision date they snap to the weights the author declared. The index
 * compounds the portfolio's daily return, `I(inception) = 100`. Nothing in the
 * engine is denominated in money — it cannot be, because no quantity ever
 * enters it. Time-weighted return is scale-invariant, so the track record this
 * produces is the real one, not an approximation.
 *
 * TWO THINGS THAT ARE EASY TO GET WRONG AND ARE LOAD-BEARING
 * ----------------------------------------------------------
 *  - Drift renormalises by the *gross* return; the index compounds the *net*
 *    return. Dividing weights by (1 + net) would break `Σw = 1`. Economically:
 *    costs are paid pro-rata out of the whole book and leave weights alone.
 *  - An instrument's daily return is the *ratio* of two base-currency levels,
 *    `(A·X)_t / (A·X)_t⁻ − 1`, never `r_price + r_fx` — that drops the cross
 *    term, which is worth basis points on any day the currency moves.
 *
 * Contributions are the naive daily decomposition scaled by the index level the
 * day's return compounded on: `Σ_t w_i(t⁻)·r_i(t)·I(t⁻)/100`. Because
 * `I(t) − I(t⁻) = I(t⁻)·r_p(t)`, the sum telescopes to exactly `I(asOf)/100 − 1`
 * — no Cariño smoothing, no residual bucket. `CASH` and `costs` are buckets in
 * their own right; without them the column does not add up.
 */

import { CASH } from './types.ts';
import type {
  BenchmarkComparison,
  ChartMarker,
  ClosedPosition,
  DecisionOutcome,
  DrawdownWindow,
  IndexSeries,
  IsoDate,
  Leg,
  LogEntry,
  MoveKind,
  Position,
  PortfolioSnapshot,
  PortfolioStats,
  PriceLookup,
  SeriesPoint,
  WindowReturns,
} from './types.ts';
import type { PortfolioPrices } from './prices.ts';
import type { PortfolioConfig } from '../../data/portfolio.config.ts';

/** Pinned so tests can assert against them rather than re-typing magic numbers. */
export const ENGINE_CONSTANTS = Object.freeze({
  /** Resolved weight below this is zero: the position is closed. */
  WEIGHT_EPS: 1e-9,
  /** Tolerance on the `Σw = 1` invariant. */
  SUM_TOL: 1e-9,
  /** Grid days of carried-forward price on a held ticker before warning. */
  STALE_MAX_DAYS: 10,
  /** ACT/365-fixed for the CASH accrual. */
  DAYCOUNT_CASH: 365,
  /** Calendar-time annualisation; 365.25 averages the leap cycle. */
  DAYCOUNT_CAGR: 365.25,
  MIN_ANNUALISE_DAYS: 60,
  MIN_RISK_DAYS: 20,
  MIN_BETA_PAIRS: 30,
  A_MIN: 180,
  A_MAX: 366,
  IDENTITY_TOL: 1e-9,
  DD_RECOVERY_TOL: 1e-12,
});

const K = ENGINE_CONSTANTS;
const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Small date + array helpers. ISO dates sort lexicographically, which is why
// plain string comparison is used for ordering throughout.
// ---------------------------------------------------------------------------

function toMs(d: IsoDate): number {
  return Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
}

function fromMs(ms: number): IsoDate {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole UTC calendar days from `a` to `b`. Negative if `b` precedes `a`. */
function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((toMs(b) - toMs(a)) / DAY_MS);
}

/** Calendar-month arithmetic, clamping day-of-month overflow (31 Mar − 1M = 28/29 Feb). */
function addMonths(d: IsoDate, months: number): IsoDate {
  const y = +d.slice(0, 4);
  const m = +d.slice(5, 7) - 1;
  const day = +d.slice(8, 10);
  const target = new Date(Date.UTC(y, m + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return fromMs(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), Math.min(day, last)));
}

/** Accepts the `Date` a content collection yields as readily as an ISO string. */
function asIso(v: unknown): IsoDate | null {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'string') {
    const s = v.slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }
  return null;
}

/** Greatest index whose date is <= `date`, or -1. */
function lastAtOrBefore(dates: readonly IsoDate[], date: IsoDate): number {
  let lo = 0;
  let hi = dates.length - 1;
  let out = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid] <= date) {
      out = mid;
      lo = mid + 1;
    } else hi = mid - 1;
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
    } else lo = mid + 1;
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Pure estimators. Exported so the worked test vectors can exercise them below
// the sample-size gates that production applies.
// ---------------------------------------------------------------------------

export interface RiskMetrics {
  n: number;
  /** Mean of log returns. */
  meanLog: number;
  /** Sample (N−1) stdev of log returns. */
  sdLog: number;
  volatility: number | null;
  sharpe: number | null;
  hitRate: number | null;
}

/**
 * Volatility, Sharpe and hit rate from a sample of arithmetic daily returns.
 *
 * Log returns for the risk figures because they are additive over time, which
 * is exactly the assumption `sqrt(A)` scaling makes; Bessel's N−1 because this
 * is a sample. The risk-free rate is de-annualised as `ln(1+rf)/A` — the only
 * de-annualisation that compounds back to `rf` over `A` days in log space,
 * which is the space the numerator lives in.
 */
export function riskMetrics(returns: readonly number[], annualisation: number, riskFreeRate: number): RiskMetrics {
  const n = returns.length;
  if (n === 0) return { n, meanLog: 0, sdLog: 0, volatility: null, sharpe: null, hitRate: null };

  const logs: number[] = [];
  for (const r of returns) logs.push(Math.log(Math.max(1 + r, 1e-12)));
  const meanLog = logs.reduce((a, b) => a + b, 0) / n;

  let ss = 0;
  for (const l of logs) ss += (l - meanLog) * (l - meanLog);
  const variance = n > 1 ? ss / (n - 1) : 0;
  const sdLog = Math.sqrt(variance);

  const volatility = n > 1 ? sdLog * Math.sqrt(annualisation) : null;
  const rfDailyLog = Math.log(1 + riskFreeRate) / annualisation;
  const sharpe =
    n > 1 && variance > 0 ? ((meanLog - rfDailyLog) * Math.sqrt(annualisation)) / sdLog : null;

  let wins = 0;
  for (const r of returns) if (r > 0) wins++; // exact zeros sit in the denominator: flat is not a win

  return { n, meanLog, sdLog, volatility, sharpe, hitRate: wins / n };
}

export interface RegressionPair {
  rp: number;
  rb: number;
}

export interface RegressionStats {
  n: number;
  beta: number | null;
  alpha: number | null;
  correlation: number | null;
  /** The sample's own empirical annualisation factor. */
  annualisation: number;
}

/**
 * Beta, correlation and annualised Jensen's alpha over already-matched pairs.
 * Arithmetic returns here: CAPM is a linear model in arithmetic excess returns,
 * and mixing log returns in biases beta.
 */
export function regressionStats(
  pairs: readonly RegressionPair[],
  riskFreeRate: number,
  spanDays: number
): RegressionStats {
  const n = pairs.length;
  // The sample runs on the benchmark's calendar, which may be sparser than the
  // portfolio grid, so it gets its own annualisation factor.
  const raw = spanDays > 0 ? Math.round(n / (spanDays / K.DAYCOUNT_CAGR)) : K.A_MAX;
  const annualisation = clamp(raw, K.A_MIN, K.A_MAX);
  if (n < 2) return { n, beta: null, alpha: null, correlation: null, annualisation };

  let mp = 0;
  let mb = 0;
  for (const p of pairs) {
    mp += p.rp;
    mb += p.rb;
  }
  mp /= n;
  mb /= n;

  let cov = 0;
  let varb = 0;
  let varp = 0;
  for (const p of pairs) {
    cov += (p.rp - mp) * (p.rb - mb);
    varb += (p.rb - mb) * (p.rb - mb);
    varp += (p.rp - mp) * (p.rp - mp);
  }
  cov /= n - 1;
  varb /= n - 1;
  varp /= n - 1;

  if (varb <= 0 || varp <= 0) return { n, beta: null, alpha: null, correlation: null, annualisation };

  const beta = cov / varb; // the risk-free rate is constant, so it cancels here
  const correlation = cov / (Math.sqrt(varp) * Math.sqrt(varb));
  const rfDaily = Math.pow(1 + riskFreeRate, 1 / annualisation) - 1;
  const alphaDaily = mp - rfDaily - beta * (mb - rfDaily);
  const alpha = Math.pow(1 + alphaDaily, annualisation) - 1;
  return { n, beta, alpha, correlation, annualisation };
}

/**
 * Match a benchmark's calendar to the portfolio's by compounding the portfolio
 * index across each of the benchmark's *own* observation intervals.
 *
 * The alternatives all lie: zipping by array index pairs unrelated dates the
 * moment the calendars differ in length, and intersecting on forward-filled
 * benchmark days injects `r_b = 0` on days the benchmark's exchange was shut
 * while the book moved, dragging beta and correlation toward zero.
 */
export function buildRegressionPairs(
  obs: readonly IsoDate[],
  grid: readonly IsoDate[],
  indexAt: (d: IsoDate) => number | null,
  levelAt: (d: IsoDate) => number | null,
  inception: IsoDate,
  asOf: IsoDate
): { tBase: IsoDate | null; late: boolean; pairs: RegressionPair[]; spanDays: number } {
  if (!obs.length || !grid.length) return { tBase: null, late: false, pairs: [], spanDays: 0 };

  const bi = lastAtOrBefore(obs, inception);
  const late = bi < 0;
  const tBase = late ? obs[0] : obs[bi];

  const window: IsoDate[] = [tBase];
  for (const d of obs) if (d > tBase && d <= asOf) window.push(d);

  const pairs: RegressionPair[] = [];
  for (let k = 1; k < window.length; k++) {
    const a = window[k - 1];
    const b = window[k];
    const ga = lastAtOrBefore(grid, a);
    const gb = lastAtOrBefore(grid, b);
    if (ga < 0 || gb < 0 || ga === gb) continue; // no portfolio observation inside the window
    const ia = indexAt(a);
    const ib = indexAt(b);
    const la = levelAt(a);
    const lb = levelAt(b);
    if (ia == null || ib == null || la == null || lb == null || ia === 0 || la === 0) continue;
    pairs.push({ rp: ib / ia - 1, rb: lb / la - 1 });
  }

  const spanDays = window.length > 1 ? daysBetween(window[0], window[window.length - 1]) : 0;
  return { tBase, late, pairs, spanDays };
}

/**
 * Deepest peak-to-trough excursion of an index series. `>=` on the peak test so
 * a flat retest re-dates the peak; `recovered` stays null while under water.
 */
export function maxDrawdown(dates: readonly IsoDate[], values: readonly number[]): DrawdownWindow | null {
  if (!dates.length) return null;
  let peak = values[0];
  let peakDate = dates[0];
  let best = 0;
  let out: DrawdownWindow | null = null;
  for (let i = 0; i < dates.length; i++) {
    const v = values[i];
    if (v >= peak) {
      peak = v;
      peakDate = dates[i];
    }
    const dd = v / peak - 1;
    if (dd < best) {
      best = dd;
      out = { peak: peakDate, trough: dates[i], depth: dd, recovered: null };
    }
  }
  if (!out || best >= 0) return null;
  const peakValue = values[dates.indexOf(out.peak)];
  for (let i = dates.indexOf(out.trough) + 1; i < dates.length; i++) {
    if (values[i] >= peakValue * (1 - K.DD_RECOVERY_TOL)) {
      out.recovered = dates[i];
      break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

/** What the engine needs of a price source: the shared contract plus extras. */
export type EnginePrices = PriceLookup & Partial<PortfolioPrices>;

/**
 * The attribution buckets `positions[]` cannot hold. They are fractions of the
 * index, exactly like `Position.contribution`, and the five numbers close:
 * `live + exited + cash + costs + residual === twr`.
 */
export interface AttributionTotals {
  live: number;
  exited: number;
  cash: number;
  costs: number;
  residual: number;
}

/** `PortfolioSnapshot` plus the attribution buckets. Additive, so any consumer
 *  typed against the shared contract still type-checks. */
export interface PortfolioResult extends PortfolioSnapshot {
  attribution: AttributionTotals;
}

export interface BuildPortfolioInput {
  entries: LogEntry[];
  prices: EnginePrices;
  config: PortfolioConfig;
  /** Defaults to `min(prices.lastDate, today)`. Never runs past the data. */
  asOf?: IsoDate;
}

interface NormLeg {
  leg: Leg;
  ticker: string;
  declared: IsoDate;
  eff: IsoDate;
}

interface DecisionEvent {
  slug: string;
  entry: LogEntry;
  date: IsoDate;
  costBps: number;
  legs: NormLeg[];
}

interface Episode {
  ticker: string;
  openedAt: IsoDate;
  closedAt: IsoDate | null;
  contribution: number;
  /** Oldest first while building; reversed on output. */
  slugs: string[];
  weightAtLastDecision: number;
  lastDecisionAt: IsoDate;
}

interface OutcomeLeg {
  ticker: string;
  name: string;
  direction: 'up' | 'down' | 'flat';
  weightBefore: number;
  weightAfter: number;
  eventDate: IsoDate;
}

interface OutcomeDraft {
  entry: LogEntry;
  date: IsoDate;
  legs: Map<string, OutcomeLeg>;
  isDoubleDown: boolean;
}

export function buildPortfolio(input: BuildPortfolioInput): PortfolioResult {
  const { entries, prices, config } = input;
  const warnings: string[] = [];
  const seen = new Set<string>();
  const warn = (code: string, message: string, dedupeKey?: string): void => {
    const key = dedupeKey ?? `${code}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    warnings.push(`${code}: ${message}`);
  };

  const baseCurrency = config.baseCurrency;
  let riskFreeRate = config.riskFreeRate ?? 0;
  if (!(riskFreeRate > -1)) {
    warn('W-BAD-RF', `riskFreeRate ${riskFreeRate} is not usable; CASH accrues 0%`);
    riskFreeRate = 0;
  }
  if (config.demo) warn('W-DEMO', 'rendering the bundled example book');

  const observationsOf = (symbol: string): readonly IsoDate[] =>
    prices.observations ? prices.observations(symbol) : prices.tradingDays('0000-01-01');
  const hasSeries = (symbol: string): boolean =>
    prices.has ? prices.has(symbol) : prices.firstDate(symbol) != null;

  // --- horizon -------------------------------------------------------------
  const today = fromMs(Date.now());
  const lastPriced = prices.lastDate || null;
  let asOf = asIso(input.asOf) ?? (lastPriced && lastPriced < today ? lastPriced : today);
  if (lastPriced && asOf > lastPriced) asOf = lastPriced; // never run past the data

  const declaredDates: IsoDate[] = [];
  for (const e of entries) {
    for (const leg of e.legs ?? []) {
      const d = asIso(leg.date) ?? asIso(e.created);
      if (d) declaredDates.push(d);
    }
  }
  declaredDates.sort();
  const inception = asIso(config.inception) ?? declaredDates[0] ?? asOf;
  if (asOf < inception) asOf = inception;

  if (lastPriced && daysBetween(lastPriced, today) > 5) {
    warn('W-STALE-CACHE', `price cache last updated ${prices.fetchedAt || lastPriced}`);
  }

  // --- 1. normalise legs ---------------------------------------------------
  const dropped = new Set<string>(); // tickers excluded across the whole log
  const instrumentLegs: Array<{ entry: LogEntry; norm: NormLeg }> = [];
  const cashLegs: Array<{ entry: LogEntry; leg: Leg; declared: IsoDate }> = [];
  const heldTickers = new Set<string>();

  for (const entry of entries) {
    const legs = entry.legs ?? [];
    if (!legs.length && entry.move !== 'note') {
      warn('W-NO-LEGS', `${entry.slug} has no legs; treated as a note`);
    }
    for (const leg of legs) {
      const declared = asIso(leg.date) ?? asIso(entry.created);
      if (!declared) continue;
      const ticker = leg.ticker;

      if (declared < inception) {
        warn(
          'W-PRE-INCEPTION',
          `${entry.slug}: leg ${ticker} dated ${declared} is before inception ${inception}`
        );
        continue;
      }

      if (ticker === CASH) {
        if (leg.portion != null || leg.scale != null) {
          warn('W-CASH-SIZE', `${entry.slug}: CASH must be sized with weight, not portion/scale`);
        }
        cashLegs.push({ entry, leg, declared });
        continue;
      }

      if (dropped.has(ticker)) continue;
      if (!hasSeries(ticker)) {
        warn('W-UNKNOWN-TICKER', `${ticker} is not in the price cache; leg dropped`, `unknown|${ticker}`);
        dropped.add(ticker);
        continue;
      }
      const ccy = prices.currencyOf ? prices.currencyOf(ticker) : prices.meta(ticker)?.currency ?? null;
      const convertible = ccy == null || ccy === baseCurrency || (prices.hasFx ? prices.hasFx(ccy) : true);
      if (!convertible) {
        // No FX means no honest base-currency return; defaulting X = 1 would
        // silently mis-state the whole position, so the ticker goes entirely.
        warn('W-NO-FX', `no FX series for ${ccy}; ${ticker} excluded entirely`, `nofx|${ticker}`);
        dropped.add(ticker);
        continue;
      }

      const obs = observationsOf(ticker);
      const first = obs.length ? obs[0] : null;
      const at = firstAtOrAfter(obs, declared); // snap FORWARD: a fill cannot precede the decision
      if (at < 0 || obs[at] > asOf) {
        warn('W-FUTURE', `${entry.slug}: leg ${ticker} dated ${declared} is after the last priced day; dropped`);
        continue;
      }
      const eff = obs[at];
      if (first && declared < first) {
        warn('W-SNAP-FIRST', `${ticker} has no history before ${first}; ${entry.slug} snapped to ${first}`);
      }
      if (eff !== declared) {
        warn('W-SNAP', `${entry.slug}: ${ticker} snapped from ${declared} to ${eff} (first day it traded on or after)`);
      }
      instrumentLegs.push({ entry, norm: { leg, ticker, declared, eff } });
      heldTickers.add(ticker);
    }
  }

  // --- 2. the day grid -----------------------------------------------------
  // The union of the calendars of the instruments the book ever holds: the set
  // of days on which the book can actually move. Benchmarks and FX are
  // forward-filled onto it and never add a day.
  const gridSet = new Set<IsoDate>([inception]);
  for (const ticker of heldTickers) {
    for (const d of observationsOf(ticker)) {
      if (d > inception && d <= asOf) gridSet.add(d);
    }
  }
  const grid = [...gridSet].sort();
  const gridPos = new Map<IsoDate, number>();
  grid.forEach((d, i) => gridPos.set(d, i));

  // CASH has no calendar of its own, so its legs snap onto the grid.
  const normCashLegs: Array<{ entry: LogEntry; norm: NormLeg }> = [];
  for (const { entry, leg, declared } of cashLegs) {
    const at = firstAtOrAfter(grid, declared);
    if (at < 0) {
      warn('W-FUTURE', `${entry.slug}: leg CASH dated ${declared} is after the last priced day; dropped`);
      continue;
    }
    const eff = grid[at];
    if (eff !== declared) {
      warn('W-SNAP', `${entry.slug}: CASH snapped from ${declared} to ${eff} (first day it traded on or after)`);
    }
    normCashLegs.push({ entry, norm: { leg, ticker: CASH, declared, eff } });
  }

  // --- 3. group into decision events --------------------------------------
  const eventMap = new Map<string, DecisionEvent>();
  for (const { entry, norm } of [...instrumentLegs, ...normCashLegs]) {
    const key = `${entry.slug}|${norm.eff}`;
    let ev = eventMap.get(key);
    if (!ev) {
      ev = {
        slug: entry.slug,
        entry,
        date: norm.eff,
        costBps: entry.costBps ?? config.costBps ?? 0,
        legs: [],
      };
      eventMap.set(key, ev);
    }
    const dup = ev.legs.findIndex((l) => l.ticker === norm.ticker);
    if (dup >= 0) {
      warn('W-DUP-LEG', `${entry.slug}: duplicate leg for ${norm.ticker} on ${norm.eff}; last one wins`);
      ev.legs.splice(dup, 1);
    }
    ev.legs.push(norm);
  }
  const events = [...eventMap.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (asIso(a.entry.created) ?? '').localeCompare(asIso(b.entry.created) ?? '') ||
      a.slug.localeCompare(b.slug)
  );
  const eventsByDate = new Map<IsoDate, DecisionEvent[]>();
  for (const ev of events) {
    const list = eventsByDate.get(ev.date);
    if (list) list.push(ev);
    else eventsByDate.set(ev.date, [ev]);
  }

  // --- 4. the main loop ----------------------------------------------------
  let w = new Map<string, number>([[CASH, 1]]);
  let index = 100;
  const points: SeriesPoint[] = [{ d: inception, v: 100 }];
  const dailyReturns: Array<{ d: IsoDate; r: number }> = [];
  const openEpisodes = new Map<string, Episode>();
  const closedEpisodes: Episode[] = [];
  const outcomeDrafts = new Map<string, OutcomeDraft>();
  const nameByTicker = new Map<string, string>();
  let cashContribution = 0;
  let costsContribution = 0;
  let turnoverTotal = 0;
  let pendingCost = 0; // an inception-day cost, deferred to the first return day
  let dayCost = 0; // costs charged by decisions taken on the day being processed

  const legName = (ticker: string, leg?: Leg): string => {
    if (ticker === CASH) return leg?.name ?? 'Cash';
    return leg?.name ?? prices.meta(ticker)?.name ?? ticker;
  };

  function applyDecision(ev: DecisionEvent): { next: Map<string, number>; turnover: number } {
    const resolved = new Map<string, number>();
    let cashPinned = false;

    for (const nl of ev.legs) {
      const cur = w.get(nl.ticker) ?? 0;
      const leg = nl.leg;
      let x: number;
      if (leg.weight != null) x = leg.weight;
      else if (leg.portion != null) x = cur * (1 - leg.portion);
      else if (leg.scale != null) x = cur * leg.scale;
      else x = 0; // sizeless leg: the schema forces action 'sell', i.e. a full exit

      if ((leg.portion != null || leg.scale != null) && cur <= K.WEIGHT_EPS) {
        warn('W-SIZE-ON-UNHELD', `${ev.slug}: ${nl.ticker} uses portion/scale but is not held; resolves to 0%`);
      }
      if (leg.weight == null && leg.portion == null && leg.scale == null && cur <= K.WEIGHT_EPS) {
        warn('W-SELL-UNHELD', `${ev.slug}: exit of ${nl.ticker}, which is not held; no-op`);
      }
      if (x < K.WEIGHT_EPS) x = 0;
      resolved.set(nl.ticker, x);
      if (nl.ticker === CASH) cashPinned = true;
    }

    let S = 0;
    for (const v of resolved.values()) S += v;
    const untouched: string[] = [];
    let U = 0;
    for (const [k, v] of w) {
      if (resolved.has(k) || k === CASH) continue;
      untouched.push(k);
      U += v;
    }
    const R = 1 - S - U;

    const clampProportional = (): void => {
      if (S > K.WEIGHT_EPS && Math.abs(S - 1) > K.SUM_TOL) {
        warn(
          'W-OVERALLOC',
          `${ev.slug}: declared weights sum to ${S.toFixed(4)} with nothing untouched to fund it; clamped proportionally`
        );
        for (const [k, v] of resolved) resolved.set(k, v / S);
        S = 1;
      }
    };

    const next = new Map<string, number>();
    if (cashPinned) {
      // The author fixed CASH, so the instruments absorb the imbalance.
      if (U > K.WEIGHT_EPS) for (const k of untouched) next.set(k, (w.get(k)! * (1 - S)) / U);
      else clampProportional();
      next.set(CASH, resolved.get(CASH) ?? 0);
    } else if (R >= 0) {
      for (const k of untouched) next.set(k, w.get(k)!);
      next.set(CASH, R); // funded from, or returned to, cash
    } else {
      // Not enough cash: the book grew. In weight terms a deposit is exactly a
      // proportional shrink of everything that was not touched.
      if (U > K.WEIGHT_EPS) for (const k of untouched) next.set(k, (w.get(k)! * (1 - S)) / U);
      else clampProportional();
      next.set(CASH, 0);
    }
    for (const [k, v] of resolved) next.set(k, v);

    for (const [k, v] of [...next]) if (v < K.WEIGHT_EPS) next.delete(k);

    // Last line of defence on the invariant; the branches above should make it
    // unnecessary, but a broken weight vector must never reach the page.
    let total = 0;
    for (const v of next.values()) total += v;
    if (Math.abs(total - 1) > K.SUM_TOL) {
      if (total <= K.WEIGHT_EPS) next.set(CASH, 1);
      else {
        warn('W-WEIGHT-SUM', `internal: weights sum to ${total} on ${ev.date}`);
        for (const [k, v] of next) next.set(k, v / total);
      }
    }

    let turnover = 0;
    for (const k of new Set([...w.keys(), ...next.keys()])) {
      turnover += Math.abs((next.get(k) ?? 0) - (w.get(k) ?? 0));
    }
    return { next, turnover: 0.5 * turnover }; // one-way (half-sum) turnover
  }

  function processEvent(ev: DecisionEvent): void {
    const wBefore = new Map(w);
    const { next, turnover } = applyDecision(ev);

    // Double-down is measured before the episode bookkeeping moves, because the
    // reference point is the episode that was open when the decision was taken.
    let entryDoubleDown = false;
    for (const nl of ev.legs) {
      if (nl.ticker === CASH) continue;
      const before = wBefore.get(nl.ticker) ?? 0;
      const after = next.get(nl.ticker) ?? 0;
      if (before <= K.WEIGHT_EPS) continue; // an open is not a double-down
      if (after <= before + K.WEIGHT_EPS) continue; // must be an increase
      const ep = openEpisodes.get(nl.ticker);
      if (!ep) continue;
      // Underwater against the instrument's own total return since the episode
      // opened — there is no cost basis in this model, and the market's move
      // since entry cannot be shaded by how the owner remembers it.
      const u = prices.returnBetween(nl.ticker, ep.openedAt, ev.date);
      if (u != null && u < 0) entryDoubleDown = true;
    }

    // Episode open/close over every ticker, not just the declared ones: a
    // decision that sums to 1 scales the untouched holdings to zero.
    for (const ticker of new Set([...wBefore.keys(), ...next.keys()])) {
      if (ticker === CASH) continue;
      const before = wBefore.get(ticker) ?? 0;
      const after = next.get(ticker) ?? 0;
      if (before <= K.WEIGHT_EPS && after > K.WEIGHT_EPS) {
        openEpisodes.set(ticker, {
          ticker,
          openedAt: ev.date,
          closedAt: null,
          contribution: 0,
          slugs: [],
          weightAtLastDecision: after,
          lastDecisionAt: ev.date,
        });
      } else if (before > K.WEIGHT_EPS && after <= K.WEIGHT_EPS) {
        const ep = openEpisodes.get(ticker);
        if (ep) {
          ep.closedAt = ev.date;
          if (!ep.slugs.includes(ev.slug)) ep.slugs.push(ev.slug);
          closedEpisodes.push(ep);
          openEpisodes.delete(ticker);
        }
      }
    }

    const draft = outcomeDrafts.get(ev.slug) ?? {
      entry: ev.entry,
      date: ev.date,
      legs: new Map<string, OutcomeLeg>(),
      isDoubleDown: false,
    };
    if (ev.date < draft.date) draft.date = ev.date;
    draft.isDoubleDown = draft.isDoubleDown || entryDoubleDown;

    for (const nl of ev.legs) {
      const before = wBefore.get(nl.ticker) ?? 0;
      const after = next.get(nl.ticker) ?? 0;
      const name = legName(nl.ticker, nl.leg);
      if (nl.leg.name) nameByTicker.set(nl.ticker, nl.leg.name);
      draft.legs.set(nl.ticker, {
        ticker: nl.ticker,
        name,
        direction:
          after > before + K.WEIGHT_EPS ? 'up' : after < before - K.WEIGHT_EPS ? 'down' : 'flat',
        weightBefore: before,
        weightAfter: after,
        eventDate: ev.date,
      });
      const ep = openEpisodes.get(nl.ticker);
      if (ep) {
        if (!ep.slugs.includes(ev.slug)) ep.slugs.push(ev.slug);
        ep.weightAtLastDecision = after;
        ep.lastDecisionAt = ev.date;
      }
    }
    outcomeDrafts.set(ev.slug, draft);

    w = next;
    turnoverTotal += turnover;
    const cost = (turnover * ev.costBps) / 10_000;
    if (ev.date === inception) pendingCost += cost;
    else dayCost += cost;
  }

  // Inception day: no drift, no return, but decisions dated there still apply.
  // Their cost is deferred to the first return day so `I(inception) = 100`
  // stays exact without silently discarding the entry cost.
  for (const ev of eventsByDate.get(inception) ?? []) processEvent(ev);

  const noPriceWarned = new Set<string>();

  for (let gi = 1; gi < grid.length; gi++) {
    const t = grid[gi];
    const tPrev = grid[gi - 1];
    const wprev = new Map(w);

    // ---- drift ----
    const r = new Map<string, number>();
    for (const [i, wi] of wprev) {
      let ri: number;
      if (i === CASH) {
        // ACT/365-fixed, geometrically pro-rated: a Fri->Mon gap earns three
        // days, and a crypto grid and an equity grid pay the same annual rate.
        const delta = daysBetween(tPrev, t);
        ri = Math.pow(1 + riskFreeRate, delta / K.DAYCOUNT_CASH) - 1;
      } else {
        const raw = prices.returnBetween(i, tPrev, t);
        if (raw == null) {
          if (wi > K.WEIGHT_EPS && !noPriceWarned.has(i)) {
            noPriceWarned.add(i);
            warn('W-NO-PRICE', `${i}: no price on/before ${tPrev}; treated as flat`);
          }
          ri = 0; // never treat a missing level as 0: that fabricates a −100% day
        } else ri = raw;
      }
      r.set(i, ri);
    }

    let rho = 0;
    for (const [i, wi] of wprev) rho += wi * r.get(i)!;
    let growth = 1 + rho;
    if (growth <= 0) {
      warn('W-WIPEOUT', `portfolio return of ${rho} on ${t} implies total loss; clamped`);
      growth = 1e-12;
      rho = growth - 1;
    }
    const drifted = new Map<string, number>();
    for (const [i, wi] of wprev) {
      const v = (wi * (1 + r.get(i)!)) / growth; // renormalise by the GROSS return
      if (v >= K.WEIGHT_EPS) drifted.set(i, v);
    }
    w = drifted;

    // ---- decisions at the close ----
    dayCost = pendingCost;
    pendingCost = 0;
    for (const ev of eventsByDate.get(t) ?? []) processEvent(ev);
    const kappa = dayCost;
    dayCost = 0;

    // ---- return, index, attribution ----
    const rp = rho - kappa;
    for (const [i, wi] of wprev) {
      const c = (wi * r.get(i)! * index) / 100;
      if (i === CASH) {
        cashContribution += c;
        continue;
      }
      // The episode that earned this is the one that was open *across* day t —
      // i.e. before today's decisions, so an exit today still keeps today's
      // return, and a re-open today does not steal it.
      let ep = findEpisodeFor(i, t);
      if (!ep) {
        // Defensive: weight without an episode should be impossible. Book it to
        // a synthetic closed episode rather than silently break the identity.
        ep = {
          ticker: i,
          openedAt: tPrev,
          closedAt: t,
          contribution: 0,
          slugs: [],
          weightAtLastDecision: wi,
          lastDecisionAt: tPrev,
        };
        closedEpisodes.push(ep);
      }
      ep.contribution += c;
    }
    costsContribution += (-kappa * index) / 100;
    index = index * (1 + rp);
    points.push({ d: t, v: index });
    dailyReturns.push({ d: t, r: rp });

    let sum = 0;
    for (const v of w.values()) sum += v;
    if (Math.abs(sum - 1) > K.SUM_TOL) warn('W-WEIGHT-SUM', `internal: weights sum to ${sum} on ${t}`);
  }

  /** The episode of `ticker` that was open across day `t` (it may have closed at its close). */
  function findEpisodeFor(ticker: string, t: IsoDate): Episode | null {
    const open = openEpisodes.get(ticker);
    if (open && open.openedAt < t) return open;
    for (let i = closedEpisodes.length - 1; i >= 0; i--) {
      const ep = closedEpisodes[i];
      if (ep.ticker === ticker && ep.openedAt < t && (ep.closedAt == null || ep.closedAt >= t)) return ep;
    }
    return null;
  }

  // A position whose weight drifted below the epsilon has no row to live in;
  // retire the episode so its contribution still appears in the table.
  for (const [ticker, ep] of [...openEpisodes]) {
    if ((w.get(ticker) ?? 0) > K.WEIGHT_EPS) continue;
    ep.closedAt = grid[grid.length - 1];
    closedEpisodes.push(ep);
    openEpisodes.delete(ticker);
  }

  const twr = index / 100 - 1;
  const lastGrid = grid[grid.length - 1];

  const portfolioIndexAt = (d: IsoDate): number | null => {
    const i = lastAtOrBefore(grid, d);
    return i < 0 ? null : points[i].v;
  };

  // --- 5. benchmarks -------------------------------------------------------
  const benchConfigs = config.benchmarks ?? [];
  const primaryCfg = benchConfigs.find((b) => b.primary) ?? benchConfigs[0];

  interface BenchState {
    symbol: string;
    label: string;
    primary: boolean;
    tBase: IsoDate;
    levelAt: (d: IsoDate) => number | null;
    indexAt: (d: IsoDate) => number | null;
    dates: IsoDate[];
    values: number[];
  }

  const benchStates: BenchState[] = [];
  for (const cfg of benchConfigs) {
    if (!hasSeries(cfg.symbol)) {
      warn('W-BENCH-MISSING', `benchmark ${cfg.symbol} is not in the price cache`);
      continue;
    }
    const obs = observationsOf(cfg.symbol);
    if (!obs.length) {
      warn('W-BENCH-MISSING', `benchmark ${cfg.symbol} is not in the price cache`);
      continue;
    }
    const bi = lastAtOrBefore(obs, inception);
    const tBase = bi < 0 ? obs[0] : obs[bi];
    if (bi < 0) warn('W-BENCH-LATE', `${cfg.symbol} starts ${tBase}, after inception; rebased there`);
    if (cfg.symbol.startsWith('^')) {
      warn('W-PRICE-ONLY-INDEX', `${cfg.symbol} excludes dividends; understates by roughly 1.5–2%/yr`);
    }
    const baseLevel = prices.levelInBase(cfg.symbol, tBase);
    if (baseLevel == null || baseLevel === 0) {
      warn('W-BENCH-MISSING', `benchmark ${cfg.symbol} has no usable level at ${tBase}`);
      continue;
    }
    const levelAt = (d: IsoDate) => prices.levelInBase(cfg.symbol, d);
    const indexAt = (d: IsoDate) => {
      if (d < tBase) return null;
      const l = levelAt(d);
      return l == null ? null : (100 * l) / baseLevel;
    };
    const dates: IsoDate[] = [];
    const values: number[] = [];
    for (const d of grid) {
      if (d < tBase) continue;
      const v = indexAt(d);
      if (v == null) continue;
      dates.push(d);
      values.push(v);
    }
    benchStates.push({
      symbol: cfg.symbol,
      label: cfg.label,
      primary: primaryCfg ? cfg.symbol === primaryCfg.symbol : false,
      tBase,
      levelAt,
      indexAt,
      dates,
      values,
    });
  }
  const primaryBench = benchStates.find((b) => b.primary) ?? null;
  const benchReturn = (from: IsoDate, to: IsoDate): number | null => {
    if (!primaryBench || from < primaryBench.tBase) return null;
    return prices.returnBetween(primaryBench.symbol, from, to);
  };

  // --- 6. trailing windows -------------------------------------------------
  /**
   * Anchors are calendar dates; the sample point is the last grid day on or
   * before the anchor. Never snap forward — that shortens the window and
   * flatters a rising book. Null whenever the anchor predates inception, so a
   * three-week number is never passed off as a one-year number.
   */
  function windowReturns(at: (d: IsoDate) => number | null, inceptionValue: number): WindowReturns {
    const endValue = at(asOf);
    const ret = (anchor: IsoDate): number | null => {
      if (anchor < inception || endValue == null) return null;
      const i = lastAtOrBefore(grid, anchor);
      if (i < 0 || grid[i] === lastGrid) return null;
      const a = at(grid[i]);
      return a == null || a === 0 ? null : endValue / a - 1;
    };
    return {
      ytd: ret(`${+asOf.slice(0, 4) - 1}-12-31`),
      m1: ret(addMonths(asOf, -1)),
      m3: ret(addMonths(asOf, -3)),
      m6: ret(addMonths(asOf, -6)),
      y1: ret(addMonths(asOf, -12)),
      inception: inceptionValue,
    };
  }

  // --- 7. risk -------------------------------------------------------------
  const spanDays = daysBetween(inception, asOf);
  const rawA = spanDays > 0 ? Math.round(dailyReturns.length / (spanDays / K.DAYCOUNT_CAGR)) : K.A_MAX;
  const annualisation = clamp(rawA, K.A_MIN, K.A_MAX);
  if (rawA !== annualisation && dailyReturns.length > 0) {
    warn('W-ANNUAL-CLAMP', `annualisation factor clamped to ${annualisation}`);
  }

  const rArray = dailyReturns.map((x) => x.r);
  const risk = riskMetrics(rArray, annualisation, riskFreeRate);
  const enoughRisk = rArray.length >= K.MIN_RISK_DAYS;

  const years = spanDays / K.DAYCOUNT_CAGR;
  let twrAnnualized: number | null = null;
  if (spanDays >= K.MIN_ANNUALISE_DAYS && years > 0) {
    twrAnnualized = 1 + twr <= 0 ? -1 : Math.pow(1 + twr, 1 / years) - 1;
  }

  let bestDay: { d: IsoDate; r: number } | null = null;
  let worstDay: { d: IsoDate; r: number } | null = null;
  for (const x of dailyReturns) {
    if (!bestDay || x.r > bestDay.r) bestDay = { d: x.d, r: x.r };
    if (!worstDay || x.r < worstDay.r) worstDay = { d: x.d, r: x.r };
  }

  // --- 8. positions and closed positions -----------------------------------
  const g30 = grid.length >= 31 ? grid[grid.length - 31] : null;
  const displayName = (ticker: string): string =>
    nameByTicker.get(ticker) ?? prices.meta(ticker)?.name ?? ticker;

  const positions: Position[] = [];
  for (const [ticker, ep] of openEpisodes) {
    const weight = w.get(ticker) ?? 0;
    if (weight <= K.WEIGHT_EPS) continue;
    positions.push({
      ticker,
      name: displayName(ticker),
      currency: prices.meta(ticker)?.currency ?? baseCurrency,
      weight,
      weightAtLastDecision: ep.weightAtLastDecision,
      returnSinceOpen: prices.returnBetween(ticker, ep.openedAt, asOf) ?? 0,
      // A momentum read on the instrument, comparable across rows — deliberately
      // not clipped to the holding window.
      return1M: g30 ? prices.returnBetween(ticker, g30, asOf) : null,
      contribution: ep.contribution,
      benchmarkSinceOpen: benchReturn(ep.openedAt, asOf),
      openedAt: ep.openedAt,
      lastDecisionAt: ep.lastDecisionAt,
      entrySlugs: [...ep.slugs].reverse(),
    });
  }
  positions.sort((a, b) => b.weight - a.weight || a.ticker.localeCompare(b.ticker));

  const closed: ClosedPosition[] = closedEpisodes.map((ep) => {
    const closedAt = ep.closedAt!;
    const returnWhileHeld = prices.returnBetween(ep.ticker, ep.openedAt, closedAt) ?? 0;
    const benchmarkReturn = benchReturn(ep.openedAt, closedAt);
    return {
      ticker: ep.ticker,
      name: displayName(ep.ticker),
      openedAt: ep.openedAt,
      closedAt,
      heldDays: daysBetween(ep.openedAt, closedAt),
      returnWhileHeld,
      benchmarkReturn,
      excess: benchmarkReturn == null ? null : returnWhileHeld - benchmarkReturn,
      contribution: ep.contribution,
      returnSinceExit: closedAt === asOf ? null : prices.returnBetween(ep.ticker, closedAt, asOf),
      entrySlugs: [...ep.slugs].reverse(),
    };
  });
  closed.sort((a, b) => b.closedAt.localeCompare(a.closedAt) || a.ticker.localeCompare(b.ticker));

  // --- 9. stale symbols ----------------------------------------------------
  for (const ticker of openEpisodes.keys()) {
    const last = prices.lastObservation ? prices.lastObservation(ticker) : null;
    if (!last) continue;
    const behind = grid.length - 1 - lastAtOrBefore(grid, last);
    if (behind > K.STALE_MAX_DAYS) warn('W-STALE', `${ticker} price stale since ${last}`);
  }

  // --- 10. outcomes and markers -------------------------------------------
  function deriveKind(legs: OutcomeLeg[]): MoveKind {
    const real = legs.filter((l) => l.ticker !== CASH); // cash is a residual, not a thesis
    if (!real.length) return 'note';
    if (real.every((l) => l.weightBefore <= K.WEIGHT_EPS && l.weightAfter > K.WEIGHT_EPS)) return 'open';
    if (real.every((l) => l.weightBefore > K.WEIGHT_EPS && l.weightAfter <= K.WEIGHT_EPS)) return 'exit';
    if (real.every((l) => l.direction === 'up')) return 'add';
    if (real.every((l) => l.direction === 'down')) return 'trim';
    if (real.every((l) => l.direction === 'flat')) return 'note';
    return 'rebalance';
  }

  function markerLabel(kind: MoveKind, tickers: string[]): string {
    if (!tickers.length) return kind === 'note' ? 'note' : kind;
    const sign = kind === 'open' || kind === 'add' ? '+' : kind === 'trim' || kind === 'exit' ? '−' : '±';
    return tickers.length === 1 ? `${sign} ${tickers[0]}` : `${sign} ${tickers.length}`;
  }

  const outcomes: Record<string, DecisionOutcome> = {};
  const markers: ChartMarker[] = [];
  for (const entry of entries) {
    const draft = outcomeDrafts.get(entry.slug);
    const legs = draft ? [...draft.legs.values()] : [];
    const date = draft?.date ?? asIso(entry.created) ?? inception;
    const kind = entry.move ?? deriveKind(legs);
    const indexHere = portfolioIndexAt(date);
    const outcome: DecisionOutcome = {
      slug: entry.slug,
      kind,
      isDoubleDown: draft?.isDoubleDown ?? false,
      date,
      legs: legs.map((l) => ({
        ticker: l.ticker,
        name: l.name,
        direction: l.direction,
        weightBefore: l.weightBefore,
        weightAfter: l.weightAfter,
        returnSince: l.ticker === CASH ? null : prices.returnBetween(l.ticker, l.eventDate, asOf),
        benchmarkSince: benchReturn(l.eventDate, asOf),
      })),
      portfolioSince:
        date === lastGrid || indexHere == null || indexHere === 0 ? null : index / indexHere - 1,
      benchmarkSince: benchReturn(date, asOf),
    };
    outcomes[entry.slug] = outcome;

    if (date >= inception && date <= asOf && indexHere != null) {
      const tickers = legs.filter((l) => l.ticker !== CASH).map((l) => l.ticker);
      markers.push({
        d: date,
        v: indexHere,
        kind,
        label: markerLabel(kind, tickers),
        title: entry.title,
        href: entry.href,
        tickers,
        isDoubleDown: outcome.isDoubleDown,
      });
    }
  }
  markers.sort((a, b) => a.d.localeCompare(b.d));

  // --- 11. series and benchmark comparisons -------------------------------
  const series: IndexSeries[] = [{ label: 'Portfolio', points }];
  const benchmarks: BenchmarkComparison[] = [];
  for (const b of benchStates) {
    series.push({
      label: b.label,
      symbol: b.symbol,
      points: b.dates.map((d, i) => ({ d, v: b.values[i] })),
    });

    const endValue = b.indexAt(asOf);
    const bTwr = endValue == null ? 0 : endValue / 100 - 1;
    const bReturns: number[] = [];
    for (let i = 1; i < b.values.length; i++) bReturns.push(b.values[i] / b.values[i - 1] - 1);
    const bRisk = riskMetrics(bReturns, annualisation, riskFreeRate);

    const { pairs, spanDays: pairSpan } = buildRegressionPairs(
      observationsOf(b.symbol),
      grid,
      portfolioIndexAt,
      b.levelAt,
      inception,
      asOf
    );
    const reg = regressionStats(pairs, riskFreeRate, pairSpan);
    const enoughPairs = pairs.length >= K.MIN_BETA_PAIRS;

    benchmarks.push({
      symbol: b.symbol,
      label: b.label,
      primary: b.primary,
      twr: bTwr,
      excess: twr - bTwr,
      returns: windowReturns(b.indexAt, bTwr),
      volatility: bReturns.length >= K.MIN_RISK_DAYS ? bRisk.volatility : null,
      maxDrawdown: maxDrawdown(b.dates, b.values),
      beta: enoughPairs ? reg.beta : null,
      alpha: enoughPairs ? reg.alpha : null,
      correlation: enoughPairs ? reg.correlation : null,
    });
  }

  // --- 12. stats and the attribution identity ------------------------------
  const stats: PortfolioStats = {
    inception,
    asOf,
    twr,
    twrAnnualized,
    returns: windowReturns(portfolioIndexAt, twr),
    volatility: enoughRisk ? risk.volatility : null,
    sharpe: enoughRisk ? risk.sharpe : null,
    maxDrawdown: maxDrawdown(
      points.map((p) => p.d),
      points.map((p) => p.v)
    ),
    bestDay,
    worstDay,
    hitRate: enoughRisk ? risk.hitRate : null,
    turnover: turnoverTotal,
    positionCount: positions.length,
    closedCount: closed.length,
    decisionCount: outcomeDrafts.size,
  };

  // The decomposition telescopes, so this is exact up to floating point. If it
  // is not, the attribution column on the page does not add up to the headline
  // number, which in a feature about keeping score is the one unshippable bug.
  let attributed = cashContribution + costsContribution;
  for (const p of positions) attributed += p.contribution;
  for (const c of closed) attributed += c.contribution;
  const residual = twr - attributed;
  if (Math.abs(residual) >= K.IDENTITY_TOL) {
    warn('W-IDENTITY', `attribution residual ${residual}; contributions do not sum to TWR`);
  }

  return {
    baseCurrency,
    asOf,
    pricesFetchedAt: prices.fetchedAt ?? '',
    pricesSource: prices.source ?? '',
    demo: config.demo,
    stats,
    positions,
    closed,
    series,
    benchmarks,
    markers,
    outcomes,
    warnings,
    // Buckets that `positions[]` alone cannot express. The page must render
    // cash, exited and costs rows or the attribution column is visibly short of
    // the headline TWR — a rendering requirement that follows from the math.
    attribution: {
      cash: cashContribution,
      costs: costsContribution,
      exited: closed.reduce((a, c) => a + c.contribution, 0),
      live: positions.reduce((a, p) => a + p.contribution, 0),
      residual,
    },
  };
}
