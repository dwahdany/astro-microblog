// @vitest-environment jsdom
/**
 * THE INVARIANT, through the app itself: open a post, change nothing, and what the app hands back
 * (Review → Download .md) is the file on disk, byte for byte — for EVERY markdown file under
 * src/content. Then the same after the things a visit normally involves (the properties sheet
 * with every field focused and left, typing and undoing in the editor).
 *
 * This mounts the real writing screen: the real working-tree source, the real frontmatter code,
 * the real draft store (on fake-indexeddb) and the REAL editor component (CodeMirror), in jsdom.
 * Only the preview iframe is a stand-in. It is the browser test tests/write/e2e/invariant.spec.ts
 * without a browser: no layout, no real key events — but the same text path end to end.
 *
 * A second block runs adversarial files (mixed and CR line endings, no final newline, BOM, a
 * file ending at its closing fence …) through the same screen from a source the test controls.
 */
import 'fake-indexeddb/auto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { redo, undo } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostNotFoundError, type ContentSource, type DraftStore, type LoadedPost, type PostRef } from '../../src/write/contracts';
import { installEditorDom } from './support/jsdom-editor';

const world = vi.hoisted(() => ({ files: null as Map<string, string> | null }));

vi.mock('../../src/write/preview/Preview.svelte', async () => ({ default: (await import('../../src/write/ui/__tests__/stubs/PreviewStub.svelte')).default }));

// The real data layer; only when a test supplies its own files is the source swapped for one that serves them.
vi.mock('../../src/write/data', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/write/data')>();
  const { gitBlobSha } = await import('../../src/write/data/git-sha');
  const fm = original.frontmatter;
  const real = original.contentSource;
  const loaded = async (path: string, raw: string): Promise<LoadedPost> => ({
    ref: fm.describe(path, raw, { sha: await gitBlobSha(raw) }),
    raw,
    parts: fm.split(raw),
    eol: fm.eol(raw),
  });
  const contentSource: ContentSource = {
    kind: 'local',
    label: real.label,
    canSave: false,
    list: async (opts): Promise<PostRef[]> =>
      world.files ? Promise.all([...world.files].map(async ([path, raw]) => (await loaded(path, raw)).ref)) : real.list(opts),
    async load(path, opts) {
      if (!world.files) return real.load(path, opts);
      const raw = world.files.get(path);
      if (raw === undefined) throw new PostNotFoundError(path);
      return loaded(path, raw);
    },
    resolveAssetUrl: (post, src) => real.resolveAssetUrl(post, src),
    save: (req) => real.save(req),
    onAuthChange: (listener) => real.onAuthChange(listener),
    status: () => real.status(),
    onStatus: (listener) => real.onStatus(listener),
  };
  return { ...original, contentSource };
});

import { contentSource, draftStore } from '../../src/write/data';
import Workspace from '../../src/write/ui/Workspace.svelte';
import { listMemory } from '../../src/write/ui/memory.svelte';

/* ---- the files on disk, read here with node:fs (not through the app) ----------- */

const ROOT = process.cwd();
function markdownFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownFiles(path);
    return name.endsWith('.md') ? [path] : [];
  });
}
const onDisk = new Map(
  markdownFiles(join(ROOT, 'src/content')).map((file) => [relative(ROOT, file).split(sep).join('/'), new Uint8Array(readFileSync(file))] as const),
);

/* ---- driving the app ------------------------------------------------------------- */

const settle = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));
let target: HTMLElement;
let app: Record<string, unknown> | undefined;
let downloads: Blob[] = [];

const q = <T extends Element = HTMLElement>(selector: string) => target.querySelector<T>(selector);
const view = () => EditorView.findFromDOM(q<HTMLElement>('.cm-editor')!)!;
const state = () => q('[data-write-state]')?.getAttribute('data-write-state');

async function open(id: string, sheet: 'review' | 'properties' | null) {
  app = mount(Workspace, { target, props: { id, sheet } });
  for (let i = 0; i < 200 && !q('.cm-editor'); i++) await settle(5);
  flushSync();
}

async function close() {
  if (app) await unmount(app);
  app = undefined;
  await settle(0);
}

/** What "Download .md" hands over, as bytes. */
async function downloaded(): Promise<Uint8Array> {
  downloads = [];
  q<HTMLButtonElement>('[data-action="download"]')!.click();
  expect(downloads).toHaveLength(1);
  // jsdom's Blob is read with jsdom's FileReader (Node's Response does not know it).
  const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(downloads[0]);
  });
  return new Uint8Array(buffer);
}

const bytes = (text: string) => new TextEncoder().encode(text);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

beforeAll(() => {
  installEditorDom();
  // jsdom has no object URLs and would try to navigate on a link click.
  URL.createObjectURL = (blob: Blob | MediaSource) => {
    downloads.push(blob as Blob);
    return 'blob:test';
  };
  URL.revokeObjectURL = () => {};
  HTMLAnchorElement.prototype.click = function () {};
});

