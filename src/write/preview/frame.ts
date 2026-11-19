/**
 * Driving the preview frame from the app.
 *
 * HOW THE PREVIEW IS ISOLATED, AND WHY THIS WAY
 *
 * The preview is an iframe on /write/preview-frame/ — a prerendered page that
 * loads the public site's real stylesheet and nothing else. The app's themes
 * never reach it and Tailwind never reaches the app.
 *
 *   sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
 *
 *  - NO `allow-scripts`. No script can run in the frame — not a `<script>` in
 *    a post, not an `onerror=` attribute, not a `javascript:` URL, not a
 *    nested embed. That is the security boundary, and it is why the frame
 *    page ships no JavaScript and the app writes the DOM from outside instead
 *    of posting messages to a script in the frame. The frame page adds a
 *    `script-src 'none'` policy as a second lock, and the renderer strips
 *    scripts as a third (see rehypeDefang).
 *  - `allow-same-origin` is what makes the styling real. Without it the frame
 *    gets an opaque origin ("null"), and every font request (Roboto Mono, all
 *    KaTeX fonts) becomes a cross-origin fetch that needs CORS headers the
 *    host does not send. Measured in Chromium against a static server: with
 *    an opaque origin 0 fonts load and all fail CORS; with allow-same-origin
 *    all load. (blog.wahdany.eu sends no Access-Control-Allow-Origin for its
 *    fonts either.) Same-origin without scripts is safe: the dangerous pair is
 *    allow-same-origin WITH allow-scripts.
 *  - `allow-popups` + `allow-popups-to-escape-sandbox` let a link open in a
 *    normal new tab. Every link except in-page `#…` anchors is rewritten to
 *    `target="_blank" rel="noopener noreferrer"`, and only http(s), mailto and
 *    tel survive, so the preview itself never navigates away.
 *
 * Because no script runs in the frame, nothing here relies on event listeners
 * attached inside it: whether a listener from the app's realm fires on a node
 * of a script-less sandboxed document is engine-specific, and only Chromium
 * could be tested. Footnote jumps and back-links are plain fragment navigation
 * done by the browser; scroll position and image state are read from outside
 * on a timer.
 *
 * RULE: post HTML is only ever parsed by the FRAME's document (a `<template>`
 * created there). Parsing it in the app's document would run `onerror`
 * handlers in the app.
 */
import { QUOTE_CLASS } from './chrome';

export const FRAME_PATH = '/write/preview-frame/';
export const FRAME_SANDBOX = 'allow-same-origin allow-popups allow-popups-to-escape-sandbox';

/** Element ids in src/pages/write/preview-frame.astro. */
export const SLOT = {
  header: 'write-preview-header',
  lead: 'write-preview-lead',
  body: 'write-preview-body',
  after: 'write-preview-after',
} as const;

export interface FrameContent {
  title: string;
  header: string;
  lead: string;
  /** `PreviewResult.html`. */
  body: string;
  after: string;
  wrapBody: 'blockquote' | null;
}

const ALLOWED_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const MAX_PATCH_DEPTH = 4;

/** True when the document is (still) the preview frame page. */
export function isPreviewDocument(doc: Document | null | undefined): doc is Document {
  return !!doc && doc.getElementById(SLOT.body) !== null;
}

/** Make every link either an in-page jump or a new-tab link with a safe scheme. */
export function hardenLinks(root: ParentNode, baseUri: string): void {
  for (const link of root.querySelectorAll('a[href], area[href]')) {
    const raw = (link.getAttribute('href') ?? '').trim();
    if (raw.startsWith('#')) {
      link.removeAttribute('target');
      continue;
    }
    let url: URL | null = null;
    try {
      url = new URL(raw, baseUri);
    } catch {
      url = null;
    }
    if (!url || !ALLOWED_LINK_PROTOCOLS.has(url.protocol)) {
      link.removeAttribute('href');
      link.setAttribute('data-write-blocked', '');
      continue;
    }
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noopener noreferrer');
  }
}

function sameShell(a: Node, b: Node): boolean {
  return a.nodeType === 1 && b.nodeType === 1 && a.cloneNode(false).isEqualNode(b.cloneNode(false));
}

/**
 * Make `current`'s children equal to `next`'s while touching as little as
 * possible: the common prefix and suffix stay in place (same nodes — an
 * unchanged image does not reload, and nothing above the reader moves), a
 * single changed element is patched recursively, anything else is replaced.
 * Returns the number of nodes inserted or removed.
 */
export function patchChildren(current: ParentNode, next: ParentNode, depth = 0): number {
  const oldNodes = Array.from(current.childNodes);
  const newNodes = Array.from(next.childNodes);

  let start = 0;
  while (start < oldNodes.length && start < newNodes.length && oldNodes[start].isEqualNode(newNodes[start])) start++;
  let oldEnd = oldNodes.length;
  let newEnd = newNodes.length;
  while (oldEnd > start && newEnd > start && oldNodes[oldEnd - 1].isEqualNode(newNodes[newEnd - 1])) {
    oldEnd--;
    newEnd--;
  }
  if (start === oldEnd && start === newEnd) return 0;

  if (
    oldEnd - start === 1 &&
    newEnd - start === 1 &&
    depth < MAX_PATCH_DEPTH &&
    sameShell(oldNodes[start], newNodes[start]) &&
    newNodes[start].childNodes.length > 0
  ) {
    return patchChildren(oldNodes[start] as Element, newNodes[start] as Element, depth + 1);
  }

  const before = oldNodes[oldEnd] ?? null;
  for (let i = start; i < oldEnd; i++) current.removeChild(oldNodes[i]);
  for (let i = start; i < newEnd; i++) current.insertBefore(newNodes[i], before);
  return oldEnd - start + (newEnd - start);
}

