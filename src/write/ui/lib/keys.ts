/** Keyboard behaviour small enough to share and to test without a browser. */

/**
 * Enter in a one-line field that hands focus on (the title → the text).
 *
 * The key press must be CANCELLED before focus moves: otherwise the same press lands in the newly
 * focused editor as a line break — on a phone, "type the title, tap Done" silently added a blank
 * line to the post. While an IME is composing, Enter belongs to the IME and is left alone.
 */
export function enterMovesOn(event: Pick<KeyboardEvent, 'key' | 'isComposing' | 'preventDefault'> & { keyCode?: number }, next: () => void): boolean {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229) return false;
  event.preventDefault();
  next();
  return true;
}
