/**
 * Line endings survive editing, whatever mix a file has (review finding: the
 * first keystroke in a file with mixed or CR line endings rewrote every line
 * ending in the body, and undo did not bring them back).
 */
import { describe, expect, it } from 'vitest';
import { history, redo, undo } from '@codemirror/commands';
import { EditorSelection, EditorState, type Transaction, type TransactionSpec } from '@codemirror/state';
import { pureCommands } from '../commands';
import { footnoteIndex } from '../footnotes';
import { docText, dominantLineBreak, lineBreaks, lineBreaksOf, scanLineBreaks, type LineBreak } from '../lineBreaks';
import { livePreview, livePreviewConfig } from '../livePreview';
import { writeMarkdown } from '../markdown';

function createState(doc: string, fallback?: LineBreak): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      lineBreaks(doc, fallback),
      history(),
      writeMarkdown(),
      footnoteIndex,
      livePreviewConfig.of({ resolveAsset: (src) => src, onFootnote: () => {}, onImage: () => {} }),
      livePreview(),
    ],
  });
}

function step(state: EditorState, command: typeof undo): EditorState {
  let next: Transaction | undefined;
  command({ state, dispatch: (tr) => (next = tr) });
  return next ? next.state : state;
}

const apply = (state: EditorState, spec: TransactionSpec) => state.update(spec).state;
const type = (state: EditorState, at: number, text: string) => apply(state, { changes: { from: at, insert: text }, userEvent: 'input.type' });

/** The reviewer's adversarial bodies. */
const CASES: [name: string, text: string][] = [
  ['pure LF', 'one\ntwo\n\nthree\n'],
  ['pure CRLF', 'one\r\ntwo\r\n\r\nthree\r\n'],
  ['CRLF with one lone LF', 'one\r\ntwo\nthree\r\nfour\r\n'],
  ['LF with one stray CRLF', 'one\ntwo\r\nthree\nfour\n'],
  ['CR only', 'one\rtwo\r\rthree\r'],
  ['CR in the middle of an LF file', 'one\ntwo\rthree\nfour\n'],
  ['all three kinds', 'a\r\nb\rc\nd\r\n\r\re\n\n'],
  ['no final break', 'one\r\ntwo\rthree'],
  ['only breaks', '\r\n\r\n\n\r'],
  ['empty', ''],
];

