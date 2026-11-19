// @vitest-environment jsdom
/**
 * Editor.svelte itself, mounted (CodeMirror view, note panel and all) in jsdom. No layout engine,
 * so nothing here is about geometry; it is about what the component does to the TEXT and what it
 * tells its parent — the parts of the review findings that sit above the pure functions:
 *   - files with mixed / CR line endings through the real component, typing and undo included
 *   - the Footnote button and the note panel when the document ends in an unclosed code fence
 *   - the note panel reporting itself (so the toolbar can disable what cannot apply)
 *   - keyboard access to footnote chips and task checkboxes
 */
import { undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EditorHandle, EditorNoteState, EditorProps, EditorSelectionState } from '../../contracts';
import { installEditorDom } from '../../../../tests/write/support/jsdom-editor';
import Editor from '../Editor.svelte';

beforeAll(installEditorDom);

let target: HTMLElement;
let app: Record<string, unknown> | undefined;
let handle: EditorHandle;
let changes: { doc: string; userEvent: boolean }[];
let notes: (EditorNoteState | null)[];
let notices: string[];
let selection: EditorSelectionState | undefined;

const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));
const view = () => EditorView.findFromDOM(target.querySelector<HTMLElement>('.cm-editor')!)!;
const panel = () => target.querySelector<HTMLElement>('[data-note-panel]');
const area = () => target.querySelector<HTMLTextAreaElement>('[data-note-text]')!;

async function edit(doc: string, props: Partial<EditorProps> = {}) {
  changes = [];
  notes = [];
  notices = [];
  app = mount(Editor, {
    target,
    props: {
      doc,
      docKey: 'doc',
      onChange: (text: string, info: { userEvent: boolean }) => changes.push({ doc: text, userEvent: info.userEvent }),
      onReady: (h: EditorHandle) => (handle = h),
      onSelectionChange: (s: EditorSelectionState) => (selection = s),
      onNoteChange: (note: EditorNoteState | null) => notes.push(note),
      onNotice: (message: string) => notices.push(message),
      resolveAsset: () => null,
      theme: 'galley',
      ...props,
    },
  });
  flushSync();
  await settle();
}

/** Type into the note panel's text field the way a keyboard does: one character, one input event. */
function typeInNote(text: string) {
  for (const ch of text) {
    area().value += ch;
    area().dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
  }
}

function press(key: string, init: KeyboardEventInit = {}) {
  view().contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  flushSync();
}

