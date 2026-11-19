/**
 * Toolbar commands and the selection state behind the toolbar's pressed buttons.
 *
 * Every command is a pure function `(state, arg?) → TransactionSpec | null`
 * (null = does not apply here), so it can be tested without a DOM and reused
 * for the note panel, which runs the inline commands on a selection inside a
 * footnote definition. A command only ever touches the markup it adds or
 * removes; surrounding text is never reformatted.
 */
import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Line,
  type SelectionRange,
  type TransactionSpec,
} from '@codemirror/state';
import { redoDepth, undoDepth } from '@codemirror/commands';
import type { SyntaxNode } from '@lezer/common';
import type { EditorCommandArgs, EditorSelectionState } from '../contracts';
import { footnoteInsertPos, insertFootnote, withLineBreaks } from './footnotes';
import { fullTree } from './markdown';

export type CommandResult = TransactionSpec | null;

/* -------------------------------------------------------------------------- *
 * Tree helpers
 * -------------------------------------------------------------------------- */

/** Innermost node with one of `names` whose range contains [from, to] (boundaries count). */
export function enclosing(state: EditorState, from: number, to: number, names: string | readonly string[]): SyntaxNode | null {
  const want = typeof names === 'string' ? [names] : names;
  const tree = fullTree(state);
  let best: SyntaxNode | null = null;
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(from, side); node; node = node.parent) {
      if (want.includes(node.name) && node.from <= from && node.to >= to) {
        if (!best || node.to - node.from < best.to - best.from) best = node;
        break;
      }
    }
  }
  return best;
}

const RAW_BLOCKS = ['FencedCode', 'CodeBlock', 'BlockMath', 'HTMLBlock', 'CommentBlock'];

/** True when the line is literal text (code, display math, raw HTML) where markdown markup means nothing. */
function isRawLine(state: EditorState, line: Line): boolean {
  const tree = fullTree(state);
  const indent = /^\s*/.exec(line.text)?.[0].length ?? 0;
  for (const pos of new Set([line.from, Math.min(line.from + indent, line.to), line.to])) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, pos === line.to ? -1 : 1); node; node = node.parent) {
      if (RAW_BLOCKS.includes(node.name) && node.from <= pos && node.to >= line.to) return true;
    }
  }
  return false;
}

/* -------------------------------------------------------------------------- *
 * Lines and their block prefixes
 * -------------------------------------------------------------------------- */