describe('reading a document back', () => {
  it.each(CASES)('%s: unedited text is identical', (_name, text) => {
    expect(docText(createState(text))).toBe(text);
  });

  it('counts every kind of break as one line break', () => {
    expect(createState('a\r\nb\rc\nd').doc.lines).toBe(4);
    expect(scanLineBreaks('a\r\nb\rc\nd')).toEqual([
      { pos: 1, sep: '\r\n' },
      { pos: 3, sep: '\r' },
      { pos: 5, sep: '\n' },
    ]);
  });

  it('picks the most common break for new lines', () => {
    expect(dominantLineBreak('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(dominantLineBreak('a\rb\rc\n')).toBe('\r');
    expect(dominantLineBreak('no breaks')).toBe('\n');
  });
});

describe('editing keeps every other line break as it was', () => {
  it.each(CASES)('%s: one character typed at the end is the only change, and undo restores the file', (_name, text) => {
    const state = createState(text);
    const typed = type(state, state.doc.length, 'X');
    expect(docText(typed)).toBe(text + 'X');
    expect(docText(step(typed, undo))).toBe(text);
  });

  it.each(CASES)('%s: typing at the start and in the middle', (_name, text) => {
    const state = createState(text);
    expect(docText(type(state, 0, 'X'))).toBe('X' + text);
    // In the middle: insert at a document position and compare with the same insertion in the text.
    for (let pos = 0; pos <= state.doc.length; pos++) {
      const before = docText(apply(state, { changes: { from: pos, to: state.doc.length } }));
      const typed = docText(type(state, pos, 'X'));
      expect(typed.startsWith(before + 'X') || typed === before + 'X', `pos ${pos}`).toBe(true);
      expect(typed.replace(before + 'X', before)).toBe(text);
    }
  });

  it('a new line gets the document’s usual break, not the neighbouring odd one', () => {
    const state = createState('one\r\ntwo\nthree\r\n');
    const afterTwo = state.doc.line(2).to;
    expect(docText(type(state, afterTwo, '\nnew'))).toBe('one\r\ntwo\r\nnew\nthree\r\n');
    const cr = createState('one\rtwo\r');
    expect(docText(type(cr, 3, '\nnew'))).toBe('one\rnew\rtwo\r');
  });

  it('deleting an odd break and undoing brings that exact break back', () => {
    const text = 'one\r\ntwo\nthree\rfour\r\n';
    const state = createState(text);
    const lf = state.doc.line(2).to;
    const joined = apply(state, { changes: { from: lf, to: lf + 1 }, userEvent: 'delete.backward' });
    expect(docText(joined)).toBe('one\r\ntwothree\rfour\r\n');
    const undone = step(joined, undo);
    expect(docText(undone)).toBe(text);
    const redone = step(undone, redo);
    expect(docText(redone)).toBe('one\r\ntwothree\rfour\r\n');
    expect(docText(step(redone, undo))).toBe(text);
  });

  it('deleting everything and undoing restores every break', () => {
    for (const [, text] of CASES) {
      const state = createState(text);
      const cleared = apply(state, { changes: { from: 0, to: state.doc.length }, userEvent: 'delete.selection' });
      expect(docText(cleared)).toBe('');
      expect(docText(step(cleared, undo))).toBe(text);
    }
  });

  it('several edits and undos in a row end at the original', () => {
    const text = 'a\r\nb\rc\nd\r\n\r\re\n\n';
    let state = createState(text);
    state = type(state, 1, '!');
    state = apply(state, { changes: { from: 2, to: 5 }, userEvent: 'delete.selection' });
    state = type(state, state.doc.length, '\nend');
    state = apply(state, { changes: { from: 0, to: 2, insert: 'zz\nyy' }, userEvent: 'input.paste' });
    expect(docText(state)).not.toBe(text);
    for (let i = 0; i < 10; i++) state = step(state, undo);
    expect(docText(state)).toBe(text);
  });

  it('pasted text with other line endings becomes lines in the document’s own ending', () => {
    // Reviewer's case: a pure CRLF file, text pasted with LF line ends.
    const state = createState('first\r\nlast\r\n');
    const pasted = apply(state, { changes: { from: 6, insert: state.toText('pasted one\npasted two\n\n# heading pasted\n') }, userEvent: 'input.paste' });
    expect(pasted.doc.lines).toBe(7);
    expect(docText(pasted)).toBe('first\r\npasted one\r\npasted two\r\n\r\n# heading pasted\r\nlast\r\n');
    // And CRLF text pasted into an LF file.
    const lf = createState('first\nlast\n');
    expect(docText(apply(lf, { changes: { from: 6, insert: lf.toText('x\r\ny\r\n') } }))).toBe('first\nx\ny\nlast\n');
  });
});

describe('commands in files with other line endings', () => {
  it('commands that add lines use the document’s usual break and leave the others alone', () => {
    const text = 'Text\r\nmore\nend\r\n';
    const state = apply(createState(text), { selection: EditorSelection.cursor(4) });
    const noted = apply(state, pureCommands.footnote(state)!);
    expect(docText(noted)).toBe('Text[^1]\r\nmore\nend\r\n\r\n[^1]: \r\n');
    expect(docText(step(noted, undo))).toBe(text);

    const empty = createState('a\r\n\r\n');
    const at = apply(empty, { selection: EditorSelection.cursor(empty.doc.length) });
    expect(docText(apply(at, pureCommands.codeBlock(at)!))).toBe('a\r\n\r\n```\r\n\r\n```');
    expect(docText(apply(at, pureCommands.rule(at)!))).toBe('a\r\n\r\n---\r\n');

    const cr = createState('a\r\r');
    const atCr = apply(cr, { selection: EditorSelection.cursor(cr.doc.length) });
    expect(docText(apply(atCr, pureCommands.rule(atCr)!))).toBe('a\r\r---\r');
  });

  it('every command, run and undone, leaves a mixed file identical', () => {
    const text = '# Title\r\n\r\nA **line** with `code`\nand a [link](https://example.com).\r- item\r\n- other\n\n> quote\r\n';
    const base = createState(text);
    const ids = Object.keys(pureCommands) as (keyof typeof pureCommands)[];
    for (const selection of [EditorSelection.cursor(12), EditorSelection.range(10, 40), EditorSelection.range(0, base.doc.length)]) {
      for (const id of ids) {
        const state = apply(base, { selection });
        const spec = (pureCommands[id] as (s: EditorState) => TransactionSpec | null)(state);
        if (!spec) continue;
        const after = apply(state, spec);
        expect(docText(step(after, undo)), id).toBe(text);
      }
    }
  });
});

describe('replacing the whole document', () => {
  it('the marks follow the new text', () => {
    const state = createState('old\r\ntext\n');
    const next = 'new\rtext\r\nhere\n';
    const replaced = apply(state, { changes: { from: 0, to: state.doc.length, insert: state.toText(next) }, effects: lineBreaksOf(state, next) });
    expect(docText(replaced)).toBe(next);
    expect(docText(step(replaced, undo))).toBe('old\r\ntext\n');
  });
});
