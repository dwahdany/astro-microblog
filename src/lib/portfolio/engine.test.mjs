/**
 * Engine tests — `node --test src/lib/portfolio/engine.test.mjs`
 *
 * Everything here runs on SYNTHETIC price fixtures, never the real cache, so
 * the suite is deterministic and works offline. The worked vectors (a)-(e) are
 * the specification's hand-computed ground truth, derived with exact rational
 * arithmetic; where a value is rational it is written as the fraction the spec
 * gives and compared to 1e-12, and where it is irrational (the CASH accruals)
 * the spec's six-decimal figure is compared to 1e-6.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPrices } from './prices.ts';
import {
  ENGINE_CONSTANTS as K,
  buildPortfolio,
  buildRegressionPairs,
  regressionStats,
  riskMetrics,
} from './engine.ts';

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** `{ SYM: { currency, px: { '2024-01-02': 100, ... } } }` -> `PriceData`. */
function priceData(spec, extra = {}) {
  const series = {};
  for (const [symbol, s] of Object.entries(spec)) {
    const dates = Object.keys(s.px).sort();
    series[symbol] = {
      symbol,
      name: s.name,
      currency: s.currency ?? 'EUR',
      instrumentType: s.instrumentType,
      dates,
      adjClose: dates.map((d) => s.px[d]),
    };
  }
  return {
    fetchedAt: '2099-01-01T00:00:00.000Z',
    baseCurrency: 'EUR',
    source: 'synthetic',
    series,
    ...extra,
  };
}

function config(over = {}) {
  return {
    enabled: true,
    demo: false,
    title: 'Portfolio',
    description: '',
    intro: '',
    baseCurrency: 'EUR',
    benchmarks: [],
    riskFreeRate: 0,
    costBps: 10,
    display: { chartMarkers: true, closedPositions: true, defaultRange: 'ALL' },
    ...over,
  };
}

function entry(slug, created, legs, over = {}) {
  return {
    slug,
    title: slug,
    created,
    legs,
    href: `/portfolio/${slug}/`,
    tags: [],
    ...over,
  };
}

const near = (actual, expected, tol, what = '') =>
  assert.ok(
    Math.abs(actual - expected) <= tol,
    `${what}: expected ${expected}, got ${actual} (Δ ${Math.abs(actual - expected)})`
  );

const codes = (snap) => snap.warnings.map((w) => w.split(':')[0]);

/** The identity that the whole attribution design exists to guarantee. */
function assertIdentity(snap, tol = K.IDENTITY_TOL) {
  const { live, exited, cash, costs } = snap.attribution;
  near(live + exited + cash + costs, snap.stats.twr, tol, 'attribution identity');
  assert.ok(Math.abs(snap.attribution.residual) < K.IDENTITY_TOL);
  assert.ok(!codes(snap).includes('W-IDENTITY'));
}

// ---------------------------------------------------------------------------
// (a) one instrument, 40% weight, three price days
// ---------------------------------------------------------------------------

function fixtureA() {
  const prices = createPrices(
    priceData({
      ACME: {
        currency: 'EUR',
        px: { '2024-01-02': 100, '2024-01-03': 105, '2024-01-04': 103, '2024-01-05': 108 },
      },
    })
  );
  return buildPortfolio({
    entries: [entry('a1', '2024-01-02', [{ ticker: 'ACME', weight: 0.4 }])],
    prices,
    config: config({ inception: '2024-01-02', riskFreeRate: 0, costBps: 10 }),
  });
}

test('(a) index, TWR, turnover and the deferred inception-day cost', () => {
  const snap = fixtureA();
  const idx = snap.series[0].points.map((p) => p.v);
  assert.deepEqual(
    snap.series[0].points.map((p) => p.d),
    ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05']
  );
  near(idx[0], 100, 0, 'I(01-02) is 100 by contract');
  near(idx[1], 2549 / 25, 1e-12, 'I(01-03)');
  near(idx[2], 644897 / 6375, 1e-12, 'I(01-04)');
  near(idx[3], 219214 / 2125, 1e-12, 'I(01-05)');
  near(snap.stats.twr, 3357 / 106250, 1e-12, 'TWR');
  near(snap.stats.turnover, 0.4, 1e-12, 'turnover');
  assert.equal(snap.stats.decisionCount, 1);
  assert.equal(snap.stats.positionCount, 1);
  assert.equal(snap.stats.closedCount, 0);
});

test('(a) contributions close on TWR exactly', () => {
  const snap = fixtureA();
  const acme = snap.positions.find((p) => p.ticker === 'ACME');
  near(acme.contribution, 0.03199529411764706, 1e-9, 'ACME contribution');
  near(snap.attribution.cash, 0, 1e-15, 'CASH contribution (rf = 0)');
  near(snap.attribution.costs, -0.0004, 1e-15, 'cost bucket');
  assertIdentity(snap, 1e-12);
});

test('(a) short history nulls the annualised and risk figures', () => {
  const snap = fixtureA();
  assert.equal(snap.stats.volatility, null);
  assert.equal(snap.stats.sharpe, null);
  assert.equal(snap.stats.hitRate, null);
  assert.equal(snap.stats.twrAnnualized, null);
  assert.equal(snap.positions[0].return1M, null); // fewer than 31 grid days
});

