// @vitest-environment jsdom
/**
 * The formatting toolbar mounted for real. Pins down the order a phone gets, and that a command
 * which cannot apply (most of them while a footnote's text is being edited) is unavailable
 * without the tap taking focus from the text.
 */
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EditorCommandId, EditorHandle, EditorNoteState, EditorSelectionState } from '../../contracts';
import Toolbar from '../Toolbar.svelte';
import { DESKTOP_GROUPS, PHONE_GROUPS } from '../lib/toolbar';

let target: HTMLElement;
let app: Record<string, unknown> | undefined;
let ran: EditorCommandId[];

const selection = (over: Partial<EditorSelectionState> = {}): EditorSelectionState => ({
  bold: false,
  italic: false,
  strike: false,
  code: false,
  link: false,
  heading: 0,
  list: null,
  quote: false,
  codeBlock: false,
  literal: false,
  empty: true,
  canUndo: true,
  canRedo: false,
  anchor: 0,
  head: 0,
  ...over,
});

function show(props: { placement: 'top' | 'bottom'; note?: EditorNoteState | null; selection?: EditorSelectionState }) {
  ran = [];
  const editor = { exec: (id: EditorCommandId) => (ran.push(id), true) } as unknown as EditorHandle;
  app = mount(Toolbar, { target, props: { editor, selection: props.selection ?? selection(), note: props.note ?? null, placement: props.placement } });
  flushSync();
}
const button = (id: string) => target.querySelector<HTMLButtonElement>(`[data-command="${id}"]`)!;
const order = () => [...target.querySelectorAll<HTMLElement>('.scroll [data-command]')].map((b) => b.dataset.command);
const unavailable = (id: string) => button(id).getAttribute('aria-disabled') === 'true';

beforeEach(() => {
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(async () => {
  if (app) await unmount(app);
  app = undefined;
  target.remove();
});

describe('order', () => {
  it('phone: link, list, quote, image first; Redo only once there is something to redo', () => {
    show({ placement: 'bottom' });
    expect(order()).toEqual(PHONE_GROUPS.flat());
    expect(order().slice(0, 4)).toEqual(['link', 'bulletList', 'quote', 'image']);
    expect(button('redo')).toBeNull();
    expect(button('undo')).not.toBeNull();
    expect(button('footnote')).not.toBeNull();
  });

  it('phone: Redo appears beside Undo after an undo', () => {
    show({ placement: 'bottom', selection: selection({ canRedo: true }) });
    expect(button('redo')).not.toBeNull();
    expect(unavailable('redo')).toBe(false);
  });

  it('desktop: grouped by kind, Undo and Redo always there', () => {
    show({ placement: 'top' });
    expect(order()).toEqual(DESKTOP_GROUPS.flat());
    expect(button('undo')).not.toBeNull();
    expect(button('redo')).not.toBeNull();
    expect(unavailable('redo')).toBe(true);
  });
});

describe('while a footnote’s text is being edited', () => {
  const editing: EditorNoteState = { label: '1', editing: true, cover: false };

  it('only the commands that work in a note are available', () => {
    show({ placement: 'bottom', note: editing });
    for (const id of ['footnote', 'heading', 'bulletList', 'quote', 'image', 'rule', 'codeBlock']) expect(unavailable(id), id).toBe(true);
    for (const id of ['bold', 'italic', 'link', 'code', 'math', 'strike', 'undo']) expect(unavailable(id), id).toBe(false);
  });

  it('pressing an unavailable one runs nothing — and the press is still cancelled, so focus stays in the note', () => {
    show({ placement: 'bottom', note: editing });
    const list = button('bulletList');
    // Not the `disabled` attribute: a disabled button would swallow the event and let the tap blur the text.
    expect(list.disabled).toBe(false);
    const down = new Event('pointerdown', { bubbles: true, cancelable: true });
    list.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    list.click();
    button('footnote').click();
    expect(ran).toEqual([]);
    button('bold').click();
    expect(ran).toEqual(['bold']);
  });

  it('a note that is open but not being typed in leaves the toolbar as it was', () => {
    show({ placement: 'bottom', note: { label: '1', editing: false, cover: false } });
    expect(unavailable('bulletList')).toBe(false);
    button('footnote').click();
    expect(ran).toEqual(['footnote']);
  });
});

describe('in a code block', () => {
  it('Footnote and Divider are unavailable; the block can still be toggled off', () => {
    show({ placement: 'top', selection: selection({ literal: true, codeBlock: true }) });
    expect(unavailable('footnote')).toBe(true);
    expect(unavailable('rule')).toBe(true);
    expect(unavailable('codeBlock')).toBe(false);
    expect(button('codeBlock').getAttribute('aria-pressed')).toBe('true');
  });
});
