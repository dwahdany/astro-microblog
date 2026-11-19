/**
 * Pure path helpers shared by the sources. Paths are repo-relative, POSIX, no
 * leading slash (`src/content/notes/2026/pro.md`).
 */
import { CONTENT_ROOT, COLLECTIONS, SITE_ORIGIN, type CollectionKind } from '../contracts';

/** `https:`, `data:`, `blob:`, `mailto:` … or protocol-relative `//host/x`. */
const ABSOLUTE_URL = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

export function isAbsoluteUrl(src: string): boolean {
  return ABSOLUTE_URL.test(src);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Join a repo directory and a relative reference; null if it climbs out of the repo. */
export function joinRepoPath(dir: string, rel: string): string | null {
  const out = dir ? dir.split('/') : [];
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join('/');
}

/** `src/content/<collection>/…` → collection, or null when the path is not a content file. */
export function collectionOf(path: string): CollectionKind | null {
  if (!path.startsWith(CONTENT_ROOT + '/')) return null;
  const name = path.slice(CONTENT_ROOT.length + 1).split('/')[0];
  return (COLLECTIONS as readonly string[]).includes(name) ? (name as CollectionKind) : null;
}

/** True for markdown files the site's loaders actually publish (portfolio ignores `_*.md`). */
export function isPostPath(path: string): boolean {
  const collection = collectionOf(path);
  if (!collection || !path.endsWith('.md')) return false;
  if (collection === 'portfolio' && basename(path).startsWith('_')) return false;
  return true;
}

/** Split `foo/bar.png?x#y` into the path and its suffix, so only the path gets encoded. */
export function splitSuffix(src: string): [path: string, suffix: string] {
  const i = src.search(/[?#]/);
  return i < 0 ? [src, ''] : [src.slice(0, i), src.slice(i)];
}

/** Percent-encode each segment once: already-encoded input (`a%20b.png`) is not double-encoded. */
export function encodePath(path: string): string {
  return path
    .split('/')
    .map((seg) => {
      try {
        return encodeURIComponent(decodeURIComponent(seg));
      } catch {
        return encodeURIComponent(seg);
      }
    })
    .join('/');
}

/**
 * The repo path an asset reference written in a post points at, or null when
 * it is not a repo file (absolute URL, site-absolute `/x.png`, in-page anchor)
 * or climbs out of the repo. Used by `resolveAssetUrl` and, later, by save()
 * to know where a pasted image must be committed.
 */
export function assetRepoPath(postPath: string, src: string): string | null {
  const ref = src.trim();
  if (ref === '' || ref.startsWith('#') || ref.startsWith('?') || ref.startsWith('/') || isAbsoluteUrl(ref)) return null;
  const [rel] = splitSuffix(ref);
  if (rel === '') return null;
  let decoded = rel;
  try {
    decoded = decodeURIComponent(rel);
  } catch {
    /* keep as written */
  }
  return joinRepoPath(dirname(postPath), decoded);
}

/**
 * The resolution rules of `ContentSource.resolveAssetUrl`, shared by both
 * sources. They differ only in where repo files and site-absolute paths live.
 *
 *   absolute URL / protocol-relative   → unchanged
 *   `#anchor`                          → unchanged (same-document link)
 *   `/x.png` (site-absolute: public/)  → `siteBase + src`
 *   `pic.png`, `./a/pic.png`, `../x`   → relative to the DIRECTORY of postPath → `repoBase + path`
 *   '' / `?query` / escaping the repo  → null
 */
export function resolveAsset(
  postPath: string,
  src: string,
  where: { repoBase: string; siteBase: string },
): string | null {
  const ref = src.trim();
  if (ref === '') return null;
  if (isAbsoluteUrl(ref) || ref.startsWith('#')) return ref;
  if (ref.startsWith('?')) return null;
  if (ref.startsWith('/')) return where.siteBase + ref;
  const [rel, suffix] = splitSuffix(ref);
  const joined = joinRepoPath(dirname(postPath), rel);
  if (joined === null || joined === '') return null;
  return where.repoBase + encodePath(joined) + suffix;
}

export { SITE_ORIGIN };
