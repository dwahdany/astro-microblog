import { describe, expect, it } from 'vitest';
import type { EditorState } from '@codemirror/state';
import {
  appendDefinition,
  deleteFootnote,
  docToNote,
  getFootnotes,
  insertFootnote,
  mapNoteEdit,
  nextFootnoteLabel,
  noteModel,
  noteToDoc,
  renameFootnote,
} from '../footnotes';
import { show, stateOf } from './helpers';

const footnote = (state: EditorState) => state.update(insertFootnote(state)!.spec).state;

/** Apply an edit to the display text of note `label`, the way the note panel does. */
function editNote(state: EditorState, label: string, a: number, b: number, insert: string, trailingBlank = 0): EditorState {
  const def = getFootnotes(state).byKey.get(label)!.defs[0];
  const model = noteModel(state, def, trailingBlank);
  return state.update({ changes: mapNoteEdit(state, model, a, b, insert) }).state;
}

function noteText(state: EditorState, label: string, trailingBlank = 0): string {
  const def = getFootnotes(state).byKey.get(label)!.defs[0];
  return noteModel(state, def, trailingBlank).text;
}

describe('index', () => {
  it('collects references and definitions by label', () => {
    const idx = getFootnotes(stateOf('A[^1] b[^note] c[^1].\n\n[^1]: one\n[^note]: two'));
    expect(idx.refs.map((r) => r.label)).toEqual(['1', 'note', '1']);
    expect(idx.defs.map((d) => d.label)).toEqual(['1', 'note']);
    expect(idx.byKey.get('1')!.refs).toHaveLength(2);
  });

  it('matches labels case-insensitively, like GFM', () => {
    const idx = getFootnotes(stateOf('A[^Note].\n\n[^note]: text'));
    expect(idx.byKey.get('note')).toMatchObject({ refs: [{ label: 'Note' }], defs: [{ label: 'note' }] });
  });

  it('exposes orphans as entries with one side empty', () => {
    const idx = getFootnotes(stateOf('A[^1].\n\n[^2]: unused'));
    expect(idx.byKey.get('1')!.defs).toEqual([]);
    expect(idx.byKey.get('2')!.refs).toEqual([]);
  });

  it('records where the note text begins and ends', () => {
    const state = stateOf('x[^1]\n\n[^1]: first\n    second\n\nafter');
    const def = getFootnotes(state).defs[0];
    expect(state.sliceDoc(def.markFrom, def.markTo)).toBe('[^1]:');
    expect(state.sliceDoc(def.bodyFrom, def.to)).toBe('first\n    second');
  });
});

describe('next label', () => {
  it('is one more than the highest number used anywhere', () => {
    expect(nextFootnoteLabel(getFootnotes(stateOf('plain')))).toBe('1');
    expect(nextFootnoteLabel(getFootnotes(stateOf('a[^1] b[^7]\n\n[^1]: x')))).toBe('8');
    expect(nextFootnoteLabel(getFootnotes(stateOf('a[^note]\n\n[^3]: orphan def')))).toBe('4');
  });
});

describe('the footnote command', () => {
  it('inserts a reference at the caret and appends the definition after a blank line', () => {
    expect(show(footnote(stateOf('A claim| here.')))).toBe('A claim[^1]| here.\n\n[^1]: ');
  });

  it('keeps the trailing newline of the file where it was', () => {
    expect(show(footnote(stateOf('A claim| here.\n')))).toBe('A claim[^1]| here.\n\n[^1]: \n');
    expect(show(footnote(stateOf('A claim| here.\n\n\n')))).toBe('A claim[^1]| here.\n\n[^1]: \n\n\n');
  });

  it('follows the spacing of the notes already at the end', () => {
    expect(show(footnote(stateOf('A[^1] b|.\n\n[^1]: one\n')))).toBe('A[^1] b[^2]|.\n\n[^1]: one\n[^2]: \n');
    expect(show(footnote(stateOf('A[^1] b[^2] c|.\n\n[^1]: one\n\n[^2]: two\n')))).toBe(
      'A[^1] b[^2] c[^3]|.\n\n[^1]: one\n\n[^2]: two\n\n[^3]: \n',
    );
  });

  it('never renumbers existing notes, even when inserting before them', () => {
    const before = 'First| then[^1] and[^2].\n\n[^1]: one\n[^2]: two\n';
    expect(show(footnote(stateOf(before)))).toBe('First[^3]| then[^1] and[^2].\n\n[^1]: one\n[^2]: two\n[^3]: \n');
  });

  it('puts the reference after a selection instead of replacing it', () => {
    expect(show(footnote(stateOf('A ⟦claim⟧ here.')))).toBe('A claim[^1]| here.\n\n[^1]: ');
  });

  it('works in an empty document and below the last text', () => {
    expect(show(footnote(stateOf('|')))).toBe('[^1]|\n\n[^1]: ');
    expect(show(footnote(stateOf('text\n\n|')))).toBe('text\n\n[^1]|\n\n[^1]: ');
  });

  it('is undone in one step by its inverse changes', () => {
    const state = stateOf('A claim| here.\n');
    const tr = state.update(insertFootnote(state)!.spec);
    expect(tr.changes.invert(state.doc).apply(tr.state.doc).toString()).toBe('A claim here.\n');
  });
});

