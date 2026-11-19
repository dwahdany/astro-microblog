/**
 * Internal-link "Previously" cards — the data half.
 *
 * The site's plugin (src/plugins/rehype-internal-link-preview.ts) finds the
 * linked post by reading src/content with `fs` at build time. A browser cannot
 * do that, so the lookup is split out here: a `LinkTarget` is exactly the
 * `PostMeta` the site's plugin derives from a file, and there are two ways to
 * get one:
 *
 *   targetFromFile     exact — same derivation as the site, from the linked
 *                      post's own frontmatter and body. Preview.svelte uses it
 *                      (it can load the linked post through the data layer).
 *   targetFromPostRef  approximation from a list entry, for callers that only
 *                      have `PreviewContext.posts`. A PostRef does not carry
 *                      the frontmatter `excerpt`, so a titled post's card
 *                      loses its second line.
 *
 * Dates use UTC, the timezone the site is built in (CI). `astro dev` on a
 * laptop uses the local zone instead, so a post created near midnight can
 * show a different day locally than on the published site and here.
 */
import type { CollectionKind, PostRef } from '../contracts';

/** URL pattern from the site's plugin: blog.wahdany.eu/{year}/{Mon}/{day}/{slug}/ */
export const INTERNAL_LINK_PATTERN =
  /^https?:\/\/blog\.wahdany\.eu\/(\d{4})\/([A-Za-z]{3})\/(\d{1,2})\/([^/]+)\/?$/;

/** Collections the site's plugin searches, in its search order (first match wins). */
export const LINKABLE_COLLECTIONS = ['entries', 'blogmarks', 'notes', 'quotations'] as const;
export type LinkableCollection = (typeof LINKABLE_COLLECTIONS)[number];

export const MONTHS_3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export interface LinkTarget {
  slug: string;
  /**
   * The collection name minus its final letter, exactly as the site computes
   * it: 'blogmark', 'note', 'quotation' — and 'entrie' for entries. The site's
   * card class is therefore `preview-entrie`, which its stylesheet does not
   * style and its label table does not know (the label falls back to "post").
   * Kept as is: the preview shows what the site shows.
   */
  type: string;
  title?: string;
  excerpt?: string;
  /** Site-relative permalink, `/2025/Oct/6/bubbles/`. */
  url: string;
  date: Date;
}

export function isLinkable(collection: CollectionKind): collection is LinkableCollection {
  return (LINKABLE_COLLECTIONS as readonly string[]).includes(collection);
}

/** Slugs of every internal permalink mentioned in the markdown (a superset of what ends up linked). */
export function internalLinkSlugs(markdown: string): string[] {
  const found = new Set<string>();
  const pattern = /https?:\/\/blog\.wahdany\.eu\/\d{4}\/[A-Za-z]{3}\/\d{1,2}\/([^/\s)>\]"'<]+)/g;
  for (const match of markdown.matchAll(pattern)) found.add(match[1]);
  return [...found];
}

function permalink(date: Date, slug: string): string {
  return `/${date.getUTCFullYear()}/${MONTHS_3[date.getUTCMonth()]}/${date.getUTCDate()}/${slug}/`;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * The site's derivation, line for line (see findPostBySlug in the plugin):
 * title per collection, and for untitled posts the first sentence of the body.
 * `body` is everything after the frontmatter's closing fence.
 */
export function targetFromFile(
  collection: LinkableCollection,
  data: Record<string, unknown>,
  body: string,
): LinkTarget | null {
  if (typeof data.slug !== 'string') return null;
  const date = new Date(data.created instanceof Date ? data.created : String(data.created));

  let title: unknown = data.title;
  if (collection === 'blogmarks') title = data.title || data.link_title;
  else if (collection === 'quotations') title = `Quote from ${String(data.source)}`;

  let excerpt = typeof data.excerpt === 'string' && data.excerpt !== '' ? data.excerpt : undefined;
  const hasTitle = nonEmpty(title);
  if (!hasTitle && !excerpt && body) {
    const plainText = body
      .replace(/!\[.*?\]\(.*?\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/[#*_`~]/g, '')
      .trim();
    const firstSentence = plainText.match(/^[^.!?]+[.!?]/);
    excerpt = firstSentence
      ? firstSentence[0].trim()
      : plainText.slice(0, 120) + (plainText.length > 120 ? '...' : '');
  }

  return {
    slug: data.slug,
    title: hasTitle ? (title as string) : undefined,
    excerpt: excerpt || undefined,
    type: collection.slice(0, -1),
    url: permalink(date, data.slug),
    date,
  };
}

/**
 * Best effort from a list entry. Differences from the site:
 *  - a titled post's frontmatter `excerpt` is unknown, so the card has no second line;
 *  - an untitled note's sentence comes from `PostRef.excerpt` (already stripped
 *    by the data layer, possibly cut at ~160 characters).
 */
export function targetFromPostRef(ref: PostRef): LinkTarget | null {
  if (!isLinkable(ref.collection) || ref.createdMs === null) return null;
  const date = new Date(ref.createdMs);
  // PostRef.title falls back to the excerpt and then the slug for untitled notes.
  const untitled =
    ref.collection === 'notes' &&
    (ref.title === ref.slug || ref.title === '' || (ref.excerpt !== '' && ref.excerpt.startsWith(ref.title)));

  let title: string | undefined;
  let excerpt: string | undefined;
  if (untitled) {
    const sentence = ref.excerpt.match(/^[^.!?]+[.!?]/);
    excerpt = sentence ? sentence[0].trim() : ref.excerpt.slice(0, 120) + (ref.excerpt.length > 120 ? '...' : '');
    if (!excerpt) excerpt = undefined;
  } else {
    title = ref.collection === 'quotations' ? `Quote from ${ref.title}` : ref.title;
  }

  return { slug: ref.slug, title, excerpt, type: ref.collection.slice(0, -1), url: permalink(date, ref.slug), date };
}

/** First match in the site's search order: entries, blogmarks, notes, quotations. */
export function findPostRefBySlug(posts: readonly PostRef[], slug: string): PostRef | undefined {
  for (const collection of LINKABLE_COLLECTIONS) {
    const hit = posts.find((p) => p.collection === collection && p.slug === slug);
    if (hit) return hit;
  }
  return undefined;
}
