/**
 * File names for images taken into a post.
 *
 * `encodeFilePath` and `renameIfNeeded` are lifted from Sveltia CMS —
 * https://github.com/sveltia/sveltia-cms (fork dwahdany/sveltia-cms) at commit 06d5552aa,
 * `src/lib/services/utils/file.js` (26-45, 54-84), with `encodeRFC3986` from `utils/url.js`.
 * Copyright (c) 2026 Kohei Yoshino. MIT License: see src/write/licenses/sveltia-MIT.txt.
 * Changes: TypeScript; `getPathInfo` and `escapeRegExp` inlined. `sanitizeImageName`,
 * `timestampName` and the path helpers are new: this app narrows every new name to `[a-z0-9.-]`,
 * which makes the percent-encoding a no-op and keeps names safe on every file system and in
 * markdown.
 */
import type { PendingAsset, PendingImage } from '../../contracts';

const escapeRegExp = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `photo.final.jpg` → `{ filename: 'photo.final', extension: 'jpg' }`; no dot → no extension. */
export function getPathInfo(name: string): { filename: string; extension: string | undefined } {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return { filename: base, extension: undefined };
  return { filename: base.slice(0, dot), extension: base.slice(dot + 1) };
}

/** `encodeURIComponent` plus the characters RFC 3986 reserves that it leaves alone: `!'()*`. */
const encodeRFC3986 = (str: string): string => encodeURIComponent(str).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Encode the given (partial) file path or file name segment by segment, keeping the slashes. Some
 * more characters than `encodeURIComponent()` does are encoded, including `!`, `(` and `)`, which
 * affect the Markdown syntax like images and links. The `@` prefix is an exception; it shouldn't be
 * encoded.
 */
export const encodeFilePath = (path: string): string => {
  const hasAtPrefix = path.startsWith('@');

  if (hasAtPrefix) {
    path = path.slice(1);
  }

  path = path.split('/').map(encodeRFC3986).join('/');

  if (hasAtPrefix) {
    return `@${path}`;
  }

  return path;
};

/**
 * Check if the given file name is already taken in the other names. If so, rename it by
 * appending a number higher than any variant already used, like `summer-beach-2.jpg`. A name that
 * is free is returned as is, even if numbered variants of it exist.
 * @param otherNames Other names (of files in the same folder).
 * @param options.hasExtension Whether the name ends with a file extension, which the number goes
 * before. Pass `false` for a slug, whose dot is part of the name.
 */
export const renameIfNeeded = (name: string, otherNames: readonly string[], { hasExtension = true }: { hasExtension?: boolean } = {}): string => {
  const lowerCaseName = name.toLowerCase();

  // Case-insensitive, since `Photo.jpg` and `photo.jpg` clash on a case-insensitive file system
  // like macOS's or Windows's
  if (!otherNames.some((otherName) => otherName.toLowerCase() === lowerCaseName)) {
    return name;
  }

  const { filename: slug, extension } = hasExtension ? getPathInfo(name) : { filename: name, extension: undefined };

  const suffix = extension ? `\\.${escapeRegExp(extension)}` : '';
  const regex = new RegExp(`^${escapeRegExp(slug)}-(?<num>\\d+)${suffix}$`, 'i');
  let highest = 0;

  // Only the highest number already taken matters, so the names are scanned once rather than sorted
  otherNames.forEach((otherName) => {
    const match = otherName.match(regex);

    if (match) {
      highest = Math.max(highest, Number((match.groups as Record<string, string>).num));
    }
  });

  return `${slug}-${highest + 1}${extension ? `.${extension}` : ''}`;
};

/* ----------------------------------------------------------- new: this app */

/** Extension written for each image type the app commits. */
export const EXTENSION_FOR_TYPE: Readonly<Record<string, string>> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

/** Names browsers and phones give a file that say nothing about it. */
const GENERIC_STEM = /^(?:image|img|pasted-?image|unnamed|untitled|blob)?$/i;

