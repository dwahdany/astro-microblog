/**
 * Pointer and focus behaviour that sits next to the live preview:
 *
 *  - focus tracking → the `editorFocused` state the preview reads;
 *  - links: a tap or click only places the caret (editing wins on touch); a
 *    small "Open" tooltip then appears above the link, and ⌘/Ctrl-click opens
 *    it directly on desktop.
 */
import { Facet, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state';
import { EditorView, ViewPlugin, showTooltip, tooltips, type Tooltip, type TooltipView, type ViewUpdate } from '@codemirror/view';
import { SITE_ORIGIN } from '../contracts';
import { editorFocused, nodeAt, setFocused } from './livePreview';

/* ---- focus ---------------------------------------------------------------- */

function domFocused(view: EditorView): boolean {
  // Deliberately not `view.hasFocus`: switching windows should not count as leaving the editor
  // (the preview would collapse and re-expand the construct under the caret each time).
  return view.root.activeElement === view.contentDOM;
}

/** Bring the `editorFocused` field in line with the DOM. Safe to call any time. */
export function syncFocus(view: EditorView): void {
  const now = domFocused(view);
  if (now !== view.state.field(editorFocused, false)) view.dispatch({ effects: setFocused.of(now) });
}

/** How long to wait for a tap's caret before revealing markup at the old one. */
const TAP_SETTLE_MS = 300;

const focusTracker = ViewPlugin.fromClass(
  class {
    private timer: ReturnType<typeof setTimeout> | undefined;
    private destroyed = false;
    private lastPointer = 0;
    /** Focus arrived through a tap whose caret position has not been reported yet. */
    private awaitingCaret = false;
    constructor(readonly view: EditorView) {
      this.schedule(0);
    }
    schedule(delay: number): void {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.awaitingCaret = false;
        if (!this.destroyed) syncFocus(this.view);
      }, delay);
    }
    pointer(): void {
      this.lastPointer = Date.now();
    }
    focusChanged(focusing: boolean): void {
      // On touch screens focus lands before the browser reports where the tap put the caret.
      // Revealing right away would open the markup at the PREVIOUS caret (say, a display-math
      // block further up) for a moment and make the page jump; wait for the new caret instead.
      this.awaitingCaret = focusing && Date.now() - this.lastPointer < 700;
      this.schedule(this.awaitingCaret ? TAP_SETTLE_MS : 0);
    }
    update(update: ViewUpdate): void {
      if (this.awaitingCaret && update.selectionSet) this.schedule(0);
    }
    destroy(): void {
      this.destroyed = true;
      clearTimeout(this.timer);
    }
  },
  {
    eventHandlers: {
      focus() {
        this.focusChanged(true);
      },
      blur() {
        this.focusChanged(false);
      },
      touchstart() {
        this.pointer();
      },
      pointerdown(event) {
        if (event.pointerType !== 'mouse') this.pointer();
      },
    },
  },
);

/* ---- links ---------------------------------------------------------------- */

export interface LinkTarget {
  from: number;
  to: number;
  /** The address as written in the markdown. */
  url: string;
}

/** The link (inline link, `<autolink>` or bare URL) at a position, if any. */
export function linkAt(state: EditorState, pos: number): LinkTarget | null {
  const node = nodeAt(state, pos, ['Link', 'Autolink', 'URL']);
  if (!node) return null;
  if (node.name === 'URL') {
    const parent = node.parent?.name;
    if (parent === 'Image' || parent === 'LinkReference') return null;
    const owner = parent === 'Link' || parent === 'Autolink' ? node.parent! : node;
    return { from: owner.from, to: owner.to, url: unwrap(state.sliceDoc(node.from, node.to)) };
  }
  const url = node.getChild('URL');
  if (!url) return null;
  return { from: node.from, to: node.to, url: unwrap(state.sliceDoc(url.from, url.to)) };
}

function unwrap(text: string): string {
  return text.startsWith('<') && text.endsWith('>') ? text.slice(1, -1) : text;
}

/**
 * Turn an address as written in a post into something a browser can open:
 * site-relative paths resolve against the published site. Returns null for
 * schemes we will not open (javascript:, data: …) and for in-page anchors.
 */
