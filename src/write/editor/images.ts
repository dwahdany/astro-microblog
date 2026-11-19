/**
 * Image model: what the image panel reads from, and writes to, the markdown.
 *
 * The site's convention is `![alt text|size](src)` with size one of `small`,
 * `medium`, `full` (src/plugins/rehype-image-size.ts). The text between the
 * brackets is alt text only; the site shows no caption.
 *
 * The panel is a view over the BRACKET TEXT OF ONE IMAGE. Every function here
 * returns a change that touches only that text (or, for `removeImage`, the
 * image itself): a size change replaces the `|size` suffix and nothing else,
 * an alt change rewrites only the part of the alt text that was edited — what
 * stands before and after the edit keeps its bytes, brackets and all.
 *
 * Alt text, as shown and as written:
 *   - `[`, `]` and `\` are written `\[`, `\]` and `\\` where they have to be
 *     (in a table, `|` is written `\|`, or the pipe would end the cell), and
 *     shown without the backslash;
 *   - every other backslash escape (`\*`) is shown as it is written;
 *   - a code span (`` `]` ``) is shown and written as it is: nothing in it is
 *     escaped (but the pipe, in a table);
 *   - line breaks become a space;
 *   - a change is only made when the result is still read as the same image
 *     with exactly that bracket text — otherwise it is refused.
 * An unknown suffix (`|large`) is alt text. Alt text that ends in `|small`
 * (or `|medium`, `|full`) IS a size, here as on the site: there is no way to
 * write such an ending as plain alt text.
 *
 * A collapsed or shortcut reference image (`![logo][]`, `![logo]`) has no alt
 * text of its own: the bracket text is the LABEL that finds its definition.
 * Size and alt text are not changed here (either would break the image).
  */
import { EditorSelection, type ChangeSpec, type EditorState, type TransactionSpec } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { fullTree } from './markdown';

export const IMAGE_SIZES = ['small', 'medium', 'full'] as const;
export type ImageSize = '' | (typeof IMAGE_SIZES)[number];

const SIZE_SUFFIX = /\|(small|medium|full)$/;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

/**
 * Cut bracket text into alt text and the recognised size suffix (both as written).
 * A backslash that escapes the suffix's pipe (`a\|small`, as a table needs) belongs to the suffix.
 */
export function splitImageText(raw: string): { alt: string; suffix: string; size: ImageSize } {
  const m = SIZE_SUFFIX.exec(raw);
  if (!m) return { alt: raw, suffix: '', size: '' };
  let start = m.index;
  let slashes = 0;
  while (start - slashes > 0 && raw[start - slashes - 1] === '\\') slashes++;
  if (slashes % 2 === 1) start -= 1;
  return { alt: raw.slice(0, start), suffix: raw.slice(start), size: m[1] as ImageSize };
}

interface AltToken {
  raw: string;
  shown: string;
}

/** Where the code span that opens with the backtick run at `i` ends (exclusive), or -1 when nothing closes it. */
function codeSpanEnd(text: string, i: number): number {
  let open = i;
  while (text[open] === '`') open++;
  const run = open - i;
  for (let j = open; j < text.length; j++) {
    if (text[j] !== '`') continue;
    let k = j;
    while (text[k] === '`') k++;
    if (k - j === run) return k;
    j = k - 1;
  }
  return -1;
}

const ownEscape = (ch: string, inTable: boolean) => ch === '\\' || ch === '[' || ch === ']' || (inTable && ch === '|');

/** Alt text as written, cut into the pieces that are shown as one: an escape, a code span, a character. */
function altTokens(raw: string, inTable: boolean): AltToken[] {
  const out: AltToken[] = [];
  for (let i = 0; i < raw.length; ) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (ch === '\\' && next !== undefined && ASCII_PUNCTUATION.test(next)) {
      out.push({ raw: ch + next, shown: ownEscape(next, inTable) ? next : ch + next });
      i += 2;
    } else if (ch === '`') {
      let end = codeSpanEnd(raw, i);
      const closed = end !== -1;
      if (!closed) for (end = i; raw[end] === '`'; ) end++;
      const span = raw.slice(i, end);
      out.push({ raw: span, shown: closed && inTable ? span.replace(/\\\|/g, '|') : span });
      i = end;
    } else {
      out.push({ raw: ch, shown: ch });
      i += 1;
    }
  }
  return out;
}

