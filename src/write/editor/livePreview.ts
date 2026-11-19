/**
 * Live preview: decorations over the unchanged markdown text.
 *
 * The document is never rewritten here. Markup is hidden, restyled or stood in
 * for by widgets; when the caret (of a focused editor) touches a construct its
 * source is shown again so it can be edited as plain text.
 *
 * What "touches" means, chosen so that tapping into text on a phone does not
 * make the line reflow under the finger:
 *   - inline constructs (emphasis, code, links, math, images): the selection
 *     touches any part of the construct;
 *   - line prefixes (`## `, `> `, `- `, `[ ]`, `[^1]:`): the selection touches
 *     the prefix characters themselves — a caret elsewhere on the line leaves
 *     them hidden;
 *   - fenced code and display math: the selection is anywhere in the block;
 *   - footnote references are always chips (and atomic): they are edited
 *     through the note panel, not as text.
 * An unfocused editor reveals nothing, so the page reads as rendered.
 */
import { syntaxTree } from '@codemirror/language';
import { Facet, StateEffect, StateField, type EditorState, type Extension, type Range } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet } from '@codemirror/view';
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common';
import type { AssetResolver } from '../contracts';
import { footnoteKey, getFootnotes } from './footnotes';
import { splitImageText } from './images';
import { fullTree } from './markdown';
import {
  BlockMathWidget,
  BulletWidget,
  CheckboxWidget,
  FenceWidget,
  FootnoteDefWidget,
  FootnoteRefWidget,
  ImageChipWidget,
  ImageWidget,
  InlineMathWidget,
  RuleWidget,
  UrlStubWidget,
  imageSettled,
  isImageKnown,
  type WidgetHost,
} from './widgets';

/* -------------------------------------------------------------------------- *
 * Configuration and state
 * -------------------------------------------------------------------------- */

export interface LivePreviewConfig extends WidgetHost {
  resolveAsset: AssetResolver;
}

const noConfig: LivePreviewConfig = { resolveAsset: () => null, onFootnote: () => {}, onImage: () => {} };

export const livePreviewConfig = Facet.define<LivePreviewConfig, LivePreviewConfig>({
  combine: (values) => values[0] ?? noConfig,
});

/** The editor gained or lost focus (dispatched by the focus tracker in Editor.svelte). */
export const setFocused = StateEffect.define<boolean>();
/** Rebuild decorations for a reason outside the state (KaTeX finished loading). */
export const refreshPreview = StateEffect.define<null>();
/** Label key of the footnote open in the note panel (its chips are highlighted), or null. */
export const setActiveFootnote = StateEffect.define<string | null>();

export const editorFocused = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setFocused)) value = e.value;
    return value;
  },
});

export const activeFootnote = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setActiveFootnote)) value = e.value;
    return value;
  },
});

/* -------------------------------------------------------------------------- *
 * Building decorations
 * -------------------------------------------------------------------------- */

interface LineInfo {
  classes: string[];
  /** Blockquote depth. */
  quote: number;
  /** End of the last `> ` prefix on the line. */
  quoteEnd: number;
  /** A list item starts on this line. */
  list: ListPrefix | null;
  /** The line continues a list item started above. */
  continuation: boolean;
}

/** The pieces of a list item's first-line prefix: `  - [ ] text` → indent, marker, gap, task, gap. */
interface ListPrefix {
  markFrom: number;
  markTo: number;
  ordered: boolean;
  /** The raw marker is shown (ordered lists always; bullets when the caret touches them). */
  markShown: boolean;
  taskFrom: number;
  taskTo: number;
  taskShown: boolean;
  checked: boolean;
  contentFrom: number;
}

const hidden = Decoration.replace({});
const cellCache = new Map<string, Decoration>();
/** A fixed-width box for `chars` characters of list prefix, so the hanging indent is exact in any font. */
function cell(chars: number, extra = ''): Decoration {
  const key = `${chars}:${extra}`;
  let deco = cellCache.get(key);
  if (!deco) {
    cellCache.set(key, (deco = Decoration.mark({ class: `cm-cell${extra ? ` ${extra}` : ''}`, attributes: { style: `--cm-n:${chars}` } })));
  }
  return deco;
}
/**
 * Text that is not prose — code, addresses, TeX, raw HTML — is taken out of the keyboard's
 * spelling and autocorrect, so a phone does not "correct" an identifier or turn `--` and straight
 * quotes in code into dashes and curly quotes. (Attributes on a span inside the editable; browsers
 * honour `spellcheck` there, and iOS reads `autocorrect`/`autocapitalize` from the nearest element
 * that sets them. Not verified on a device.)
 */
