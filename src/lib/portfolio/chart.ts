/**
 * Build-time geometry model for the performance chart.
 *
 * Pure TypeScript: no DOM, no Astro, no dependencies. `buildChartModel()` turns
 * rebased index series plus decision markers into everything the component
 * needs to emit static markup — one pre-rendered layer per range, so range
 * switching is a CSS radio toggle and works with JavaScript disabled.
 *
 * TWO INVARIANTS WORTH KNOWING
 * ----------------------------
 * 1. PRIVACY. The only numbers that reach this module are index levels rebased
 *    to 100 at inception, and the only numbers that leave it are index levels,
 *    percentages, dates, slugs and coordinates. Nothing denominated in money
 *    can pass through: `assertNoAmounts()` throws in dev if a "level" is large
 *    enough to look like a currency amount. Because every series is rebased to
 *    100, a return since inception is just `level - 100`, so no second numeric
 *    payload is ever serialised.
 *
 * 2. GEOMETRY ONLY IN THE SVG. Each layer's viewBox is `0 0 (n-1) 1000` and is
 *    drawn with `preserveAspectRatio="none"`, so it stretches to any aspect
 *    ratio while `vector-effect="non-scaling-stroke"` keeps stroke widths
 *    exact. That shear is also why nothing round and nothing textual may live
 *    inside the SVG: circles would become ellipses and glyphs would smear.
 *    Markers, end caps, tick labels and the crosshair are therefore HTML
 *    positioned in percent over the same box — the mapping is exact and
 *    identical for both: `x% = i/(n-1)`, `y% = y/1000`.
 */

import type { ChartMarker, IndexSeries, IsoDate, MoveKind } from './types';
import {
  dateParts,
  dayOfWeek,
  deltaDirection,
  deltaGlyph,
  formatAxisDay,
  formatAxisMonth,
  formatAxisYear,
  formatCardDate,
  formatLevel,
  formatLongDate,
  formatSignedPercent,
  formatSpanDate,
  formatTick,
  isoAddMonths,
  isoStartOfYear,
  isoToDays,
  isValidIsoDate,
  round2,
} from './format';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type RangeKey = '1M' | '6M' | 'YTD' | '1Y' | 'ALL';

export const RANGE_KEYS: readonly RangeKey[] = ['1M', '6M', 'YTD', '1Y', 'ALL'];

export const RANGE_TITLES: Record<RangeKey, string> = {
  '1M': 'Last month',
  '6M': 'Last six months',
  YTD: 'Year to date',
  '1Y': 'Last year',
  ALL: 'Since inception',
};

export type MarkerArm = 'in' | 'out' | 'neutral';

/** Line style for one series. Index 0 is always the portfolio. */
export interface SeriesStyle {
  /** Stable key used in `data-series` / `data-key` attributes. */
  key: string;
  label: string;
  /** Uppercased label for the terminal-style readout. */
  readout: string;
  color: string;
  width: number;
  /** SVG `stroke-dasharray`, or `null` for a solid line. */
  dash: string | null;
  portfolio: boolean;
  /** Latest index level, or `null` when the series has no points. */
  latest: number | null;
  latestLabel: string;
  latestDelta: string;
  latestGlyph: string;
  latestDirection: 'up' | 'down' | 'flat';
}

export interface GridLine {
  /** SVG y, 0–1000. */
  y: number;
  level: number;
  label: string;
  /** Hidden below 640px to thin a dense lattice. */
  dense: boolean;
}

export interface XTick {
  /** Slot index within the layer. */
  i: number;
  /** Percent across the plot, 0–100. */
  x: number;
  label: string;
  /** Second line, printed only when the year changes. */
  sub: string | null;
  align: 'start' | 'mid' | 'end';
  dense: boolean;
}

export interface LinePath {
  key: string;
  color: string;
  width: number;
  dash: string | null;
  /** Slot index of the first drawn point — the crosshair needs this offset. */
  i0: number;
  /** Slot index of the last drawn point. */
  i1: number;
  /** `"0,412 1,408 …"`, integers only. */
  points: string;
}

export interface EndCap {
  key: string;
  color: string;
  x: number;
  y: number;
  /** `y`, nudged so two end labels in the right gutter cannot overlap. */
  labelY: number;
  label: string;
  ariaLabel: string;
}

export interface MarkerMember {
  dateLabel: string;
  moveLabel: string;
  title: string;
}