describe('rename', () => {
  it('changes every reference and the definition together', () => {
    const state = stateOf('A[^1] b[^1] c[^2].\n\n[^1]: one\n[^2]: two');
    const result = renameFootnote(state, '1', 'source');
    expect('spec' in result).toBe(true);
    if ('spec' in result) {
      expect(state.update(result.spec).state.sliceDoc()).toBe('A[^source] b[^source] c[^2].\n\n[^source]: one\n[^2]: two');
    }
  });

  it('refuses labels that are invalid or already taken', () => {
    const state = stateOf('A[^1] c[^2].\n\n[^1]: one\n[^2]: two');
    expect(renameFootnote(state, '1', 'two words')).toEqual({ error: 'invalid' });
    expect(renameFootnote(state, '1', '')).toEqual({ error: 'invalid' });
    expect(renameFootnote(state, '1', 'a]b')).toEqual({ error: 'invalid' });
    expect(renameFootnote(state, '1', '2')).toEqual({ error: 'exists' });
    expect(renameFootnote(state, '1', '1')).toEqual({ error: 'same' });
    expect(renameFootnote(state, '9', 'x')).toEqual({ error: 'missing' });
  });
});

describe('delete', () => {
  it('removes the references and the definition line', () => {
    const state = stateOf('A[^1] b[^2].\n\n[^1]: one\n[^2]: two\n');
    expect(state.update(deleteFootnote(state, '1')!).state.sliceDoc()).toBe('A b[^2].\n\n[^2]: two\n');
    expect(state.update(deleteFootnote(state, '2')!).state.sliceDoc()).toBe('A[^1] b.\n\n[^1]: one\n');
  });

  it('is the inverse of the footnote command', () => {
    for (const before of ['A claim| here.', 'A claim| here.\n', 'A[^1] b|.\n\n[^1]: one\n', 'A[^1] b|.\n\n[^1]: one']) {
      const start = stateOf(before);
      const inserted = footnote(start);
      const label = nextFootnoteLabel(getFootnotes(start));
      expect(inserted.update(deleteFootnote(inserted, label)!).state.sliceDoc()).toBe(start.sliceDoc());
    }
  });

  it('removes a multi-line definition whole', () => {
    const state = stateOf('A[^1].\n\n[^1]: one\n    two\n\n    three\n\nAfter.\n');
    expect(state.update(deleteFootnote(state, '1')!).state.sliceDoc()).toBe('A.\n\n\nAfter.\n');
  });
});

describe('appending a definition for an orphan reference', () => {
  it('writes the note text with indented continuation lines', () => {
    const state = stateOf('A[^x].\n');
    const { change } = appendDefinition(state, 'x', 'line one\nline two\n\npara two');
    expect(state.update({ changes: change }).state.sliceDoc()).toBe('A[^x].\n\n[^x]: line one\n    line two\n\n    para two\n');
  });
});