/** Alt text as written → as shown in the panel. */
export function decodeAlt(raw: string, inTable = false): string {
  let out = '';
  for (const token of altTokens(raw, inTable)) out += token.shown;
  return out;
}

const flatten = (text: string) => text.replace(/[ \t]*(?:\r\n?|\n)+[ \t]*/g, ' ');

/**
 * Alt text as typed in the panel → as written between the brackets. Never leaves a bracket that
 * could end the alt text. `after`: what is shown right after this text ('' at the end of the alt
 * text), which decides how a backslash at its end is written.
 */
export function encodeAlt(text: string, inTable = false, after = ''): string {
  const flat = flatten(text);
  let out = '';
  for (let i = 0; i < flat.length; ) {
    const ch = flat[i];
    const next = i + 1 < flat.length ? flat[i + 1] : after[0];
    if (ch === '\\') {
      if (next === undefined || ownEscape(next, inTable)) {
        out += '\\\\'; // a backslash of its own: it would escape what follows (or the closing bracket)
        i += 1;
      } else if (ASCII_PUNCTUATION.test(next) && i + 1 < flat.length) {
        out += ch + next; // an escape the writer typed: kept as it is
        i += 2;
      } else {
        out += ch;
        i += 1;
      }
    } else if (ch === '`') {
      let end = codeSpanEnd(flat, i);
      const closed = end !== -1;
      if (!closed) for (end = i; flat[end] === '`'; ) end++;
      const span = flat.slice(i, end);
      out += closed && inTable ? span.replace(/\|/g, '\\|') : span; // code: nothing in it is an escape
      i = end;
    } else {
      out += ownEscape(ch, inTable) ? '\\' + ch : ch;
      i += 1;
    }
  }
  return out;
}

export interface ImageInfo {
  /** The whole image, `![` to the closing `)` (or `]` of a reference). */
  from: number;
  to: number;
  /** The text between the brackets. */
  textFrom: number;
  textTo: number;
  /** Bracket text as written, cut in two: `rawAlt + suffix`. */
  rawAlt: string;
  suffix: string;
  size: ImageSize;
  /** The address as written (without `<…>`), '' for a reference-style image. */
  src: string;
  /** Inside a table cell: a pipe has to be written `\|`. */
  inTable: boolean;
  /** The bracket text runs over more than one line: its alt text is not edited here. */
  multiline: boolean;
  /**
   * A collapsed or shortcut reference (`![logo][]`, `![logo]`): the bracket text is the label that
   * finds the definition, so neither size nor alt text can be changed without breaking the image.
   */
  isLabel: boolean;
}

function describe(state: EditorState, node: SyntaxNode): ImageInfo | null {
  const marks = node.getChildren('LinkMark');
  if (marks.length < 2) return null;
  const textFrom = marks[0].to;
  const textTo = marks[1].from;
  if (textTo < textFrom) return null;
  const text = state.sliceDoc(textFrom, textTo);
  const { alt, suffix, size } = splitImageText(text);
  const url = node.getChild('URL');
  let src = url ? state.sliceDoc(url.from, url.to) : '';
  if (src.startsWith('<') && src.endsWith('>')) src = src.slice(1, -1);
  let inTable = false;
  for (let p = node.parent; p; p = p.parent) if (p.name === 'Table') inTable = true;
  const label = node.getChild('LinkLabel');
  const isLabel = !url && !(label && label.to - label.from > 2);
  return { from: node.from, to: node.to, textFrom, textTo, rawAlt: alt, suffix, size, src, inTable, multiline: /[\r\n]/.test(text), isLabel };
}

/** The image at `pos`: the one starting there, else one the position is inside of or next to. */
export function imageAt(state: EditorState, pos: number): ImageInfo | null {
  const tree = fullTree(state);
  let inside: SyntaxNode | null = null;
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (node.name !== 'Image' || node.from > pos || node.to < pos) continue;
      if (node.from === pos) return describe(state, node);
      inside ??= node;
    }
  }
  return inside ? describe(state, inside) : null;
}

