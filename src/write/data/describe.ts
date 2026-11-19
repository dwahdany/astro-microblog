/**
 * Deriving list entries, slugs and paths from a post's text.
 */
import { isMap, isScalar, parseDocument } from 'yaml';
import {
  CONTENT_ROOT,
  type CollectionKind,
  type FrontmatterIssue,
  type ParsedFrontmatter,
  type PostRef,
} from '../contracts';
import { parseTimestamp } from './dates';
import { basename, collectionOf } from './paths';
import { split } from './split';

/**
 * Parse the frontmatter slice with the YAML 1.2 core schema: timestamps stay
 * strings exactly as written. Never throws.
 */
export function parse(frontmatter: string): ParsedFrontmatter {
  if (frontmatter.trim() === '') return { data: {}, keys: [], issues: [] };
  let doc;
  try {
    doc = parseDocument(frontmatter, { prettyErrors: true });
  } catch (err) {
    return { data: {}, keys: [], issues: [{ message: String((err as Error).message ?? err) }] };
  }
  const issues: FrontmatterIssue[] = doc.errors.map((e) => ({
    message: e.message.split('\n')[0],
    line: e.linePos?.[0]?.line,
  }));
  if (issues.length > 0) return { data: {}, keys: [], issues };
  if (doc.contents === null) return { data: {}, keys: [], issues: [] }; // comments only
  if (!isMap(doc.contents)) {
    return { data: {}, keys: [], issues: [{ message: 'Frontmatter must be a YAML mapping (key: value lines).', line: 1 }] };
  }
  const keys = doc.contents.items.map((pair) => (isScalar(pair.key) ? String(pair.key.value) : String(pair.key)));
  let data: Record<string, unknown>;
  try {
    data = doc.toJS() as Record<string, unknown>;
  } catch (err) {
    return { data: {}, keys: [], issues: [{ message: String((err as Error).message ?? err) }] };
  }
  return { data, keys, issues };
}

const TRANSLITERATE: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  œ: 'oe',
  ø: 'o',
  đ: 'd',
  ð: 'd',
  þ: 'th',
  ł: 'l',
  ı: 'i',
};

/**
 * ASCII, lowercase, hyphenated — like Sveltia with `encoding: ascii` and
 * `clean_accents: true` ("What's the date? — LessWrong" →
 * `what-s-the-date-lesswrong`). '' when nothing usable remains.
 */
export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[ßæœøđðþłı]/g, (ch) => TRANSLITERATE[ch] ?? ch)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * `src/content/<collection>/<year>/<slug>.md` (Sveltia's `{{year}}/{{slug}}`),
 * the year being that of `created` in UTC; series live flat. An unreadable
 * date falls back to the current year.
 */
export function pathFor(collection: CollectionKind, slug: string, created: string | Date): string {
  if (collection === 'series') return `${CONTENT_ROOT}/series/${slug}.md`;
  const ms = parseTimestamp(created);
  const year = new Date(ms ?? Date.now()).getUTCFullYear();
  return `${CONTENT_ROOT}/${collection}/${year}/${slug}.md`;
}

/** Plain-text start of a markdown body, for list rows and search. */
export function plainExcerpt(body: string, max = 160): string {
  // Only the start matters; cap the work on long posts.
  const text = body
    .slice(0, max * 12)
    .replace(/<!--[\s\S]*?(?:-->|$)/g, ' ')
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:\n\1[^\n]*|(?![\s\S]))/gm, ' ')
    .replace(/^\[\^[^\]]+\]:.*$/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[\^[^\]]+\]/g, '')
    .replace(/<\/?[a-zA-Z][^>\n]*>/g, ' ')
    .replace(/^\s{0,3}(?:#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\$\$?/g, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/ ([.,;:!?])/g, '$1')
    .trim();
  return text.length > max ? text.slice(0, max - 1).trimEnd() + '…' : text;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '');

/** Build the list entry for a post from its path and text. */
export function describe(path: string, raw: string, extra: { id?: string; isNew?: boolean; sha?: string } = {}): PostRef {
  const parts = split(raw);
  const { data } = parse(parts.frontmatter);
  const collection = collectionOf(path) ?? 'notes';
  const stem = basename(path).replace(/\.md$/, '');
  const slug = str(data.slug) || stem;
  const excerpt = plainExcerpt(str(data.excerpt)) || plainExcerpt(parts.body);

  const candidates: Record<CollectionKind, string[]> = {
    entries: [str(data.title)],
    portfolio: [str(data.title)],
    series: [str(data.title)],
    notes: [str(data.title), excerpt],
    blogmarks: [str(data.title), str(data.link_title)],
    quotations: [str(data.source)],
    photos: [str(data.title), str(data.alt)],
  };
  const title = candidates[collection].find((t) => t !== '') ?? slug;

  const createdRaw = data.created;
  const created =
    typeof createdRaw === 'string' && createdRaw.trim() !== ''
      ? createdRaw
      : createdRaw instanceof Date && !Number.isNaN(createdRaw.getTime())
        ? createdRaw.toISOString()
        : null;

  return {
    id: extra.id ?? path,
    path,
    collection,
    slug,
    title,
    created,
    createdMs: parseTimestamp(created),
    tags: Array.isArray(data.tags) ? data.tags.filter((t): t is string => typeof t === 'string') : [],
    draft: data.is_draft === true,
    excerpt,
    isNew: extra.isNew ?? false,
    sha: extra.sha,
  };
}

/** Newest first; posts without a readable date last; ties by path so the order is stable. */
export function byNewest(a: PostRef, b: PostRef): number {
  if (a.createdMs !== b.createdMs) {
    if (a.createdMs === null) return 1;
    if (b.createdMs === null) return -1;
    return b.createdMs - a.createdMs;
  }
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
