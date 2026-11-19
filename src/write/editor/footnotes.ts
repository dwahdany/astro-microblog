/**
 * Footnotes as a document model — pure functions over EditorState.
 *
 * Everything here reads the syntax tree and returns positions or
 * TransactionSpecs. Nothing renumbers, reorders or reformats existing notes:
 * each operation touches only the characters it is about (a label, a note's
 * own text, a newly appended definition).
 */
import { syntaxTree } from '@codemirror/language';
import { EditorSelection, StateField, type ChangeSpec, type EditorState, type TransactionSpec } from '@codemirror/state';
import type { SyntaxNode } from '@lezer/common';
import { FOOTNOTE_LABEL, fullTree } from './markdown';

export interface FootnoteRef {
  label: string;
  key: string;
  /** Range of the whole `[^label]`. */
  from: number;
  to: number;
}

export interface FootnoteDef {
  label: string;
  key: string;
  /** Start of `[^label]:`. */
  from: number;
  /** End of the definition's last line. */
  to: number;
  /** Range of the `[^label]:` mark. */
  markFrom: number;
  markTo: number;
  /** Where the note's text starts: after the mark and one optional space. */
  bodyFrom: number;
}

export interface FootnoteEntry {
  key: string;
  refs: FootnoteRef[];
  defs: FootnoteDef[];
}

export interface FootnoteIndex {
  refs: FootnoteRef[];
  defs: FootnoteDef[];
  byKey: Map<string, FootnoteEntry>;
}

/**
 * Text built here uses `\n`. The editor keeps `state.lineBreak` at `\n` and writes each line break
 * back in the file's own kind (./lineBreaks.ts), so this is a no-op there; it still honours a state
 * that was configured with another separator. Offsets are always computed on the `\n` form:
 * CodeMirror counts every line break as one position whatever the separator.
 */
export function withLineBreaks(state: EditorState, text: string): string {
  return state.lineBreak === '\n' ? text : text.replace(/\n/g, state.lineBreak);
}

/** GFM matches footnote labels case-insensitively. */
export function footnoteKey(label: string): string {
  return label.toLowerCase();
}

export function isValidFootnoteLabel(label: string): boolean {
  return FOOTNOTE_LABEL.test(label);
}

export function scanFootnotes(state: EditorState): FootnoteIndex {
  const refs: FootnoteRef[] = [];
  const defs: FootnoteDef[] = [];
  const byKey = new Map<string, FootnoteEntry>();
  const entry = (key: string) => {
    let e = byKey.get(key);
    if (!e) byKey.set(key, (e = { key, refs: [], defs: [] }));
    return e;
  };
  fullTree(state).iterate({
    enter(node) {
      if (node.name === 'FootnoteReference') {
        const label = state.sliceDoc(node.from + 2, node.to - 1);
        const ref: FootnoteRef = { label, key: footnoteKey(label), from: node.from, to: node.to };
        refs.push(ref);
        entry(ref.key).refs.push(ref);
        return false;
      }
      if (node.name === 'FootnoteDefinition') {
        const mark = node.node.firstChild;
        if (!mark || mark.name !== 'FootnoteDefinitionMark') return;
        const label = state.sliceDoc(mark.from + 2, mark.to - 2);
        const afterMark = state.sliceDoc(mark.to, mark.to + 1);
        const def: FootnoteDef = {
          label,
          key: footnoteKey(label),
          from: node.from,
          to: state.doc.lineAt(node.to).to,
          markFrom: mark.from,
          markTo: mark.to,
          bodyFrom: afterMark === ' ' || afterMark === '\t' ? mark.to + 1 : mark.to,
        };
        defs.push(def);
        entry(def.key).defs.push(def);
      }
      return undefined;
    },
  });
  return { refs, defs, byKey };
}

/** The index for the current document, recomputed only when the text or the tree changes. */
export const footnoteIndex = StateField.define<FootnoteIndex>({
  create: scanFootnotes,
  update(value, tr) {
    if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return scanFootnotes(tr.state);
    return value;
  },
});

