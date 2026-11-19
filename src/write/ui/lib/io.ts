/** The ways out of a read-only app: the clipboard and a file download. */

/**
 * Copy text, exactly. The async clipboard API only exists in secure contexts —
 * a phone loading the dev server over plain http on the LAN does not have it —
 * so there is a fallback through `document.execCommand('copy')`.
 *
 * The fallback must not put the text INTO a textarea and copy what comes out:
 * a textarea's value has its line endings normalised (CRLF and bare CR become
 * LF), and "Copy markdown" promises the file byte for byte. The textarea is
 * only there so there is a selection to copy; the `copy` event it triggers is
 * answered with the original string.
 *
 * Resolves false when both ways fail.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;font-size:16px';
    document.body.appendChild(area);
    area.select();
    area.setSelectionRange(0, area.value.length);
    let exact = false;
    const onCopy = (event: ClipboardEvent) => {
      if (!event.clipboardData) return;
      event.clipboardData.setData('text/plain', text);
      event.preventDefault();
      exact = true;
    };
    document.addEventListener('copy', onCopy, true);
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } finally {
      document.removeEventListener('copy', onCopy, true);
      area.remove();
    }
    // Without the event (a very old browser) what was copied is the textarea's value: only exact for LF text.
    return ok && (exact || !text.includes('\r'));
  } catch {
    return false;
  }
}

/** Offer `text` as a file download. Byte-exact: the text is written as UTF-8 with no BOM added and no line-ending changes. */
export function downloadText(filename: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export interface PageMeta {
  title: string;
  slug: string;
}

/**
 * Ask the site's own /api/fetch-meta (the endpoint the old admin uses) for a
 * page's title and a slug made from it. Null when the page cannot be read.
 */
export async function fetchPageMeta(url: string, signal?: AbortSignal): Promise<PageMeta | null> {
  if (!/^https?:\/\/\S+\.\S+/.test(url)) return null;
  try {
    const response = await fetch(`/api/fetch-meta?url=${encodeURIComponent(url)}`, { signal });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    if (typeof data !== 'object' || data === null) return null;
    const { title, slug } = data as { title?: unknown; slug?: unknown };
    if (typeof title !== 'string' || title.trim() === '') return null;
    return { title: title.trim(), slug: typeof slug === 'string' ? slug : '' };
  } catch {
    return null;
  }
}