/** Every image whose source ends on the line holding `pos`, in document order (their pictures are drawn below that line). */
export function imagesOnLine(state: EditorState, pos: number): ImageInfo[] {
  const line = state.doc.lineAt(pos);
  const out: ImageInfo[] = [];
  fullTree(state).iterate({
    from: Math.max(0, line.from - 1),
    to: line.to,
    enter(node) {
      if (node.name !== 'Image') return undefined;
      if (node.to >= line.from && node.to <= line.to) {
        const info = describe(state, node.node);
        if (info) out.push(info);
      }
      return false;
    },
  });
  return out;
}

/** What the panel shows for an image. */
export interface ImageView {
  /** File name of the address (or the address, or "image"), for the panel's heading. */
  name: string;
  src: string;
  /** Alt text as shown (see `decodeAlt`). */
  alt: string;
  size: ImageSize;
  /** False when the alt text cannot be edited here (it runs over several lines, or it is a reference label). */
  altEditable: boolean;
  /** False when the size cannot be set here (the bracket text is a reference label). */
  sizeEditable: boolean;
}

export function imageView(info: ImageInfo): ImageView {
  // A `data:` or `blob:` address has no file name worth showing.
  const name = /^(?:data|blob):/i.test(info.src) ? '' : (info.src.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? '');
  return {
    name: name || (/^(?:data|blob):/i.test(info.src) ? 'image' : info.src) || 'image',
    src: info.src,
    alt: decodeAlt(info.rawAlt, info.inTable).replace(/\s*[\r\n]+\s*/g, ' '),
    size: info.size,
    altEditable: !info.multiline && !info.isLabel,
    sizeEditable: !info.isLabel,
  };
}

/** After `changes`, is the image at (mapped) `from` still the same image, with exactly `text` between its brackets? */
function stillReads(state: EditorState, info: ImageInfo, changes: ChangeSpec, text: string): boolean {
  let next: EditorState;
  try {
    next = state.update({ changes }).state;
  } catch {
    return false;
  }
  const after = imageAt(next, info.from);
  return !!after && after.from === info.from && after.src === info.src && after.rawAlt + after.suffix === text && after.to === info.to + (text.length - (info.textTo - info.textFrom));
}

/**
 * Set the size: only the `|size` suffix is replaced (added, or removed for the default).
 * Null when nothing changes or the result would not be read as this image.
 */
export function setImageSize(state: EditorState, info: ImageInfo, size: ImageSize): TransactionSpec | null {
  if (size === info.size || info.isLabel) return null;
  const suffix = size ? `${info.inTable ? '\\|' : '|'}${size}` : '';
  const from = info.textTo - info.suffix.length;
  const change = { from, to: info.textTo, insert: suffix };
  if (!stillReads(state, info, change, info.rawAlt + suffix)) return null;
  return { changes: change, userEvent: 'input.image.size' };
}

/**
 * Set the alt text from what was typed in the panel. Only the part that was edited is rewritten:
 * the alt text before and after it keeps its bytes (brackets that were never escaped, a link or a
 * code span inside the alt text). When that cannot be read back as typed, the whole alt text is
 * written afresh. `{ unchanged }` when the text already reads that way, `{ refused }` when it
 * cannot be written safely (the document is then left alone).
 */
