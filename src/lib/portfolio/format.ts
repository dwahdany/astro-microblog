/**
 * Build-time formatters for the portfolio chart.
 *
 * Everything here is hand-rolled against a FIXED locale (en-GB conventions:
 * day before month, 24-hour-free, no ordinals) rather than `Intl`, so output
 * can never drift with the build machine's ICU data, timezone or environment.
 * These run at build time only — nothing in this module is shipped to or
 * called by the browser.
 *
 * Dates are `YYYY-MM-DD` strings interpreted as UTC calendar days and are
 * parsed by slicing, never by `new Date(string)` (which is timezone-sensitive
 * for some shapes). Numbers are formatted with `toFixed`, which is locale
 * independent by specification.
 */

import type { IsoDate } from './types';

export const MONTHS_UPPER = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
] as const;

export const MONTHS_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
] as const;

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const MS_PER_DAY = 86_400_000;

export interface DateParts {
  year: number;
  /** 1–12. */
  month: number;
  /** 1–31. */
  day: number;
}

export function isValidIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== 'string' || !ISO_RE.test(value)) return false;
  const { year, month, day } = dateParts(value as IsoDate);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  return Number.isFinite(Date.UTC(year, month - 1, day));
}

export function dateParts(iso: IsoDate): DateParts {
  return {
    year: Number(iso.slice(0, 4)),
    month: Number(iso.slice(5, 7)),
    day: Number(iso.slice(8, 10)),
  };
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Whole days since the Unix epoch, UTC. */
export function isoToDays(iso: IsoDate): number {
  const { year, month, day } = dateParts(iso);
  return Math.round(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

export function isoFromDays(days: number): IsoDate {
  const d = new Date(days * MS_PER_DAY);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday. */
export function dayOfWeek(iso: IsoDate): number {
  const { year, month, day } = dateParts(iso);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** Shifts by whole months, clamping the day to the target month's length. */
export function isoAddMonths(iso: IsoDate, months: number): IsoDate {
  const { year, month, day } = dateParts(iso);
  const total = year * 12 + (month - 1) + months;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return `${String(y).padStart(4, '0')}-${pad2(m + 1)}-${pad2(Math.min(day, lastDay))}`;
}

export function isoStartOfYear(iso: IsoDate): IsoDate {
  return `${iso.slice(0, 4)}-01-01`;
}

// ---------------------------------------------------------------------------
// Date display
// ---------------------------------------------------------------------------

/** `2025-03-14` — machine-readable, used for `datetime` and the data table. */
export function formatIsoDate(iso: IsoDate): string {
  return iso;
}

/** `14 MAR` — dense x-axis tick inside a one-month window. */
export function formatAxisDay(iso: IsoDate): string {
  const { month, day } = dateParts(iso);
  return `${pad2(day)} ${MONTHS_UPPER[month - 1]}`;
}

/** `MAR` — month-start x-axis tick. */
export function formatAxisMonth(iso: IsoDate): string {
  return MONTHS_UPPER[dateParts(iso).month - 1];
}

/** `2025` — the second x-axis line, printed only when the year changes. */
export function formatAxisYear(iso: IsoDate): string {
  return iso.slice(0, 4);
}

/** `14 MAR 25` — readout chip and marker cards. */
export function formatCardDate(iso: IsoDate): string {
  const { year, month, day } = dateParts(iso);
  return `${pad2(day)} ${MONTHS_UPPER[month - 1]} ${String(year).slice(2)}`;
}

/** `14 March 2025` — prose, accessible labels and the figure caption. */
export function formatLongDate(iso: IsoDate): string {
  const { year, month, day } = dateParts(iso);
  return `${day} ${MONTHS_LONG[month - 1]} ${year}`;
}

/** `14 Mar` / `14 Mar 2025` — compact spans inside cluster labels. */
export function formatSpanDate(iso: IsoDate, withYear: boolean): string {
  const { year, month, day } = dateParts(iso);
  const base = `${day} ${MONTHS_LONG[month - 1].slice(0, 3)}`;
  return withYear ? `${base} ${year}` : base;
}

// ---------------------------------------------------------------------------
// Numbers. Index levels only — this component never sees a currency amount.
// ---------------------------------------------------------------------------

/** `132.4` — an index level rebased to 100 at inception. */
export function formatLevel(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return '—';
  return value.toFixed(digits);
}

/** `120` / `97.5` — axis tick label; decimals only when the step needs them. */
export function formatTick(value: number, step: number): string {
  const digits = Number.isInteger(step) ? 0 : Number.isInteger(step * 10) ? 1 : 2;
  return value.toFixed(digits);
}

/** `+32.4%` / `-8.1%` / `0.0%` — a delta already expressed in percent points. */
export function formatSignedPercent(points: number, digits = 1): string {
  if (!Number.isFinite(points)) return '—';
  const rounded = Number(points.toFixed(digits));
  const sign = rounded > 0 ? '+' : rounded < 0 ? '-' : '';
  return `${sign}${Math.abs(rounded).toFixed(digits)}%`;
}

/** `↑` / `↓` / `·` — the coloured glyph that sits beside an uncoloured number. */
export function deltaGlyph(points: number, digits = 1): string {
  if (!Number.isFinite(points)) return '·';
  const rounded = Number(points.toFixed(digits));
  return rounded > 0 ? '↑' : rounded < 0 ? '↓' : '·';
}

export function deltaDirection(points: number, digits = 1): 'up' | 'down' | 'flat' {
  if (!Number.isFinite(points)) return 'flat';
  const rounded = Number(points.toFixed(digits));
  return rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat';
}

/** Rounds an SVG/CSS coordinate to at most 2 decimals, dropping `-0`. */
export function round2(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const r = Math.round(value * 100) / 100;
  return Object.is(r, -0) ? 0 : r;
}