test('(a) weights drift and stay normalised', () => {
  const snap = fixtureA();
  near(snap.positions[0].weight, 18 / 43, 1e-12, 'w_ACME(01-05)');
  near(snap.positions[0].weightAtLastDecision, 0.4, 1e-12, 'w at last decision');
  assert.equal(snap.positions[0].openedAt, '2024-01-02');
});

// ---------------------------------------------------------------------------
// (b) EUR + USD, an FX move, a decision on day 2
// ---------------------------------------------------------------------------

function fixtureB() {
  const prices = createPrices(
    priceData({
      'EUROA.DE': {
        currency: 'EUR',
        px: { '2024-03-01': 50, '2024-03-04': 51, '2024-03-05': 52.02, '2024-03-06': 52.02 },
      },
      USTECH: {
        currency: 'USD',
        px: { '2024-03-01': 200, '2024-03-04': 205, '2024-03-05': 210, '2024-03-06': 220.5 },
      },
      'USDEUR=X': {
        currency: 'EUR',
        px: { '2024-03-01': 0.9, '2024-03-04': 0.9, '2024-03-05': 0.92, '2024-03-06': 0.92 },
      },
    })
  );
  return buildPortfolio({
    entries: [
      entry(
        'd1',
        '2024-03-01',
        [
          { ticker: 'EUROA.DE', weight: 0.5 },
          { ticker: 'USTECH', weight: 0.3 },
        ],
        { costBps: 0 }
      ),
      entry(
        'd2',
        '2024-03-05',
        [
          { ticker: 'EUROA.DE', portion: 0.3 },
          { ticker: 'USTECH', weight: 0.45 },
        ],
        { costBps: 25 }
      ),
    ],
    prices,
    config: config({ inception: '2024-03-01', riskFreeRate: 0, costBps: 10 }),
  });
}

test('(b) the FX return is joint, not the sum of price and currency', () => {
  const prices = createPrices(
    priceData({
      USTECH: { currency: 'USD', px: { '2024-03-04': 205, '2024-03-05': 210 } },
      'USDEUR=X': { currency: 'EUR', px: { '2024-03-04': 0.9, '2024-03-05': 0.92 } },
    })
  );
  const r = prices.returnBetween('USTECH', '2024-03-04', '2024-03-05');
  near(r, 29 / 615, 1e-15, 'joint return');
  near(r, 0.04715447154471544, 1e-12, 'joint return');
  assert.ok(Math.abs(r - 0.04661246612466125) > 1e-6, 'must not be the naive sum');
});

test('(b) index, weights and the same-day cost', () => {
  const snap = fixtureB();
  const idx = snap.series[0].points.map((p) => p.v);
  near(idx[1], 407 / 4, 1e-12, 'I(03-04)');
  near(idx[2], 321713737 / 3088000, 1e-9, 'I(03-05) — the cost hits day 2');
  near(idx[3], 131580918433 / 1235200000, 1e-9, 'I(03-06)');
  near(snap.stats.twr, 8060918433 / 123520000000, 1e-12, 'TWR');
  near(snap.stats.turnover, 0.8 + 289 / 1930, 1e-12, 'turnover');
});

test('(b) `portion` resolves against the POST-drift weight', () => {
  const snap = fixtureB();
  const leg = snap.outcomes.d2.legs.find((l) => l.ticker === 'EUROA.DE');
  near(leg.weightBefore, 289 / 579, 1e-12, 'w̃ before D2');
  near(leg.weightAfter, 2023 / 5790, 1e-12, 'w after D2 (0.349396, not 0.35)');
  assert.equal(leg.direction, 'down');
  assert.equal(snap.outcomes.d2.kind, 'rebalance');
});

test('(b) contributions close on TWR', () => {
  const snap = fixtureB();
  const byTicker = Object.fromEntries(snap.positions.map((p) => [p.ticker, p.contribution]));
  near(byTicker['EUROA.DE'], 0.0202, 1e-12, 'EUROA.DE contribution');
  near(byTicker.USTECH, 0.045440925, 1e-8, 'USTECH contribution');
  near(snap.attribution.costs, -0.000380897, 1e-8, 'cost bucket');
  assertIdentity(snap, 1e-12);
});

test('(b) weights sum to 1 on every day', () => {
  const snap = fixtureB();
  assert.ok(!codes(snap).includes('W-WEIGHT-SUM'));
  const total = snap.positions.reduce((a, p) => a + p.weight, 0);
  assert.ok(total < 1 && total > 0.8, 'the rest is cash');
});

// ---------------------------------------------------------------------------
// (c) full exit into CASH at a non-zero risk-free rate, then re-entry
// ---------------------------------------------------------------------------

function fixtureC() {
  const prices = createPrices(
    priceData({
      DIVCO: {
        currency: 'EUR',
        px: {
          '2024-06-03': 20,
          '2024-06-04': 21,
          '2024-06-05': 21.42,
          '2024-06-06': 21,
          '2024-06-07': 20.58,
          '2024-06-10': 21,
        },
      },
    })
  );
  return buildPortfolio({
    entries: [
      entry('c1', '2024-06-03', [{ ticker: 'DIVCO', weight: 1 }], { costBps: 0 }),
      entry('c2', '2024-06-05', [{ ticker: 'DIVCO', action: 'sell' }], { costBps: 0 }),
      entry('c3', '2024-06-07', [{ ticker: 'DIVCO', weight: 1 }], { costBps: 0 }),
    ],
    prices,
    config: config({ inception: '2024-06-03', riskFreeRate: 0.02, costBps: 0 }),
  });
}

