/**
 * Shared type contract for the portfolio feature.
 *
 * WHY WEIGHTS, NOT SHARES
 * -----------------------
 * This repository is public — the source, not just the built site. So the
 * trade log itself must not contain anything from which position sizes or net
 * worth could be recovered. Shares × price does exactly that, so the log never
 * records shares.
 *
 * Instead a decision records the *weights* it produced: "after this, NVDA is 8%
 * of the book". Between decisions weights drift with prices; on a decision date
 * they snap to the newly declared values. That is a complete description of the
 * portfolio up to an unknown scale factor, and scale is precisely the thing we
 * are hiding.
 *
 * This costs nothing in accuracy for the number that matters. Time-weighted
 * return is scale-invariant — it depends only on the weight path — so the
 * published track record is the real one, not an approximation. What is
 * genuinely unavailable is anything denominated in money: realised P&L in
 * euros, and money-weighted return (XIRR), which needs actual cash flows.
 * Judging decisions is what TWR is for, so that is the right trade.
 *
 * Total returns throughout: instrument returns come from dividend- and
 * split-adjusted closes, so distributions are already included and never need
 * to be modelled separately.
 */

/** Calendar date, `YYYY-MM-DD`, always interpreted in UTC. */
export type IsoDate = string;

/** ISO-4217 currency code, e.g. `EUR`, `USD`. */
export type CurrencyCode = string;

/**
 * Reserved pseudo-ticker for the uninvested remainder. Accrues the configured
 * risk-free rate daily so "I went 30% cash" is expressible and scored fairly.
 */
export const CASH = 'CASH' as const;

// ---------------------------------------------------------------------------
// Inputs: the decision log (authored as markdown frontmatter)
// ---------------------------------------------------------------------------

export type TradeAction = 'buy' | 'sell';

/**
 * One leg of a decision: what a single holding's weight became.
 *
 * Exactly one sizing field must be given, or none for a full exit:
 *   weight  — the post-trade weight of the book (the primary, explicit form)
 *   portion — sell this fraction of the position (0.5 = sold half)
 *   scale   — multiply the position's weight (2 = doubled the position)
 *   (none)  — with `action: 'sell'`, exit the position entirely
 *
 * Weights are the *actual* post-trade weights, not aspirational targets.
 * Rounding to the nearest half percent is fine and keeps the log tidy.
 */
export interface Leg {
  /** Yahoo Finance symbol, e.g. `VWCE.DE`, `ASML.AS`, `NVDA`, or `CASH`. */
  ticker: string;
  /** Human label. Falls back to the instrument name from the price feed. */
  name?: string;
  /** Direction. Derived by comparing to the pre-trade weight when omitted. */
  action?: TradeAction;
  /** Execution date. Defaults to the log entry's `created` date. */
  date?: IsoDate;
  /** Post-trade share of the book, 0..1. */
  weight?: number;
  /** Fraction of the existing position sold, 0..1. */
  portion?: number;
  /** Multiplier applied to the existing weight, > 0. */
  scale?: number;
}

/** How a log entry moved the book. Derived from its legs when not stated. */
export type MoveKind =
  | 'open'      // first appearance of a holding
  | 'add'       // increased an existing holding
  | 'trim'      // reduced but did not close
  | 'exit'      // closed a holding entirely
  | 'rebalance' // increases and decreases in the same decision
  | 'note';     // commentary only, no legs

/** Owner's self-reported conviction, rendered as a small meter. */
export type Conviction = 'low' | 'medium' | 'high';

/** A decision, as handed to the engine by the page layer. */
export interface LogEntry {
  slug: string;
  title: string;
  created: IsoDate;
  /** Explicit override; otherwise derived from `legs`. */
  move?: MoveKind;
  conviction?: Conviction;
  legs: Leg[];
  /**
   * Round-trip trading cost for this decision in basis points of turnover.
   * Falls back to `portfolioConfig.costBps`.
   */
  costBps?: number;
  href: string;
  tags: string[];
  excerpt?: string;
}

// ---------------------------------------------------------------------------
// Price data (produced by scripts/fetch-prices.mjs)
// ---------------------------------------------------------------------------

