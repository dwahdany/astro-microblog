/**
 * Widgets the live preview draws in place of (or next to) markdown source.
 *
 * A widget is presentation only. Each `eq` compares exactly what the DOM
 * depends on, so CodeMirror keeps the existing DOM when decorations are
 * rebuilt (no image reloads or re-typeset math while the caret moves).
 */
import { StateEffect } from '@codemirror/state';
import { EditorView, WidgetType } from '@codemirror/view';
import { katexReady, loadKatex, renderMath } from './katex';

/** What a tapped footnote chip reports. */
export interface FootnoteTap {
  label: string;
  /** Document position of the chip. */
  pos: number;
  kind: 'ref' | 'def';
}

export interface WidgetHost {
  onFootnote(view: EditorView, tap: FootnoteTap): void;
  /**
   * A picture was tapped. `lineEnd` is the end of the line its source ends on, `index` which of
   * that line's images it is (several images on one line are drawn one below the other).
   */
  onImage(view: EditorView, tap: { lineEnd: number; index: number }): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Make an element act as a button without ever taking focus (or the caret) from the editor. */
function pressable(dom: HTMLElement, onPress: (event: Event) => void): void {
  dom.addEventListener('mousedown', (e) => e.preventDefault());
  dom.addEventListener('click', (e) => {
    e.preventDefault();
    onPress(e);
  });
}

/**
 * Tapping a rendered stand-in puts the caret into the source it stands for (which reveals it).
 * Needed on touch screens, where the browser will not place a caret on a non-editable element;
 * with a mouse it simply makes the click land in a predictable place.
 */
function entersSource(dom: HTMLElement, view: EditorView, target: (pos: number) => number): void {
  pressable(dom, () => {
    const pos = Math.min(target(view.posAtDOM(dom)), view.state.doc.length);
    view.dispatch({ selection: { anchor: pos }, userEvent: 'select.pointer' });
    view.focus();
  });
}

/* ---- list markers -------------------------------------------------------- */

export class BulletWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(): HTMLElement {
    return el('span', 'cm-w-bullet', '•');
  }
  ignoreEvent(): boolean {
    return false;
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }
  toDOM(view: EditorView): HTMLElement {
    const dom = el('span', 'cm-w-task');
    dom.setAttribute('role', 'checkbox');
    dom.setAttribute('aria-checked', String(this.checked));
    dom.setAttribute('aria-label', this.checked ? 'Done' : 'To do');
    dom.setAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter');
    dom.title = 'Tap to tick, or ⌘/Ctrl+Enter with the caret on this line';
    dom.append(el('span', 'cm-w-task-box'));
    pressable(dom, () => {
      if (view.state.readOnly) return;
      const pos = view.posAtDOM(dom);
      const marker = view.state.sliceDoc(pos, pos + 3);
      if (!/^\[[ xX]\]$/.test(marker)) return;
      view.dispatch({
        changes: { from: pos + 1, to: pos + 2, insert: marker[1] === ' ' ? 'x' : ' ' },
        userEvent: 'input.task',
      });
    });
    return dom;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/* ---- rules and fences ---------------------------------------------------- */

export class RuleWidget extends WidgetType {
  eq(): boolean {
    return true;
  }
  toDOM(view: EditorView): HTMLElement {
    const dom = el('span', 'cm-w-hr');
    entersSource(dom, view, (pos) => view.state.doc.lineAt(pos).to);
    return dom;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/** Stands in for a hidden opening code fence: shows the language, keeps the line. */
export class FenceWidget extends WidgetType {
  constructor(readonly lang: string) {
    super();
  }
  eq(other: FenceWidget): boolean {
    return other.lang === this.lang;
  }
  toDOM(view: EditorView): HTMLElement {
    const dom = el('span', 'cm-w-fence', this.lang || 'code');
    entersSource(dom, view, (pos) => view.state.doc.lineAt(pos).to);
    return dom;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/* ---- footnotes ----------------------------------------------------------- */

export class FootnoteRefWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly orphan: boolean,
    readonly active: boolean,
    readonly host: WidgetHost,
  ) {
    super();
  }
  eq(other: FootnoteRefWidget): boolean {
    return other.label === this.label && other.orphan === this.orphan && other.active === this.active && other.host === this.host;
  }
  toDOM(view: EditorView): HTMLElement {
    const dom = el('sup', 'cm-w-fn' + (this.orphan ? ' cm-w-fn-orphan' : '') + (this.active ? ' cm-w-fn-active' : ''), this.label);
    dom.setAttribute('role', 'button');
    dom.dataset.footnoteRef = this.label;
    dom.setAttribute('aria-label', this.orphan ? `Footnote ${this.label} has no note yet` : `Footnote ${this.label}`);
    dom.setAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter');
    dom.title = this.orphan ? `No note for [^${this.label}] yet` : `Footnote ${this.label}: tap to open, or ⌘/Ctrl+Enter with the caret next to it`;
    pressable(dom, () => this.host.onFootnote(view, { label: this.label, pos: view.posAtDOM(dom), kind: 'ref' }));
    return dom;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

export class FootnoteDefWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly orphan: boolean,
    readonly active: boolean,
    readonly host: WidgetHost,
  ) {
    super();
  }
  eq(other: FootnoteDefWidget): boolean {
    return other.label === this.label && other.orphan === this.orphan && other.active === this.active && other.host === this.host;
  }
  toDOM(view: EditorView): HTMLElement {
    const dom = el('span', 'cm-w-fndef' + (this.orphan ? ' cm-w-fn-orphan' : '') + (this.active ? ' cm-w-fn-active' : ''), this.label);
    dom.setAttribute('role', 'button');
    dom.dataset.footnoteDef = this.label;
    dom.setAttribute('aria-label', this.orphan ? `Note ${this.label} is not referenced in the text` : `Note ${this.label}`);
    if (this.orphan) dom.title = `Nothing in the text points to [^${this.label}]`;
    pressable(dom, () => this.host.onFootnote(view, { label: this.label, pos: view.posAtDOM(dom), kind: 'def' }));
    return dom;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/* ---- images -------------------------------------------------------------- */

/** Natural sizes of images seen so far, so a widget can reserve its box before the image loads again. */
const imageSizes = new Map<string, { width: number; height: number }>();
const failedImages = new Set<string>();

/**
 * A picture finished loading (or failed): its box has the height it will keep. The live preview
 * rebuilds on this effect, which swaps the widget for its `settled` twin and so has CodeMirror
 * measure the content again.
 *
 * `view.requestMeasure()` alone is not enough. CodeMirror only re-reads line and widget heights
 * when the height of `.cm-content` changed, and that element is at least as tall as the scroller
 * (`min-height: 100%`): in a post shorter than the screen a picture can grow from its placeholder
 * to its real size without the content box changing at all. The height map then keeps the
 * placeholder's height, and since CodeMirror finds the line under a tap through that map, every
 * tap below the picture lands on the wrong line (one paragraph off, in the report).
 */
export const imageSettled = StateEffect.define<null>();

/** This URL has been loaded and shown before (so showing it again costs no new request). */
export function isImageKnown(url: string): boolean {
  return imageSizes.has(url);
}

/** Stands in for hidden `![alt](src)` source: one quiet line naming the image. */
export class ImageChipWidget extends WidgetType {
  constructor(readonly caption: string) {
    super();
  }
  eq(other: ImageChipWidget): boolean {
    return other.caption === this.caption;
  }
  toDOM(view: EditorView): HTMLElement {
    const dom = el('span', 'cm-w-imgchip');
    dom.append(el('span', 'cm-w-imgchip-icon'), el('span', 'cm-w-imgchip-text', this.caption));
    entersSource(dom, view, (pos) => pos + 2); // inside the alt text
    return dom;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Stands in for the `(address)` of a link or image whose text is being edited: a long URL
 * appearing in the middle of a paragraph would re-wrap it under the caret. Tapping the stub
 * (or moving the caret into it) shows the address.
 */
export class UrlStubWidget extends WidgetType {
  constructor(readonly url: string) {
    super();
  }
  eq(other: UrlStubWidget): boolean {
    return other.url === this.url;
  }
  toDOM(view: EditorView): HTMLElement {
    const dom = el('span', 'cm-w-urlstub', '(…)');
    dom.title = this.url;
    dom.setAttribute('role', 'button');
    dom.setAttribute('aria-label', `Edit address: ${this.url}`);
    entersSource(dom, view, (pos) => pos + 1); // just inside the parenthesis
    return dom;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

export class ImageWidget extends WidgetType {
  /** The picture's final box is known (it has loaded before, or failed): nothing will change its height. */
  private readonly settled: boolean;
  constructor(
    /** Resolved URL, or null when the source cannot be resolved. */
    readonly url: string | null,
    readonly src: string,
    readonly alt: string,
    readonly size: string,
    /** The address is being typed: nothing is fetched until the caret leaves it. */
    readonly typing = false,
    /** Who to tell about a tap. Not part of `eq`: the picture is the same whoever listens. */
    readonly host: WidgetHost | null = null,
  ) {
    super();
    this.settled = url === null || imageSizes.has(url) || failedImages.has(url);
  }
  /** The same picture in the same place: only how it is described (alt, size, settled) may differ. */
  private samePicture(other: ImageWidget): boolean {
    return other.url === this.url && other.src === this.src && other.typing === this.typing;
  }
  eq(other: ImageWidget): boolean {
    return this.samePicture(other) && other.alt === this.alt && other.size === this.size && other.settled === this.settled;
  }
  /**
   * Keep the element (and the picture already loaded in it) when only the alt text, the size or
   * `settled` changed: a size picked in the image panel must not make the picture reload.
   * CodeMirror still counts this as a redraw and measures the content again.
   */
  updateDOM(dom: HTMLElement, _view: EditorView, from: ImageWidget): boolean {
    if (!this.samePicture(from)) return false;
    if (this.size) dom.dataset.size = this.size;
    else delete dom.dataset.size;
    const img = dom.querySelector('img');
    if (img && img.alt !== this.alt) img.alt = this.alt;
    return true;
  }
  get estimatedHeight(): number {
    const known = this.url ? imageSizes.get(this.url) : undefined;
    if (!this.url || failedImages.has(this.url)) return 56;
    return known ? Math.min(known.height, 420) + 16 : 220;
  }
  toDOM(view: EditorView): HTMLElement {
    const dom = el('div', 'cm-w-image');
    if (this.size) dom.dataset.size = this.size;
    // The widget sits at the end of the line holding the image's source. A picture that has an
    // address opens the image panel (size, alt text, remove); one whose address is still to be
    // written puts the caret into its source instead.
    if (this.host && this.src && !this.typing) {
      const host = this.host;
      dom.setAttribute('role', 'button');
      dom.setAttribute('aria-label', `Image ${this.src}: size and alt text`);
      dom.setAttribute('aria-keyshortcuts', 'Control+Enter Meta+Enter');
      dom.title = 'Tap for size and alt text, or ⌘/Ctrl+Enter with the caret in the image';
      pressable(dom, () => {
        let index = 0;
        for (let prev = dom.previousElementSibling; prev?.classList.contains('cm-w-image'); prev = prev.previousElementSibling) index++;
        host.onImage(view, { lineEnd: view.posAtDOM(dom), index });
      });
    } else entersSource(dom, view, (pos) => pos);
    /** The box now has its final height: have CodeMirror measure it (see `imageSettled`). */
    const settle = () => {
      if (this.settled || !dom.isConnected) view.requestMeasure();
      else view.dispatch({ effects: imageSettled.of(null) });
    };
    const fail = (changed: boolean) => {
      dom.replaceChildren(el('span', 'cm-w-image-missing', this.src ? `Image not found: ${this.src}` : 'Image has no address yet'));
      dom.dataset.state = 'missing';
      if (changed) settle();
    };
    if (this.typing) {
      dom.replaceChildren(el('span', 'cm-w-image-missing', this.src ? 'The image shows when you leave the address' : 'Image has no address yet'));
      dom.dataset.state = 'typing';
      return dom;
    }
    if (!this.url || failedImages.has(this.url)) {
      fail(false);
      return dom;
    }
    const url = this.url;
    const img = document.createElement('img');
    img.alt = this.alt;
    img.draggable = false;
    img.decoding = 'async';
    const known = imageSizes.get(url);
    if (known) {
      // Reserve the box so the text below does not jump when the image paints.
      img.width = known.width;
      img.height = known.height;
    }
    img.addEventListener('load', () => {
      imageSizes.set(url, { width: img.naturalWidth, height: img.naturalHeight });
      dom.dataset.state = 'loaded';
      settle();
    });
    img.addEventListener('error', () => {
      failedImages.add(url);
      fail(true);
    });
    img.src = url;
    dom.append(img);
    return dom;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

/* ---- math ---------------------------------------------------------------- */

function fillMath(dom: HTMLElement, tex: string, display: boolean): void {
  const result = renderMath(tex, display);
  if (!result) {
    // KaTeX is still loading: show the source; the preview is rebuilt when it arrives.
    dom.textContent = tex;
    dom.dataset.state = 'pending';
    void loadKatex().catch(() => {
      dom.dataset.state = 'unavailable';
    });
    return;
  }
  if (result.error) {
    dom.textContent = tex;
    dom.dataset.state = 'error';
    dom.title = result.error;
    return;
  }
  dom.innerHTML = result.html;
  dom.dataset.state = 'ok';
}

export class InlineMathWidget extends WidgetType {
  private readonly ready = katexReady();
  constructor(
    readonly tex: string,
    readonly display: boolean,
  ) {
    super();
  }
  eq(other: InlineMathWidget): boolean {
    return other.tex === this.tex && other.display === this.display && other.ready === this.ready;
  }
  toDOM(view: EditorView): HTMLElement {
    const dom = el('span', 'cm-w-math' + (this.display ? ' cm-w-math-display' : ''));
    fillMath(dom, this.tex, this.display);
    entersSource(dom, view, (pos) => pos + (this.display ? 2 : 1));
    return dom;
  }
  ignoreEvent(): boolean {
    return true;
  }
}

export class BlockMathWidget extends WidgetType {
  private readonly ready = katexReady();
  constructor(
    readonly tex: string,
    /** True when shown under the visible source (while it is being edited). */
    readonly preview: boolean,
  ) {
    super();
  }
  eq(other: BlockMathWidget): boolean {
    return other.tex === this.tex && other.preview === this.preview && other.ready === this.ready;
  }
  get estimatedHeight(): number {
    return 28 + 28 * Math.min(8, this.tex.split('\n').length);
  }
  toDOM(view: EditorView): HTMLElement {
    const dom = el('div', 'cm-w-mathblock' + (this.preview ? ' cm-w-mathblock-preview' : ''));
    const inner = el('div', 'cm-w-mathblock-inner');
    fillMath(inner, this.tex, true);
    dom.dataset.state = inner.dataset.state;
    dom.append(inner);
    // Collapsed: the widget replaces the block, so step onto its first line of TeX.
    // As a preview it sits after the block: the caret goes to the block's end.
    entersSource(dom, view, (pos) => (this.preview ? pos : Math.min(view.state.doc.lineAt(pos).to + 1, view.state.doc.length)));
    return dom;
  }
  ignoreEvent(): boolean {
    return true;
  }
}
