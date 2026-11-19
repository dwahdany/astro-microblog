/** One glyph and one line of explanation per collection. */
import type { Component } from 'svelte';
import Bookmark from '@lucide/svelte/icons/bookmark';
import ChartLine from '@lucide/svelte/icons/chart-line';
import FileText from '@lucide/svelte/icons/file-text';
import ImageIcon from '@lucide/svelte/icons/image';
import Library from '@lucide/svelte/icons/library';
import Quote from '@lucide/svelte/icons/quote';
import StickyNote from '@lucide/svelte/icons/sticky-note';
import type { CollectionKind } from '../contracts';

export type IconComponent = Component<{ size?: number | string; strokeWidth?: number | string; 'aria-hidden'?: 'true' }>;

export const KIND_ICON: Readonly<Record<CollectionKind, IconComponent>> = {
  entries: FileText,
  notes: StickyNote,
  blogmarks: Bookmark,
  quotations: Quote,
  photos: ImageIcon,
  portfolio: ChartLine,
  series: Library,
};

/** What each kind of post is, for the "New post" sheet. */
export const KIND_BLURB: Readonly<Record<CollectionKind, string>> = {
  entries: 'A long post with a title.',
  notes: 'A short thought. The title is optional.',
  blogmarks: 'A link worth keeping, with your comment.',
  quotations: 'Someone else’s words, with the source.',
  photos: 'A photo with alt text and a caption.',
  portfolio: 'A portfolio decision and its reasoning.',
  series: 'A group of entries that belong together.',
};