/**
 * A daily total-return series for one symbol: split- AND dividend-adjusted
 * closes. Dates are trading days only; consumers forward-fill.
 *
 * Levels are meaningless in isolation (an adjusted series is only defined up to
 * a scale factor); only ratios between two dates are used.
 */
export interface PriceSeries {
  symbol: string;
  name?: string;
  currency: CurrencyCode;
  /** Instrument classification reported by the feed, e.g. `EQUITY`, `ETF`. */
  instrumentType?: string;
  /** Parallel arrays, ascending by date, equal length. */
  dates: IsoDate[];
  /** Dividend- and split-adjusted close, in `currency`. */
  adjClose: number[];
}

/** The on-disk price cache: `src/data/prices.json`. */
export interface PriceData {
  /** When the cache was last refreshed (ISO 8601 timestamp). */
  fetchedAt: string;
  baseCurrency: CurrencyCode;
  /** Which feed produced this snapshot, for the page's provenance line. */
  source: string;
  /** Keyed by symbol. Includes instruments, benchmarks and FX pairs. */
  series: Record<string, PriceSeries>;
}

/**
 * Read-only price lookup handed to the engine. Implementations forward-fill and
 * handle FX, so callers never touch raw arrays.
 */
export interface PriceLookup {
  /** Latest date for which any price is known. */
  readonly lastDate: IsoDate;
  /** Every trading day in `[from, to]`, ascending. */
  tradingDays(from: IsoDate, to?: IsoDate): IsoDate[];
  /**
   * Total return of `symbol` in the base currency between two dates,
   * FX included. Null when either endpoint is unknown.
   */
  returnBetween(symbol: string, from: IsoDate, to: IsoDate): number | null;
  /** Adjusted close in the base currency, forward-filled. */
  levelInBase(symbol: string, date: IsoDate): number | null;
  /** First date on which `symbol` has data. */
  firstDate(symbol: string): IsoDate | null;
  meta(symbol: string): Pick<PriceSeries, 'name' | 'currency' | 'instrumentType'> | null;
}

// ---------------------------------------------------------------------------
// Engine output
// ---------------------------------------------------------------------------

/** One point on a rebased index series. `v` is 100 at inception. */
export interface SeriesPoint {
  d: IsoDate;
  v: number;
}

export interface IndexSeries {
  /** Display label, e.g. `Portfolio` or `FTSE All-World`. */
  label: string;
  /** Present for benchmarks; absent for the portfolio itself. */
  symbol?: string;
  /** Hex colour to draw with. Assigned by the page, not the engine. */
  color?: string;
  points: SeriesPoint[];
}

/** A live holding, as of the last priced day. */
export interface Position {
  ticker: string;
  name: string;
  currency: CurrencyCode;
  /** Current share of the book, 0..1, after drift since the last decision. */
  weight: number;
  /** Weight immediately after the most recent decision that touched it. */
  weightAtLastDecision: number;
  /** Total return of the instrument, base currency, since `openedAt`. */
  returnSinceOpen: number;
  /** Same instrument, same window, but only over the last 30 trading days. */
  return1M: number | null;
  /**
   * Contribution to the portfolio's cumulative TWR, in fractional terms.
   * These sum exactly to `PortfolioStats.twr` — see the engine's derivation.
   */
  contribution: number;
  /** What the primary benchmark returned over the same holding window. */
  benchmarkSinceOpen: number | null;
  openedAt: IsoDate;
  lastDecisionAt: IsoDate;
  /** Slugs of log entries that touched this ticker, newest first. */
  entrySlugs: string[];
}

/** A holding that is fully closed, kept for the "graveyard" table. */
export interface ClosedPosition {
  ticker: string;
  name: string;
  openedAt: IsoDate;
  closedAt: IsoDate;
  heldDays: number;
  /** Instrument total return, base currency, over the holding window. */
  returnWhileHeld: number;
  /** What the primary benchmark did over exactly the same window. */
  benchmarkReturn: number | null;
  /** `returnWhileHeld` minus `benchmarkReturn`. The interesting column. */
  excess: number | null;
  /** Contribution to cumulative TWR over the whole track record. */
  contribution: number;
  /** How the instrument has done since the exit — was selling right? */
  returnSinceExit: number | null;
  entrySlugs: string[];
}

