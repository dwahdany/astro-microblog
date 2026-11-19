/**
 * What the shell remembers between screens (module state) and across reloads
 * (sessionStorage / localStorage): the list's filters and scroll position, the
 * last list it showed, and a just-created post on its way to the writing screen.
 */
import type { CollectionKind, LoadedPost, PostRef } from '../contracts';

const FILTER_KEY = 'write:list-filters';
const MODE_KEY = 'write:view-mode';

export type ViewMode = 'write' | 'split' | 'preview';

interface Filters {
  query: string;
  kind: CollectionKind | 'all';
  draftsOnly: boolean;
}

function readFilters(): Filters {
  const fallback: Filters = { query: '', kind: 'all', draftsOnly: false };
  try {
    const stored = JSON.parse(sessionStorage.getItem(FILTER_KEY) ?? 'null') as Partial<Filters> | null;
    if (!stored) return fallback;
    return {
      query: typeof stored.query === 'string' ? stored.query : '',
      kind: typeof stored.kind === 'string' ? (stored.kind as Filters['kind']) : 'all',
      draftsOnly: stored.draftsOnly === true,
    };
  } catch {
    return fallback;
  }
}

/** The list's filters. Survive leaving the list and reloading the tab. */
export const filters = $state<Filters>(readFilters());

export function rememberFilters(): void {
  try {
    sessionStorage.setItem(FILTER_KEY, JSON.stringify(filters));
  } catch {
    // Storage unavailable: the filters just reset on reload.
  }
}

/** The last list shown and where it was scrolled to, so coming back from a post is instant. */
export const listMemory: { posts: PostRef[] | null; scrollTop: number } = { posts: null, scrollTop: 0 };

/**
 * A post created a moment ago, handed to the writing screen in memory so that
 * it opens even when this browser refuses to store drafts (private mode).
 */
export const handoff = new Map<string, LoadedPost>();

/**
 * A post always opens ready to write. Only the layout preference — editor and
 * preview side by side — is remembered; "preview" is a glance, not a setting.
 */
export function readViewMode(): ViewMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'split' ? 'split' : 'write';
  } catch {
    return 'write';
  }
}

export function rememberViewMode(mode: ViewMode): void {
  if (mode === 'preview') return;
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    // not remembered
  }
}

/**
 * A publish (or delete) that has just succeeded, kept across the change of screen it causes: a new
 * post moves to its real address, a deleted one leaves for the list. Shown once, where it lands.
 */
export interface Published {
  /** Where the post is now (the path that was deleted, for a delete). */
  path: string;
  commitUrl?: string;
  /** More than 1 when large images made the save several commits. */
  commits?: number;
  deleted?: boolean;
  /** The post was not at this address before (created, or moved). */
  moved?: boolean;
  at: number;
}
export const published = $state<{ last: Published | null }>({ last: null });
