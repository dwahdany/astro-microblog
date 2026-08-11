import type { CurrencyCode, IsoDate } from '../lib/portfolio/types';

export interface BenchmarkConfig {
  /** Yahoo Finance symbol. */
  symbol: string;
  /** Display label on the chart legend. */
  label: string;
  /** Drawn as the primary comparison line and used for excess-return stats. */
  primary?: boolean;
}

export interface PortfolioConfig {
  /** Publish the page at /portfolio/. Set false to keep it out of the build. */
  enabled: boolean;
  /**
   * Render the bundled example book in `src/content/portfolio/`. Shows an
   * "example data" banner and keeps the page out of sitemaps and feeds.
   * Flip to false once you have replaced the examples with real entries.
   */
  demo: boolean;
  title: string;
  description: string;
  /** Shown above the fold — the one-paragraph "what this is". */
  intro: string;
  baseCurrency: CurrencyCode;
  /**
   * Start of the track record. Decisions before this date are ignored; every
   * index series is rebased to 100 here. Defaults to the first decision.
   */
  inception?: IsoDate;
  benchmarks: BenchmarkConfig[];
  /** Annual risk-free rate, as a fraction. Used for Sharpe and for CASH. */
  riskFreeRate: number;
  /**
   * Default trading cost charged against turnover on every decision, in basis
   * points (10 = 0.10% of the weight actually moved). Overridable per entry
   * with `cost_bps`. Keeps the track record from flattering itself.
   */
  costBps: number;
  display: {
    /** Draw decision markers from the log on the performance chart. */
    chartMarkers: boolean;
    /** Show the closed-positions ("graveyard") table. */
    closedPositions: boolean;
    /** Default range button selected on load. */
    defaultRange: '1M' | '6M' | 'YTD' | '1Y' | 'ALL';
  };
}

export const portfolioConfig: PortfolioConfig = {
  enabled: true,
  demo: false,
  title: 'Portfolio',
  description:
    'What I own, what I changed, and why — with the track record attached.',
  intro:
    'A log of the positions I hold and the changes I make to them, each with the reasoning I had at the time. Published so the reasoning stays honest: the chart keeps score whether or not the notes aged well. Sizes are weights, never amounts — enough to judge the calls, not enough to reconstruct the balance.',
  baseCurrency: 'EUR',
  // The book was transferred in from another broker on this date; the track
  // record starts here because it is the first day with a verifiable snapshot.
  inception: '2024-08-21',
  benchmarks: [
    { symbol: 'VWCE.DE', label: 'FTSE All-World', primary: true },
    { symbol: '^GSPC', label: 'S&P 500' },
  ],
  riskFreeRate: 0.02,
  costBps: 10,
  display: {
    chartMarkers: true,
    closedPositions: true,
    defaultRange: 'ALL',
  },
};

/** Benchmark symbols the price cache must always contain. */
export const benchmarkSymbols = portfolioConfig.benchmarks.map((b) => b.symbol);

export const primaryBenchmark =
  portfolioConfig.benchmarks.find((b) => b.primary) ?? portfolioConfig.benchmarks[0];