export interface MarkerNode {
  key: string;
  /** `'cluster'` collapses several decisions that would otherwise overlap. */
  glyph: MoveKind | 'cluster';
  arm: MarkerArm;
  /** `note` decisions have no trade, so they sit as a tick in the x gutter. */
  gutter: boolean;
  slot: number;
  x: number;
  y: number;
  href: string;
  ariaLabel: string;
  /** Card placement, computed at build time so it can never leave the plot. */
  flip: 'rt' | 'lt' | 'rb' | 'lb';
  count: number;
  date: IsoDate;
  dateLabel: string;
  title: string;
  moveLabel: string;
  tickers: string[];
  levelLabel: string | null;
  deltaLabel: string | null;
  members: MarkerMember[];
}

export interface RangeLayer {
  key: RangeKey;
  /** False when the window predates inception or is too short to be honest. */
  available: boolean;
  /** Number of trading-day slots. */
  n: number;
  /** viewBox width, `max(n - 1, 1)`. */
  vbWidth: number;
  from: IsoDate;
  to: IsoDate;
  /** Domain in scale space (already log-transformed when `yScale` is `log`). */
  dmin: number;
  dmax: number;
  /** SVG y of the 100 line, or `null` when 100 is outside the domain. */
  baselineY: number | null;
  /** Where the gain/loss wash splits. Equals `baselineY` when 100 is in view. */
  washSplitY: number;
  washSide: 'both' | 'gain' | 'loss';
  grid: GridLine[];
  xTicks: XTick[];
  lines: LinePath[];
  /** Portfolio polygon closed at the baseline, or `null`. */
  area: string | null;
  endcaps: EndCap[];
  markers: MarkerNode[];
  /** First slot date; the crosshair rebuilds every other date from `dd`. */
  t0: IsoDate;
  /** Two base-36 chars per slot: the day gap from the previous slot. */
  dd: string;
}

export interface TableRow {
  d: IsoDate;
  values: Array<string>;
}

export interface DecisionRow {
  d: IsoDate;
  moveLabel: string;
  title: string;
  tickers: string;
  href: string;
  levelLabel: string;
}

export interface ChartModel {
  /** True when there is nothing to draw; the component renders a note instead. */
  empty: boolean;
  yScale: 'linear' | 'log';
  series: SeriesStyle[];
  layers: RangeLayer[];
  /** Layers that earned a range button, in `RANGE_KEYS` order. */
  available: RangeLayer[];
  defaultRange: RangeKey;
  inception: IsoDate | null;
  asOf: IsoDate | null;
  /** Prose sentence for the `<figcaption>`. */
  summary: string;
  markerCount: number;
  tableRows: TableRow[];
  decisionRows: DecisionRow[];
}