beforeEach(() => {
  world.files = null;
  listMemory.posts = null;
  history.replaceState(null, '', '#/');
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(async () => {
  await close();
  target.remove();
});

describe('every post under src/content, through the writing screen', () => {
  it('the app lists exactly the posts the site publishes', async () => {
    const listed = (await contentSource.list()).map((p) => p.path).sort();
    const published = [...onDisk.keys()].filter((p) => !/\/portfolio\/_/.test(p)).sort();
    expect(listed).toEqual(published);
    expect(listed.length).toBeGreaterThan(50);
  });

  it('opened and left alone: "No changes", no draft kept, and the download is the file byte for byte', async () => {
    const posts = await contentSource.list();
    let checked = 0;
    for (const post of posts) {
      await open(post.path, 'review');
      expect(state(), post.path).toBe('clean');
      expect(q('[data-review-state]')?.getAttribute('data-review-state'), post.path).toBe('unchanged');
      const out = await downloaded();
      expect(same(out, onDisk.get(post.path)!), `${post.path}: downloaded bytes differ from the file`).toBe(true);
      await close();
      expect(await draftStore.get(post.path), `${post.path}: a draft was kept`).toBeUndefined();
      checked++;
    }
    expect(checked).toBe(posts.length);
    console.info(`[app invariant] ${checked}/${posts.length} posts: opened unedited, download byte-identical, no draft kept`);
  }, 240_000);

  it('after the properties sheet (every field focused and left) and a caret walk: still byte-identical', async () => {
    const posts = await contentSource.list();
    for (const post of posts) {
      await open(post.path, 'properties');
      for (const field of target.querySelectorAll<HTMLElement>('[data-sheet="properties"] input, [data-sheet="properties"] textarea, [data-sheet="properties"] select')) {
        field.focus();
        field.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
        field.blur();
        field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      }
      const v = view();
      const length = v.state.doc.length;
      for (const pos of [0, Math.floor(length / 3), Math.floor((2 * length) / 3), length]) v.dispatch({ selection: { anchor: pos } });
      v.dispatch({ selection: { anchor: 0, head: length } });
      flushSync();
      expect(state(), post.path).toBe('clean');
      await close();
      expect(await draftStore.get(post.path), `${post.path}: a draft was kept`).toBeUndefined();
    }
  }, 240_000);

  it('type, then undo: back to "No changes" and the download is the file again', async () => {
    const posts = await contentSource.list();
    for (const post of posts) {
      await open(post.path, 'review');
      const v = view();
      const mid = Math.floor(v.state.doc.length / 2);
      v.dispatch({ changes: { from: mid, insert: 'x **y** [^zz]\n' }, userEvent: 'input.type' });
      v.dispatch({ changes: { from: v.state.doc.length, insert: '\n\nend' }, userEvent: 'input.type' });
      flushSync();
      expect(state(), post.path).toBe('edited');
      while (undo(v)) {
        /* all the way back */
      }
      flushSync();
      expect(state(), post.path).toBe('clean');
      expect(same(await downloaded(), onDisk.get(post.path)!), `${post.path}: differs after undo`).toBe(true);
      // Leave nothing behind for the next post.
      await settle(300);
      await close();
      expect(await draftStore.get(post.path), `${post.path}: a draft was kept`).toBeUndefined();
    }
  }, 480_000);
});

describe('adversarial files, through the writing screen', () => {
  const FM_LF = '---\nslug: disksurvey\ntitle: Disk survey\ncreated: 2026-01-02T03:04:00+00:00\ntags: []\nis_draft: false\n---\n\n';
  const crlf = (text: string) => text.replace(/\n/g, '\r\n');
  const PATH = 'src/content/notes/2026/disksurvey.md';
  const body = 'First paragraph with **bold**.\n\n- one\n- two\n\nSecond[^1].\n\n[^1]: Note.\n';

  const files: [name: string, raw: string][] = [
    ['LF frontmatter + CRLF body', FM_LF + crlf(body)],
    ['CRLF file containing one lone LF', crlf(FM_LF + body).replace('- one\r\n', '- one\n')],
    ['CR-only file', (FM_LF + body).replace(/\n/g, '\r')],
    ['LF file with one stray CRLF', FM_LF + body.replace('- two\n', '- two\r\n')],
    ['a CR in the middle of a line', FM_LF + body.replace('paragraph with', 'paragraph\rwith')],
    ['pure CRLF', crlf(FM_LF + body)],
    ['no final newline', FM_LF + body.replace(/\n$/, '')],
    ['BOM', '﻿' + FM_LF + body],
    ['tabs and trailing spaces', FM_LF + 'a  \n\tb\t\n   \n' + body],
    ['no frontmatter', body],
    ['unclosed frontmatter', '---\nslug: x\n\n' + body],
    ['`---` lines in the body', FM_LF + 'a\n\n---\n\nb\n---\n' + body],
    ['blank lines after the fence', FM_LF + '\n\n\n' + body],
    ['emoji, RTL, combining and control characters', FM_LF + 'a😀b שלום é ​\u0007 x\n' + body],
  ];

  it.each(files)('%s: unedited, the download is byte-identical and no draft is kept', async (_name, raw) => {
    world.files = new Map([[PATH, raw]]);
    await open(PATH, 'review');
    expect(state()).toBe('clean');
    expect(same(await downloaded(), bytes(raw))).toBe(true);
    await close();
    expect(await draftStore.get(PATH)).toBeUndefined();
  });

  it.each(files)('%s: one X typed at the end is the ONLY change (and the file keeps its final line break); undo and redo are exact', async (_name, raw) => {
    world.files = new Map([[PATH, raw]]);
    await open(PATH, 'review');
    const v = view();
    // The X goes after everything, the file's final line break included. A file that ended with a
    // line break still does: the very break it had comes after the X. A file that had none gets none.
    const expected = raw + 'X' + (/(\r\n|\r|\n)$/.exec(raw)?.[1] ?? '');
    v.dispatch({ changes: { from: v.state.doc.length, insert: 'X' }, userEvent: 'input.type' });
    flushSync();
    expect(state()).toBe('edited');
    const typed = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await downloaded());
    expect(typed).toBe(expected);
    // What is kept on the device is that same text.
    await settle(350);
    expect((await draftStore.get(PATH))?.raw).toBe(expected);

    expect(undo(v)).toBe(true);
    flushSync();
    expect(state()).toBe('clean');
    expect(same(await downloaded(), bytes(raw))).toBe(true);
    expect(redo(v)).toBe(true);
    flushSync();
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(await downloaded())).toBe(expected);
    expect(undo(v)).toBe(true);
    await settle(350);
    await close();
    expect(await draftStore.get(PATH)).toBeUndefined();
  });

  it('Discard on a mixed-ending file gives the original back exactly', async () => {
    const raw = crlf(FM_LF + body).replace('- one\r\n', '- one\n');
    world.files = new Map([[PATH, raw]]);
    await open(PATH, 'review');
    const v = view();
    v.dispatch({ changes: { from: 0, insert: 'Edited. ' }, userEvent: 'input.type' });
    await settle(350);
    flushSync();
    q<HTMLButtonElement>('[data-action="discard"]')!.click();
    flushSync();
    q<HTMLButtonElement>('[data-action="discard-confirm"]')!.click();
    await settle(100);
    flushSync();
    expect(state()).toBe('clean');
    expect(EditorView.findFromDOM(q<HTMLElement>('.cm-editor')!)!.state.doc.lines).toBeGreaterThan(5);
    await close();
    expect(await draftStore.get(PATH)).toBeUndefined();
    await open(PATH, 'review');
    expect(state()).toBe('clean');
    expect(same(await downloaded(), bytes(raw))).toBe(true);
  });

  it('a file that ends at its closing `---`: typing a body keeps the frontmatter, and the title can still be edited', async () => {
    const raw = '---\nslug: disksurvey\ntitle: Disk survey\ncreated: 2026-01-02T03:04:00+00:00\ntags: []\nis_draft: false\n---';
    world.files = new Map([[PATH, raw]]);
    await open(PATH, 'review');
    expect(same(await downloaded(), bytes(raw))).toBe(true);
    const v = view();
    v.dispatch({ changes: { from: 0, insert: 'X' }, userEvent: 'input.type' });
    flushSync();
    expect(new TextDecoder().decode(await downloaded())).toBe(raw + '\nX');
    expect(undo(v)).toBe(true);
    flushSync();
    expect(same(await downloaded(), bytes(raw))).toBe(true);
  });

  it('a CR-only file: its properties are not editable (shown as text), so nothing can mangle them', async () => {
    const raw = (FM_LF + body).replace(/\n/g, '\r');
    world.files = new Map([[PATH, raw]]);
    await open(PATH, 'properties');
    // The YAML parser does not read bare CRs as line breaks: the block is shown as text, never as fields.
    expect(q('[data-title-input]')).toBeNull();
    expect(q('[data-sheet="properties"] [data-field]')).toBeNull();
    expect(state()).toBe('clean');
  });

  it('a CR-only file whose single key does parse: a title edit is refused with a message, nothing changes', async () => {
    // The reviewer's case: `---\rtitle: a\r---\rbody\r` used to come out as `---\rtitle: b---\rbody\r`.
    const raw = '---\rtitle: a\r---\rbody\r';
    world.files = new Map([[PATH, raw]]);
    await open(PATH, 'review');
    const title = q<HTMLInputElement>('[data-title-input]')!;
    expect(title).not.toBeNull();
    title.focus();
    title.value = 'b';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();
    expect(q('[data-banner="patch-refused"]')?.textContent).toMatch(/bare CR/);
    expect(state()).toBe('clean');
    expect(same(await downloaded(), bytes(raw))).toBe(true);
  });
});
