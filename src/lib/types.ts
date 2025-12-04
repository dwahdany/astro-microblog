import type { CollectionEntry } from 'astro:content';

export type EntryItem = CollectionEntry<'entries'>;
export type BlogmarkItem = CollectionEntry<'blogmarks'>;
export type QuotationItem = CollectionEntry<'quotations'>;
export type NoteItem = CollectionEntry<'notes'>;
export type SeriesItem = CollectionEntry<'series'>;

export type ContentType = 'entry' | 'blogmark' | 'quotation' | 'note';

export type ContentItem =
  | { type: 'entry'; item: EntryItem }
  | { type: 'blogmark'; item: BlogmarkItem }
  | { type: 'quotation'; item: QuotationItem }
  | { type: 'note'; item: NoteItem };

export type DayGroup = {
  date: string; // ISO date string YYYY-MM-DD
  displayDate: string; // Human readable date
  items: ContentItem[];
};

// Month name mapping (3-letter abbreviation)
export const MONTHS_3: Record<number, string> = {
  1: 'Jan',
  2: 'Feb',
  3: 'Mar',
  4: 'Apr',
  5: 'May',
  6: 'Jun',
  7: 'Jul',
  8: 'Aug',
  9: 'Sep',
  10: 'Oct',
  11: 'Nov',
  12: 'Dec',
};

// Reverse mapping for URL parsing
export const MONTHS_3_REVERSE: Record<string, number> = Object.fromEntries(
  Object.entries(MONTHS_3).map(([k, v]) => [v, parseInt(k)])
);