const LITERAL_TEXT = { spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' };
const LITERAL_MARKS = new Set(['cm-inline-code', 'cm-url', 'cm-linkref', 'cm-image-src', 'cm-math-src', 'cm-html-inline']);
const LITERAL_LINES = ['cm-code', 'cm-math-line', 'cm-html'];

const markCache = new Map<string, Decoration>();
function mark(className: string): Decoration {
  let deco = markCache.get(className);
  if (!deco) {
    deco = Decoration.mark(LITERAL_MARKS.has(className) ? { class: className, attributes: LITERAL_TEXT } : { class: className });
    markCache.set(className, deco);
  }
  return deco;
}

const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });

/**
 * Split the site's `alt|size` convention (see src/plugins/rehype-image-size.ts): the alt text as
 * the site reads it (trimmed) and the size, '' when the text does not end in one. The model the
 * image panel edits through is in ./images.ts.
 */
export function parseImageAlt(raw: string): { alt: string; size: string } {
  const { alt, size } = splitImageText(raw);
  return size ? { alt: alt.trim(), size } : { alt: raw, size: '' };
}

function unwrapUrl(text: string): string {
  return text.startsWith('<') && text.endsWith('>') ? text.slice(1, -1) : text;
}

export interface PreviewDecorations {
  decorations: DecorationSet;
  /** Ranges the caret skips over as a unit (footnote chips). */
  atomic: DecorationSet;
}

