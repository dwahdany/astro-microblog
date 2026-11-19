/**
 * KaTeX, loaded on first use (a post without math never downloads it).
 * Rendered HTML is cached per TeX string, so moving the caret around a
 * document full of formulas does not re-typeset anything.
 */
type Katex = typeof import('katex').default;

let katex: Katex | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const cache = new Map<string, MathResult>();
const CACHE_LIMIT = 500;

export interface MathResult {
  html: string;
  /** Parse error message when the TeX is invalid (the html then shows the source). */
  error: string | null;
}

export function katexReady(): boolean {
  return katex !== null;
}

/** Start loading KaTeX (idempotent). Listeners registered with `onKatexReady` fire once it is usable. */
export function loadKatex(): Promise<void> {
  // The stylesheet is asked for by URL and linked here, on first use. A plain `import('….css')`
  // would be hoisted by the build into the page's <head> as a render-blocking stylesheet for
  // everyone, math or not.
  loading ??= Promise.all([import('katex'), import('katex/dist/katex.min.css?url')]).then(
    ([mod, css]) => {
      linkStylesheet(css.default);
      katex = mod.default;
      for (const listener of listeners) listener();
    },
    (err) => {
      loading = null; // allow a retry (e.g. the chunk failed to load while offline)
      throw err;
    },
  );
  return loading;
}

function linkStylesheet(href: string): void {
  if (typeof document === 'undefined' || document.querySelector('link[data-write-katex]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.writeKatex = '';
  document.head.append(link);
}

export function onKatexReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Typeset TeX, or null while KaTeX is not loaded yet. Never throws. */
export function renderMath(tex: string, display: boolean): MathResult | null {
  if (!katex) return null;
  const key = (display ? 'D' : 'I') + tex;
  const hit = cache.get(key);
  if (hit) return hit;
  let result: MathResult;
  try {
    result = { html: katex.renderToString(tex, { displayMode: display, throwOnError: true, strict: 'ignore' }), error: null };
  } catch (err) {
    result = { html: '', error: err instanceof Error ? err.message.replace(/^KaTeX parse error:\s*/, '') : String(err) };
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, result);
  return result;
}