export function getFootnotes(state: EditorState): FootnoteIndex {
  return state.field(footnoteIndex, false) ?? scanFootnotes(state);
}

/** One more than the highest numeric label in use (references and definitions alike). */
export function nextFootnoteLabel(index: FootnoteIndex): string {
  let max = 0;
  for (const key of index.byKey.keys()) {
    if (/^\d{1,9}$/.test(key)) max = Math.max(max, Number(key));
  }
  return String(max + 1);
}

/* -------------------------------------------------------------------------- *
 * Appending a definition
 * -------------------------------------------------------------------------- */

/**
 * Where a new definition goes and what separates it from what is there.
 * `refLineEnd`: end of the line a reference is being inserted on in the same
 * step (it may sit below the current last line of text), or -1.
 */
function appendPlan(state: EditorState, index: FootnoteIndex, refLineEnd = -1): { at: number; sep: string } {
  const { doc } = state;
  let line = doc.line(doc.lines);
  while (line.number > 1 && line.text.trim() === '') line = doc.line(line.number - 1);
  const hasText = line.text.trim() !== '';
  if (refLineEnd >= 0 && (!hasText || refLineEnd > line.to)) return { at: refLineEnd, sep: '\n\n' };
  if (!hasText) return { at: doc.length, sep: '' };
  const last = index.defs.find((d) => d.from <= line.from && d.to >= line.to) ?? index.defs.find((d) => d.to === line.to);
  if (!last) return { at: line.to, sep: '\n\n' };
  // The document already ends in notes: follow how they are spaced there.
  const before = index.defs.filter((d) => d.to < last.from).pop();
  let sep = '\n';
  if (before) {
    const between = state.doc.sliceString(before.to, last.from, '\n');
    if (/\n[ \t]*\n/.test(between)) sep = '\n\n';
  }
  return { at: line.to, sep };
}

function indentNoteText(text: string, indent = '    '): string {
  return text
    .split('\n')
    .map((l, i) => (i === 0 || l === '' ? l : indent + l))
    .join('\n');
}

/** Change that appends `[^label]: text` at the end of the document. Unchecked: see `appendDefinitionSafely`. */
export function appendDefinition(
  state: EditorState,
  label: string,
  text = '',
  refLineEnd = -1,
): { change: ChangeSpec; at: number; insert: string } {
  const plan = appendPlan(state, getFootnotes(state), refLineEnd);
  const insert = `${plan.sep}[^${label}]: ${indentNoteText(text)}`;
  return { change: { from: plan.at, insert: withLineBreaks(state, insert) }, at: plan.at, insert };
}

/** After `changes`, is `[^label]` read as a note (and, with `needRef`, as a reference too)? */
function readsAsFootnote(state: EditorState, changes: ChangeSpec, label: string, needRef: boolean): boolean {
  let next: EditorState;
  try {
    next = state.update({ changes }).state;
  } catch {
    return false;
  }
  const entry = scanFootnotes(next).byKey.get(footnoteKey(label));
  return !!entry && entry.defs.length > 0 && (!needRef || entry.refs.length > 0);
}

/**
 * The fence that would close a code or display-math block left open at the very end of the
 * document, or null when the document does not end inside one.
 */
function openFenceAtEnd(state: EditorState): string | null {
  const { doc } = state;
  let line = doc.line(doc.lines);
  while (line.number > 1 && line.text.trim() === '') line = doc.line(line.number - 1);
  for (let node: SyntaxNode | null = fullTree(state).resolveInner(line.to, -1); node; node = node.parent) {
    if (node.name === 'FencedCode') {
      const marks = node.getChildren('CodeMark');
      if (marks.length !== 1) return null;
      return state.sliceDoc(marks[0].from, marks[0].to);
    }
    if (node.name === 'BlockMath') {
      const marks = node.getChildren('BlockMathMark');
      if (marks.length !== 1) return null;
      return state.sliceDoc(marks[0].from, marks[0].to);
    }
  }
  return null;
}

