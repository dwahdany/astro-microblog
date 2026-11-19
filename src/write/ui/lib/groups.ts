/** Grouping the post list by how recent a post is. Pure; `now` is passed in. */

export interface Group<T> {
  key: string;
  label: string;
  items: T[];
}

const DAY = 24 * 60 * 60 * 1000;
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Which group a post created at `ms` falls in, seen from `now` (local time):
 * the last seven days, the rest of this month, a month of this year, or a year.
 */
export function recencyBucket(ms: number | null, now: number): { key: string; label: string } {
  if (ms === null) return { key: 'undated', label: 'No date' };
  if (ms > now) return { key: 'upcoming', label: 'Dated in the future' };
  if (now - ms < 7 * DAY) return { key: 'week', label: 'This week' };
  const then = new Date(ms);
  const today = new Date(now);
  if (then.getFullYear() !== today.getFullYear()) {
    return { key: `y${then.getFullYear()}`, label: String(then.getFullYear()) };
  }
  if (then.getMonth() === today.getMonth()) return { key: 'month', label: 'Earlier this month' };
  return { key: `m${then.getMonth()}`, label: MONTHS[then.getMonth()] };
}

/** Group items, keeping their order (the list arrives newest first). */
export function groupByRecency<T extends { createdMs: number | null }>(items: readonly T[], now: number): Group<T>[] {
  const groups: Group<T>[] = [];
  const byKey = new Map<string, Group<T>>();
  for (const item of items) {
    const bucket = recencyBucket(item.createdMs, now);
    let group = byKey.get(bucket.key);
    if (!group) {
      group = { ...bucket, items: [] };
      byKey.set(bucket.key, group);
      groups.push(group);
    }
    group.items.push(item);
  }
  return groups;
}

const SHORT_MONTHS = MONTHS.map((m) => m.slice(0, 3));

/** "11 Nov" — the group heading already says which year. */
export function dayMonth(ms: number | null): string {
  if (ms === null) return '';
  const d = new Date(ms);
  return `${d.getDate()} ${SHORT_MONTHS[d.getMonth()]}`;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then a date. */
export function relativeTime(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return `${dayMonth(ms)}${sameYear ? '' : ` ${d.getFullYear()}`}`;
}
