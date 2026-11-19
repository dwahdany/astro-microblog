import { EditorSelection, EditorState, type Extension, type TransactionSpec } from '@codemirror/state';
import { history } from '@codemirror/commands';
import { footnoteIndex } from '../footnotes';
import { writeMarkdown } from '../markdown';

/**
 * Build a state from text with selection markers:
 *   `|`      a caret
 *   `⟦…⟧`    a selection (anchor at ⟦, head at ⟧)
 */
export function stateOf(marked: string, extra: Extension = []): EditorState {
  let doc = marked;
  let selection = EditorSelection.single(0);
  const open = doc.indexOf('⟦');
  if (open >= 0) {
    doc = doc.replace('⟦', '');
    const close = doc.indexOf('⟧');
    doc = doc.replace('⟧', '');
    selection = EditorSelection.single(open, close);
  } else {
    const caret = doc.indexOf('|');
    if (caret >= 0) {
      doc = doc.replace('|', '');
      selection = EditorSelection.single(caret);
    }
  }
  return EditorState.create({ doc, selection, extensions: [writeMarkdown(), footnoteIndex, history(), extra] });
}

/** The inverse of `stateOf`. */
export function show(state: EditorState): string {
  const { from, to, empty } = state.selection.main;
  const text = state.sliceDoc();
  if (empty) return text.slice(0, from) + '|' + text.slice(from);
  return text.slice(0, from) + '⟦' + text.slice(from, to) + '⟧' + text.slice(to);
}

/** Run a command on marked text and return the marked result (or null when it does not apply). */
export function run(marked: string, command: (state: EditorState) => TransactionSpec | null): string | null {
  const state = stateOf(marked);
  const spec = command(state);
  return spec ? show(state.update(spec).state) : null;
}

/** Run a command several times in a row. */
export function runTimes(marked: string, command: (state: EditorState) => TransactionSpec | null, times: number): string {
  let state = stateOf(marked);
  for (let i = 0; i < times; i++) {
    const spec = command(state);
    if (!spec) throw new Error(`command did not apply on pass ${i + 1}: ${show(state)}`);
    state = state.update(spec).state;
  }
  return show(state);
}