const BLOCK_PREFIX =
  /^((?:[ \t]{0,3}>[ \t]?)*)([ \t]*)(?:([-*+]|\d{1,9}[.)])([ \t]+|$)(\[[ xX]\](?:[ \t]+|$))?)?(#{1,6}(?:[ \t]+|$))?/;

export interface LinePrefix {
  /** `> ` markers (with their spaces). */
  quote: string;
  /** Indentation before a list marker / the content. */
  indent: string;
  /** `-`, `*`, `+`, `1.` or `1)`; '' when the line is not a list item. */
  marker: string;
  markerGap: string;
  /** `[ ] ` / `[x] ` including trailing space; '' when not a task. */
  task: string;
  /** `## ` including trailing space; '' when not an ATX heading. */
  heading: string;
}

export function parsePrefix(text: string): LinePrefix {
  const m = BLOCK_PREFIX.exec(text)!;
  return { quote: m[1] ?? '', indent: m[2] ?? '', marker: m[3] ?? '', markerGap: m[4] ?? '', task: m[5] ?? '', heading: m[6] ?? '' };
}

const listStart = (p: LinePrefix) => p.quote.length + p.indent.length;
const listEnd = (p: LinePrefix) => listStart(p) + p.marker.length + p.markerGap.length + p.task.length;
const listKind = (p: LinePrefix): 'bullet' | 'ordered' | 'task' | null =>
  !p.marker ? null : p.task ? 'task' : /\d/.test(p.marker) ? 'ordered' : 'bullet';

function selectedLines(state: EditorState, range: SelectionRange = state.selection.main): Line[] {
  const first = state.doc.lineAt(range.from);
  let last = state.doc.lineAt(range.to);
  if (!range.empty && last.number > first.number && range.to === last.from) last = state.doc.line(last.number - 1);
  const lines: Line[] = [];
  for (let n = first.number; n <= last.number; n++) lines.push(state.doc.line(n));
  return lines;
}

/** Lines a block command should act on: literal lines never, blank lines only when they are all there is. */
function blockTargets(state: EditorState): Line[] {
  const lines = selectedLines(state).filter((l) => !isRawLine(state, l));
  return lines.length > 1 ? lines.filter((l) => l.text.trim() !== '') : lines;
}

/** Apply changes, keeping the caret after anything inserted exactly where it stands. */
function withChanges(state: EditorState, changes: ChangeSpec, userEvent: string): CommandResult {
  const set = state.changes(changes);
  if (set.empty) return null;
  return { changes: set, selection: state.selection.map(set, 1), scrollIntoView: true, userEvent };
}

/* -------------------------------------------------------------------------- *
 * Inline marks: bold, italic, strike, code, math
 * -------------------------------------------------------------------------- */

interface InlineKind {
  node: string;
  mark: string;
}

const INLINE: Record<'bold' | 'italic' | 'strike' | 'code' | 'math', InlineKind> = {
  bold: { node: 'StrongEmphasis', mark: '**' },
  italic: { node: 'Emphasis', mark: '*' },
  strike: { node: 'Strikethrough', mark: '~~' },
  code: { node: 'InlineCode', mark: '`' },
  math: { node: 'InlineMath', mark: '$' },
};

/** The node's opening and closing marks (its first and last child). */
function markRanges(node: SyntaxNode): { open: { from: number; to: number }; close: { from: number; to: number } } | null {
  const open = node.firstChild;
  const close = node.lastChild;
  if (!open || !close || open.from === close.from) return null;
  if (open.from !== node.from || close.to !== node.to) return null;
  return { open: { from: open.from, to: open.to }, close: { from: close.from, to: close.to } };
}

function runLength(state: EditorState, pos: number, dir: 1 | -1, ch: string): number {
  const line = state.doc.lineAt(pos);
  let n = 0;
  if (dir < 0) while (pos - n - 1 >= line.from && state.sliceDoc(pos - n - 1, pos - n) === ch) n++;
  else while (pos + n < line.to && state.sliceDoc(pos + n, pos + n + 1) === ch) n++;
  return n;
}

/**
 * "Math" that is really prose between two dollar signs: `Price is $5 and $6 today` parses as
 * inline math (`5 and `) here and on the site alike, but nobody wrote it as math. TeX does not
 * end in a space, and does not open with a number followed by words.
 */
function looksLikePrices(tex: string): boolean {
  return /\s$/.test(tex) || (/^\d/.test(tex) && /\s/.test(tex));
}

export function toggleInline(state: EditorState, kind: keyof typeof INLINE): CommandResult {
  const { node: nodeName, mark } = INLINE[kind];
  const { from, to, empty } = state.selection.main;
  const event = `input.format.${kind}`;

  // Already inside the construct: leave it (caret at its end) or remove it.
  const node = enclosing(state, from, to, nodeName);
  const marks = node && markRanges(node);
  if (node && marks && ((from > node.from && to < node.to) || (!empty && from >= node.from && to <= node.to))) {
    // A caret between two prices is not "inside math": removing the dollar signs would change the
    // amounts. With a selection the writer has said what they mean, and it is unwrapped as asked.
    if (kind === 'math' && empty && looksLikePrices(state.sliceDoc(marks.open.to, marks.close.from))) return null;
    if (empty && from >= marks.close.from) {
      // Typing the construct and pressing the button again steps out of it.
      return { selection: EditorSelection.cursor(node.to), scrollIntoView: true, userEvent: 'select' };
    }
    const set = state.changes([marks.open, marks.close]);
    return { changes: set, selection: state.selection.map(set), scrollIntoView: true, userEvent: event };
  }

  if (empty) {
    // An empty pair the button just made (`**|**`): take it away again.
    const left = runLength(state, from, -1, mark[0]);
    const right = runLength(state, from, 1, mark[0]);
    const emptyPair = mark.length === 2 ? left >= 2 && right >= 2 : mark === '*' ? left % 2 === 1 && right % 2 === 1 : left === 1 && right === 1;
    if (emptyPair) {
      return {
        changes: { from: from - mark.length, to: from + mark.length },
        selection: EditorSelection.cursor(from - mark.length),
        userEvent: event,
      };
    }
    const word = state.wordAt(from);
    if (word && word.from < from && word.to > from) {
      return {
        changes: [
          { from: word.from, insert: mark },
          { from: word.to, insert: mark },
        ],
        selection: EditorSelection.cursor(from + mark.length),
        userEvent: event,
      };
    }
    return {
      changes: { from, insert: mark + mark },
      selection: EditorSelection.cursor(from + mark.length),
      scrollIntoView: true,
      userEvent: event,
    };
  }

  // Wrap the selection — per line, inside any list/quote/heading prefix, without the outer spaces.
  const segments: { from: number; to: number }[] = [];
  for (const line of selectedLines(state)) {
    if (isRawLine(state, line)) continue;
    const prefix = parsePrefix(line.text);
    const contentFrom = line.from + listEnd(prefix) + prefix.heading.length;
    let a = Math.max(from, contentFrom);
    let b = Math.min(to, line.to);
    while (a < b && /\s/.test(state.sliceDoc(a, a + 1))) a++;
    while (b > a && /\s/.test(state.sliceDoc(b - 1, b))) b--;
    if (a < b) segments.push({ from: a, to: b });
  }
  if (!segments.length) return null;
  const changes: ChangeSpec[] = [];
  for (const s of segments) changes.push({ from: s.from, insert: mark }, { from: s.to, insert: mark });
  const set = state.changes(changes);
  const first = segments[0];
  const last = segments[segments.length - 1];
  return {
    changes: set,
    selection: EditorSelection.range(set.mapPos(first.from, 1), set.mapPos(last.to, -1)),
    scrollIntoView: true,
    userEvent: event,
  };
}

/* -------------------------------------------------------------------------- *
 * Links and images
 * -------------------------------------------------------------------------- */

const URL_LIKE = /^(?:https?:\/\/|mailto:|www\.)\S+$/i;

function linkParts(state: EditorState, node: SyntaxNode) {
  const marks = node.getChildren('LinkMark');
  if (marks.length < 2) return null;
  const textFrom = marks[0].to;
  const textTo = marks[1].from;
  const open = marks.find((m) => state.sliceDoc(m.from, m.to) === '(');
  const close = marks[marks.length - 1];
  const inline = !!open && state.sliceDoc(close.from, close.to) === ')';
  // `[text]` on its own parses as a Link node too, but is only a link if a definition exists
  // somewhere; treat it as plain bracketed text.
  if (!inline && !node.getChild('LinkLabel')) return null;
  return { textFrom, textTo, urlFrom: inline ? open!.to : -1, urlTo: inline ? close.from : -1 };
}

/** The bare URL or `<autolink>` the position is in or next to, with the range that holds it. */
function addressAt(state: EditorState, pos: number): { from: number; to: number; url: string } | null {
  const auto = enclosing(state, pos, pos, 'Autolink');
  if (auto) {
    const url = auto.getChild('URL');
    if (url) return { from: auto.from, to: auto.to, url: state.sliceDoc(url.from, url.to) };
  }
  // Parentheses or spaces in an address need the `<…>` form to be one link destination.
  const destination = (url: string) => (/[()\s]/.test(url) ? `<${url}>` : url);
  const node = enclosing(state, pos, pos, 'URL');
  if (node && node.parent && !['Link', 'Image', 'LinkReference', 'Autolink'].includes(node.parent.name)) {
    return { from: node.from, to: node.to, url: destination(state.sliceDoc(node.from, node.to)) };
  }
  // Not recognised by the parser as an autolink, but still plainly an address.
  const line = state.doc.lineAt(pos);
  let a = pos - line.from;
  let b = a;
  while (a > 0 && !/\s/.test(line.text[a - 1])) a--;
  while (b < line.text.length && !/\s/.test(line.text[b])) b++;
  const token = line.text.slice(a, b).replace(/[.,;:!?]+$/, '');
  if (!/^https?:\/\/\S+\.\S+$/i.test(token) || /[[\]<>]/.test(token)) return null;
  if (pos - line.from > a + token.length) return null;
  if (enclosing(state, pos, pos, ['Link', 'Image', 'InlineCode', 'LinkReference'])) return null;
  return { from: line.from + a, to: line.from + a + token.length, url: destination(token) };
}

export function toggleLink(state: EditorState, arg?: { url?: string; text?: string }): CommandResult {
  const { from, to, empty } = state.selection.main;
  const event = 'input.format.link';

  if (arg?.url) {
    const text = arg.text ?? (empty ? arg.url : state.sliceDoc(from, to));
    const insert = `[${text}](${arg.url})`;
    return { changes: { from, to, insert }, selection: EditorSelection.cursor(from + insert.length), scrollIntoView: true, userEvent: event };
  }

  const node = enclosing(state, from, to, 'Link');
  const parts = node && linkParts(state, node);
  if (node && parts && from > node.from && to <= node.to && (from < node.to || !empty)) {
    if (empty && parts.urlFrom >= 0) {
      // Step through a link being written: text → address → out.
      if (parts.urlFrom === parts.urlTo && from <= parts.textTo) {
        return { selection: EditorSelection.cursor(parts.urlFrom), scrollIntoView: true, userEvent: 'select' };
      }
      if (from === parts.urlTo) return { selection: EditorSelection.cursor(node.to), scrollIntoView: true, userEvent: 'select' };
    }
    // Unlink: keep the text, drop the rest.
    const set = state.changes([
      { from: node.from, to: parts.textFrom },
      { from: parts.textTo, to: node.to },
    ]);
    return {
      changes: set,
      selection: EditorSelection.range(set.mapPos(parts.textFrom, 1), set.mapPos(parts.textTo, -1)),
      scrollIntoView: true,
      userEvent: event,
    };
  }

  if (empty) {
    // The caret is in an address (a bare URL or an `<autolink>`): the whole address becomes the
    // target, not the word of it the caret happens to be in.
    const address = addressAt(state, from);
    if (address) {
      return {
        changes: { from: address.from, to: address.to, insert: `[](${address.url})` },
        selection: EditorSelection.cursor(address.from + 1),
        scrollIntoView: true,
        userEvent: event,
      };
    }
    const word = state.wordAt(from);
    if (word && word.from < from && word.to >= from) {
      const text = state.sliceDoc(word.from, word.to);
      return {
        changes: { from: word.from, to: word.to, insert: `[${text}]()` },
        selection: EditorSelection.cursor(word.from + text.length + 3),
        scrollIntoView: true,
        userEvent: event,
      };
    }
    return { changes: { from, insert: '[]()' }, selection: EditorSelection.cursor(from + 1), scrollIntoView: true, userEvent: event };
  }

  const selected = state.sliceDoc(from, to);
  if (state.doc.lineAt(from).number !== state.doc.lineAt(to).number) return null;
  if (URL_LIKE.test(selected.trim())) {
    // A selected address becomes the target; the caret waits where the text goes.
    return {
      changes: { from, to, insert: `[](${selected.trim()})` },
      selection: EditorSelection.cursor(from + 1),
      scrollIntoView: true,
      userEvent: event,
    };
  }
  return {
    changes: { from, to, insert: `[${selected}]()` },
    selection: EditorSelection.cursor(from + selected.length + 3),
    scrollIntoView: true,
    userEvent: event,
  };
}

export function insertImage(state: EditorState, arg?: { src: string; alt?: string; size?: 'small' | 'medium' | 'full' }): CommandResult {
  const { from, to } = state.selection.main;
  const event = 'input.image';
  if (!arg?.src) {
    const alt = state.doc.sliceString(from, to, ' ');
    return {
      changes: { from, to, insert: `![${alt}]()` },
      selection: EditorSelection.cursor(from + alt.length + 4),
      scrollIntoView: true,
      userEvent: event,
    };
  }
  const alt = (arg.alt ?? '') + (arg.size ? `|${arg.size}` : '');
  const src = /[\s()]/.test(arg.src) ? `<${arg.src}>` : arg.src;
  const insert = `![${alt}](${src})`;
  return { changes: { from, to, insert }, selection: EditorSelection.cursor(from + insert.length), scrollIntoView: true, userEvent: event };
}

/* -------------------------------------------------------------------------- *
 * Block commands: heading, lists, quote, fenced blocks, rule
 * -------------------------------------------------------------------------- */

type HeadingLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export function setHeading(state: EditorState, arg?: { level?: HeadingLevel }): CommandResult {
  const lines = blockTargets(state);
  if (!lines.length) return null;
  const tree = fullTree(state);
  const items = lines.map((line) => {
    const prefix = parsePrefix(line.text);
    let setext: SyntaxNode | null = null;
    for (let n: SyntaxNode | null = tree.resolveInner(Math.min(line.from + listEnd(prefix), line.to), 1); n; n = n.parent) {
      if (n.name === 'SetextHeading1' || n.name === 'SetextHeading2') setext = n;
    }
    const level = setext ? (setext.name === 'SetextHeading1' ? 1 : 2) : prefix.heading.trim().length;
    return { line, prefix, setext, level };
  });
  const current = items[0].level;
  let level: number;
  if (arg?.level != null) level = items.every((i) => i.level === arg.level) ? 0 : arg.level;
  else level = current === 0 || current === 1 ? 2 : current === 2 ? 3 : 0;

  const changes: ChangeSpec[] = [];
  const done = new Set<number>();
  for (const { line, prefix, setext } of items) {
    if (setext) {
      // Underlined heading: drop the underline and (re)write it in `#` form on its first line.
      if (done.has(setext.from)) continue;
      done.add(setext.from);
      const underline = setext.lastChild;
      if (underline && underline.name === 'HeaderMark') {
        const markLine = state.doc.lineAt(underline.from);
        changes.push({ from: markLine.from - 1, to: markLine.to });
      }
      const first = state.doc.lineAt(setext.from);
      const at = first.from + listEnd(parsePrefix(first.text));
      if (level) changes.push({ from: at, insert: '#'.repeat(level) + ' ' });
      continue;
    }
    const at = line.from + listEnd(prefix);
    changes.push({ from: at, to: at + prefix.heading.length, insert: level ? '#'.repeat(level) + ' ' : '' });
  }
  return withChanges(state, changes, 'input.format.heading');
}

export function toggleList(state: EditorState, kind: 'bullet' | 'ordered' | 'task'): CommandResult {
  const lines = blockTargets(state);
  if (!lines.length) return null;
  const items = lines.map((line) => ({ line, prefix: parsePrefix(line.text) }));
  const allSame = items.every((i) => listKind(i.prefix) === kind);

  // Continue the look of the list directly above, if there is one.
  const first = items[0];
  const above = first.line.number > 1 ? parsePrefix(state.doc.line(first.line.number - 1).text) : null;
  const sibling = above && above.marker && above.indent === first.prefix.indent && above.quote === first.prefix.quote ? above : null;
  const bullet = sibling && listKind(sibling) !== 'ordered' ? sibling.marker : '-';
  const ordered = sibling && listKind(sibling) === 'ordered' ? sibling.marker : null;
  let number = ordered ? Number.parseInt(ordered, 10) + 1 : 1;
  const delimiter = ordered ? ordered.slice(-1) : '.';

  const changes: ChangeSpec[] = items.map(({ line, prefix }) => {
    const from = line.from + listStart(prefix);
    const to = line.from + listEnd(prefix);
    if (allSame) return { from, to, insert: '' };
    const ownBullet = prefix.marker && !/\d/.test(prefix.marker) ? prefix.marker : bullet;
    if (kind === 'bullet') return { from, to, insert: `${ownBullet} ` };
    if (kind === 'task') return { from, to, insert: `${ownBullet} ${prefix.task || '[ ] '}` };
    return { from, to, insert: `${number++}${delimiter} ` };
  });
  return withChanges(state, changes, 'input.format.list');
}

export function toggleQuote(state: EditorState): CommandResult {
  const lines = selectedLines(state);
  const nonBlank = lines.filter((l) => l.text.trim() !== '');
  const quoted = /^([ \t]{0,3})>[ \t]?/;
  const changes: ChangeSpec[] = [];
  if (nonBlank.length && nonBlank.every((l) => quoted.test(l.text))) {
    for (const line of lines) {
      const m = quoted.exec(line.text);
      if (m) changes.push({ from: line.from + m[1].length, to: line.from + m[0].length });
    }
  } else {
    for (const line of lines) changes.push({ from: line.from, insert: line.text === '' && lines.length > 1 ? '>' : '> ' });
  }
  return withChanges(state, changes, 'input.format.quote');
}

function toggleFenced(
  state: EditorState,
  nodeName: 'FencedCode' | 'BlockMath',
  markName: 'CodeMark' | 'BlockMathMark',
  fence: string,
  info: string,
  event: string,
): CommandResult {
  const { from, to, empty, anchor, head } = state.selection.main;
  const { doc } = state;
  const node = enclosing(state, from, to, nodeName);
  if (node) {
    // Inside one already: unwrap by removing the fence lines.
    const marks = node.getChildren(markName);
    const openLine = doc.lineAt(node.from);
    const close = marks.length > 1 ? doc.lineAt(marks[marks.length - 1].from) : null;
    const changes: ChangeSpec[] = [];
    if (close && close.number === openLine.number + 1) {
      changes.push({ from: openLine.from, to: close.to });
    } else {
      changes.push({ from: openLine.from, to: Math.min(openLine.to + 1, doc.length) });
      if (close) changes.push({ from: close.from - 1, to: close.to });
    }
    const set = state.changes(changes);
    return { changes: set, selection: state.selection.map(set), scrollIntoView: true, userEvent: event };
  }

  const lines = selectedLines(state);
  const first = lines[0];
  const last = lines[lines.length - 1];
  let marker = fence;
  if (nodeName === 'FencedCode') {
    const body = state.sliceDoc(first.from, last.to);
    while (body.includes(marker)) marker += fence[0];
  }
  const open = `${marker}${info}\n`;
  if (empty && first.text.trim() === '') {
    return {
      changes: { from: first.from, to: first.to, insert: withLineBreaks(state, `${open}\n${marker}`) },
      selection: EditorSelection.cursor(first.from + open.length),
      scrollIntoView: true,
      userEvent: event,
    };
  }
  return {
    changes: [
      { from: first.from, insert: withLineBreaks(state, open) },
      { from: last.to, insert: withLineBreaks(state, `\n${marker}`) },
    ],
    selection: EditorSelection.range(anchor + open.length, head + open.length),
    scrollIntoView: true,
    userEvent: event,
  };
}

export const toggleCodeBlock = (state: EditorState, arg?: { lang?: string }): CommandResult =>
  toggleFenced(state, 'FencedCode', 'CodeMark', '```', arg?.lang ?? '', 'input.format.codeBlock');

export const toggleMathBlock = (state: EditorState): CommandResult =>
  toggleFenced(state, 'BlockMath', 'BlockMathMark', '$$', '', 'input.format.mathBlock');

/** A thematic break on its own line, kept apart from text above (which `---` would turn into a heading). */
export function insertRule(state: EditorState): CommandResult {
  const { doc } = state;
  const line = doc.lineAt(state.selection.main.to);
  const event = 'input.rule';
  // Inside code, display math or raw HTML a `---` would be more of that text, not a divider.
  if (isRawLine(state, line)) return null;
  if (line.text.trim() === '') {
    const above = line.number > 1 ? doc.line(line.number - 1).text.trim() : '';
    const lead = above === '' ? '' : '\n';
    const isLast = line.number === doc.lines;
    const insert = `${lead}---${isLast ? '\n' : ''}`;
    const end = line.from + insert.length;
    return {
      changes: { from: line.from, to: line.to, insert: withLineBreaks(state, insert) },
      selection: EditorSelection.cursor(isLast ? end : end + 1),
      scrollIntoView: true,
      userEvent: event,
    };
  }
  const isLast = line.number === doc.lines;
  const insert = `\n\n---${isLast ? '\n' : ''}`;
  const end = line.to + insert.length;
  return {
    changes: { from: line.to, insert: withLineBreaks(state, insert) },
    selection: EditorSelection.cursor(isLast ? end : end + 1),
    scrollIntoView: true,
    userEvent: event,
  };
}

/* -------------------------------------------------------------------------- *
 * Indent / outdent (list items)
 * -------------------------------------------------------------------------- */

function listItemAt(state: EditorState, line: Line): SyntaxNode | null {
  const prefix = parsePrefix(line.text);
  if (!prefix.marker) return null;
  const pos = line.from + listStart(prefix);
  for (let node: SyntaxNode | null = fullTree(state).resolveInner(pos, 1); node; node = node.parent) {
    if (node.name === 'ListItem' && node.from === pos) return node;
  }
  return null;
}

function parentItem(node: SyntaxNode): SyntaxNode | null {
  for (let n = node.parent; n; n = n.parent) if (n.name === 'ListItem') return n;
  return null;
}

/** Column where a list item's own content starts, relative to its marker (2 for `- `, 3 for `1. `). */
function contentOffset(state: EditorState, item: SyntaxNode): number {
  const p = parsePrefix(state.doc.lineAt(item.from).text);
  return p.marker.length + Math.min(p.markerGap.length || 1, 4);
}

function shiftListItems(state: EditorState, dir: 1 | -1): CommandResult {
  const { doc } = state;
  const lines = selectedLines(state);
  const firstItem = lines.map((l) => listItemAt(state, l)).find((n) => n);
  if (!firstItem) return null;

  let delta: number;
  if (dir > 0) {
    // Nest under the item above: move to where its content starts.
    const prev = firstItem.prevSibling;
    if (!prev || prev.name !== 'ListItem') return null;
    delta = contentOffset(state, prev);
  } else {
    const parent = parentItem(firstItem);
    if (!parent) return null;
    delta = firstItem.from - doc.lineAt(firstItem.from).from - (parent.from - doc.lineAt(parent.from).from);
    if (delta <= 0) return null;
  }

  // Every selected item moves with its whole body (children, continuation lines).
  let start = doc.lineAt(firstItem.from).number;
  let end = start;
  for (const line of lines) {
    const item = listItemAt(state, line);
    if (!item) continue;
    start = Math.min(start, line.number);
    end = Math.max(end, doc.lineAt(item.to).number);
  }
  end = Math.max(end, lines[lines.length - 1].number);

  const changes: ChangeSpec[] = [];
  for (let n = start; n <= end; n++) {
    const line = doc.line(n);
    if (line.text.trim() === '') continue;
    const quote = parsePrefix(line.text).quote.length;
    if (dir > 0) changes.push({ from: line.from + quote, insert: ' '.repeat(delta) });
    else {
      const spaces = /^ */.exec(line.text.slice(quote))![0].length;
      const take = Math.min(delta, spaces);
      if (take) changes.push({ from: line.from + quote, to: line.from + quote + take });
    }
  }
  return withChanges(state, changes, dir > 0 ? 'input.indent' : 'delete.dedent');
}

export const indentList = (state: EditorState): CommandResult => shiftListItems(state, 1);
export const outdentList = (state: EditorState): CommandResult => shiftListItems(state, -1);

/**
 * Enter on the empty last item of a top-level list ends the list: the marker goes and a blank line
 * separates what follows. (Without the blank line, the next thing typed would be a "lazy
 * continuation" — rendered as part of the previous item even though it does not look like it.)
 * Returns null everywhere else, so the regular markdown Enter handling runs.
 */
export function exitEmptyListItem(state: EditorState): CommandResult {
  const { head, empty } = state.selection.main;
  if (!empty) return null;
  const line = state.doc.lineAt(head);
  if (!/^(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]*)?$/.test(line.text) || line.number === 1) return null;
  const item = listItemAt(state, line);
  if (!item || parentItem(item) || item.nextSibling) return null;
  const above = state.doc.line(line.number - 1);
  const insert = above.text.trim() === '' ? '' : state.lineBreak;
  return {
    changes: { from: line.from, to: line.to, insert },
    selection: EditorSelection.cursor(line.from + insert.length),
    scrollIntoView: true,
    userEvent: 'input',
  };
}

