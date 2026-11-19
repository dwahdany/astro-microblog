/**
 * The byte-identity invariant, checked against every markdown file in
 * src/content at the state level (no DOM): loading a post's body into the
 * editor's state and reading it back yields the same text; typing and then
 * undoing returns the same text; and no toolbar command leaves a trace once
 * undone. Text is read back the way the editor reports it (`docText`). The
 * browser-level version of this test lives in e2e/editor.spec.ts.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { history, undo } from '@codemirror/commands';
import { EditorSelection, EditorState, type Transaction } from '@codemirror/state';
import { pureCommands } from '../commands';
import { footnoteIndex, getFootnotes } from '../footnotes';
import { buildDecorations, livePreview, livePreviewConfig, setFocused } from '../livePreview';
import { docText, lineBreaks } from '../lineBreaks';
import { fullTree, writeMarkdown } from '../markdown';

const CONTENT = join(process.cwd(), 'src/content');

function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}

/** The body the app hands the editor: everything after the frontmatter and the blank lines under it. */
const bodyOf = (raw: string) => raw.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)*/, '');

/** The same state the editor builds (Editor.svelte), minus the view-only extensions. */
function createState(doc: string): EditorState {
  return EditorState.create({
    doc,
    extensions: [
      lineBreaks(doc),
      history(),
      writeMarkdown(),
      footnoteIndex,
      livePreviewConfig.of({ resolveAsset: (src) => src, onFootnote: () => {}, onImage: () => {} }),
      livePreview(),
    ],
  });
}

function undoAll(state: EditorState): EditorState {
  let current = state;
  for (let i = 0; i < 100; i++) {
    let next: Transaction | undefined;
    if (!undo({ state: current, dispatch: (tr) => (next = tr) }) || !next) break;
    current = next.state;
  }
  return current;
}

const files = markdownFiles(CONTENT);

describe('every post under src/content', () => {
  it('finds the posts', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('reads back identical after loading, with decorations built at many caret positions', () => {
    for (const file of files) {
      const body = bodyOf(readFileSync(file, 'utf8'));
      let state = createState(body);
      expect(docText(state), relative(CONTENT, file)).toBe(body);
      // The tree must cover the whole document (decorations and commands rely on it).
      expect(fullTree(state).length).toBe(body.length);
      buildDecorations(state);
      state = state.update({ effects: setFocused.of(true) }).state;
      const step = Math.max(1, Math.floor(body.length / 60));
      for (let pos = 0; pos <= body.length; pos += step) {
        state = state.update({ selection: EditorSelection.cursor(pos) }).state;
        buildDecorations(state);
      }
      state = state.update({ selection: EditorSelection.range(0, body.length) }).state;
      buildDecorations(state);
      expect(docText(state), relative(CONTENT, file)).toBe(body);
    }
  });

  it('typing then undoing returns the identical text', () => {
    for (const file of files) {
      const body = bodyOf(readFileSync(file, 'utf8'));
      let state = createState(body);
      for (const at of [0, Math.floor(body.length / 2), body.length]) {
        state = state.update({ changes: { from: at, insert: 'x **y** [^zz]\n' }, userEvent: 'input.type' }).state;
        state = state.update({ changes: { from: 0, to: Math.min(3, state.doc.length) }, userEvent: 'delete.backward' }).state;
      }
      expect(docText(state)).not.toBe(body);
      expect(docText(undoAll(state)), relative(CONTENT, file)).toBe(body);
    }
  });

  it('every toolbar command, run mid-document and then undone, leaves the identical text', () => {
    const ids = Object.keys(pureCommands) as (keyof typeof pureCommands)[];
    for (const file of files) {
      const body = bodyOf(readFileSync(file, 'utf8'));
      const base = createState(body);
      const mid = Math.floor(body.length / 2);
      const selections = [EditorSelection.cursor(mid), EditorSelection.range(mid, Math.min(body.length, mid + 12))];
      for (const selection of selections) {
        for (const id of ids) {
          const state = base.update({ selection }).state;
          const spec = (pureCommands[id] as (s: EditorState) => ReturnType<(typeof pureCommands)['bold']>)(state);
          if (!spec) continue;
          const after = state.update(spec).state;
          expect(docText(undoAll(after)), `${relative(CONTENT, file)}: ${id}`).toBe(body);
        }
      }
    }
  });

  it('existing footnotes are never renumbered or rewritten by adding one', () => {
    for (const file of files) {
      const body = bodyOf(readFileSync(file, 'utf8'));
      const state = createState(body);
      const before = getFootnotes(state);
      if (!before.defs.length) continue;
      const after = state.update(pureCommands.footnote(state.update({ selection: EditorSelection.cursor(0) }).state)!).state;
      const idx = getFootnotes(after);
      for (const def of before.defs) {
        const same = idx.defs.find((d) => d.label === def.label);
        expect(same, `${relative(CONTENT, file)} [^${def.label}]`).toBeDefined();
        expect(after.sliceDoc(same!.from, same!.to)).toBe(state.sliceDoc(def.from, def.to));
      }
      expect(idx.refs.length).toBe(before.refs.length + 1);
    }
  });
});

// Line endings (CRLF, bare CR, mixed files) are covered in ./lineBreaks.test.ts.