test('(c) an all-CASH stretch earns exactly the risk-free accrual', () => {
  const snap = fixtureC();
  const idx = snap.series[0].points.map((p) => p.v);
  const daily = Math.pow(1.02, 1 / 365) - 1;
  near(idx[0], 100, 0);
  near(idx[1], 105, 1e-12, 'I(06-04)');
  near(idx[2], 107.1, 1e-12, 'I(06-05)');
  // DIVCO fell 2% on 06-06 and the book, being all cash, did not follow it.
  near(idx[3], 107.1 * (1 + daily), 1e-12, 'I(06-06)');
  near(idx[4], 107.1 * (1 + daily) ** 2, 1e-12, 'I(06-07)');
  near(idx[5], 107.1 * (1 + daily) ** 2 * (21 / 20.58), 1e-12, 'I(06-10)');
  near(idx[3], 107.1058107368, 1e-6, 'spec value');
  near(idx[5], 109.2975732539, 1e-6, 'spec value');
  near(snap.stats.twr, 1.05 * 1.02 * (1 + daily) ** 2 * (21 / 20.58) - 1, 1e-12, 'TWR closed form');
  near(snap.stats.twr, 0.0929757325, 1e-9, 'TWR');
  near(snap.stats.turnover, 3, 1e-12, 'turnover');
  assert.equal(snap.stats.decisionCount, 3);
});

test('(c) the weekend gap is not on the grid but is paid interest', () => {
  const snap = fixtureC();
  assert.deepEqual(
    snap.series[0].points.map((p) => p.d),
    ['2024-06-03', '2024-06-04', '2024-06-05', '2024-06-06', '2024-06-07', '2024-06-10']
  );
  // 06-07 -> 06-10 is a 3-calendar-day gap, but CASH is 0 across it, so the
  // three-day accrual is not earned: the last day is pure DIVCO.
  const idx = snap.series[0].points.map((p) => p.v);
  near(idx[5] / idx[4] - 1, 1 / 49, 1e-12, 'r_p(06-10)');
});

test('(c) openedAt resets on re-entry: one closed row, one live row', () => {
  const snap = fixtureC();
  assert.equal(snap.stats.positionCount, 1);
  assert.equal(snap.stats.closedCount, 1);

  const dead = snap.closed[0];
  assert.equal(dead.ticker, 'DIVCO');
  assert.equal(dead.openedAt, '2024-06-03');
  assert.equal(dead.closedAt, '2024-06-05');
  assert.equal(dead.heldDays, 2);
  near(dead.returnWhileHeld, 0.071, 1e-12, 'returnWhileHeld');
  near(dead.returnSinceExit, -1 / 51, 1e-12, 'returnSinceExit');
  assert.equal(dead.benchmarkReturn, null);
  assert.equal(dead.excess, null);
  near(dead.contribution, 0.071, 1e-12, 'episode #1 contribution');
  assert.deepEqual(dead.entrySlugs, ['c2', 'c1']);

  const live = snap.positions[0];
  assert.equal(live.openedAt, '2024-06-07'); // reset, not 06-03
  assert.equal(live.lastDecisionAt, '2024-06-07');
  near(live.weight, 1, 1e-12);
  near(live.weightAtLastDecision, 1, 1e-12);
  near(live.returnSinceOpen, 21 / 20.58 - 1, 1e-12, 'returnSinceOpen');
  near(live.contribution, 0.0218595147, 1e-9, 'episode #2 contribution');
  assert.equal(live.return1M, null);
});

test('(c) CASH is its own bucket and the identity closes', () => {
  const snap = fixtureC();
  near(snap.attribution.cash, 0.0001162179, 1e-9, 'CASH contribution');
  near(snap.attribution.costs, 0, 1e-15, 'no costs at 0 bps');
  assertIdentity(snap, 1e-12);
});

test('(c) derived move kinds', () => {
  const snap = fixtureC();
  assert.equal(snap.outcomes.c1.kind, 'open');
  assert.equal(snap.outcomes.c2.kind, 'exit');
  assert.equal(snap.outcomes.c3.kind, 'open'); // a clean re-entry is a new open
  assert.deepEqual(
    snap.markers.map((m) => m.label),
    ['+ DIVCO', '− DIVCO', '+ DIVCO']
  );
  near(snap.markers[0].v, 100, 1e-12, 'marker sits on the index');
});

// ---------------------------------------------------------------------------
// (d) the benchmark join
// ---------------------------------------------------------------------------