export function buildDecorations(state: EditorState): PreviewDecorations {
  const { doc } = state;
  const tree = fullTree(state);
  const config = state.facet(livePreviewConfig);
  const focused = state.field(editorFocused, false) ?? false;
  const active = state.field(activeFootnote, false) ?? null;
  const notes = getFootnotes(state);
  const selection = state.selection.ranges;
  const touches = (from: number, to: number) => focused && selection.some((r) => r.from <= to && r.to >= from);

  const out: Range<Decoration>[] = [];
  const atomic: Range<Decoration>[] = [];
  const lines = new Map<number, LineInfo>();
  /** Lines swallowed by a block replacement: they must not get line decorations. */
  const replacedLines: { from: number; to: number }[] = [];

  const info = (lineFrom: number): LineInfo => {
    let i = lines.get(lineFrom);
    if (!i) lines.set(lineFrom, (i = { classes: [], quote: 0, quoteEnd: -1, list: null, continuation: false }));
    return i;
  };
  const hide = (from: number, to: number) => {
    if (from < to) out.push(hidden.range(from, to));
  };
  const style = (className: string, from: number, to: number) => {
    if (from < to) out.push(mark(className).range(from, to));
  };
  /** Call `f` with the start of every line a node covers. */
  const eachLine = (from: number, to: number, f: (lineFrom: number, index: number, last: boolean) => void) => {
    const first = doc.lineAt(from).number;
    const last = doc.lineAt(to).number;
    for (let n = first; n <= last; n++) f(doc.line(n).from, n - first, n === last);
  };
  const skipSpaces = (pos: number, max = 4): number => {
    let end = pos;
    while (end - pos < max && end < doc.length) {
      const ch = doc.sliceString(end, end + 1);
      if (ch !== ' ' && ch !== '\t') break;
      end++;
    }
    return end;
  };

  let lastDefLine = -1;

  /**
   * Whether the `(address)` of a link/image stays folded: it has an address, and the selection is
   * not inside the parentheses. `paren` is the opening one, `end` the end of the construct.
   */
  const addressCollapsed = (paren: { from: number; to: number }, end: number): boolean =>
    end - 1 > paren.to && !touches(paren.to, end - 1);

  const inline = (node: SyntaxNodeRef, className: string, markNames: string[]): void => {
    style(className, node.from, node.to);
    if (touches(node.from, node.to)) return;
    for (let child = node.node.firstChild; child; child = child.nextSibling) {
      if (markNames.includes(child.name)) hide(child.from, child.to);
    }
  };

  tree.iterate({
    enter(node): boolean | void {
      const name = node.name;
      switch (name) {
        case 'ATXHeading1':
        case 'ATXHeading2':
        case 'ATXHeading3':
        case 'ATXHeading4':
        case 'ATXHeading5':
        case 'ATXHeading6': {
          const line = doc.lineAt(node.from);
          info(line.from).classes.push('cm-h', `cm-h${name.slice(-1)}`);
          const opening = node.node.firstChild;
          if (opening && opening.name === 'HeaderMark' && opening.from === node.from) {
            const contentFrom = Math.min(skipSpaces(opening.to, 64), line.to);
            // An empty heading keeps its marks visible: hidden, it would be invisible content.
            if (contentFrom < line.to && !touches(opening.from, opening.to)) hide(opening.from, contentFrom);
          }
          return;
        }
        case 'SetextHeading1':
        case 'SetextHeading2': {
          const level = name === 'SetextHeading1' ? 1 : 2;
          eachLine(node.from, node.to, (from, _i, last) => {
            info(from).classes.push(...(last ? ['cm-setext-rule'] : ['cm-h', `cm-h${level}`]));
          });
          return;
        }
        case 'Blockquote': {
          eachLine(node.from, node.to, (from) => {
            info(from).quote++;
          });
          return;
        }
        case 'QuoteMark': {
          const end = skipSpaces(node.to, 1);
          const line = doc.lineAt(node.from);
          const i = info(line.from);
          i.quoteEnd = Math.max(i.quoteEnd, end);
          if (!touches(node.from, node.to)) hide(node.from, end);
          return;
        }
        case 'ListItem': {
          const item = node.node;
          const listMark = item.firstChild;
          if (!listMark || listMark.name !== 'ListMark') return;
          const firstLine = doc.lineAt(node.from);
          const ordered = item.parent?.name === 'OrderedList';
          const task = item.getChild('Task')?.getChild('TaskMarker') ?? null;
          let contentFrom = Math.min(skipSpaces(listMark.to), firstLine.to);
          if (task && task.from === contentFrom) contentFrom = Math.min(skipSpaces(task.to, 1), firstLine.to);
          const isTask = !!task && task.to <= contentFrom;
          const checked = isTask && doc.sliceString(task!.from + 1, task!.from + 2) !== ' ';
          info(firstLine.from).list = {
            markFrom: listMark.from,
            markTo: listMark.to,
            ordered,
            markShown: ordered || touches(listMark.from, listMark.to),
            taskFrom: isTask ? task!.from : -1,
            taskTo: isTask ? task!.to : -1,
            taskShown: isTask && touches(task!.from, task!.to),
            checked,
            contentFrom,
          };
          if (checked) info(firstLine.from).classes.push('cm-task-done');
          eachLine(node.from, node.to, (from, index) => {
            if (index > 0) {
              const i = info(from);
              i.continuation = true;
              i.list = null;
            }
          });
          return;
        }
        case 'FencedCode': {
          const marks = node.node.getChildren('CodeMark');
          const open = marks[0];
          const close = marks.length > 1 ? marks[marks.length - 1] : null;
          const shown = touches(node.from, node.to);
          eachLine(node.from, node.to, (from, index, last) => {
            const classes = info(from).classes;
            classes.push('cm-code');
            if (index === 0) classes.push('cm-code-open');
            if (last) classes.push('cm-code-close');
            if (index === 0 || (last && close)) classes.push('cm-code-fence');
          });
          if (!shown && open) {
            const openLine = doc.lineAt(open.from);
            const infoNode = node.node.getChild('CodeInfo');
            const lang = infoNode ? doc.sliceString(infoNode.from, infoNode.to) : '';
            out.push(Decoration.replace({ widget: new FenceWidget(lang) }).range(open.from, openLine.to));
            if (close) hide(close.from, close.to);
          }
          return;
        }
        case 'CodeBlock': {
          eachLine(node.from, node.to, (from, index, last) => {
            const classes = info(from).classes;
            classes.push('cm-code');
            if (index === 0) classes.push('cm-code-open');
            if (last) classes.push('cm-code-close');
          });
          return;
        }
        case 'InlineCode': {
          const open = node.node.firstChild;
          const close = node.node.lastChild;
          if (!open || !close || open === close || touches(node.from, node.to)) {
            style('cm-inline-code', node.from, node.to);
          } else {
            hide(open.from, open.to);
            style('cm-inline-code', open.to, close.from);
            hide(close.from, close.to);
          }
          return false;
        }
        case 'Emphasis':
          return inline(node, 'cm-em', ['EmphasisMark']);
        case 'StrongEmphasis':
          return inline(node, 'cm-strong', ['EmphasisMark']);
        case 'Strikethrough':
          return inline(node, 'cm-strike', ['StrikethroughMark']);
        case 'Link': {
          const marks = node.node.getChildren('LinkMark');
          if (marks.length < 2) return;
          const textFrom = marks[0].to;
          const textTo = marks[1].from;
          const url = node.node.getChild('URL');
          const isInline = marks.length >= 4 && doc.sliceString(marks[2].from, marks[2].to) === '(';
          if (!isInline && !node.node.getChild('LinkLabel')) return; // `[text]` alone is not a link
          style('cm-link', textFrom, textTo);
          if (isInline && textFrom < textTo && !touches(node.from, node.to)) {
            hide(node.from, textFrom);
            hide(textTo, node.to);
          } else if (isInline && addressCollapsed(marks[2], node.to)) {
            // Editing the text: brackets show, the address stays folded so the paragraph does not re-wrap.
            out.push(Decoration.replace({ widget: new UrlStubWidget(url ? doc.sliceString(url.from, url.to) : '') }).range(marks[2].from, node.to));
          } else if (url) {
            style('cm-url', url.from, url.to);
          }
          return;
        }
        case 'Autolink': {
          const url = node.node.getChild('URL');
          if (!url) return;
          style('cm-link', url.from, url.to);
          if (!touches(node.from, node.to)) {
            hide(node.from, url.from);
            hide(url.to, node.to);
          }
          return false;
        }
        case 'URL': {
          // Bare GFM autolink (URL nodes inside links/images are handled by their parent).
          const parent = node.node.parent?.name;
          if (parent !== 'Link' && parent !== 'Image' && parent !== 'LinkReference' && parent !== 'Autolink') {
            style('cm-link', node.from, node.to);
          }
          return;
        }
        case 'LinkReference': {
          style('cm-linkref', node.from, node.to);
          return false;
        }
        case 'Image': {
          const marks = node.node.getChildren('LinkMark');
          if (marks.length < 2) return false;
          const urlNode = node.node.getChild('URL');
          const src = urlNode ? unwrapUrl(doc.sliceString(urlNode.from, urlNode.to)) : '';
          const { alt, size } = parseImageAlt(doc.sliceString(marks[0].to, marks[1].from));
          const line = doc.lineAt(node.to);
          const paren = marks.length >= 4 && doc.sliceString(marks[2].from, marks[2].to) === '(' ? marks[2] : null;
          if (!touches(node.from, node.to)) {
            const caption = alt || src.split('/').pop() || 'image';
            out.push(Decoration.replace({ widget: new ImageChipWidget(caption) }).range(node.from, node.to));
          } else {
            style('cm-image-src', node.from, node.to);
            if (paren && addressCollapsed(paren, node.to)) {
              out.push(Decoration.replace({ widget: new UrlStubWidget(src) }).range(paren.from, node.to));
            }
          }
          const url = src ? config.resolveAsset(src) : null;
          // While the caret is in the address it is being typed: `h`, `ht`, `htt`… are not images to
          // go and fetch (one request per keystroke, some to hosts that exist). The picture loads
          // when the caret leaves the address — unless this exact one has been shown already.
          const typing = !!paren && touches(paren.to, node.to - 1) && !(url !== null && isImageKnown(url));
          out.push(
            Decoration.widget({
              widget: new ImageWidget(typing ? null : url, src, alt, size, typing, config),
              block: true,
              side: 1,
            }).range(line.to),
          );
          return false;
        }
        case 'FootnoteReference': {
          const label = doc.sliceString(node.from + 2, node.to - 1);
          const key = footnoteKey(label);
          const entry = notes.byKey.get(key);
          const deco = Decoration.replace({
            widget: new FootnoteRefWidget(label, !entry || entry.defs.length === 0, active === key, config),
          });
          out.push(deco.range(node.from, node.to));
          atomic.push(deco.range(node.from, node.to));
          return false;
        }
        case 'FootnoteDefinition': {
          const defMark = node.node.firstChild;
          const firstLine = doc.lineAt(node.from);
          // The first note after body text gets a rule above it, like the footnotes section it becomes.
          let above = firstLine.number - 1;
          while (above >= 1 && doc.line(above).text.trim() === '') above--;
          const startsSection = above < 1 || above !== lastDefLine;
          eachLine(node.from, node.to, (from, index) => {
            const classes = info(from).classes;
            classes.push('cm-fn-def');
            if (index === 0 && startsSection) classes.push('cm-fn-section');
          });
          lastDefLine = doc.lineAt(node.to).number;
          if (defMark && defMark.name === 'FootnoteDefinitionMark') {
            const label = doc.sliceString(defMark.from + 2, defMark.to - 2);
            const key = footnoteKey(label);
            const entry = notes.byKey.get(key);
            if (!touches(defMark.from, defMark.to)) {
              out.push(
                Decoration.replace({
                  widget: new FootnoteDefWidget(label, !entry || entry.refs.length === 0, active === key, config),
                }).range(defMark.from, defMark.to),
              );
            }
          }
          return;
        }
        case 'InlineMath': {
          const open = node.node.firstChild;
          const close = node.node.lastChild;
          if (!open || !close || open === close) return false;
          const tex = doc.sliceString(open.to, close.from);
          if (touches(node.from, node.to) || tex.trim() === '') style('cm-math-src', node.from, node.to);
          else out.push(Decoration.replace({ widget: new InlineMathWidget(tex, open.to - open.from >= 2) }).range(node.from, node.to));
          return false;
        }
        case 'BlockMath': {
          const marks = node.node.getChildren('BlockMathMark');
          const firstLine = doc.lineAt(node.from);
          const lastLine = doc.lineAt(node.to);
          const closed = marks.length > 1;
          const texFrom = Math.min(firstLine.to + 1, node.to);
          const texTo = closed ? Math.max(texFrom, doc.lineAt(marks[marks.length - 1].from).from - 1) : node.to;
          let tex = texFrom < texTo ? doc.sliceString(texFrom, texTo) : '';
          if (node.node.getChild('QuoteMark')) tex = tex.replace(/^[ \t]*(?:>[ \t]?)+/gm, '');
          const wholeLines = node.from === firstLine.from && node.to === lastLine.to;
          const hasMath = tex.trim() !== '';
          if (hasMath && wholeLines && !touches(node.from, node.to)) {
            out.push(Decoration.replace({ widget: new BlockMathWidget(tex, false), block: true }).range(node.from, node.to));
            replacedLines.push({ from: node.from, to: node.to });
          } else {
            eachLine(node.from, node.to, (from, index, last) => {
              const classes = info(from).classes;
              classes.push('cm-math-line');
              if (index === 0) classes.push('cm-math-open');
              if (last) classes.push('cm-math-close');
            });
            if (hasMath) {
              out.push(Decoration.widget({ widget: new BlockMathWidget(tex, true), block: true, side: 1 }).range(lastLine.to));
            }
          }
          return false;
        }
        case 'HorizontalRule': {
          if (touches(node.from, node.to)) style('cm-hr-src', node.from, node.to);
          else out.push(rule.range(node.from, node.to));
          return false;
        }
        case 'Table': {
          eachLine(node.from, node.to, (from) => {
            info(from).classes.push('cm-table');
          });
          return;
        }
        case 'HTMLBlock':
        case 'CommentBlock':
        case 'ProcessingInstructionBlock': {
          eachLine(node.from, node.to, (from) => {
            info(from).classes.push('cm-html');
          });
          return false;
        }
        case 'HTMLTag':
        case 'Comment':
        case 'ProcessingInstruction': {
          style('cm-html-inline', node.from, node.to);
          return false;
        }
        default:
          return;
      }
    },
  });

  // Line decorations: classes, quote depth and hanging indent, one per line.
  for (const [lineFrom, i] of lines) {
    if (replacedLines.some((r) => lineFrom >= r.from && lineFrom <= r.to)) continue;
    const line = doc.lineAt(lineFrom);
    const classes = i.classes.slice();
    const vars: string[] = [];
    if (i.quote > 0) {
      classes.push('cm-quote', `cm-quote-${Math.min(i.quote, 3)}`);
      vars.push(`--cm-quote:${i.quote}`);
    }
    // The prefix that hangs in the line's padding: a list marker (or a continuation line's
    // indentation), after any quote marks. Each piece is a fixed-width cell; their sum is the hang.
    let prefixFrom = line.from;
    let hang = 0;
    const piece = (from: number, to: number, extra = '') => {
      if (to <= from) return;
      out.push(cell(to - from, extra).range(from, to));
      hang += to - from;
    };
    if (i.list) {
      const l = i.list;
      if (i.quoteEnd > prefixFrom && i.quoteEnd <= l.markFrom) prefixFrom = i.quoteEnd;
      if (!doc.sliceString(prefixFrom, l.contentFrom).includes('\t')) {
        const isTask = l.taskFrom >= 0;
        piece(prefixFrom, l.markFrom);
        if (l.markShown) piece(l.markFrom, l.markTo, l.ordered ? 'cm-list-number' : 'cm-list-mark');
        else if (isTask) out.push(hidden.range(l.markFrom, l.markTo)); // a task shows only its checkbox
        else {
          out.push(bullet.range(l.markFrom, l.markTo));
          hang += 1;
        }
        piece(l.markTo, isTask ? l.taskFrom : l.contentFrom);
        if (isTask) {
          if (l.taskShown) piece(l.taskFrom, l.taskTo, 'cm-list-mark');
          else {
            out.push(Decoration.replace({ widget: new CheckboxWidget(l.checked) }).range(l.taskFrom, l.taskTo));
            hang += 2;
          }
          piece(l.taskTo, l.contentFrom);
        }
      }
    } else if (i.continuation) {
      if (i.quoteEnd > prefixFrom) prefixFrom = i.quoteEnd;
      let end = prefixFrom;
      while (end < line.to && doc.sliceString(end, end + 1) === ' ') end++;
      piece(prefixFrom, end);
    }
    if (hang > 0) {
      classes.push('cm-hang');
      vars.push(`--cm-hang:${hang}`);
    }
    if (!classes.length) continue;
    const attributes: Record<string, string> = { class: classes.join(' ') };
    if (classes.some((c) => LITERAL_LINES.includes(c))) Object.assign(attributes, LITERAL_TEXT);
    if (vars.length) attributes.style = vars.join(';');
    out.push(Decoration.line({ attributes }).range(lineFrom));
  }

  return { decorations: Decoration.set(out, true), atomic: Decoration.set(atomic, true) };
}