describe('note text model', () => {
  const doc = 'x[^1]\n\n[^1]: first\n    second\n\n    third\n\nafter';

  it('shows the note without its continuation indent', () => {
    expect(noteText(stateOf(doc), '1')).toBe('first\nsecond\n\nthird');
  });

  it('maps offsets both ways', () => {
    const state = stateOf(doc);
    const model = noteModel(state, getFootnotes(state).defs[0]);
    for (let i = 0; i <= model.text.length; i++) expect(docToNote(model, noteToDoc(model, i))).toBe(i);
    expect(state.sliceDoc(noteToDoc(model, 6), noteToDoc(model, 12))).toBe('second');
  });

  it('typing changes only the typed characters', () => {
    const state = editNote(stateOf(doc), '1', 5, 5, '!');
    expect(state.sliceDoc()).toBe('x[^1]\n\n[^1]: first!\n    second\n\n    third\n\nafter');
  });

  it('a new line gets the continuation indent; a blank line stays empty', () => {
    let state = editNote(stateOf('x[^1]\n\n[^1]: one two'), '1', 3, 4, '\n');
    expect(state.sliceDoc()).toBe('x[^1]\n\n[^1]: one\n    two');
    expect(noteText(state, '1')).toBe('one\ntwo');
    state = editNote(state, '1', 3, 3, '\n');
    expect(state.sliceDoc()).toBe('x[^1]\n\n[^1]: one\n\n    two');
    expect(noteText(state, '1')).toBe('one\n\ntwo');
  });

  it('joining lines removes the break and the indent', () => {
    const state = editNote(stateOf(doc), '1', 5, 6, ' ');
    expect(state.sliceDoc()).toBe('x[^1]\n\n[^1]: first second\n\n    third\n\nafter');
  });

  it('reuses the indentation the note already has', () => {
    const state = editNote(stateOf('x[^1]\n\n[^1]: a\n  b'), '1', 3, 3, '\nc');
    expect(state.sliceDoc()).toBe('x[^1]\n\n[^1]: a\n  b\n  c');
  });

  it('Enter at the end, then text, continues the note (the panel tracks the pending line)', () => {
    let state = editNote(stateOf('x[^1]\n\n[^1]: one\n'), '1', 3, 3, '\n');
    expect(state.sliceDoc()).toBe('x[^1]\n\n[^1]: one\n\n');
    expect(noteText(state, '1', 1)).toBe('one\n');
    state = editNote(state, '1', 4, 4, 't', 1);
    expect(state.sliceDoc()).toBe('x[^1]\n\n[^1]: one\n    t\n');
    expect(noteText(state, '1')).toBe('one\nt');
  });

  it('Enter twice at the end, then text, starts a second paragraph inside the note', () => {
    let state = editNote(stateOf('x[^1]\n\n[^1]: one'), '1', 3, 3, '\n');
    state = editNote(state, '1', 4, 4, '\n', 1);
    expect(noteText(state, '1', 2)).toBe('one\n\n');
    state = editNote(state, '1', 5, 5, 'two', 2);
    expect(state.sliceDoc()).toBe('x[^1]\n\n[^1]: one\n\n    two');
    expect(noteText(state, '1')).toBe('one\n\ntwo');
  });

  it('does not swallow the next block when extending over blank lines', () => {
    const state = stateOf('x[^1]\n\n[^1]: one\n\nafter');
    expect(noteText(state, '1', 3)).toBe('one\n');
  });

  it('typing into an empty definition adds the space after the colon when it is missing', () => {
    expect(editNote(stateOf('x[^1]\n\n[^1]:'), '1', 0, 0, 'n').sliceDoc()).toBe('x[^1]\n\n[^1]: n');
    expect(editNote(stateOf('x[^1]\n\n[^1]: '), '1', 0, 0, 'n').sliceDoc()).toBe('x[^1]\n\n[^1]: n');
  });

  it('pasting several lines indents each one', () => {
    const state = editNote(stateOf('x[^1]\n\n[^1]: '), '1', 0, 0, 'a\nb\n\nc');
    expect(state.sliceDoc()).toBe('x[^1]\n\n[^1]: a\n    b\n\n    c');
    expect(noteText(state, '1')).toBe('a\nb\n\nc');
  });

  it('a lazy continuation line is shown and edited as it is', () => {
    const state = stateOf('x[^1]\n\n[^1]: one\nlazy');
    expect(noteText(state, '1')).toBe('one\nlazy');
    expect(editNote(state, '1', 8, 8, '!').sliceDoc()).toBe('x[^1]\n\n[^1]: one\nlazy!');
  });
});