test('(d) interval compounding matches the benchmark calendar', () => {
  const grid = [
    '2024-01-02',
    '2024-01-03',
    '2024-01-04',
    '2024-01-05',
    '2024-01-06',
    '2024-01-07',
    '2024-01-08',
  ];
  const rp = [0.01, -0.02, 0.015, 0.004, -0.002, 0.008];
  const idx = [100];
  for (const r of rp) idx.push(idx[idx.length - 1] * (1 + r));
  const indexByDate = new Map(grid.map((d, i) => [d, idx[i]]));

  const obs = ['2024-01-02', '2024-01-03', '2024-01-04', '2024-01-05', '2024-01-08'];
  const tr = new Map([
    ['2024-01-02', 100.0],
    ['2024-01-03', 100.8],
    ['2024-01-04', 99.2],
    ['2024-01-05', 100.1],
    ['2024-01-08', 101.0],
  ]);
  const indexAt = (d) => indexByDate.get(d) ?? null;
  const levelAt = (d) => tr.get(d) ?? null;

  const { pairs, tBase, spanDays } = buildRegressionPairs(
    obs,
    grid,
    indexAt,
    levelAt,
    '2024-01-02',
    '2024-01-08'
  );
  assert.equal(tBase, '2024-01-02');
  assert.equal(pairs.length, 4);
  assert.equal(spanDays, 6);
  near(pairs[3].rp, 1.004 * 0.998 * 1.008 - 1, 1e-12, 'Sat+Sun+Mon compounded');
  near(pairs[3].rp, 0.010007936, 1e-12);
  near(pairs[3].rb, 0.008991008991008993, 1e-12);

  const stats = regressionStats(pairs, 0.02, spanDays);
  assert.equal(stats.annualisation, 244);
  near(stats.beta, 1.291642, 1e-6, 'beta');
  near(stats.correlation, 0.991604, 1e-6, 'correlation');
  near(stats.alpha, 0.125597, 1e-6, 'annualised alpha');

  // Negative control: zipping the six daily r_p against the four r_b by index
  // gives 1.206213. The implementation must be incapable of producing it.
  const naive = regressionStats(
    rp.slice(0, 4).map((r, i) => ({ rp: r, rb: pairs[i].rb })),
    0.02,
    spanDays
  );
  near(naive.beta, 1.206213, 1e-6, 'the wrong answer, for reference');
  assert.ok(Math.abs(stats.beta - naive.beta) > 0.05, 'the join must not degenerate to a zip');
});

// ---------------------------------------------------------------------------
// (e) risk estimators
// ---------------------------------------------------------------------------

test('(e) volatility, Sharpe and hit rate', () => {
  const m = riskMetrics([0.01, -0.02, 0.015, 0.0, 0.005], 252, 0.02);
  near(m.meanLog, 0.001924755508, 1e-12, 'mean log return');
  near(m.sdLog, 0.013557114373, 1e-12, 'sample sd of log returns');
  near(m.volatility, 0.215212518765, 1e-12, 'annualised volatility');
  near(m.sharpe, 2.161750456762, 1e-11, 'Sharpe');
  near(m.hitRate, 0.6, 1e-15, 'the exact zero is in the denominator');
});

// ---------------------------------------------------------------------------
// degenerate inputs
// ---------------------------------------------------------------------------

test('an empty log renders: index of one point, no positions', () => {
  const prices = createPrices(
    priceData({ ACME: { currency: 'EUR', px: { '2024-01-02': 100, '2024-01-03': 105 } } })
  );
  const snap = buildPortfolio({ entries: [], prices, config: config({ inception: '2024-01-02' }) });
  assert.equal(snap.stats.twr, 0);
  assert.deepEqual(snap.positions, []);
  assert.deepEqual(snap.closed, []);
  assert.deepEqual(snap.markers, []);
  assert.deepEqual(snap.outcomes, {});
  assert.equal(snap.series[0].points.length, 1);
  assert.equal(snap.series[0].points[0].v, 100);
  assert.equal(snap.stats.returns.inception, 0);
  assert.equal(snap.stats.maxDrawdown, null);
  assertIdentity(snap);
});

test('a missing price cache renders instead of throwing', () => {
  const prices = createPrices(null);
  const snap = buildPortfolio({
    entries: [entry('x', '2024-08-22', [{ ticker: 'AAPL', weight: 0.1 }])],
    prices,
    config: config({ inception: '2024-08-21' }),
    asOf: '2024-09-30',
  });
  assert.equal(snap.stats.twr, 0);
  assert.equal(snap.positions.length, 0);
  assert.ok(codes(snap).includes('W-UNKNOWN-TICKER'));
  assert.equal(snap.pricesFetchedAt, '');
  assertIdentity(snap);
});

// ---------------------------------------------------------------------------
// snapping, weights and the deposit path
// ---------------------------------------------------------------------------

const FLAT = {
  A: { currency: 'EUR', px: {} },
  B: { currency: 'EUR', px: {} },
};
for (const d of [
  '2024-01-02',
  '2024-01-03',
  '2024-01-04',
  '2024-01-05',
  '2024-01-08',
  '2024-01-09',
]) {
  FLAT.A.px[d] = 10;
  FLAT.B.px[d] = 20;
}

test('a decision dated on a weekend snaps forward to the next trading day', () => {
  const prices = createPrices(priceData(FLAT));
  const snap = buildPortfolio({
    entries: [
      // 2024-01-06 is a Saturday: a fill cannot happen on a day the market was shut.
      entry('w1', '2024-01-06', [{ ticker: 'A', weight: 0.5 }]),
    ],
    prices,
    config: config({ inception: '2024-01-02' }),
  });
  assert.ok(codes(snap).includes('W-SNAP'));
  assert.equal(snap.outcomes.w1.date, '2024-01-08');
  assert.equal(snap.positions[0].openedAt, '2024-01-08');
  assert.ok(!snap.series[0].points.some((p) => p.d === '2024-01-06'));
});

