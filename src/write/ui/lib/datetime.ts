/**
 * Between a frontmatter timestamp and the browser's date pickers. Pure.
 *
 * The file's text is the truth: these helpers only run when the owner actually
 * picks a different moment, and the sheet skips the patch when the picked
 * value is the one already shown (so opening the picker and choosing the same
 * minute never rewrites `created`).
 */
const pad = (n: number): string => String(n).padStart(2, '0');

/** Frontmatter timestamp → value for `<input type="datetime-local">` (local time, minutes). Null when it does not parse. */
export function toLocalInput(value: string): string | null {
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `<input type="datetime-local">` value (local time) → the moment it names. Null when empty or invalid. */
export function localInputDate(local: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(local);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * `<input type="datetime-local">` value → the timestamp format the site's
 * posts use (and Sveltia writes): UTC, `YYYY-MM-DDTHH:mm:ss+00:00`.
 * Null when the input is empty or invalid. (The properties sheet writes in the
 * format the FILE already uses instead: data `formatLike`.)
 */
export function fromLocalInput(local: string): string | null {
  const d = localInputDate(local);
  return d ? utcStamp(d) : null;
}

/** A Date as `YYYY-MM-DDTHH:mm:ss+00:00`. */
export function utcStamp(d: Date): string {
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+00:00`
  );
}

/** Frontmatter date or timestamp → value for `<input type="date">` (the date as written, no zone maths). */
export function toDateInput(value: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return m ? m[1] : null;
}