/* -------------------------------------------------------------------------- *
 * The extension
 * -------------------------------------------------------------------------- */

const previewField = StateField.define<PreviewDecorations>({
  create: buildDecorations,
  update(value, tr) {
    const rebuild =
      tr.docChanged ||
      tr.selection !== undefined ||
      syntaxTree(tr.state) !== syntaxTree(tr.startState) ||
      tr.state.facet(livePreviewConfig) !== tr.startState.facet(livePreviewConfig) ||
      tr.effects.some((e) => e.is(setFocused) || e.is(refreshPreview) || e.is(setActiveFootnote) || e.is(imageSettled));
    return rebuild ? buildDecorations(tr.state) : value;
  },
  provide: (field) => [
    EditorView.decorations.from(field, (v) => v.decorations),
    EditorView.atomicRanges.from(field, (v) => () => v.atomic),
  ],
});

/** For tests and tooling: the current decoration set. */
export function previewDecorations(state: EditorState): PreviewDecorations {
  return state.field(previewField);
}

/** Node at `pos` (or one of its ancestors) with the given name. */
export function nodeAt(state: EditorState, pos: number, names: readonly string[]): SyntaxNode | null {
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = fullTree(state).resolveInner(pos, side); node; node = node.parent) {
      if (names.includes(node.name) && node.from <= pos && node.to >= pos) return node;
    }
  }
  return null;
}

export function livePreview(): Extension {
  return [editorFocused, activeFootnote, previewField];
}