test('a leg before the instrument has any history snaps to its first day', () => {
  const prices = createPrices(
    priceData({
      LATE: { currency: 'EUR', px: { '2024-01-08': 50, '2024-01-09': 55 } },
      A: FLAT.A,
    })
  );
  const snap = buildPortfolio({
    entries: [entry('l1', '2024-01-03', [{ ticker: 'LATE', weight: 0.5 }])],
    prices,
    config: config({ inception: '2024-01-02' }),
  });
  assert.ok(codes(snap).includes('W-SNAP-FIRST'));
  assert.equal(snap.positions[0].openedAt, '2024-01-08');
});

test('declared weights above the book shrink the untouched holdings (the deposit path)', () => {
  const prices = createPrices(priceData(FLAT));
  const snap = buildPortfolio({
    entries: [
      entry('p1', '2024-01-02', [
        { ticker: 'A', weight: 0.5 },
        { ticker: 'B', weight: 0.3 },
      ]),
      // A alone to 0.9: S = 0.9, U = 0.3 (B), R = -0.2. Cash is exhausted and B
      // shrinks proportionally to 0.1 — in weight terms, that is a deposit.
      entry('p2', '2024-01-03', [{ ticker: 'A', weight: 0.9 }]),
    ],
    prices,
    config: config({ inception: '2024-01-02', costBps: 0 }),
  });
  const byTicker = Object.fromEntries(snap.positions.map((p) => [p.ticker, p.weight]));
  near(byTicker.A, 0.9, 1e-12, 'A');
  near(byTicker.B, 0.1, 1e-12, 'B scaled by (1-S)/U');
  near(byTicker.A + byTicker.B, 1, 1e-12, 'cash is gone; weights still sum to 1');
  assert.ok(!codes(snap).includes('W-OVERALLOC'));
});

test('declared weights over 1 with nothing to fund them are clamped and warned', () => {
  const prices = createPrices(priceData(FLAT));
  const snap = buildPortfolio({
    entries: [
      entry('o1', '2024-01-02', [
        { ticker: 'A', weight: 0.8 },
        { ticker: 'B', weight: 0.6 },
      ]),
    ],
    prices,
    config: config({ inception: '2024-01-02', costBps: 0 }),
  });
  assert.ok(codes(snap).includes('W-OVERALLOC'));
  const byTicker = Object.fromEntries(snap.positions.map((p) => [p.ticker, p.weight]));
  near(byTicker.A, 0.8 / 1.4, 1e-12, 'A clamped proportionally');
  near(byTicker.B, 0.6 / 1.4, 1e-12, 'B clamped proportionally');
  near(byTicker.A + byTicker.B, 1, 1e-12);
});

test('a pinned CASH leg is honoured and the instruments absorb the imbalance', () => {
  const prices = createPrices(priceData(FLAT));
  const snap = buildPortfolio({
    entries: [
      entry('c1', '2024-01-02', [
        { ticker: 'A', weight: 0.4 },
        { ticker: 'B', weight: 0.4 },
      ]),
      entry('c2', '2024-01-03', [{ ticker: 'CASH', weight: 0.5 }]),
    ],
    prices,
    config: config({ inception: '2024-01-02', costBps: 0 }),
  });
  const byTicker = Object.fromEntries(snap.positions.map((p) => [p.ticker, p.weight]));
  near(byTicker.A, 0.25, 1e-12, 'A scaled by (1-S)/U');
  near(byTicker.B, 0.25, 1e-12, 'B scaled by (1-S)/U');
  near(byTicker.A + byTicker.B, 0.5, 1e-12, 'the other half is the pinned cash');
});

test('a ticker exited and later re-opened produces two disjoint episodes', () => {
  const prices = createPrices(priceData(FLAT));
  const snap = buildPortfolio({
    entries: [
      entry('e1', '2024-01-02', [{ ticker: 'A', weight: 0.6 }], { costBps: 0 }),
      entry('e2', '2024-01-03', [{ ticker: 'A', action: 'sell' }], { costBps: 0 }),
      entry('e3', '2024-01-05', [{ ticker: 'A', weight: 0.4 }], { costBps: 0 }),
    ],
    prices,
    config: config({ inception: '2024-01-02', costBps: 0 }),
  });
  assert.equal(snap.closed.length, 1);
  assert.equal(snap.closed[0].openedAt, '2024-01-02');
  assert.equal(snap.closed[0].closedAt, '2024-01-03');
  assert.equal(snap.positions.length, 1);
  assert.equal(snap.positions[0].openedAt, '2024-01-05');
  assert.ok(!snap.positions[0].entrySlugs.includes('e1'), 'no shared history');
  assertIdentity(snap);
});

test('legs before inception and unknown tickers are dropped with warnings', () => {
  const prices = createPrices(priceData(FLAT));
  const snap = buildPortfolio({
    entries: [
      entry('b1', '2023-12-29', [{ ticker: 'A', weight: 0.5 }]),
      entry('b2', '2024-01-03', [{ ticker: 'NOPE', weight: 0.5 }]),
    ],
    prices,
    config: config({ inception: '2024-01-02' }),
  });
  assert.ok(codes(snap).includes('W-PRE-INCEPTION'));
  assert.ok(codes(snap).includes('W-UNKNOWN-TICKER'));
  assert.equal(snap.positions.length, 0);
});

// ---------------------------------------------------------------------------
// currency handling
// ---------------------------------------------------------------------------