/* -------------------------------------------------------------------------- *
 * Registry
 * -------------------------------------------------------------------------- */

type PureCommandId = Exclude<keyof EditorCommandArgs, 'undo' | 'redo'>;

/** Commands that are plain document edits. Undo/redo (and indent inside code) need the view; see Editor.svelte. */
export const pureCommands: { [K in PureCommandId]: (state: EditorState, arg?: Exclude<EditorCommandArgs[K], void>) => CommandResult } = {
  bold: (s) => toggleInline(s, 'bold'),
  italic: (s) => toggleInline(s, 'italic'),
  strike: (s) => toggleInline(s, 'strike'),
  code: (s) => toggleInline(s, 'code'),
  math: (s) => toggleInline(s, 'math'),
  link: toggleLink,
  image: insertImage,
  heading: setHeading,
  bulletList: (s) => toggleList(s, 'bullet'),
  orderedList: (s) => toggleList(s, 'ordered'),
  taskList: (s) => toggleList(s, 'task'),
  quote: toggleQuote,
  codeBlock: toggleCodeBlock,
  mathBlock: toggleMathBlock,
  rule: insertRule,
  footnote: (s) => insertFootnote(s)?.spec ?? null,
  indent: indentList,
  outdent: outdentList,
};

/* -------------------------------------------------------------------------- *
 * Selection state for the toolbar
 * -------------------------------------------------------------------------- */