/** A line that already starts a definition for this label, as plain text (whatever the parser makes of it). */
export function hasDefinitionLine(state: EditorState, label: string): boolean {
  const start = `[^${label.toLowerCase()}]:`;
  for (let n = 1; n <= state.doc.lines; n++) {
    if (state.doc.line(n).text.replace(/^[ \t>]*/, '').toLowerCase().startsWith(start)) return true;
  }
  return false;
}

/**
 * The changes that append `[^label]: text` at the end AND are read as a note afterwards.
 *
 * Appending is not always enough: when the document ends inside a code or display-math block
 * that was never closed, the new line would land inside that block and be code, not a note
 * (review finding: every keystroke in the note panel then appended another `[^1]:` line). In
 * that one case the block is closed first, with its own fence, on a line of its own — the same
 * text the writer would have to add by hand, and it renders the same on the site, where an
 * unclosed block also runs to the end. Returns null when the result still would not be a note
 * (the caller then leaves the document alone).
 *
 * `ref`: a reference inserted in the same step, checked too.
 */
export function appendDefinitionSafely(
  state: EditorState,
  label: string,
  text = '',
  ref?: { at: number; insert: string },
): ChangeSpec[] | null {
  const refLineEnd = ref ? state.doc.lineAt(ref.at).to : -1;
  const withRef = (def: ChangeSpec): ChangeSpec[] => (ref ? [{ from: ref.at, insert: ref.insert }, def] : [def]);

  const plain = withRef(appendDefinition(state, label, text, refLineEnd).change);
  if (readsAsFootnote(state, plain, label, !!ref)) return plain;

  const fence = openFenceAtEnd(state);
  if (fence !== null) {
    const { doc } = state;
    let line = doc.line(doc.lines);
    while (line.number > 1 && line.text.trim() === '') line = doc.line(line.number - 1);
    const at = Math.max(line.to, refLineEnd);
    const insert = `\n${fence}\n\n[^${label}]: ${indentNoteText(text)}`;
    const closed = withRef({ from: at, insert: withLineBreaks(state, insert) });
    if (readsAsFootnote(state, closed, label, !!ref)) return closed;
  }
  return null;
}

/** Inline constructs a reference must not be dropped into: it goes right after them instead. */
const INLINE_UNITS = ['Link', 'Image', 'InlineCode', 'InlineMath', 'Autolink', 'URL', 'HTMLTag', 'Comment', 'FootnoteReference'];
/** Blocks whose text is literal: a reference typed there is not a footnote on the site. */
const LITERAL_BLOCKS = ['FencedCode', 'CodeBlock', 'BlockMath', 'HTMLBlock', 'CommentBlock', 'ProcessingInstructionBlock', 'LinkReference'];

/**
 * Where a new reference goes for a caret at `pos`: `pos` itself in ordinary text; just after a
 * link, image, code span, inline math or URL the caret is inside of; null inside literal text
 * (code blocks, display math, raw HTML), where there is no such thing as a footnote.
 */
export function footnoteInsertPos(state: EditorState, pos: number): number | null {
  const tree = fullTree(state);
  let at = pos;
  for (const side of [-1, 1] as const) {
    for (let node: SyntaxNode | null = tree.resolveInner(pos, side); node; node = node.parent) {
      if (LITERAL_BLOCKS.includes(node.name) && node.from <= pos && node.to >= pos) return null;
      if (INLINE_UNITS.includes(node.name) && node.from < pos && node.to > pos) at = Math.max(at, node.to);
    }
  }
  return at;
}

/**
 * The Footnote command: `[^n]` at the end of the selection, `[^n]: ` appended
 * to the document. The caret ends up right after the reference. Null where a
 * footnote cannot go (inside code, display math or raw HTML) or would not be
 * read as one.
 */