export interface DrawdownWindow {
  peak: IsoDate;
  trough: IsoDate;
  /** Negative fraction, e.g. -0.183. */
  depth: number;
  /** Null while still under water. */
  recovered: IsoDate | null;
}

/** Trailing-window returns. `null` when the window predates inception. */
export interface WindowReturns {
  ytd: number | null;
  m1: number | null;
  m3: number | null;
  m6: number | null;
  y1: number | null;
  inception: number;
}

export interface PortfolioStats {
  inception: IsoDate;
  asOf: IsoDate;
  /** Time-weighted return, cumulative since inception. Fraction. */
  twr: number;
  /** Annualised (CAGR) equivalent of `twr`. Null under ~60 days of history. */
  twrAnnualized: number | null;
  returns: WindowReturns;
  /** Annualised stdev of daily returns. */
  volatility: number | null;
  /** Excess return over the risk-free rate divided by volatility. */
  sharpe: number | null;
  maxDrawdown: DrawdownWindow | null;
  bestDay: { d: IsoDate; r: number } | null;
  worstDay: { d: IsoDate; r: number } | null;
  /** Fraction of days with a positive return. */
  hitRate: number | null;
  /** Sum of |Δweight| across all decisions — how much churn the log implies. */
  turnover: number;
  positionCount: number;
  closedCount: number;
  decisionCount: number;
}

/** Per-benchmark comparison, computed over the portfolio's own date range. */
export interface BenchmarkComparison {
  symbol: string;
  label: string;
  primary: boolean;
  twr: number;
  /** Portfolio TWR minus benchmark TWR, in fraction terms. */
  excess: number;
  returns: WindowReturns;
  volatility: number | null;
  maxDrawdown: DrawdownWindow | null;
  /** Beta of the portfolio against this benchmark. */
  beta: number | null;
  /** Annualised Jensen's alpha. */
  alpha: number | null;
  /** Correlation of daily returns. */
  correlation: number | null;
}

/** A decision marker drawn on the chart. */
export interface ChartMarker {
  d: IsoDate;
  /** Index level of the portfolio series on that date, for y-positioning. */
  v: number;
  kind: MoveKind;
  /** Short label, e.g. `+ NVDA`. */
  label: string;
  title: string;
  href: string;
  tickers: string[];
  /** Added to a holding that was underwater at the time. */
  isDoubleDown: boolean;
}

/**
 * How a single decision has aged: the honest scoreboard attached to each log
 * entry. Computed from the price history after the fact, not self-reported.
 */
export interface DecisionOutcome {
  slug: string;
  kind: MoveKind;
  isDoubleDown: boolean;
  date: IsoDate;
  legs: Array<{
    ticker: string;
    name: string;
    direction: 'up' | 'down' | 'flat';
    /** Weight before and after this decision. */
    weightBefore: number;
    weightAfter: number;
    /** Instrument total return from the decision date to `asOf`. */
    returnSince: number | null;
    /** Primary benchmark over the same window, for context. */
    benchmarkSince: number | null;
  }>;
  /** Portfolio TWR from this decision to `asOf`. */
  portfolioSince: number | null;
  benchmarkSince: number | null;
}

/** Everything the portfolio page needs. Produced by `buildPortfolio()`. */
export interface PortfolioSnapshot {
  baseCurrency: CurrencyCode;
  asOf: IsoDate;
  /** Freshness of the underlying price cache (ISO 8601). */
  pricesFetchedAt: string;
  /** Provenance line for the footer. */
  pricesSource: string;
  /** True when the page is rendering the bundled example book. */
  demo: boolean;
  stats: PortfolioStats;
  positions: Position[];
  closed: ClosedPosition[];
  /** Index series rebased to 100: portfolio first, then benchmarks. */
  series: IndexSeries[];
  benchmarks: BenchmarkComparison[];
  markers: ChartMarker[];
  /** Keyed by log-entry slug, for the per-decision pages. */
  outcomes: Record<string, DecisionOutcome>;
  /** Non-fatal problems worth surfacing (unknown ticker, weights ≠ 1, gaps). */
  warnings: string[];
}