test('a GBp (pence) holding converts through GBP, not through pence', () => {
  const prices = createPrices(
    priceData({
      'CIBR.L': { currency: 'GBp', px: { '2024-01-02': 500, '2024-01-03': 550 } },
      'GBPEUR=X': { currency: 'EUR', px: { '2024-01-02': 1.2, '2024-01-03': 1.2 } },
    })
  );
  // 500 pence = £5.00 = €6.00 — not €600, which is what a missed /100 gives.
  near(prices.levelInBase('CIBR.L', '2024-01-02'), 6, 1e-12, 'level in EUR');
  near(prices.levelInBase('CIBR.L', '2024-01-03'), 6.6, 1e-12, 'level in EUR');
  near(prices.returnBetween('CIBR.L', '2024-01-02', '2024-01-03'), 0.1, 1e-12, 'return');
  assert.equal(prices.meta('CIBR.L').currency, 'GBP');
  assert.equal(prices.currencyOf('CIBR.L'), 'GBP');

  const snap = buildPortfolio({
    entries: [entry('g1', '2024-01-02', [{ ticker: 'CIBR.L', weight: 0.5 }], { costBps: 0 })],
    prices,
    config: config({ inception: '2024-01-02' }),
  });
  near(snap.stats.twr, 0.05, 1e-12, 'half a book up 10%');
  assert.equal(snap.positions[0].currency, 'GBP');
  assertIdentity(snap);
});

test('FX resolves in either orientation and the joint return is unchanged', () => {
  const direct = createPrices(
    priceData({
      US: { currency: 'USD', px: { '2024-01-02': 100, '2024-01-03': 110 } },
      'USDEUR=X': { currency: 'EUR', px: { '2024-01-02': 0.9, '2024-01-03': 0.95 } },
    })
  );
  const inverse = createPrices(
    priceData({
      US: { currency: 'USD', px: { '2024-01-02': 100, '2024-01-03': 110 } },
      'EURUSD=X': { currency: 'USD', px: { '2024-01-02': 1 / 0.9, '2024-01-03': 1 / 0.95 } },
    })
  );
  const a = direct.returnBetween('US', '2024-01-02', '2024-01-03');
  const b = inverse.returnBetween('US', '2024-01-02', '2024-01-03');
  near(a, (110 * 0.95) / (100 * 0.9) - 1, 1e-12, 'joint return');
  near(b, a, 1e-12, 'inverse pair gives the same answer');
});

test('a currency with no FX series excludes the ticker entirely', () => {
  const prices = createPrices(
    priceData({
      JP: { currency: 'JPY', px: { '2024-01-02': 100, '2024-01-03': 110 } },
      A: FLAT.A,
    })
  );
  const snap = buildPortfolio({
    entries: [entry('j1', '2024-01-02', [{ ticker: 'JP', weight: 0.5 }])],
    prices,
    config: config({ inception: '2024-01-02' }),
  });
  assert.ok(codes(snap).includes('W-NO-FX'));
  assert.equal(snap.positions.length, 0);
  assert.equal(snap.stats.twr, 0);
});

test('an FX pair quoting past the last instrument day does not extend the horizon', () => {
  const prices = createPrices(
    priceData({
      US: { currency: 'USD', px: { '2024-01-02': 100, '2024-01-03': 110 } },
      'USDEUR=X': {
        currency: 'EUR',
        px: { '2024-01-02': 0.9, '2024-01-03': 0.9, '2024-01-07': 0.95 },
      },
    })
  );
  assert.equal(prices.lastDate, '2024-01-03');
  const snap = buildPortfolio({
    entries: [entry('f1', '2024-01-02', [{ ticker: 'US', weight: 1 }], { costBps: 0 })],
    prices,
    config: config({ inception: '2024-01-02' }),
  });
  assert.equal(snap.stats.asOf, '2024-01-03');
  near(snap.stats.twr, 0.1, 1e-12, 'the Sunday FX print is not in the track record');
});

test('a held ticker that stopped printing is flagged, not silently frozen', () => {
  // A keeps trading for 15 days; DEAD printed once and never again.
  const long = {
    A: { currency: 'EUR', px: {} },
    DEAD: { currency: 'EUR', px: { '2024-01-02': 10 } },
  };
  for (let i = 0; i < 15; i++) long.A.px[`2024-01-${String(2 + i).padStart(2, '0')}`] = 10;
  const p2 = createPrices(priceData(long));
  const snap = buildPortfolio({
    entries: [
      entry('s1', '2024-01-02', [
        { ticker: 'A', weight: 0.5 },
        { ticker: 'DEAD', weight: 0.5 },
      ]),
    ],
    prices: p2,
    config: config({ inception: '2024-01-02' }),
  });
  assert.ok(codes(snap).includes('W-STALE'));
});

// ---------------------------------------------------------------------------
// benchmarks
// ---------------------------------------------------------------------------

