/**
 * Git blob ids, computed locally.
 *
 * `sha1("blob <byte length>\0" + bytes)` is the id git (and the GitHub API)
 * gives a file's content. Computing it ourselves lets the sources
 *   - key caches by content, so a cache entry can never be stale;
 *   - notice when raw.githubusercontent.com serves an older revision than the
 *     tree listing (its CDN lags up to five minutes behind a push);
 *   - hand save() a `baseSha` that truly describes the text that was edited.
 *
 * Uses WebCrypto (`crypto.subtle`), which browsers expose only in secure
 * contexts (https, localhost). Elsewhere `gitBlobSha` resolves to undefined
 * and callers simply go without verification.
 */

const encoder = new TextEncoder();

export function canHash(): boolean {
  return typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.subtle?.digest === 'function';
}

export async function gitBlobSha(content: Uint8Array | string): Promise<string | undefined> {
  if (!canHash()) return undefined;
  const bytes = typeof content === 'string' ? encoder.encode(content) : content;
  const header = encoder.encode(`blob ${bytes.byteLength}\0`);
  const all = new Uint8Array(header.byteLength + bytes.byteLength);
  all.set(header, 0);
  all.set(bytes, header.byteLength);
  const digest = await globalThis.crypto.subtle.digest('SHA-1', all);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Decode file bytes as UTF-8 WITHOUT dropping a byte-order mark.
 * (`Response.text()` strips a leading BOM, which would break byte identity
 * for such a file; the BOM is a slice of its own in `PostParts`.)
 */
export function decodeUtf8(bytes: Uint8Array | ArrayBuffer): string {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
}