export interface BuildChartModelOptions {
  series: IndexSeries[];
  markers?: ChartMarker[];
  defaultRange?: RangeKey;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Deliberately a deeper green than `--color-terminal-accent-green`, which is
 *  reserved for up/positive polarity. This one means "my line" and nothing else. */
const SERIES_PALETTE = ['#17b053', '#3b82f6', '#ec4899', '#a78bfa', '#2dd4bf'];

const MIN_RANGE_SLOTS = 10;
const PAD_FRACTION = 0.06;
/** Stops a quiet month rendering as a rollercoaster. */
const MIN_SPAN = 4;
/** Above this max/min ratio a linear axis stops being readable. */
const LOG_THRESHOLD = 3;
/** Percent-space clustering, calibrated at a 640px reference plot width. */
const CLUSTER_X_PCT = 2.5;
const CLUSTER_Y_PCT = 6;
const MAX_X_TICKS = 12;
/** An index level larger than this is not an index level. */
const MAX_PLAUSIBLE_LEVEL = 10_000;

const ARM_BY_KIND: Record<MoveKind, MarkerArm> = {
  open: 'in',
  add: 'in',
  trim: 'out',
  exit: 'out',
  rebalance: 'neutral',
  note: 'neutral',
};

const MOVE_LABEL: Record<MoveKind, string> = {
  open: 'OPEN',
  add: 'ADD',
  trim: 'TRIM',
  exit: 'EXIT',
  rebalance: 'REBAL',
  note: 'NOTE',
};

const MOVE_VERB: Record<MoveKind, string> = {
  open: 'Opened',
  add: 'Added to',
  trim: 'Trimmed',
  exit: 'Exited',
  rebalance: 'Rebalanced',
  note: 'Note on',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isDev = (() => {
  try {
    return Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
})();

/**
 * The structural privacy check. Levels are rebased to 100, so anything in the
 * thousands is a currency amount that has leaked in from the wrong layer.
 */
function assertNoAmounts(label: string, value: number): void {
  if (isDev && Math.abs(value) > MAX_PLAUSIBLE_LEVEL) {
    throw new Error(
      `[portfolio/chart] Series "${label}" carries a value of ${value}. ` +
        'Chart input must be index levels rebased to 100, never amounts.'
    );
  }
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/** Two base-36 characters, so a gap of up to 1295 days survives the round trip. */
function encodeGap(days: number): string {
  const clamped = clamp(Math.round(days), 0, 1295);
  return clamped.toString(36).padStart(2, '0');
}

/** ISO dates sort lexicographically, so a plain string compare is correct. */
function firstIndexAtOrAfter(slots: IsoDate[], date: IsoDate): number {
  let lo = 0;
  let hi = slots.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (slots[mid] < date) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---------------------------------------------------------------------------
// Normalisation
// ---------------------------------------------------------------------------

interface NormalSeries {
  style: Omit<SeriesStyle, 'latest' | 'latestLabel' | 'latestDelta' | 'latestGlyph' | 'latestDirection'>;
  /** Date → level, deduplicated and validated. */
  byDate: Map<IsoDate, number>;
  dates: IsoDate[];
}

function normaliseSeries(series: IndexSeries[]): NormalSeries[] {
  const out: NormalSeries[] = [];
  series.forEach((s, index) => {
    const label = typeof s?.label === 'string' && s.label.trim() ? s.label.trim() : `Series ${index + 1}`;
    const byDate = new Map<IsoDate, number>();
    for (const p of s?.points ?? []) {
      if (!p || !isValidIsoDate(p.d) || typeof p.v !== 'number' || !Number.isFinite(p.v)) continue;
      assertNoAmounts(label, p.v);
      byDate.set(p.d, p.v);
    }
    const dates = [...byDate.keys()].sort();
    out.push({
      style: {
        key: `s${index}`,
        label,
        readout: label.toUpperCase(),
        color: typeof s?.color === 'string' && s.color ? s.color : SERIES_PALETTE[index % SERIES_PALETTE.length],
        width: index === 0 ? 2.25 : 1.5,
        dash: index === 0 || index === 1 ? null : index === 2 ? '5 3' : '2 3',
        portfolio: index === 0,
      },
      byDate,
      dates,
    });
  });
  return out;
}

/**
 * Forward-fills one series onto the shared slot lattice. Values are `null`
 * before the series' first point and after its last — a series that stops
 * early must not be drawn as a flat line to the right edge.
 */
function fillSeries(ns: NormalSeries, slots: IsoDate[]): Array<number | null> {
  const values: Array<number | null> = new Array(slots.length).fill(null);
  if (ns.dates.length === 0) return values;
  const first = ns.dates[0];
  const last = ns.dates[ns.dates.length - 1];
  let carry: number | null = null;
  for (let i = 0; i < slots.length; i++) {
    const d = slots[i];
    if (d < first || d > last) continue;
    const v = ns.byDate.get(d);
    if (v !== undefined) carry = v;
    values[i] = carry;
  }
  return values;
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

interface Domain {
  /** Level-space bounds, used for tick generation. */
  lo: number;
  hi: number;
  /** Scale-space bounds, used for pixel mapping. */
  dmin: number;
  dmax: number;
}

/**
 * Padding and the minimum-span guard are applied in SCALE space, so a log
 * axis pads multiplicatively. Doing it in level space would let a wide log
 * window pad its lower bound straight through zero.
 */
function makeDomain(values: number[], scale: 'linear' | 'log'): Domain {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of values) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 98;
    hi = 102;
  }
  if (scale === 'log' && lo <= 0) lo = Math.max(hi, 1) / 1000;

  const t = scale === 'log' ? (x: number) => Math.log(Math.max(x, Number.EPSILON)) : (x: number) => x;
  const inv = scale === 'log' ? Math.exp : (x: number) => x;

  let dmin = t(lo);
  let dmax = t(hi);
  const pad = (dmax - dmin) * PAD_FRACTION;
  dmin -= pad;
  dmax += pad;

  // Flat or near-flat windows: expand symmetrically rather than divide by zero.
  // 4 index points on a linear axis, the same 4% on a log one.
  const minSpan = scale === 'log' ? Math.log(1 + MIN_SPAN / 100) : MIN_SPAN;
  if (dmax - dmin < minSpan) {
    const mid = (dmax + dmin) / 2;
    dmin = mid - minSpan / 2;
    dmax = mid + minSpan / 2;
  }

  return { lo: inv(dmin), hi: inv(dmax), dmin, dmax };
}

/** Maps a level to SVG y (0 at the top, 1000 at the bottom). */
function makeYOf(domain: Domain, scale: 'linear' | 'log') {
  const span = domain.dmax - domain.dmin;
  const safeSpan = span > 0 ? span : 1;
  return (level: number): number => {
    if (!Number.isFinite(level)) return 500;
    const t = scale === 'log' ? Math.log(Math.max(level, Number.EPSILON)) : level;
    return clamp(Math.round((1000 * (domain.dmax - t)) / safeSpan), 0, 1000);
  };
}

interface TickChoice {
  step: number;
  anchor: number;
  kMin: number;
  kMax: number;
  count: number;
  score: number;
}

/**
 * A nice-tick lattice anchored at 100 rather than at 0. Anchoring at the
 * reader's mental zero is what makes the axis read as "percent from where I
 * started" instead of a row of arbitrary numbers.
 */
function chooseTicks(lo: number, hi: number): TickChoice | null {
  const mid = (lo + hi) / 2;
  const anchoredAt100 = lo <= 100 && 100 <= hi;
  let best: TickChoice | null = null;

  for (let exp = -2; exp <= 4; exp++) {
    for (const mantissa of [1, 2, 2.5, 5]) {
      const step = mantissa * 10 ** exp;
      const anchor = anchoredAt100 ? 100 : Math.round(mid / step) * step;
      const kMin = Math.ceil((lo - anchor) / step - 1e-9);
      const kMax = Math.floor((hi - anchor) / step + 1e-9);
      const count = kMax - kMin + 1;
      if (count < 2 || count > 14) continue;
      // A whole-number lattice reads better than a 2.5 one, so it is worth
      // about one tick of density.
      const fractional = !Number.isInteger(step) || !Number.isInteger(anchor);
      const score = Math.abs(count - 6) + (fractional ? 1 : 0);
      const bestScore: number = best ? best.score : Infinity;
      // Ties go to the sparser axis: fewer, rounder numbers.
      if (score < bestScore || (score === bestScore && best !== null && count < best.count)) {
        best = { step, anchor, kMin, kMax, count, score };
      }
    }
  }
  return best;
}

/** A log axis wants a 1-2-5 decade ladder, not an evenly spaced one. */
function chooseLogTicks(lo: number, hi: number): number[] {
  const kMin = Math.floor(Math.log10(Math.max(lo, Number.EPSILON)));
  const kMax = Math.ceil(Math.log10(Math.max(hi, Number.EPSILON)));
  let best: number[] | null = null;
  for (const mantissas of [[1], [1, 3], [1, 2, 5], [1, 1.5, 2, 3, 5, 7]]) {
    const ticks: number[] = [];
    for (let k = kMin; k <= kMax; k++) {
      for (const m of mantissas) {
        const v = Number((m * 10 ** k).toPrecision(12));
        if (v >= lo && v <= hi) ticks.push(v);
      }
    }
    ticks.sort((a, b) => a - b);
    if (ticks.length < 2) continue;
    if (!best || Math.abs(ticks.length - 6) < Math.abs(best.length - 6)) best = ticks;
  }
  return best ?? [lo, Math.sqrt(lo * hi), hi];
}

function buildGrid(domain: Domain, yOf: (level: number) => number, scale: 'linear' | 'log'): GridLine[] {
  if (scale === 'log') {
    const ticks = chooseLogTicks(domain.lo, domain.hi);
    return ticks.map((level, index) => ({
      y: yOf(level),
      level,
      label: level >= 10 ? level.toFixed(0) : formatTick(level, 0.1),
      dense: ticks.length > 4 && index % 2 === 1,
    }));
  }
  const choice = chooseTicks(domain.lo, domain.hi);
  if (!choice) {
    const mid = (domain.lo + domain.hi) / 2;
    return [domain.lo, mid, domain.hi].map((level) => ({
      y: yOf(level),
      level,
      label: formatTick(level, 1),
      dense: false,
    }));
  }
  const lines: GridLine[] = [];
  for (let k = choice.kMin; k <= choice.kMax; k++) {
    const level = Number((choice.anchor + k * choice.step).toFixed(6));
    lines.push({
      y: yOf(level),
      level,
      label: formatTick(level, choice.step),
      // Alternate outward from the anchor, so the anchor itself always survives.
      dense: choice.count > 4 && Math.abs(k) % 2 === 1,
    });
  }
  // Never thin the axis down to a single visible label on small screens.
  if (lines.filter((l) => !l.dense).length < 2) {
    for (const l of lines) l.dense = false;
  }
  return lines;
}

// ---------------------------------------------------------------------------
// x ticks
// ---------------------------------------------------------------------------

function xPercent(i: number, n: number): number {
  return n > 1 ? round2((i / (n - 1)) * 100) : 50;
}

function evenlySpacedTicks(n: number): number[] {
  if (n <= 1) return [0];
  const wanted = Math.min(4, n);
  const idx: number[] = [];
  for (let k = 0; k < wanted; k++) {
    idx.push(Math.round((k * (n - 1)) / (wanted - 1)));
  }
  return [...new Set(idx)];
}

function buildXTicks(slots: IsoDate[], key: RangeKey): XTick[] {
  const n = slots.length;
  if (n === 0) return [];
  if (n === 1) {
    return [{ i: 0, x: 50, label: formatAxisDay(slots[0]), sub: formatAxisYear(slots[0]), align: 'mid', dense: false }];
  }

  let indices: number[] = [];
  const monthStarts: number[] = [];
  for (let i = 1; i < n; i++) {
    if (slots[i].slice(0, 7) !== slots[i - 1].slice(0, 7)) monthStarts.push(i);
  }

  if (key === '1M') {
    for (let i = 0; i < n; i++) if (dayOfWeek(slots[i]) === 1) indices.push(i);
  } else if (key === '6M' || key === 'YTD') {
    indices = monthStarts;
  } else if (key === '1Y') {
    indices = monthStarts.filter((_, k) => k % 2 === 0);
  } else {
    indices = monthStarts.filter((i) => [1, 4, 7, 10].includes(dateParts(slots[i]).month));
  }

  if (indices.length < 2) indices = evenlySpacedTicks(n);
  while (indices.length > MAX_X_TICKS) indices = indices.filter((_, k) => k % 2 === 0);

  const dense = key === 'ALL' && indices.filter((i) => dateParts(slots[i]).month === 1).length >= 2;

  let lastYear = '';
  return indices.map((i) => {
    const iso = slots[i];
    const year = formatAxisYear(iso);
    const showYear = year !== lastYear;
    lastYear = year;
    const x = xPercent(i, n);
    return {
      i,
      x,
      label: key === '1M' ? formatAxisDay(iso) : formatAxisMonth(iso),
      sub: key === '1M' ? null : showYear ? year : null,
      align: x < 6 ? 'start' : x > 94 ? 'end' : 'mid',
      dense: dense && dateParts(iso).month !== 1,
    };
  });
}

// ---------------------------------------------------------------------------
// Markers
// ---------------------------------------------------------------------------

interface PlacedMarker {
  source: ChartMarker;
  kind: MoveKind;
  slot: number;
  x: number;
  y: number;
  level: number | null;
  /** Gutter ticks and on-line glyphs never cluster with each other. */
  gutter: boolean;
}

function flipOf(x: number, y: number): MarkerNode['flip'] {
  const horizontal = x < 60 ? 'r' : 'l';
  const vertical = y < 40 ? 't' : 'b';
  return `${horizontal}${vertical}` as MarkerNode['flip'];
}

function markerAria(p: PlacedMarker, date: IsoDate): string {
  const m = p.source;
  const verb = MOVE_VERB[p.kind];
  const who = m.tickers.length ? m.tickers.join(', ') : m.title;
  // Levels are re-anchored per range, so this is movement across the window on
  // screen, not since inception.
  const level =
    p.level !== null
      ? ` Portfolio ${formatSignedPercent(p.level - 100)} over the range shown.`
      : '';
  const doubleDown = m.isDoubleDown ? ' Added while underwater.' : '';
  return `${verb} ${who} — ${formatLongDate(date)}. ${m.title}.${level}${doubleDown} Read the reasoning.`;
}

function buildMarkers(
  markers: ChartMarker[],
  slots: IsoDate[],
  n: number,
  yOf: (level: number) => number,
  portfolioAt: (i: number) => number | null
): MarkerNode[] {
  if (n === 0 || markers.length === 0) return [];
  const first = slots[0];
  const last = slots[n - 1];

  const placed: PlacedMarker[] = [];
  for (const m of markers) {
    if (!m || !isValidIsoDate(m.d)) continue;
    // Before the window: genuinely outside this range, so it is not drawn.
    if (m.d < first) continue;
    const found = firstIndexAtOrAfter(slots, m.d);
    const slot = m.d > last ? n - 1 : Math.min(found, n - 1);
    const kind: MoveKind = (m.kind && MOVE_LABEL[m.kind] ? m.kind : 'note') as MoveKind;
    const gutter = kind === 'note';
    const lineLevel = portfolioAt(slot);
    const level =
      lineLevel !== null
        ? lineLevel
        : typeof m.v === 'number' && Number.isFinite(m.v)
          ? m.v
          : null;
    if (level !== null) assertNoAmounts('markers', level);
    placed.push({
      source: m,
      kind,
      slot,
      x: xPercent(slot, n),
      y: gutter ? 100 : level !== null ? round2(yOf(level) / 10) : 50,
      level: gutter ? null : level,
      gutter,
    });
  }

  placed.sort((a, b) => a.slot - b.slot || a.y - b.y);

  // Greedy left-to-right sweep against the cluster anchor, so a cluster can
  // never span more than the threshold no matter how long the chain gets.
  const groups: PlacedMarker[][] = [];
  for (const p of placed) {
    const current = groups[groups.length - 1];
    const anchor = current?.[0];
    const joins =
      anchor !== undefined &&
      anchor.gutter === p.gutter &&
      Math.abs(p.x - anchor.x) < CLUSTER_X_PCT &&
      Math.abs(p.y - anchor.y) < CLUSTER_Y_PCT;
    if (joins) current.push(p);
    else groups.push([p]);
  }

  return groups.map((group, index) => {
    const head = group[0];
    const gutter = head.kind === 'note';
    if (group.length === 1) {
      const m = head.source;
      const date = slots[head.slot];
      return {
        key: `m${index}`,
        glyph: head.kind,
        arm: ARM_BY_KIND[head.kind],
        gutter,
        slot: head.slot,
        x: head.x,
        y: head.y,
        href: m.href,
        ariaLabel: markerAria(head, m.d),
        flip: flipOf(head.x, head.y),
        count: 1,
        date: m.d,
        dateLabel: formatCardDate(m.d),
        title: m.title,
        moveLabel: MOVE_LABEL[head.kind],
        tickers: m.tickers ?? [],
        levelLabel: head.level !== null ? formatLevel(head.level) : null,
        deltaLabel: head.level !== null ? formatSignedPercent(head.level - 100) : null,
        members: [],
      } satisfies MarkerNode;
    }

    const arms = new Set(group.map((p) => ARM_BY_KIND[p.kind]));
    const arm: MarkerArm = arms.size === 1 ? [...arms][0] : 'neutral';
    const firstDate = group[0].source.d;
    const lastDate = group[group.length - 1].source.d;
    const sameYear = firstDate.slice(0, 4) === lastDate.slice(0, 4);
    const span =
      firstDate === lastDate
        ? formatLongDate(firstDate)
        : `${formatSpanDate(firstDate, !sameYear)} to ${formatSpanDate(lastDate, true)}`;
    const summary = group
      .map((p) => `${MOVE_VERB[p.kind].toLowerCase()} ${p.source.tickers.join(', ') || p.source.title}`)
      .join(', ');
    return {
      key: `m${index}`,
      glyph: 'cluster',
      arm,
      gutter,
      slot: head.slot,
      x: head.x,
      y: head.y,
      href: head.source.href,
      ariaLabel: `${group.length} decisions, ${span}: ${summary}. Read the first one.`,
      flip: flipOf(head.x, head.y),
      count: group.length,
      date: firstDate,
      dateLabel: formatCardDate(firstDate),
      title: `${group.length} decisions`,
      moveLabel: 'MULTI',
      tickers: [...new Set(group.flatMap((p) => p.source.tickers ?? []))],
      levelLabel: head.level !== null ? formatLevel(head.level) : null,
      deltaLabel: head.level !== null ? formatSignedPercent(head.level - 100) : null,
      members: group.map((p) => ({
        dateLabel: formatCardDate(p.source.d),
        moveLabel: MOVE_LABEL[p.kind],
        title: p.source.title,
      })),
    } satisfies MarkerNode;
  });
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

function windowStart(slots: IsoDate[], key: RangeKey): number {
  const n = slots.length;
  const last = slots[n - 1];
  if (key === 'ALL') return 0;
  const from =
    key === '1M'
      ? isoAddMonths(last, -1)
      : key === '6M'
        ? isoAddMonths(last, -6)
        : key === '1Y'
          ? isoAddMonths(last, -12)
          : isoStartOfYear(last);
  return firstIndexAtOrAfter(slots, from);
}

/**
 * Direct end labels are the thing that lets a reader identify a line without
 * matching colours, so they must never collide. The dots stay on their lines;
 * only the labels are pushed apart.
 */
function spreadEndLabels(endcaps: EndCap[]): void {
  const MIN_GAP = 6; // percent of plot height ≈ 14px at the mobile aspect ratio
  const order = endcaps.slice().sort((a, b) => a.labelY - b.labelY);
  for (let i = 1; i < order.length; i++) {
    const gap = order[i].labelY - order[i - 1].labelY;
    if (gap < MIN_GAP) order[i].labelY = round2(order[i - 1].labelY + MIN_GAP);
  }
  const overflow = order.length ? order[order.length - 1].labelY - 100 : 0;
  if (overflow > 0) {
    for (const e of order) e.labelY = round2(Math.max(0, e.labelY - overflow));
  }
}

function buildLayer(
  key: RangeKey,
  allSlots: IsoDate[],
  filled: Array<Array<number | null>>,
  styles: NormalSeries[],
  markers: ChartMarker[],
  scale: 'linear' | 'log'
): RangeLayer {
  const start = windowStart(allSlots, key);
  const slots = allSlots.slice(start);
  const n = slots.length;
  const vbWidth = Math.max(n - 1, 1);

  // Every window is re-anchored to 100 at its own first point, so a range
  // button answers "what happened over this period" instead of "where does
  // this period sit relative to inception". Without it, 1M on a book up 48%
  // draws a line hovering around 148 and the 100 baseline is off-screen —
  // the reader has to do the division themselves, and the two series are no
  // longer visually comparable over the window they are being shown for.
  //
  // Each series takes its own base, so one that starts mid-window enters at
  // 100 on its own first day rather than being scaled by a value it did not
  // have. Everything downstream — domain, ticks, endcap labels, markers, the
  // area wash, and the crosshair, which reads levels back out of the plotted
  // geometry — inherits this automatically.
  const windows = filled.map((values) => {
    const w = values.slice(start);
    const base = w.find((v) => v !== null && v !== 0) ?? null;
    if (base === null) return w;
    return w.map((v) => (v === null ? null : (v / base) * 100));
  });

  const visible: number[] = [];
  for (const values of windows) {
    for (const v of values) if (v !== null) visible.push(v);
  }
  const domain = makeDomain(visible, scale);
  const yOf = makeYOf(domain, scale);

  const grid = buildGrid(domain, yOf, scale);
  const hasBaseline = domain.lo <= 100 && 100 <= domain.hi;
  const baselineY = hasBaseline ? yOf(100) : null;

  const lines: LinePath[] = [];
  const endcaps: EndCap[] = [];
  windows.forEach((values, si) => {
    const style = styles[si].style;
    let i0 = -1;
    let i1 = -1;
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v === null) continue;
      if (i0 === -1) i0 = i;
      i1 = i;
      parts.push(`${i},${yOf(v)}`);
    }
    if (i0 === -1) return;
    lines.push({
      key: style.key,
      color: style.color,
      width: style.width,
      dash: style.dash,
      i0,
      i1,
      points: parts.join(' '),
    });
    const lastValue = values[i1] as number;
    const y = round2(yOf(lastValue) / 10);
    endcaps.push({
      key: style.key,
      color: style.color,
      x: xPercent(i1, n),
      y,
      labelY: y,
      label: formatLevel(lastValue),
      ariaLabel: `${style.label} ${formatLevel(lastValue)}`,
    });
  });
  spreadEndLabels(endcaps);

  // Area: the portfolio polygon closed at the baseline, so the filled quantity
  // is literally "gain over where I started". With 100 out of view there is
  // only one arm and it closes at the plot floor.
  const portfolioLine = lines.find((l) => l.key === styles[0]?.style.key) ?? null;
  const washSplitY = baselineY ?? 1000;
  const portfolioValues = windows[0] ?? [];
  const aboveBaseline = portfolioValues.some((v) => v !== null && v >= 100);
  const washSide: RangeLayer['washSide'] = hasBaseline ? 'both' : aboveBaseline ? 'gain' : 'loss';
  const area =
    portfolioLine && portfolioLine.i1 > portfolioLine.i0
      ? `${portfolioLine.points} ${portfolioLine.i1},${washSplitY} ${portfolioLine.i0},${washSplitY}`
      : null;

  // Markers sit ON the portfolio line, so they take the line's own value —
  // never the marker's self-reported one, which could float off the path. A
  // marker snapped past the end of the line falls back to its last point.
  const portfolioAt = (i: number): number | null => {
    const values = windows[0];
    if (!values) return null;
    for (let k = Math.min(i, values.length - 1); k >= 0; k--) {
      if (values[k] !== null) return values[k] as number;
    }
    return null;
  };

  return {
    key,
    available: key === 'ALL' ? n > 0 : start > 0 && n >= MIN_RANGE_SLOTS,
    n,
    vbWidth,
    from: slots[0] ?? '',
    to: slots[n - 1] ?? '',
    dmin: round2(domain.dmin),
    dmax: round2(domain.dmax),
    baselineY,
    washSplitY,
    washSide,
    grid,
    xTicks: buildXTicks(slots, key),
    lines,
    area,
    endcaps,
    markers: buildMarkers(markers, slots, n, yOf, portfolioAt),
    t0: slots[0] ?? '',
    dd: slots.map((d, i) => (i === 0 ? '00' : encodeGap(isoToDays(d) - isoToDays(slots[i - 1])))).join(''),
  };
}

// ---------------------------------------------------------------------------
// Tables (the no-JS, screen-reader-first view of the same numbers)
// ---------------------------------------------------------------------------

function buildTableRows(
  slots: IsoDate[],
  filled: Array<Array<number | null>>
): TableRow[] {
  const n = slots.length;
  if (n === 0) return [];
  let indices: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i === n - 1 || slots[i + 1].slice(0, 7) !== slots[i].slice(0, 7)) indices.push(i);
  }
  while (indices.length > 60) indices = indices.filter((_, k) => k % 2 === 0 || k === indices.length - 1);
  if (indices[0] !== 0) indices.unshift(0);
  return indices.map((i) => ({
    d: slots[i],
    values: filled.map((values) => {
      const v = values[i];
      return v === null || v === undefined ? '—' : formatLevel(v);
    }),
  }));
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function buildChartModel(options: BuildChartModelOptions): ChartModel {
  const inputSeries = Array.isArray(options.series) ? options.series : [];
  const inputMarkers = Array.isArray(options.markers) ? options.markers : [];
  const requested: RangeKey = RANGE_KEYS.includes(options.defaultRange as RangeKey)
    ? (options.defaultRange as RangeKey)
    : 'ALL';

  const normal = normaliseSeries(inputSeries);

  const slotSet = new Set<IsoDate>();
  for (const ns of normal) for (const d of ns.dates) slotSet.add(d);
  const slots = [...slotSet].sort();

  if (slots.length === 0 || normal.length === 0) {
    return {
      empty: true,
      yScale: 'linear',
      series: [],
      layers: [],
      available: [],
      defaultRange: 'ALL',
      inception: null,
      asOf: null,
      summary: 'No price history yet — the chart appears with the first decision.',
      markerCount: 0,
      tableRows: [],
      decisionRows: [],
    };
  }

  const filled = normal.map((ns) => fillSeries(ns, slots));

  // Log escape hatch, decided once over ALL and applied to every layer, so the
  // ranges stay comparable with each other.
  let lo = Infinity;
  let hi = -Infinity;
  for (const values of filled) {
    for (const v of values) {
      if (v === null) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  const yScale: 'linear' | 'log' =
    Number.isFinite(lo) && lo > 0 && hi / lo > LOG_THRESHOLD ? 'log' : 'linear';

  const layers = RANGE_KEYS.map((key) => buildLayer(key, slots, filled, normal, inputMarkers, yScale));
  const available = layers.filter((l) => l.available);
  const defaultLayer = available.find((l) => l.key === requested) ?? available[available.length - 1];
  const defaultRange = defaultLayer?.key ?? 'ALL';

  const series: SeriesStyle[] = normal.map((ns, i) => {
    const values = filled[i];
    let latest: number | null = null;
    for (let k = values.length - 1; k >= 0; k--) {
      if (values[k] !== null) {
        latest = values[k] as number;
        break;
      }
    }
    const delta = latest === null ? NaN : latest - 100;
    return {
      ...ns.style,
      latest,
      latestLabel: latest === null ? '—' : formatLevel(latest),
      latestDelta: formatSignedPercent(delta),
      latestGlyph: deltaGlyph(delta),
      latestDirection: deltaDirection(delta),
    };
  });

  const inception = slots[0];
  const asOf = slots[slots.length - 1];
  const portfolio = series[0];
  const markerCount = layers.find((l) => l.key === 'ALL')?.markers.reduce((sum, m) => sum + m.count, 0) ?? 0;

  const benchmarkText = series
    .slice(1)
    .filter((s) => s.latest !== null)
    .map((s) => `${s.label} ${formatSignedPercent((s.latest as number) - 100)}`)
    .join(', ');
  const summary =
    `${portfolio.label} index rebased to 100 at ${formatLongDate(inception)}, ` +
    `ending at ${portfolio.latestLabel} (${portfolio.latestDelta}) on ${formatLongDate(asOf)}.` +
    (benchmarkText ? ` ${benchmarkText}.` : '') +
    (markerCount
      ? ` ${markerCount} decision marker${markerCount === 1 ? '' : 's'} link to the log entry that explains ${markerCount === 1 ? 'it' : 'them'}.`
      : '') +
    (yScale === 'log' ? ' Log scale.' : '');

  const decisionRows: DecisionRow[] = inputMarkers
    .filter((m) => m && isValidIsoDate(m.d))
    .slice()
    .sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0))
    .map((m) => ({
      d: m.d,
      moveLabel: MOVE_LABEL[m.kind] ?? 'NOTE',
      title: m.title,
      tickers: (m.tickers ?? []).join(', ') || '—',
      href: m.href,
      levelLabel: typeof m.v === 'number' && Number.isFinite(m.v) ? formatLevel(m.v) : '—',
    }));

  return {
    empty: false,
    yScale,
    series,
    layers,
    available,
    defaultRange,
    inception,
    asOf,
    summary,
    markerCount,
    tableRows: buildTableRows(slots, filled),
    decisionRows,
  };
}
