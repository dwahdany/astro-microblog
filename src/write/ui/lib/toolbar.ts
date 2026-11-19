/**
 * Which formatting commands the toolbar shows, in what order, and when one applies.
 *
 * Two orders, because two different things are scarce:
 *
 *  - On a wide screen everything fits in one row, so the commands are grouped by kind (text,
 *    blocks, inserts) the way writing tools usually are.
 *  - On a phone with the keyboard up only four to five full-size (44px) buttons fit between the
 *    pinned Footnote on the left and Undo / Hide keyboard on the right; the rest is a sideways
 *    swipe away. So the strip is ordered by how much a phone needs a BUTTON for the thing: link,
 *    list, quote and image first (awkward or impossible to type on a phone keyboard: brackets, a
 *    dash at line start, `>` on the symbols page), then heading, then bold and italic (two taps of
 *    `*`), then the rest.
 */
import { NOTE_COMMANDS, type EditorCommandId, type EditorNoteState, type EditorSelectionState } from '../../contracts';

/** Groups are separated by a rule. */
export const DESKTOP_GROUPS: readonly (readonly EditorCommandId[])[] = [
  ['bold', 'italic', 'heading', 'link'],
  ['quote', 'bulletList', 'orderedList', 'taskList', 'outdent', 'indent'],
  ['image', 'code', 'codeBlock', 'math', 'mathBlock', 'strike', 'rule'],
];

export const PHONE_GROUPS: readonly (readonly EditorCommandId[])[] = [
  ['link', 'bulletList', 'quote', 'image', 'heading', 'bold', 'italic'],
  ['orderedList', 'taskList', 'outdent', 'indent'],
  ['code', 'codeBlock', 'math', 'mathBlock', 'strike', 'rule'],
];

/**
 * How many buttons of the phone strip are fully visible without swiping on the narrowest phone
 * (360px) with the keyboard up; the fifth shows most of itself there and all of itself from 375px.
 */
export const PHONE_FIRST_SCREEN = 4;

/**
 * Whether a command can do anything right now. A button whose command would do nothing is
 * disabled rather than left to fail silently:
 *  - while a footnote's text is being edited, only the inline commands apply to it;
 *  - inside literal text (a code block, display math, raw HTML) there are no footnotes or dividers.
 */
export function commandAvailable(
  id: EditorCommandId,
  context: { note: EditorNoteState | null | undefined; selection: EditorSelectionState | undefined },
): boolean {
  const { note, selection } = context;
  if (id === 'undo') return selection?.canUndo !== false;
  if (id === 'redo') return selection?.canRedo !== false;
  if (note?.editing) return (NOTE_COMMANDS as readonly EditorCommandId[]).includes(id);
  if (selection?.literal && (id === 'footnote' || id === 'rule')) return false;
  return true;
}