export function insertFootnote(state: EditorState): { spec: TransactionSpec; label: string } | null {
  const index = getFootnotes(state);
  const label = nextFootnoteLabel(index);
  const at = footnoteInsertPos(state, state.selection.main.to);
  if (at === null) return null;
  const ref = `[^${label}]`;
  const changes = appendDefinitionSafely(state, label, '', { at, insert: ref });
  if (!changes) return null;
  return {
    label,
    spec: {
      changes,
      selection: EditorSelection.cursor(at + ref.length),
      scrollIntoView: true,
      userEvent: 'input.footnote',
    },
  };
}

/* -------------------------------------------------------------------------- *
 * Renaming and deleting
 * -------------------------------------------------------------------------- */

export type RenameResult = { spec: TransactionSpec } | { error: 'invalid' | 'exists' | 'missing' | 'same' };

/** Change a label everywhere it is used: every reference and the definition, in one step. */
export function renameFootnote(state: EditorState, from: string, to: string): RenameResult {
  if (!isValidFootnoteLabel(to)) return { error: 'invalid' };
  const index = getFootnotes(state);
  const entry = index.byKey.get(footnoteKey(from));
  if (!entry) return { error: 'missing' };
  const changes: ChangeSpec[] = [];
  for (const ref of entry.refs) {
    if (ref.label !== to) changes.push({ from: ref.from + 2, to: ref.to - 1, insert: to });
  }
  for (const def of entry.defs) {
    if (def.label !== to) changes.push({ from: def.markFrom + 2, to: def.markTo - 2, insert: to });
  }
  if (!changes.length) return { error: 'same' };
  if (footnoteKey(to) !== entry.key && index.byKey.has(footnoteKey(to))) return { error: 'exists' };
  return { spec: { changes, userEvent: 'input.footnote.rename' } };
}

/** Remove a note: every reference to it and its definition (with the line it occupied). */
export function deleteFootnote(state: EditorState, label: string): TransactionSpec | null {
  const entry = getFootnotes(state).byKey.get(footnoteKey(label));
  if (!entry) return null;
  const { doc } = state;
  const removed: { from: number; to: number }[] = [];
  for (const def of entry.defs) {
    const startLine = doc.lineAt(def.from);
    let from = startLine.from;
    let to = def.to;
    // Last thing in the document: also take the blank line that set it apart.
    const prev = startLine.number > 1 ? doc.line(startLine.number - 1) : null;
    if (prev && prev.text.trim() === '' && state.sliceDoc(to).trim() === '') from = prev.from;
    if (to < doc.length) to += 1;
    else if (from > 0) from -= 1;
    const last = removed[removed.length - 1];
    if (last && from < last.to) from = last.to;
    if (from < to) removed.push({ from, to });
  }
  const changes: ChangeSpec[] = [...removed];
  for (const ref of entry.refs) {
    if (!removed.some((r) => ref.from < r.to && ref.to > r.from)) changes.push({ from: ref.from, to: ref.to });
  }
  const first = entry.refs[0];
  const changeSet = state.changes(changes);
  return {
    changes: changeSet,
    selection: first ? EditorSelection.cursor(changeSet.mapPos(first.from, -1)) : undefined,
    userEvent: 'delete.footnote',
  };
}

/* -------------------------------------------------------------------------- *
 * A note's text, as shown in the note panel
 * -------------------------------------------------------------------------- */

export interface NoteLine {
  /** Document position of this display line's first character. */
  from: number;
  text: string;
  /** Whitespace stripped from the front of the document line (continuation indent). */
  stripped: number;
}

export interface NoteModel {
  lines: NoteLine[];
  /** The note as plain text: continuation indentation removed. */
  text: string;
  /** Indentation to give new continuation lines (taken from the note itself when it has any). */
  indent: string;
}

const MAX_STRIP = 4;