test('benchmarks are rebased to 100 at inception and compared over the same range', () => {
  const prices = createPrices(
    priceData({
      A: FLAT.A,
      BENCH: { currency: 'EUR', px: { '2024-01-02': 200, '2024-01-03': 210, '2024-01-09': 220 } },
      '^IDX': { currency: 'EUR', px: { '2024-01-05': 50, '2024-01-09': 55 } },
    })
  );
  const snap = buildPortfolio({
    entries: [entry('b1', '2024-01-02', [{ ticker: 'A', weight: 1 }], { costBps: 0 })],
    prices,
    config: config({
      inception: '2024-01-02',
      benchmarks: [
        { symbol: 'BENCH', label: 'Bench', primary: true },
        { symbol: '^IDX', label: 'Index' },
      ],
    }),
  });
  const bench = snap.series.find((s) => s.symbol === 'BENCH');
  near(bench.points[0].v, 100, 1e-12, 'rebased at inception');
  near(bench.points[bench.points.length - 1].v, 110, 1e-12, '200 -> 220');
  near(snap.benchmarks[0].twr, 0.1, 1e-12);
  near(snap.benchmarks[0].excess, snap.stats.twr - 0.1, 1e-12);
  assert.equal(snap.benchmarks[0].beta, null, 'too few pairs to regress');

  // A price-only index and a benchmark that starts late both have to say so.
  assert.ok(codes(snap).includes('W-PRICE-ONLY-INDEX'));
  assert.ok(codes(snap).includes('W-BENCH-LATE'));
  const late = snap.series.find((s) => s.symbol === '^IDX');
  assert.equal(late.points[0].d, '2024-01-05', 'starts where its data does; never back-filled');
});

// ---------------------------------------------------------------------------
// a long run: trailing windows, annualisation, the risk gates and the join
// ---------------------------------------------------------------------------

function longRun() {
  // Deterministic pseudo-random walk over ~2 years of weekdays. Two calendars:
  // the instrument trades every weekday, the benchmark skips every 7th one, so
  // the regression has to match intervals rather than zip arrays.
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5);

  const inst = { currency: 'USD', px: {} };
  const bench = { currency: 'EUR', px: {} };
  const fx = { currency: 'EUR', px: {} };
  let p = 100;
  let b = 200;
  let x = 0.9;
  const day = new Date(Date.UTC(2023, 0, 2));
  let n = 0;
  const dates = [];
  while (dates.length < 520) {
    const dow = day.getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const d = day.toISOString().slice(0, 10);
      dates.push(d);
      p *= 1 + rand() * 0.03 + 0.0006;
      b *= 1 + rand() * 0.02 + 0.0004;
      x *= 1 + rand() * 0.006;
      inst.px[d] = p;
      fx.px[d] = x;
      if (n++ % 7 !== 3) bench.px[d] = b; // the benchmark's exchange shuts sometimes
    }
    day.setUTCDate(day.getUTCDate() + 1);
  }

  const prices = createPrices(priceData({ INST: inst, BENCH: bench, 'USDEUR=X': fx }));
  const inception = dates[0];
  const snap = buildPortfolio({
    entries: [
      entry('L1', inception, [{ ticker: 'INST', weight: 0.6 }]),
      entry('L2', dates[100], [{ ticker: 'INST', scale: 1.2 }]),
      entry('L3', dates[300], [{ ticker: 'INST', portion: 0.25 }]),
    ],
    prices,
    config: config({
      inception,
      riskFreeRate: 0.02,
      costBps: 10,
      benchmarks: [{ symbol: 'BENCH', label: 'Bench', primary: true }],
    }),
  });
  return { snap, dates, inception };
}

test('long run: trailing windows read off the index at the right anchors', () => {
  const { snap, dates } = longRun();
  const pts = snap.series[0].points;
  const end = pts[pts.length - 1].v;
  const asOf = snap.stats.asOf;
  assert.equal(asOf, dates[dates.length - 1]);

  const anchorValue = (anchor) => {
    let v = null;
    for (const pt of pts) if (pt.d <= anchor) v = pt.v;
    return v;
  };
  const iso = (y, m, d) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
  const [Y, M, D] = asOf.split('-').map(Number);

  near(snap.stats.returns.m1, end / anchorValue(iso(Y, M - 2, D)) - 1, 1e-12, 'm1');
  near(snap.stats.returns.m3, end / anchorValue(iso(Y, M - 4, D)) - 1, 1e-12, 'm3');
  near(snap.stats.returns.m6, end / anchorValue(iso(Y, M - 7, D)) - 1, 1e-12, 'm6');
  near(snap.stats.returns.y1, end / anchorValue(iso(Y - 1, M - 1, D)) - 1, 1e-12, 'y1');
  near(snap.stats.returns.ytd, end / anchorValue(`${Y - 1}-12-31`) - 1, 1e-12, 'ytd');
  near(snap.stats.returns.inception, snap.stats.twr, 1e-15, 'inception window is the TWR');
});

test('month arithmetic clamps day-of-month overflow (31 Mar − 1M = 29 Feb)', () => {
  const px = {};
  const d = new Date(Date.UTC(2024, 0, 31));
  let v = 100;
  while (d <= new Date(Date.UTC(2024, 2, 31))) {
    px[d.toISOString().slice(0, 10)] = v;
    v *= 1.001; // a strictly rising book, so a mis-anchored window is visible
    d.setUTCDate(d.getUTCDate() + 1);
  }
  const prices = createPrices(priceData({ DAILY: { currency: 'EUR', px } }));
  const snap = buildPortfolio({
    entries: [entry('m1', '2024-01-31', [{ ticker: 'DAILY', weight: 1 }], { costBps: 0 })],
    prices,
    config: config({ inception: '2024-01-31' }),
  });
  assert.equal(snap.stats.asOf, '2024-03-31');
  const at = (date) => snap.series[0].points.find((p) => p.d === date).v;
  const end = at('2024-03-31');
  near(snap.stats.returns.m1, end / at('2024-02-29') - 1, 1e-12, 'clamped to the end of February');
  assert.ok(
    Math.abs(snap.stats.returns.m1 - (end / at('2024-03-02') - 1)) > 1e-6,
    'must not roll over into March'
  );
});

