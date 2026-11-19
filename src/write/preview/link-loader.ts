/**
 * Exact "Previously" card data for the posts a draft links to.
 *
 * This is the one place the preview talks to the data layer: it loads each
 * linked post (usually one or two, cached by the source) and derives the card
 * the way the site's build does. renderMarkdown itself stays pure and only
 * receives the result.
 */
import type { ContentSource, FrontmatterApi, PostRef } from '../contracts';
import {
  findPostRefBySlug,
  internalLinkSlugs,
  isLinkable,
  targetFromFile,
  targetFromPostRef,
  type LinkTarget,
} from './link-targets';

export interface LinkLoaderDeps {
  source: Pick<ContentSource, 'list' | 'load'>;
  frontmatter: Pick<FrontmatterApi, 'parse'>;
}

export function createLinkLoader({ source, frontmatter }: LinkLoaderDeps) {
  const cache = new Map<string, LinkTarget | null>();

  async function resolve(slug: string, posts: readonly PostRef[]): Promise<LinkTarget | null> {
    const ref = findPostRefBySlug(posts, slug);
    if (!ref || !isLinkable(ref.collection)) return null;
    try {
      const loaded = await source.load(ref.path);
      const data = frontmatter.parse(loaded.parts.frontmatter).data;
      return targetFromFile(ref.collection, data, loaded.parts.gap + loaded.parts.body) ?? targetFromPostRef(ref);
    } catch {
      // Offline or rate-limited: an approximate card beats none.
      return targetFromPostRef(ref);
    }
  }

  /** Targets for every internal permalink in `markdown`. Never rejects. */
  return async function linkTargets(markdown: string, posts?: readonly PostRef[]): Promise<LinkTarget[]> {
    const slugs = internalLinkSlugs(markdown);
    if (slugs.length === 0) return [];
    let list = posts;
    if (!list) {
      try {
        list = await source.list();
      } catch {
        return [];
      }
    }
    const out: LinkTarget[] = [];
    for (const slug of slugs) {
      if (!cache.has(slug)) cache.set(slug, await resolve(slug, list));
      const hit = cache.get(slug);
      if (hit) out.push(hit);
    }
    return out;
  };
}