/**
 * `trailingBlank`: how many blank lines directly below the definition to treat
 * as (still empty) lines of the note. The parser ends a definition at its last
 * line of text, so a line break just typed at the end of a note would
 * otherwise fall outside it before any text follows.
 */
export function noteModel(state: EditorState, def: FootnoteDef, trailingBlank = 0): NoteModel {
  const { doc } = state;
  const first = doc.lineAt(def.from);
  const last = doc.lineAt(def.to);
  const lines: NoteLine[] = [{ from: def.bodyFrom, text: state.sliceDoc(def.bodyFrom, first.to), stripped: 0 }];
  let indent = '';
  for (let n = first.number + 1; n <= last.number; n++) {
    const line = doc.line(n);
    let strip = 0;
    if (line.text.charCodeAt(0) === 9) strip = 1;
    else while (strip < MAX_STRIP && line.text.charCodeAt(strip) === 32) strip++;
    if (strip && !indent && line.text.trim() !== '') indent = line.text.slice(0, strip);
    lines.push({ from: line.from + strip, text: line.text.slice(strip), stripped: strip });
  }
  for (let n = last.number + 1; n <= doc.lines && n <= last.number + trailingBlank; n++) {
    const line = doc.line(n);
    if (line.text !== '') break;
    lines.push({ from: line.from, text: '', stripped: 0 });
  }
  return { lines, text: lines.map((l) => l.text).join('\n'), indent: indent || '    ' };
}

/** Display offset → document position. */
export function noteToDoc(model: NoteModel, offset: number): number {
  let rest = Math.max(0, offset);
  for (let i = 0; i < model.lines.length; i++) {
    const line = model.lines[i];
    if (rest <= line.text.length || i === model.lines.length - 1) return line.from + Math.min(rest, line.text.length);
    rest -= line.text.length + 1;
  }
  return model.lines[0].from;
}

/** Document position → display offset (positions inside stripped indentation snap to the line start). */
export function docToNote(model: NoteModel, pos: number): number {
  let offset = 0;
  for (let i = 0; i < model.lines.length; i++) {
    const line = model.lines[i];
    const end = line.from + line.text.length;
    if (pos <= end || i === model.lines.length - 1) return offset + Math.min(Math.max(0, pos - line.from), line.text.length);
    offset += line.text.length + 1;
  }
  return offset;
}

/**
 * Translate an edit made to the note's display text (replace [a, b) with
 * `insert`) into the smallest document change: only the edited characters are
 * touched, and new lines get the note's continuation indent (blank lines stay
 * truly empty).
 */
export function mapNoteEdit(state: EditorState, model: NoteModel, a: number, b: number, insert: string): ChangeSpec {
  const from = noteToDoc(model, a);
  const to = noteToDoc(model, b);
  const restOfLine = state.sliceDoc(to, state.doc.lineAt(to).to);
  const segments = insert.split('\n');
  let text = segments[0];
  for (let i = 1; i < segments.length; i++) {
    const isLast = i === segments.length - 1;
    const blank = segments[i] === '' && (!isLast || restOfLine === '');
    text += '\n' + (blank ? '' : model.indent) + segments[i];
  }
  const startLine = state.doc.lineAt(from);
  const firstLine = state.doc.lineAt(model.lines[0].from);
  if (segments[0] !== '') {
    // Typing on an empty continuation line: it needs the indent to stay part of the note.
    if (startLine.number > firstLine.number && startLine.text === '') text = model.indent + text;
    // `[^1]:` with nothing after it: put the customary space before the first character.
    else if (startLine.number === firstLine.number && from === startLine.to && /\]:$/.test(startLine.text)) text = ' ' + text;
  }
  return { from, to, insert: withLineBreaks(state, text) };
}

/** What the note panel shows for the footnote that is open. */
export interface NoteView {
  label: string;
  /** The note's text as shown (continuation indentation removed). */
  text: string;
  /** Number of references to this note in the text. */
  refs: number;
  /** False when the reference has no definition yet (typing creates it). */
  hasDef: boolean;
}