test('long run: risk, annualisation and the regression all come off the gate', () => {
  const { snap } = longRun();
  assert.ok(snap.stats.volatility > 0, 'volatility');
  assert.ok(snap.stats.sharpe !== null, 'sharpe');
  assert.ok(snap.stats.hitRate > 0 && snap.stats.hitRate < 1, 'hit rate');
  assert.ok(snap.stats.twrAnnualized !== null, 'CAGR');

  const days = Math.round(
    (Date.parse(snap.stats.asOf) - Date.parse(snap.stats.inception)) / 86400000
  );
  near(
    snap.stats.twrAnnualized,
    (1 + snap.stats.twr) ** (365.25 / days) - 1,
    1e-12,
    'CAGR uses calendar time'
  );

  const dd = snap.stats.maxDrawdown;
  assert.ok(dd && dd.depth < 0 && dd.peak <= dd.trough, 'a drawdown window');

  const bench = snap.benchmarks[0];
  assert.ok(bench.beta !== null && bench.alpha !== null, 'enough pairs to regress');
  assert.ok(bench.correlation > -1 && bench.correlation < 1, 'correlation in range');
  assert.ok(bench.volatility > 0);
  near(bench.excess, snap.stats.twr - bench.twr, 1e-12, 'excess is a difference of fractions');

  assert.ok(snap.positions[0].benchmarkSinceOpen !== null);
  assert.ok(snap.positions[0].return1M !== null, '31+ grid days exist');
  assertIdentity(snap);
});

test('long run: the identity closes with costs, scale and portion legs', () => {
  const { snap } = longRun();
  assert.ok(snap.attribution.costs < 0, 'churn costs something');
  assert.ok(snap.stats.turnover > 0);
  near(
    snap.attribution.live + snap.attribution.exited + snap.attribution.cash + snap.attribution.costs,
    snap.stats.twr,
    1e-12,
    'contributions sum to TWR'
  );
});

// ---------------------------------------------------------------------------
// double-down
// ---------------------------------------------------------------------------

test('adding to a losing position is a double-down; adding to a winner is not', () => {
  const px = (v3, v4) => ({
    DOWN: { currency: 'EUR', px: { '2024-01-02': 100, '2024-01-03': v3, '2024-01-04': v4 } },
  });
  const build = (v3) => {
    const prices = createPrices(priceData(px(v3, v3)));
    return buildPortfolio({
      entries: [
        entry('t1', '2024-01-02', [{ ticker: 'DOWN', weight: 0.2 }], { costBps: 0 }),
        entry('t2', '2024-01-03', [{ ticker: 'DOWN', weight: 0.4 }], { costBps: 0 }),
      ],
      prices,
      config: config({ inception: '2024-01-02', costBps: 0 }),
    });
  };
  const losing = build(80);
  assert.equal(losing.outcomes.t2.isDoubleDown, true);
  assert.equal(losing.outcomes.t2.kind, 'add');
  assert.equal(losing.markers.find((m) => m.title === 't2').isDoubleDown, true);

  const winning = build(120);
  assert.equal(winning.outcomes.t2.isDoubleDown, false);
  assert.equal(winning.outcomes.t1.isDoubleDown, false, 'an open is never a double-down');
});

test('buying back cheaper after a clean exit is not a double-down', () => {
  const prices = createPrices(
    priceData({
      X: {
        currency: 'EUR',
        px: { '2024-01-02': 100, '2024-01-03': 80, '2024-01-04': 70, '2024-01-05': 60 },
      },
    })
  );
  const snap = buildPortfolio({
    entries: [
      entry('x1', '2024-01-02', [{ ticker: 'X', weight: 0.5 }], { costBps: 0 }),
      entry('x2', '2024-01-03', [{ ticker: 'X', action: 'sell' }], { costBps: 0 }),
      entry('x3', '2024-01-04', [{ ticker: 'X', weight: 0.5 }], { costBps: 0 }),
      entry('x4', '2024-01-05', [{ ticker: 'X', weight: 0.8 }], { costBps: 0 }),
    ],
    prices,
    config: config({ inception: '2024-01-02', costBps: 0 }),
  });
  assert.equal(snap.outcomes.x3.isDoubleDown, false, 'the episode reset');
  assert.equal(snap.outcomes.x4.isDoubleDown, true, 'underwater within the new episode');
});

// ---------------------------------------------------------------------------
// the central constraint
// ---------------------------------------------------------------------------

test('no output field is denominated in currency', () => {
  const snap = fixtureB();
  const money = /(amount|price|paid|cost(?!s$|Bps)|fee|pnl|profit|loss|value|nav|balance|equity|shares|units|quantity|qty|xirr|eur|usd|deposit|withdraw)/i;
  const walk = (node, path) => {
    if (node == null) return;
    if (typeof node === 'number') {
      assert.ok(!money.test(path), `numeric field "${path}" reads as a monetary quantity`);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(snap, '');

  // The only currency-ish strings allowed are ISO codes naming the unit that
  // weights are *not* denominated in.
  assert.equal(snap.baseCurrency, 'EUR');
  const json = JSON.stringify(snap);
  assert.ok(!/[€$£]/.test(json), 'no currency symbols anywhere in the output');
  assert.ok(!('xirr' in snap.stats) && !('realised' in snap.stats));
});
