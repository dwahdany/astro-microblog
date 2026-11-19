/**
 * Timestamps as the content files write them.
 *
 * Existing formats (counted over src/content):
 *   2026-11-11T10:43:00+00:00   Sveltia: UTC wall-clock, seconds zeroed, `+00:00`
 *   2025-12-11T11:13:00Z        hand-written / imported
 *   2026-09-03                  portfolio (date only)
 * The frontmatter is parsed with the YAML 1.2 core schema, so these stay the
 * exact strings above; nothing here ever turns one into a Date and prints it
 * back. `formatLike` exists so a date picker can hand `patch` a value in the
 * SAME format the file already uses.
 */

const p2 = (n: number) => String(n).padStart(2, '0');

/**
 * What Sveltia's datetime widget (format `YYYY-MM-DDTHH:mm:ssZ`) writes for
 * "now": the UTC time with seconds zeroed and a `+00:00` offset — checked
 * against commit times of CMS-created posts (created 10:43 UTC, committed
 * 10:48 UTC from a UTC+1 machine).
 */
export function sveltiaTimestamp(date: Date): string {
  return (
    `${date.getUTCFullYear()}-${p2(date.getUTCMonth() + 1)}-${p2(date.getUTCDate())}` +
    `T${p2(date.getUTCHours())}:${p2(date.getUTCMinutes())}:00+00:00`
  );
}

const SHAPE =
  /^(\d{4})-(\d\d)-(\d\d)(?:([Tt ])(\d\d):(\d\d)(?::(\d\d)(\.\d+)?)?(Z|z|[-+]\d\d(?::?\d\d)?)?)?$/;

/** Epoch ms of a `created`-style value, or null when it is not a date. Date-only values are UTC midnight. */
export function parseTimestamp(value: unknown): number | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value !== 'string' || value.trim() === '') return null;
  const ms = Date.parse(value.trim());
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Format `date` the way `sample` is written: date-only stays date-only, `Z`
 * stays `Z`, an offset keeps that offset (the instant is converted into it),
 * seconds/fraction are kept only if the sample has them. Anything
 * unrecognised (or no sample) gets Sveltia's format.
 */
export function formatLike(sample: string | null | undefined, date: Date): string {
  const m = sample ? SHAPE.exec(sample.trim()) : null;
  if (!m) return sveltiaTimestamp(date);
  const [, , , , sep, , , seconds, fraction, zone] = m;

  let offsetMin = 0;
  if (zone && zone !== 'Z' && zone !== 'z') {
    const zm = /^([-+])(\d\d)(?::?(\d\d))?$/.exec(zone)!;
    offsetMin = (zm[1] === '-' ? -1 : 1) * (Number(zm[2]) * 60 + Number(zm[3] ?? 0));
  }
  const shifted = new Date(date.getTime() + offsetMin * 60_000);
  const day = `${shifted.getUTCFullYear()}-${p2(shifted.getUTCMonth() + 1)}-${p2(shifted.getUTCDate())}`;
  if (sep === undefined) return day;

  let out = `${day}${sep}${p2(shifted.getUTCHours())}:${p2(shifted.getUTCMinutes())}`;
  if (seconds !== undefined) {
    out += `:${p2(shifted.getUTCSeconds())}`;
    if (fraction !== undefined) {
      const digits = fraction.length - 1;
      out += '.' + String(shifted.getUTCMilliseconds()).padStart(3, '0').padEnd(digits, '0').slice(0, digits);
    }
  }
  return out + (zone ?? '');
}