function fill(doc: Document, id: string, html: string): number {
  const slot = doc.getElementById(id);
  if (!slot) return 0;
  // A template owned by the frame's document: inert while parsed (no image
  // loads, no handlers) and its nodes are adopted on insertion.
  const template = doc.createElement('template');
  template.innerHTML = html;
  hardenLinks(template.content, doc.baseURI);
  return patchChildren(slot, template.content);
}

/** Write a rendered post into the frame. Returns how many nodes changed. */
export function applyContent(doc: Document, content: FrameContent): number {
  if (!isPreviewDocument(doc)) return 0;
  doc.title = content.title ? `Preview: ${content.title}` : 'Preview';
  const body =
    content.wrapBody === 'blockquote'
      ? `<blockquote data-write-wrap class="${QUOTE_CLASS}">${content.body}</blockquote>`
      : content.body;
  return (
    fill(doc, SLOT.header, content.header) +
    fill(doc, SLOT.lead, content.lead) +
    fill(doc, SLOT.body, body) +
    fill(doc, SLOT.after, content.after)
  );
}

/* -------------------------------------------------------------------------- *
 * Scroll position
 * -------------------------------------------------------------------------- */

/**
 * Where the reader is, expressed against content rather than pixels: the
 * first body block that reaches below the top edge, and how far into it.
 * Pixels alone go wrong as soon as an image above loads or a block changes
 * height; a block reference survives both.
 */
export interface ScrollAnchor {
  /** scrollTop when captured (used as is when the reader was above the body). */
  top: number;
  /** Index of the anchor block among the body's blocks, or -1. */
  index: number;
  /** Pixels of the anchor block above the top edge. */
  offset: number;
  /** The block itself, while the same frame document lives. */
  node?: Element;
}

function scrollerOf(doc: Document): Element {
  return doc.scrollingElement ?? doc.documentElement;
}

function bodyBlocks(doc: Document): Element[] {
  const body = doc.getElementById(SLOT.body);
  if (!body) return [];
  const wrap = body.querySelector(':scope > [data-write-wrap]');
  return Array.from((wrap ?? body).children);
}

export function getScrollTop(doc: Document): number {
  return scrollerOf(doc).scrollTop;
}

export function setScrollTop(doc: Document, top: number): number {
  const scroller = scrollerOf(doc);
  scroller.scrollTop = Math.max(0, top);
  return scroller.scrollTop;
}

export function captureAnchor(doc: Document): ScrollAnchor {
  const top = getScrollTop(doc);
  const blocks = bodyBlocks(doc);
  for (let index = 0; index < blocks.length; index++) {
    const rect = blocks[index].getBoundingClientRect();
    if (rect.bottom > 0) {
      // Still above the first block: plain pixels are the better description.
      if (index === 0 && rect.top > 0) break;
      return { top, index, offset: -rect.top, node: blocks[index] };
    }
  }
  return { top, index: -1, offset: 0 };
}

/** The scrollTop that puts the anchor back where it was. */
/**
 * The block that sits `fraction` (0–1) of the way through the body's TEXT — used to open the
 * preview near where the writing was. Text, not pixels or block count: a long paragraph is a long
 * stretch of source too, while an image or a formula is one short line of it.
 */
export function fractionAnchor(doc: Document, fraction: number): ScrollAnchor {
  const blocks = bodyBlocks(doc);
  if (!(fraction > 0) || blocks.length === 0) return { top: 0, index: -1, offset: 0 };
  const lengths = blocks.map((b) => (b.textContent ?? '').length + 1);
  const target = Math.min(1, fraction) * lengths.reduce((a, b) => a + b, 0);
  let seen = 0;
  let index = blocks.length - 1;
  for (let i = 0; i < blocks.length; i++) {
    seen += lengths[i];
    if (seen > target) {
      index = i;
      break;
    }
  }
  return { top: 0, index, offset: 0, node: blocks[index] };
}

export function anchorTop(doc: Document, anchor: ScrollAnchor): number {
  if (anchor.index < 0) return anchor.top;
  const blocks = bodyBlocks(doc);
  const node = anchor.node && anchor.node.isConnected ? anchor.node : blocks[Math.min(anchor.index, blocks.length - 1)];
  if (!node) return anchor.top;
  return getScrollTop(doc) + node.getBoundingClientRect().top + anchor.offset;
}

/** An anchor without its node reference, for remembering across frame reloads. */
export function detachAnchor(anchor: ScrollAnchor): ScrollAnchor {
  return { top: anchor.top, index: anchor.index, offset: anchor.offset };
}

/* -------------------------------------------------------------------------- *
 * Broken images
 * -------------------------------------------------------------------------- */

/**
 * Images that finished loading with nothing to show. Polled from outside
 * (no `error` events reach us); lazy images that have not been requested yet
 * are not `complete` and are not reported.
 */
export function findBrokenImages(doc: Document): string[] {
  const broken: string[] = [];
  for (const img of Array.from(doc.images)) {
    const src = img.getAttribute('src');
    if (!src) continue;
    if (img.complete && img.naturalWidth === 0) {
      img.setAttribute('data-write-broken', '');
      if (!broken.includes(src)) broken.push(src);
    } else if (img.hasAttribute('data-write-broken')) {
      img.removeAttribute('data-write-broken');
    }
  }
  return broken;
}
