import { getCollection } from 'astro:content';
import type { ContentItem, DayGroup } from './types';
import { MONTHS_3 } from './types';

/**
 * Fetches all non-draft content from all collections
 */
export async function getAllContent(): Promise<ContentItem[]> {
  const [entries, blogmarks, quotations, notes] = await Promise.all([
    getCollection('entries', ({ data }) => !data.is_draft),
    getCollection('blogmarks', ({ data }) => !data.is_draft),
    getCollection('quotations', ({ data }) => !data.is_draft),
    getCollection('notes', ({ data }) => !data.is_draft),
  ]);

  const all: ContentItem[] = [
    ...entries.map((item) => ({ type: 'entry' as const, item })),
    ...blogmarks.map((item) => ({ type: 'blogmark' as const, item })),
    ...quotations.map((item) => ({ type: 'quotation' as const, item })),
    ...notes.map((item) => ({ type: 'note' as const, item })),
  ];

  return all.sort(
    (a, b) =>
      new Date(b.item.data.created).getTime() -
      new Date(a.item.data.created).getTime()
  );
}

/**
 * Groups content items by day
 */
export function groupByDay(items: ContentItem[]): DayGroup[] {
  const groups = new Map<string, ContentItem[]>();

  for (const item of items) {
    const date = new Date(item.item.data.created);
    const dateKey = date.toISOString().split('T')[0];
    if (!groups.has(dateKey)) {
      groups.set(dateKey, []);
    }
    groups.get(dateKey)!.push(item);
  }

  return Array.from(groups.entries()).map(([date, items]) => ({
    date,
    displayDate: formatDisplayDate(new Date(date)),
    items,
  }));
}

/**
 * Formats a date for display (e.g., "Wednesday, December 4, 2024")
 */
export function formatDisplayDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

/**
 * Formats a date for short display (e.g., "Dec 4, 2024")
 */
export function formatShortDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/**
 * Generates a URL for a content item
 * Format: /{YEAR}/{Month}/{Day}/{slug}/
 */
export function getItemUrl(item: ContentItem): string {
  const date = new Date(item.item.data.created);
  const year = date.getFullYear();
  const month = MONTHS_3[date.getMonth() + 1];
  const day = date.getDate();
  const slug = item.item.data.slug;
  return `/${year}/${month}/${day}/${slug}/`;
}

/**
 * Gets the title for a content item
 */
export function getItemTitle(item: ContentItem): string {
  switch (item.type) {
    case 'entry':
      return item.item.data.title;
    case 'blogmark':
      return item.item.data.title || item.item.data.link_title;
    case 'quotation':
      return `Quoting ${item.item.data.source}`;
    case 'note':
      return item.item.data.title || `Note from ${formatShortDate(new Date(item.item.data.created))}`;
  }
}

/**
 * Gets all unique tags from content
 */
export async function getAllTags(): Promise<Map<string, number>> {
  const allContent = await getAllContent();
  const tagCounts = new Map<string, number>();

  for (const item of allContent) {
    for (const tag of item.item.data.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
  }

  return new Map([...tagCounts.entries()].sort((a, b) => b[1] - a[1]));
}

/**
 * Filters content by tag(s)
 */
export async function getContentByTags(tags: string[]): Promise<ContentItem[]> {
  const allContent = await getAllContent();
  return allContent.filter((item) =>
    tags.every((tag) => item.item.data.tags.includes(tag))
  );
}

/**
 * Gets content for a specific date
 */
export async function getContentByDate(
  year: number,
  month: number,
  day?: number
): Promise<ContentItem[]> {
  const allContent = await getAllContent();
  return allContent.filter((item) => {
    const date = new Date(item.item.data.created);
    if (date.getFullYear() !== year) return false;
    if (date.getMonth() + 1 !== month) return false;
    if (day !== undefined && date.getDate() !== day) return false;
    return true;
  });
}

/**
 * Gets available years with content
 */
export async function getYearsWithContent(): Promise<number[]> {
  const allContent = await getAllContent();
  const years = new Set<number>();
  for (const item of allContent) {
    years.add(new Date(item.item.data.created).getFullYear());
  }
  return Array.from(years).sort((a, b) => b - a);
}

/**
 * Gets available months for a year
 */
export async function getMonthsWithContent(
  year: number
): Promise<{ month: number; name: string; count: number }[]> {
  const allContent = await getAllContent();
  const monthCounts = new Map<number, number>();

  for (const item of allContent) {
    const date = new Date(item.item.data.created);
    if (date.getFullYear() === year) {
      const month = date.getMonth() + 1;
      monthCounts.set(month, (monthCounts.get(month) || 0) + 1);
    }
  }

  return Array.from(monthCounts.entries())
    .map(([month, count]) => ({
      month,
      name: MONTHS_3[month],
      count,
    }))
    .sort((a, b) => b.month - a.month);
}
