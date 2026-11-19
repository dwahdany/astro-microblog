/**
 * Line breaks, kept exactly as the file has them.
 *
 * CodeMirror stores a document as lines and forgets what separated them: read
 * back, every break is whatever single separator the state is configured with.
 * That is fine for a file with one kind of line ending and wrong for any
 * other — a CRLF file with one stray LF, an old-Mac CR file, a file whose
 * frontmatter and body disagree. Typing one character into such a file would
 * rewrite every line ending in it, and undo would not bring them back.
 *
 * So the editor never lets CodeMirror choose. The state is created WITHOUT
 * `EditorState.lineSeparator`: every `\r\n`, `\r` and `\n` in the text (and in
 * anything pasted later) is one line break, one position. Next to the document
 * this module keeps a set of marks, one on each break that is NOT the
 * document's usual one, and `docText()` writes each break back as it was:
 *
 *   - an untouched break keeps its kind, wherever edits move it;
 *   - a break the user adds (Enter, paste, a toolbar command) is the
 *     document's usual one (`fallback`);
 *   - deleting a break drops its mark, and undoing the deletion restores it
 *     (through `invertedEffects`, so the history carries it).
 *
 * `state.lineBreak` is therefore always `\n` inside the editor; text built by
 * commands uses `\n` and positions count every break as one.
 */
import { invertedEffects } from '@codemirror/commands';
import { Facet, RangeSet, RangeValue, StateEffect, StateField, type EditorState, type Extension, type Range, type Text } from '@codemirror/state';

export type LineBreak = '\n' | '\r\n' | '\r';

const ANY_BREAK = /\r\n?|\n/g;

class BreakMark extends RangeValue {
  constructor(readonly sep: LineBreak) {
    super();
  }
  eq(other: RangeValue): boolean {
    return other instanceof BreakMark && other.sep === this.sep;
  }
}
// The mark covers exactly the break character: text typed on either side stays outside it,
// and when the break is deleted the mark collapses and is dropped.
BreakMark.prototype.startSide = 1;
BreakMark.prototype.endSide = -1;

const MARKS: Record<LineBreak, BreakMark> = { '\n': new BreakMark('\n'), '\r\n': new BreakMark('\r\n'), '\r': new BreakMark('\r') };

interface BreakAt {
  /** Document position of the break (the end of its line). */
  pos: number;
  sep: LineBreak;
}

/** Put marks (back) on breaks: used to restore the ones a change removed when that change is undone. */
const restoreBreaks = StateEffect.define<BreakAt[]>({
  map: (list, changes) => list.map((b) => ({ pos: changes.mapPos(b.pos, 1), sep: b.sep })),
});

/** The break written for new lines, and for every break without a mark. */
const fallbackBreak = Facet.define<LineBreak, LineBreak>({ combine: (values) => values[0] ?? '\n' });

const isBreak = (doc: Text, pos: number): boolean => pos >= 0 && pos < doc.length && doc.lineAt(pos).to === pos;

const breakMarks = StateField.define<RangeSet<BreakMark>>({
  create: () => RangeSet.empty,
  update(marks, tr) {
    if (tr.docChanged && marks.size > 0) marks = marks.map(tr.changes);
    for (const effect of tr.effects) {
      if (!effect.is(restoreBreaks)) continue;
      const fallback = tr.state.facet(fallbackBreak);
      const add: Range<BreakMark>[] = [];
      for (const b of effect.value) {
        if (b.sep === fallback || !isBreak(tr.state.doc, b.pos)) continue;
        let taken = false;
        marks.between(b.pos, b.pos + 1, (from) => {
          if (from === b.pos) taken = true;
        });
        if (!taken && !add.some((r) => r.from === b.pos)) add.push(MARKS[b.sep].range(b.pos, b.pos + 1));
      }
      if (add.length) marks = marks.update({ add, sort: true });
    }
    return marks;
  },
});

/** Marks a change is about to remove, as an effect the history replays when the change is undone. */
const rememberLostBreaks = invertedEffects.of((tr) => {
  if (!tr.docChanged) return [];
  const marks = tr.startState.field(breakMarks, false);
  if (!marks || marks.size === 0) return [];
  const lost: BreakAt[] = [];
  tr.changes.iterChangedRanges((fromA, toA) => {
    marks.between(fromA, toA, (from, to, value) => {
      if (from >= fromA && to <= toA) lost.push({ pos: from, sep: value.sep });
    });
  });
  return lost.length ? [restoreBreaks.of(lost)] : [];
});

/** Every line break in a text, with its position as CodeMirror counts (each break is one position). */
export function scanLineBreaks(text: string): BreakAt[] {
  const out: BreakAt[] = [];
  let extra = 0;
  ANY_BREAK.lastIndex = 0;
  for (let m = ANY_BREAK.exec(text); m; m = ANY_BREAK.exec(text)) {
    out.push({ pos: m.index - extra, sep: m[0] as LineBreak });
    extra += m[0].length - 1;
  }
  return out;
}

/** The most common line break in a text (`\n` when it has none; ties go to the earlier kind). */
export function dominantLineBreak(text: string): LineBreak {
  const counts = new Map<LineBreak, number>();
  for (const b of scanLineBreaks(text)) counts.set(b.sep, (counts.get(b.sep) ?? 0) + 1);
  let best: LineBreak = '\n';
  let most = 0;
  for (const [sep, n] of counts) {
    if (n > most) {
      best = sep;
      most = n;
    }
  }
  return best;
}

/**
 * The extension for a document created from `text`. `fallback` is the break for new lines
 * (default: the one `text` uses most). The state must be created from the same `text` and
 * WITHOUT `EditorState.lineSeparator`.
 */
export function lineBreaks(text: string, fallback: LineBreak = dominantLineBreak(text)): Extension {
  const odd = scanLineBreaks(text).filter((b) => b.sep !== fallback);
  return [
    fallbackBreak.of(fallback),
    breakMarks.init(() => (odd.length ? RangeSet.of(odd.map((b) => MARKS[b.sep].range(b.pos, b.pos + 1))) : RangeSet.empty)),
    rememberLostBreaks,
  ];
}

/** Effects that make the marks describe `text` — for a transaction that replaces the whole document with it. */
export function lineBreaksOf(state: EditorState, text: string): StateEffect<unknown>[] {
  const fallback = state.facet(fallbackBreak);
  const odd = scanLineBreaks(text).filter((b) => b.sep !== fallback);
  return odd.length ? [restoreBreaks.of(odd)] : [];
}

/** The document as text, every line break as it is in the file. This is what the editor reports and hands back. */
export function docText(state: EditorState): string {
  const fallback = state.facet(fallbackBreak);
  const marks = state.field(breakMarks, false);
  if (!marks || marks.size === 0) return state.doc.sliceString(0, undefined, fallback);
  let out = '';
  let pos = 0;
  for (const cursor = marks.iter(); cursor.value; cursor.next()) {
    // A mark only ever sits on a break; anything else would be a bug, and is written as the usual break.
    if (cursor.from < pos || !isBreak(state.doc, cursor.from)) continue;
    out += state.doc.sliceString(pos, cursor.from, fallback) + cursor.value.sep;
    pos = cursor.to;
  }
  return out + state.doc.sliceString(pos, undefined, fallback);
}

/** The break this document writes for a new line. */
export function newLineBreak(state: EditorState): LineBreak {
  return state.facet(fallbackBreak);
}
