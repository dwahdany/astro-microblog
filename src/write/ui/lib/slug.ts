/**
 * A new post's slug follows its title until the owner edits the slug by hand.
 * Stateless: the slug counts as "still automatic" when it is empty, the
 * scaffold's placeholder, or exactly what the previous title would have given.
 */
import type { CollectionKind } from '../../contracts';

/** Same cap as the site's /api/fetch-meta. */
const MAX_SLUG = 60;

/** The field a post's slug is derived from (Sveltia's `summary` field for the collection). */
export function slugSeedKey(collection: CollectionKind): string {
  if (collection === 'blogmarks') return 'link_title';
  if (collection === 'quotations') return 'source';
  return 'title';
}

export function autoSlug(seed: string, slugify: (text: string) => string): string {
  return slugify(seed).slice(0, MAX_SLUG).replace(/-+$/, '');
}

export function isAutoSlug(slug: string, previousSeed: string, slugify: (text: string) => string): boolean {
  if (slug === '' || /^untitled-[0-9a-z]{4,}$/.test(slug)) return true;
  return previousSeed.trim() !== '' && slug === autoSlug(previousSeed, slugify);
}