beforeEach(() => {
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(async () => {
  if (app) await unmount(app);
  app = undefined;
  target.remove();
});

describe('line endings through the real component', () => {
  const cases: [string, string][] = [
    ['LF frontmatter + CRLF body (the body alone is CRLF)', 'one\r\ntwo\r\n\r\nthree\r\n'],
    ['CRLF file containing one lone LF', 'one\r\ntwo\nthree\r\nfour\r\n'],
    ['CR-only file', 'one\rtwo\r\rthree\r'],
    ['LF file with one stray CRLF', 'one\ntwo\r\nthree\nfour\n'],
    ['a CR in the middle of an LF file', 'one\ntwo\rthree\nfour\n'],
    ['pure LF', 'one\ntwo\n'],
  ];

  it.each(cases)('%s: untouched, the text reads back identical and nothing is reported', async (_name, doc) => {
    await edit(doc);
    expect(handle.getDoc()).toBe(doc);
    expect(changes).toEqual([]);
  });

  it.each(cases)('%s: one X typed at the end is the only change; undo restores the file', async (_name, doc) => {
    await edit(doc);
    const v = view();
    v.dispatch({ changes: { from: v.state.doc.length, insert: 'X' }, userEvent: 'input.type' });
    expect(changes.at(-1)).toEqual({ doc: doc + 'X', userEvent: true });
    expect(handle.getDoc()).toBe(doc + 'X');
    expect(undo(v)).toBe(true);
    expect(handle.getDoc()).toBe(doc);
    expect(changes.at(-1)!.doc).toBe(doc);
  });

  it('every kind of break is a line of its own on screen (a pasted LF in a CRLF file is not one long line)', async () => {
    await edit('first\r\nlast\r\n');
    const v = view();
    v.dispatch({ changes: { from: 6, insert: v.state.toText('pasted one\npasted two\n') }, userEvent: 'input.paste' });
    expect(handle.getDoc()).toBe('first\r\npasted one\r\npasted two\r\nlast\r\n');
    const lines = [...target.querySelectorAll('.cm-line')].map((l) => l.textContent);
    expect(lines.slice(0, 4)).toEqual(['first', 'pasted one', 'pasted two', 'last']);
  });

  it('setDoc with the same text (Discard) hands back exactly that text', async () => {
    const doc = 'one\r\ntwo\nthree\r';
    await edit(doc);
    handle.setDoc(doc);
    expect(changes.at(-1)).toEqual({ doc, userEvent: false });
    expect(handle.getDoc()).toBe(doc);
    handle.setDoc('other\rtext\r\n', { keepHistory: true });
    expect(handle.getDoc()).toBe('other\rtext\r\n');
    expect(undo(view())).toBe(true);
    expect(handle.getDoc()).toBe(doc);
  });

  it('`lineSeparator` only decides for a text without any break', async () => {
    await edit('no breaks yet', { lineSeparator: '\r\n' });
    const v = view();
    v.dispatch({ changes: { from: v.state.doc.length, insert: '\nnext' }, userEvent: 'input.type' });
    expect(handle.getDoc()).toBe('no breaks yet\r\nnext');
  });
});

describe('Footnote button with an unclosed code fence at the end of the document', () => {
  it('typing "hello" in the note leaves ONE definition, read as a note', async () => {
    await edit('Some text here.\n\n```js\nlet a = 1;\n');
    handle.setSelection({ anchor: 'Some text here.'.length });
    expect(handle.exec('footnote')).toBe(true);
    flushSync();
    expect(panel()).not.toBeNull();
    typeInNote('hello');
    expect(handle.getDoc()).toBe('Some text here.[^1]\n\n```js\nlet a = 1;\n```\n\n[^1]: hello\n');
    expect(handle.getDoc().match(/\[\^1\]:/g)).toHaveLength(1);
    expect(area().value).toBe('hello');
  });

  it('a reference without a note, typed into: one definition, however many keystrokes', async () => {
    await edit('See[^7].\n\n```\nopen\n');
    target.querySelector<HTMLElement>('[data-footnote-ref="7"]')!.click();
    flushSync();
    typeInNote('hello');
    expect(handle.getDoc()).toBe('See[^7].\n\n```\nopen\n```\n\n[^7]: hello\n');
  });

  it('where it cannot become a note, nothing is appended and the panel says so', async () => {
    await edit('See[^7].\n\n<!-- never closed\n');
    target.querySelector<HTMLElement>('[data-footnote-ref="7"]')!.click();
    flushSync();
    typeInNote('hello');
    expect(handle.getDoc()).toBe('See[^7].\n\n<!-- never closed\n');
    expect(target.querySelector('[data-note-status]')!.textContent).toMatch(/cannot be added/);
  });
});

describe('Footnote button where a footnote cannot go', () => {
  it('inside a code block: nothing changes, and the parent is told why', async () => {
    const doc = '```js\nlet a = 1;\n```\n\nText\n';
    await edit(doc);
    handle.setSelection({ anchor: 10 });
    expect(selection?.literal).toBe(true);
    expect(handle.exec('footnote')).toBe(false);
    expect(handle.getDoc()).toBe(doc);
    expect(changes).toEqual([]);
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/cannot go inside a code block/);
    expect(panel()).toBeNull();
  });

  it('at the edge of link text: the reference lands after the link', async () => {
    await edit('See [the docs](https://example.com/docs)');
    handle.setSelection({ anchor: 'See [the docs'.length });
    expect(handle.exec('footnote')).toBe(true);
    expect(handle.getDoc()).toBe('See [the docs](https://example.com/docs)[^1]\n\n[^1]: ');
  });
});

describe('the note panel tells the shell about itself', () => {
  it('open → editing while its text field has the keyboard → closed', async () => {
    await edit('Text[^1]\n\n[^1]: note\n');
    expect(notes.at(-1) ?? null).toBeNull();
    target.querySelector<HTMLElement>('[data-footnote-ref="1"]')!.click();
    flushSync();
    area().focus();
    area().dispatchEvent(new FocusEvent('focus'));
    flushSync();
    expect(notes.at(-1)).toMatchObject({ label: '1', editing: true });
    area().dispatchEvent(new FocusEvent('blur'));
    flushSync();
    expect(notes.at(-1)).toMatchObject({ label: '1', editing: false });
    target.querySelector<HTMLElement>('[data-note-action="done"]')!.click();
    flushSync();
    expect(notes.at(-1)).toBeNull();
  });

  it('commands that mean nothing in a note do nothing; inline ones act on the note text', async () => {
    await edit('Text[^1]\n\n[^1]: note\n');
    target.querySelector<HTMLElement>('[data-footnote-ref="1"]')!.click();
    flushSync();
    area().focus();
    const before = handle.getDoc();
    expect(handle.exec('bulletList')).toBe(false);
    expect(handle.exec('footnote')).toBe(false);
    expect(handle.getDoc()).toBe(before);
    area().setSelectionRange(0, 4);
    expect(handle.exec('bold')).toBe(true);
    expect(handle.getDoc()).toBe('Text[^1]\n\n[^1]: **note**\n');
  });
});

describe('keyboard access to what was tap-only', () => {
  it('⌘/Ctrl+Enter next to a footnote chip opens its note', async () => {
    await edit('Text[^1] more\n\n[^1]: note\n');
    handle.setSelection({ anchor: 'Text[^1]'.length });
    press('Enter', { ctrlKey: true });
    press('Enter', { metaKey: true });
    expect(panel()?.getAttribute('data-note-panel')).toBe('1');
    expect(handle.getDoc()).toBe('Text[^1] more\n\n[^1]: note\n');
  });

  it('⌘/Ctrl+Enter on a task line ticks and unticks it, touching one character', async () => {
    await edit('- [ ] buy milk\n- [x] done\n');
    handle.setSelection({ anchor: 8 });
    const mod = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
    press('Enter', mod);
    expect(handle.getDoc()).toBe('- [x] buy milk\n- [x] done\n');
    press('Enter', mod);
    expect(handle.getDoc()).toBe('- [ ] buy milk\n- [x] done\n');
  });

  it('on an ordinary line it is left to the editor’s usual binding (a new line below)', async () => {
    await edit('Just text\n');
    handle.setSelection({ anchor: 4 });
    const mod = /Mac/.test(navigator.platform) ? { metaKey: true } : { ctrlKey: true };
    press('Enter', mod);
    expect(handle.getDoc()).toBe('Just text\n\n');
    expect(panel()).toBeNull();
  });
});
