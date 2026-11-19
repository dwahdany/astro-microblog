/** Counting what was written. Pure. */

/**
 * Words in a markdown body: link and image targets, footnote markers, HTML
 * comments and tags do not count; the words inside code do.
 */
export function countWords(markdown: string): number {
  const text = markdown
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/\]\([^)\n]*\)/g, '] ')
    .replace(/\[\^[^\]\n]+\]:?/g, ' ')
    .replace(/<\/?[a-zA-Z][^>\n]*>/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ');
  return text.match(/[\p{L}\p{N}]+(?:['’.\-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

/** Minutes to read at 230 words a minute; 0 for an empty text, never less than 1 otherwise. */
export function readingMinutes(words: number): number {
  return words === 0 ? 0 : Math.max(1, Math.round(words / 230));
}

/** "1,204 words", "1 word". */
export function wordsLabel(words: number): string {
  return `${words.toLocaleString('en-GB')} ${words === 1 ? 'word' : 'words'}`;
}

/** Split `text` around the first case-insensitive occurrence of `query`, for highlighting a search hit. */
export function splitHit(text: string, query: string): [before: string, hit: string, after: string] {
  const q = query.trim();
  if (q === '') return [text, '', ''];
  const at = text.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return [text, '', ''];
  return [text.slice(0, at), text.slice(at, at + q.length), text.slice(at + q.length)];
}

/** "412 kB", "3.4 MB": a file size as people say it (decimal units, as phones and GitHub show them). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1000) return `${Math.round(bytes)} B`;
  if (bytes < 999_500) return `${Math.round(bytes / 1000)} kB`;
  const mb = bytes / 1_000_000;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}