export function resolveLinkUrl(url: string): string | null {
  const raw = url.trim();
  if (!raw || raw.startsWith('#')) return null;
  const withScheme = /^www\./i.test(raw) ? `https://${raw}` : raw;
  try {
    const resolved = new URL(withScheme, `${SITE_ORIGIN}/`);
    return ['http:', 'https:', 'mailto:'].includes(resolved.protocol) ? resolved.href : null;
  } catch {
    return null;
  }
}

export const linkOpener = Facet.define<(url: string) => void, (url: string) => void>({
  combine: (values) =>
    values[0] ??
    ((url) => {
      window.open(url, '_blank', 'noopener,noreferrer');
    }),
});

function openLink(view: EditorView, target: LinkTarget): boolean {
  const href = resolveLinkUrl(target.url);
  if (!href) return false;
  view.state.facet(linkOpener)(href);
  return true;
}

const showLinkTip = StateEffect.define<LinkTarget | null>();

function tipDom(view: EditorView): TooltipView {
  // CodeMirror styles the element it is given as the tooltip box; the button goes inside it.
  const box = document.createElement('div');
  const dom = document.createElement('button');
  box.append(dom);
  dom.type = 'button';
  dom.className = 'cm-w-linktip';
  dom.dataset.linkOpen = '';
  const label = document.createElement('span');
  label.className = 'cm-w-linktip-go';
  label.textContent = 'Open';
  const address = document.createElement('span');
  address.className = 'cm-w-linktip-url';
  const arrow = document.createElement('span');
  arrow.className = 'cm-w-linktip-go';
  arrow.textContent = '↗';
  arrow.setAttribute('aria-hidden', 'true');
  dom.append(label, address, arrow);
  let current: LinkTarget | null = null;
  const render = (state: EditorState) => {
    current = state.field(linkTip)?.target ?? null;
    address.textContent = current ? current.url.replace(/^https?:\/\/(www\.)?/, '') : '';
    dom.title = current?.url ?? '';
  };
  render(view.state);
  // Keep the caret (and the phone keyboard) where it is.
  dom.addEventListener('mousedown', (e) => e.preventDefault());
  dom.addEventListener('click', (e) => {
    e.preventDefault();
    if (current) openLink(view, current);
  });
  return {
    dom: box,
    update(update: ViewUpdate) {
      render(update.state);
    },
  };
}

interface LinkTip {
  target: LinkTarget;
  tooltip: Tooltip;
}

const linkTip = StateField.define<LinkTip | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(showLinkTip)) {
        value = e.value && resolveLinkUrl(e.value.url)
          ? { target: e.value, tooltip: { pos: e.value.from, end: e.value.to, above: true, create: tipDom } }
          : null;
      }
      if (e.is(setFocused) && !e.value) value = null;
    }
    if (!value) return null;
    if (tr.docChanged) return null;
    const { head, empty } = tr.state.selection.main;
    if (!empty || head < value.target.from || head > value.target.to) return null;
    return value;
  },
  provide: (field) => showTooltip.from(field, (v) => v?.tooltip ?? null),
});

const linkPointer = EditorView.domEventHandlers({
  mousedown(event, view) {
    // ⌘/Ctrl-click opens; a plain click is just a click in text.
    if (event.button !== 0 || !(event.metaKey || event.ctrlKey)) return false;
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    const target = linkAt(view.state, pos);
    if (!target || !openLink(view, target)) return false;
    event.preventDefault();
    return true;
  },
  click(event, view) {
    if (event.metaKey || event.ctrlKey) return false;
    // After a tap/click has placed the caret (the native selection settles a moment later on
    // touch), offer to open the link the caret landed in.
    setTimeout(() => {
      if (!view.dom.isConnected) return;
      const { head, empty } = view.state.selection.main;
      const target = empty && view.state.field(editorFocused, false) ? linkAt(view.state, head) : null;
      const shown = view.state.field(linkTip, false)?.target ?? null;
      if (target?.from === shown?.from && target?.url === shown?.url) return;
      view.dispatch({ effects: showLinkTip.of(target) });
    }, 60);
    return false;
  },
});

export function interaction(): Extension {
  return [
    focusTracker,
    linkTip,
    linkPointer,
    // `absolute` keeps tooltips right when iOS shifts the layout viewport for the keyboard;
    // the editor's own box is the space they must stay inside.
    tooltips({ position: 'absolute', tooltipSpace: (view) => view.dom.getBoundingClientRect() }),
  ];
}