export function selectionState(state: EditorState): EditorSelectionState {
  const { from, to, anchor, head, empty } = state.selection.main;
  const inside = (name: string | readonly string[]): boolean => {
    const node = enclosing(state, from, to, name);
    if (!node) return false;
    return empty ? from > node.from && from < node.to : true;
  };
  const line = state.doc.lineAt(head);
  const raw = isRawLine(state, line);
  const prefix = raw ? null : parsePrefix(line.text);

  let heading = prefix ? prefix.heading.trim().length : 0;
  if (!heading && !raw) {
    const setext = enclosing(state, from, from, ['SetextHeading1', 'SetextHeading2']);
    if (setext) heading = setext.name === 'SetextHeading1' ? 1 : 2;
  }

  let list = prefix ? listKind(prefix) : null;
  let quote = !!prefix && prefix.quote !== '';
  if (!raw && (!list || !quote)) {
    // Continuation lines carry no marker of their own: ask the tree.
    for (let node: SyntaxNode | null = fullTree(state).resolveInner(head, -1); node; node = node.parent) {
      if (node.name === 'Blockquote') quote = true;
      if (node.name === 'ListItem' && !list) {
        const p = parsePrefix(state.doc.lineAt(node.from).text);
        list = listKind(p);
      }
    }
  }

  return {
    bold: inside('StrongEmphasis'),
    italic: inside('Emphasis'),
    strike: inside('Strikethrough'),
    code: inside('InlineCode'),
    link: inside('Link') && linkParts(state, enclosing(state, from, to, 'Link')!) !== null,
    heading: heading as EditorSelectionState['heading'],
    list,
    quote,
    codeBlock: enclosing(state, from, to, ['FencedCode', 'CodeBlock']) !== null && raw,
    literal: raw || footnoteInsertPos(state, to) === null,
    empty,
    canUndo: undoDepth(state) > 0,
    canRedo: redoDepth(state) > 0,
    anchor,
    head,
  };
}