const two = (n: number): string => String(n).padStart(2, '0');

/** `20260912-103000`, in UTC: a name for an image that has no meaningful one of its own. */
export function timestampName(date: Date = new Date()): string {
  return (
    `${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}` +
    `-${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}`
  );
}

/**
 * A safe file name for a new image: lowercase ASCII letters, digits and single hyphens, plus the
 * extension that matches the bytes (`type`), whatever extension the file arrived with.
 * `Façade Photo (1).JPEG` + image/jpeg → `facade-photo-1.jpg`; a name with nothing usable in it
 * (or a generic one such as `image.png`) becomes a UTC timestamp.
 */
export function sanitizeImageName(original: string | undefined, type: string, now: Date = new Date()): string {
  const extension = EXTENSION_FOR_TYPE[type] ?? 'bin';
  const base = (original ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  // `.png` alone is an extension without a name
  const { filename } = /^\.[^.]*$/.test(base) ? { filename: '' } : getPathInfo(base);
  let stem = filename
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
    .replace(/-+$/g, '');
  if (GENERIC_STEM.test(stem)) stem = timestampName(now);
  return `${stem}.${extension}`;
}

const dirname = (path: string): string => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** File name of a post without `.md`: the name of its image folder. */
export function postStem(postPath: string): string {
  return postPath.slice(postPath.lastIndexOf('/') + 1).replace(/\.md$/, '');
}

/** `src/content/notes/2026/x.md` → `src/content/notes/2026/x` — where the post's images live. */
export function imageFolder(postPath: string): string {
  const dir = dirname(postPath);
  return (dir ? dir + '/' : '') + postStem(postPath);
}

/** Repo path of an image of the post. */
export function imagePath(postPath: string, name: string): string {
  return `${imageFolder(postPath)}/${name}`;
}

/** What to write in the markdown for an image of the post: `<stem>/<name>` (no `./`, no leading slash). */
export function imageRef(postPath: string, name: string): string {
  return encodeFilePath(`${postStem(postPath)}/${name}`);
}

/** Is the image mentioned anywhere in the text (body or frontmatter)? */
export function isImageReferenced(raw: string, postPath: string, name: string): boolean {
  const plain = `${postStem(postPath)}/${name}`;
  return raw.includes(plain) || raw.includes(encodeFilePath(plain));
}

/**
 * The files a save has to carry for a draft's images, at their repo paths for `postPath`.
 * With `raw`, images the text no longer mentions are left out (they stay in the draft).
 */
export function pendingAssetsFor(postPath: string, images: readonly PendingImage[] | undefined, raw?: string): PendingAsset[] {
  return (images ?? [])
    .filter((image) => raw === undefined || isImageReferenced(raw, postPath, image.name))
    .map((image) => ({ path: imagePath(postPath, image.name), data: image.data }));
}

/**
 * Rewrite image references after a post moved (its slug changed): `<old stem>/<name>` becomes
 * `<new stem>/<name>`, optionally with a leading `./`. Only references are touched — the stem must
 * start right after a delimiter (`(`, quote, whitespace, `<`, `=`, `:` or start of line) and be
 * followed by `/` and a file name — and, when `names` is given, only references to those files.
 * Returns the SAME string when nothing matched.
 */
export function rewriteImageRefs(raw: string, fromPostPath: string, toPostPath: string, names?: Iterable<string>): string {
  const from = postStem(fromPostPath);
  const to = postStem(toPostPath);
  if (from === to || from === '') return raw;
  const known = names ? new Set([...names].flatMap((n) => [n, encodeFilePath(n)])) : undefined;
  const pattern = new RegExp(`(^|[\\s("'<=:\\[])(\\./)?${escapeRegExp(encodeFilePath(from))}/([^\\s)"'<>?#]+)`, 'gm');
  return raw.replace(pattern, (match, lead: string, dot: string | undefined, name: string) =>
    known && !known.has(name) ? match : `${lead}${dot ?? ''}${encodeFilePath(to)}/${name}`,
  );
}