export function setImageAlt(state: EditorState, info: ImageInfo, text: string): { spec: TransactionSpec } | { unchanged: true } | { refused: true } {
  if (info.multiline || info.isLabel) return { refused: true };
  const prev = info.rawAlt;
  const typed = flatten(text);
  const tokens = altTokens(prev, info.inTable);
  const shown = tokens.map((t) => t.shown).join('');
  if (typed === shown) return { unchanged: true };

  // What was typed and what is shown agree at both ends: keep the tokens there as they are written.
  const max = Math.min(shown.length, typed.length);
  let same = 0;
  while (same < max && shown.charCodeAt(same) === typed.charCodeAt(same)) same++;
  let sameEnd = 0;
  while (sameEnd < max - same && shown.charCodeAt(shown.length - 1 - sameEnd) === typed.charCodeAt(typed.length - 1 - sameEnd)) sameEnd++;
  let head = 0;
  let headShown = 0;
  while (head < tokens.length && headShown + tokens[head].shown.length <= same) headShown += tokens[head++].shown.length;
  // A backslash that escaped nothing may escape what is typed after it: it is written again.
  while (head > 0 && tokens[head - 1].raw === '\\') headShown -= tokens[--head].shown.length;
  let tail = tokens.length;
  let tailShown = 0;
  while (tail > head && tailShown + tokens[tail - 1].shown.length <= sameEnd) tailShown += tokens[--tail].shown.length;
  const before = tokens.slice(0, head).map((t) => t.raw).join('');
  const after = tokens.slice(tail).map((t) => t.raw).join('');
  const middle = typed.slice(headShown, typed.length - tailShown);
  const candidates = [before + encodeAlt(middle, info.inTable, tokens[tail]?.shown ?? '') + after, encodeAlt(typed, info.inTable)];

  for (const next of candidates) {
    if (next === prev || decodeAlt(next, info.inTable) !== typed) continue;
    let start = 0;
    const most = Math.min(prev.length, next.length);
    while (start < most && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
    let end = 0;
    while (end < most - start && prev.charCodeAt(prev.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) end++;
    const change = { from: info.textFrom + start, to: info.textFrom + prev.length - end, insert: next.slice(start, next.length - end) };
    if (!stillReads(state, info, change, next + info.suffix)) continue;
    // Tagged like ordinary typing, so a run of keystrokes in the field is one undo step.
    return { spec: { changes: change, userEvent: change.insert === '' ? 'delete.backward' : 'input.type' } };
  }
  return { refused: true };
}

/** What wraps an image and is nothing without it: the marks of each, by node name. */
const WRAPPERS: Record<string, string> = { Link: 'LinkMark', Emphasis: 'EmphasisMark', StrongEmphasis: 'EmphasisMark', Strikethrough: 'StrikethroughMark' };

/**
 * Remove the image. A link that holds nothing but the image goes with it (`[![a](b)](c)` would
 * leave an empty link), and so does emphasis or a strikethrough around it alone (`~~![a](b)~~`
 * would leave `~~~~`, which opens a code block) — and the line of an image that stood alone on
 * it, with one of the blank lines that set it apart, so no gap is left behind.
 */
export function removeImage(state: EditorState, info: ImageInfo): TransactionSpec {
  const { doc } = state;
  let from = info.from;
  let to = info.to;
  let node: SyntaxNode | null = fullTree(state).resolveInner(info.from, 1);
  while (node && !(node.name === 'Image' && node.from === info.from && node.to === info.to)) node = node.parent;
  for (node = node?.parent ?? null; node; node = node.parent) {
    const mark = WRAPPERS[node.name];
    if (!mark) break;
    const marks = node.getChildren(mark);
    // A link's text is between its first two marks; emphasis is between its first and its last.
    const close = node.name === 'Link' ? marks[1] : marks[marks.length - 1];
    if (marks.length < 2 || state.sliceDoc(marks[0].to, close.from).trim() !== state.sliceDoc(from, to)) break;
    from = node.from;
    to = node.to;
  }
  const first = doc.lineAt(from);
  const last = doc.lineAt(to);
  const alone = state.sliceDoc(first.from, from).trim() === '' && state.sliceDoc(to, last.to).trim() === '';
  if (alone) {
    const blank = (n: number) => n >= 1 && n <= doc.lines && doc.line(n).text.trim() === '';
    const before = first.number === 1 || blank(first.number - 1);
    const after = last.number === doc.lines || blank(last.number + 1);
    from = first.from;
    to = last.to;
    if (last.number < doc.lines) {
      to += 1; // the line's own break
      // Set apart on both sides: one of the two blank lines goes too.
      if (before && after && first.number > 1) {
        const next = doc.line(last.number + 1);
        if (next.number < doc.lines) to = next.to + 1;
        else from = doc.line(first.number - 1).from; // the blank line after is the end of the text: take the one before
      } else if (before && after) {
        const next = doc.line(last.number + 1);
        to = next.number < doc.lines ? next.to + 1 : next.to;
      }
    } else if (first.number > 1) {
      // The last line of the text: take the break before it, and the blank line that set it apart.
      from = before ? doc.line(first.number - 1).from : first.from;
      if (from > 0) from -= 1;
    }
  }
  return { changes: { from, to }, selection: EditorSelection.cursor(from), scrollIntoView: true, userEvent: 'delete.image' };
}
