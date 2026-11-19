// @vitest-environment jsdom
/**
 * The writing screen (Workspace.svelte) mounted for real — with the real draft store (on
 * fake-indexeddb), the real frontmatter code and the real Review / Properties / Toolbar — against
 * a content source the test controls. The editor and the preview are stand-ins (./stubs).
 *
 * These pin down the review findings that live in the screen's own state handling:
 *   - Enter / Done in the title must not reach the post body
 *   - a draft in conflict with the source stays flagged through edits and reopens
 *   - the same post in two tabs: no silent overwrite
 *   - the save path: what is sent, what becomes of the draft and the base, what blocks it
 */
import 'fake-indexeddb/auto';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PostNotFoundError,
  ReadOnlyError,
  SaveConflictError,
  SaveError,
  type ContentSource,
  type DraftRecord,
  type DraftStore,
  type LoadedPost,
  type PostRef,
  type SaveRequest,
  type SaveResult,
} from '../../contracts';

/* ---- the controllable world ------------------------------------------------ */

const world = vi.hoisted(() => ({
  files: new Map<string, string>(),
  canSave: false,
  saves: [] as unknown[],
  save: null as null | ((req: unknown) => Promise<unknown>),
  authListeners: new Set<() => void>(),
  dbName: 'workspace-test-0',
  store: null as unknown,
  secondStore: null as unknown,
}));

vi.mock('../../editor/Editor.svelte', async () => ({ default: (await import('./stubs/EditorStub.svelte')).default }));
vi.mock('../../preview/Preview.svelte', async () => ({ default: (await import('./stubs/PreviewStub.svelte')).default }));

vi.mock('../../data', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../data')>();
  const { createDraftStore } = await import('../../data/draft-store');
  const { gitBlobSha } = await import('../../data/git-sha');
  const fm = original.frontmatter;

  const loaded = async (path: string, raw: string): Promise<LoadedPost> => ({
    ref: fm.describe(path, raw, { sha: await gitBlobSha(raw) }),
    raw,
    parts: fm.split(raw),
    eol: fm.eol(raw),
  });
  const source: ContentSource = {
    kind: 'github',
    label: 'the test repo',
    get canSave() {
      return world.canSave;
    },
    async list(): Promise<PostRef[]> {
      return Promise.all([...world.files].map(async ([path, raw]) => (await loaded(path, raw)).ref));
    },
    async load(path) {
      const raw = world.files.get(path);
      if (raw === undefined) throw new PostNotFoundError(path);
      return loaded(path, raw);
    },
    resolveAssetUrl: () => null,
    async save(req: SaveRequest): Promise<SaveResult> {
      world.saves.push(req);
      if (!world.canSave) throw new ReadOnlyError();
      return (await world.save!(req)) as SaveResult;
    },
    onAuthChange(listener) {
      world.authListeners.add(listener);
      return () => void world.authListeners.delete(listener);
    },
    status: () => ({ state: 'fresh' }),
    onStatus: () => () => {},
  };
  // One store per test database; a getter so each test gets a fresh one.
  const draftStore = new Proxy({} as DraftStore, {
    get(_target, key: keyof DraftStore) {
      world.store ??= createDraftStore(world.dbName);
      return (world.store as DraftStore)[key];
    },
  });
  return { ...original, contentSource: source, draftStore };
});

import Workspace from '../Workspace.svelte';
import WorkspaceHost from './stubs/WorkspaceHost.svelte';
import { createDraftStore } from '../../data/draft-store';
import { gitBlobSha } from '../../data/git-sha';
import { handoff, listMemory } from '../memory.svelte';
import { frontmatter } from '../../data/frontmatter';

/* ---- helpers ------------------------------------------------------------------ */

const PATH = 'src/content/notes/2026/a-note.md';
const FM = '---\nslug: a-note\ntitle: A note\ncreated: 2026-11-18T10:00:00+00:00\ntags: []\nis_draft: false\n---\n\n';
const BODY = 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\n';
const ORIGINAL = FM + BODY;

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
/** Longer than the autosave delay. */
const autosaved = () => settle(400);

let n = 0;
let target: HTMLElement;
let mounted: Record<string, unknown>[] = [];

const store = () => world.store as DraftStore & { close(): void };
const q = <T extends Element = HTMLElement>(selector: string) => target.querySelector<T>(selector);
const banner = () => q('[data-banner]')?.getAttribute('data-banner') ?? null;
const state = () => q('[data-write-state]')?.getAttribute('data-write-state');
const editorText = () => q<HTMLTextAreaElement>('[data-stub-editor]')!.value;

async function open(id = PATH, sheet: 'review' | 'properties' | null = null) {
  const app = mount(Workspace, { target, props: { id, sheet } });
  mounted.push(app);
  for (let i = 0; i < 50 && !q('[data-stub-editor]'); i++) await settle(10);
  flushSync();
  return app;
}

async function close() {
  for (const app of mounted.splice(0)) await unmount(app);
  await settle();
}

function type(text: string) {
  const area = q<HTMLTextAreaElement>('[data-stub-editor]')!;
  area.value = text;
  area.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

const draft = (over: Partial<DraftRecord>): DraftRecord => ({
  id: PATH,
  path: PATH,
  collection: 'notes',
  isNew: false,
  raw: ORIGINAL,
  baseRaw: ORIGINAL,
  updatedAt: Date.now() - 60_000,
  ...over,
});

beforeEach(() => {
  world.files = new Map([[PATH, ORIGINAL]]);
  world.canSave = false;
  world.saves = [];
  world.save = null;
  world.dbName = `workspace-test-${++n}`;
  world.store = null;
  world.secondStore = null;
  listMemory.posts = null;
  handoff.clear();
  history.replaceState(null, '', '#/');
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(async () => {
  await close();
  (world.store as { close?: () => void } | null)?.close?.();
  (world.secondStore as { close?: () => void } | null)?.close?.();
  target.remove();
});

/* ---- the tests ---------------------------------------------------------------- */

describe('opening a post', () => {
  it('shows it unchanged and keeps no draft', async () => {
    await open();
    expect(state()).toBe('clean');
    expect(editorText()).toBe(BODY);
    expect(banner()).toBeNull();
    await autosaved();
    expect(await store().get(PATH)).toBeUndefined();
  });
});

describe('Enter / Done in the title field', () => {
  it('is cancelled, moves focus to the text, and the post stays untouched', async () => {
    await open();
    const title = q<HTMLInputElement>('[data-title-input]')!;
    title.focus();
    const press = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    title.dispatchEvent(press);
    flushSync();
    // Cancelled: the browser will not deliver this key press to whatever has focus next.
    expect(press.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(q('[data-stub-editor]'));
    expect(state()).toBe('clean');
    await autosaved();
    expect(await store().get(PATH)).toBeUndefined();
  });

  it('other keys in the title are not cancelled', async () => {
    await open();
    const title = q<HTMLInputElement>('[data-title-input]')!;
    const press = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true });
    title.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(false);
  });
});

describe('a draft in conflict with the source', () => {
  const mine = ORIGINAL.replace('line 2', 'line 2 (mine)');
  const theirs = ORIGINAL.replace('line 2', 'line 2 (theirs)').replace('line 8', 'line 8 (theirs)');

  async function seedConflict() {
    const baseSha = await gitBlobSha(ORIGINAL);
    world.store = createDraftStore(world.dbName);
    await store().put(draft({ raw: mine, baseSha }));
    world.files.set(PATH, theirs);
    return { baseSha, newSha: await gitBlobSha(theirs) };
  }

  it('is announced, with the kept text shown', async () => {
    await seedConflict();
    await open();
    expect(banner()).toBe('upstream-conflict');
    expect(editorText()).toContain('line 2 (mine)');
    expect(editorText()).not.toContain('(theirs)');
  });

  it('stays flagged after typing, after the autosave, and after reopening', async () => {
    const { baseSha, newSha } = await seedConflict();
    await open();
    type(editorText().replace('(mine)', '(mine!)'));
    await autosaved();
    expect(banner()).toBe('upstream-conflict');

    // What is stored still names the OLD original — never the new upstream — plus the marker.
    const stored = (await store().get(PATH))!;
    expect(stored.raw).toContain('(mine!)');
    expect(stored.baseRaw).toBe(ORIGINAL);
    expect(stored.baseSha).toBe(baseSha);
    expect(stored.baseSha).not.toBe(newSha);
    expect(stored.conflict).toEqual({ sha: newSha });

    await close();
    await open();
    expect(banner()).toBe('upstream-conflict');
    expect(editorText()).toContain('(mine!)');

    // …and once more after another keystroke.
    type(editorText().replace('(mine!)', '(mine!!)'));
    await autosaved();
    await close();
    await open();
    expect(banner()).toBe('upstream-conflict');
  });

  it('blocks Publish until resolved; "Keep mine" resolves it onto the new original', async () => {
    const { newSha } = await seedConflict();
    world.canSave = true;
    world.save = async () => {
      throw new Error('must not be called');
    };
    await open(PATH, 'review');
    expect(q('[data-review-conflict]')).not.toBeNull();
    expect(q<HTMLButtonElement>('[data-action="publish"]')!.disabled).toBe(true);
    // Said once, above the diff, with the way out — not again as a blocker or a commit message to fill in.
    expect(q('[data-review-conflict]')!.textContent).toMatch(/would undo/);
    expect(q('[data-publish-blockers]')).toBeNull();
    expect(q('[data-publish-error]')).toBeNull();
    expect(q('[data-commit-message]')).toBeNull();
    expect(q('[data-sheet="review"]')!.querySelectorAll('[role="alert"]')).toHaveLength(1);

    q<HTMLButtonElement>('[data-review-conflict] [data-action="keep-mine"]')!.click();
    await autosaved();
    flushSync();
    expect(banner()).toBeNull();
    expect(q('[data-review-conflict]')).toBeNull();
    expect(q<HTMLButtonElement>('[data-action="publish"]')!.disabled).toBe(false);
    const stored = (await store().get(PATH))!;
    expect(stored.baseRaw).toBe(theirs);
    expect(stored.baseSha).toBe(newSha);
    expect(stored.conflict).toBeUndefined();
    expect(world.saves).toEqual([]);
  });

  it('changes elsewhere in the file are carried over, with no conflict', async () => {
    const baseSha = await gitBlobSha(ORIGINAL);
    world.store = createDraftStore(world.dbName);
    await store().put(draft({ raw: mine, baseSha }));
    world.files.set(PATH, ORIGINAL.replace('line 8', 'line 8 (theirs)'));
    await open();
    expect(banner()).toBe('upstream-merged');
    expect(editorText()).toContain('line 2 (mine)');
    expect(editorText()).toContain('line 8 (theirs)');
    await autosaved();
    expect((await store().get(PATH))!.conflict).toBeUndefined();
  });
});

describe('the same post open in two tabs', () => {
  /** "The other tab": a second store on the same database, as another tab's would be. */
  const otherTab = () => (world.secondStore ??= createDraftStore(world.dbName)) as DraftStore;

  it('a tab with nothing unstored follows what the other tab kept', async () => {
    await open();
    await otherTab().put(draft({ raw: ORIGINAL.replace('line 5', 'line 5 from the other tab') }), { expectedRev: 0 });
    for (let i = 0; i < 40 && banner() !== 'followed-tab'; i++) await settle(20);
    flushSync();
    expect(banner()).toBe('followed-tab');
    expect(editorText()).toContain('line 5 from the other tab');
  });

  it('a tab with unstored text of its own does not overwrite the other tab’s, and asks', async () => {
    await open();
    type(BODY.replace('line 1', 'AAA from this tab'));
    // Before this tab's autosave fires, the other tab stores its own version.
    await otherTab().put(draft({ raw: ORIGINAL.replace('line 9', 'BBB from the other tab') }), { expectedRev: 0 });
    await autosaved();
    flushSync();
    expect(banner()).toBe('other-tab');
    // The store still holds the other tab's text, and this tab still shows its own.
    expect((await store().get(PATH))!.raw).toContain('BBB from the other tab');
    expect((await store().get(PATH))!.raw).not.toContain('AAA');
    expect(editorText()).toContain('AAA from this tab');

    // More typing does not sneak a write through either.
    type(editorText() + 'more\n');
    await autosaved();
    expect((await store().get(PATH))!.raw).not.toContain('AAA');
  });

  it('"Keep this one" stores this tab’s text; "Show that version" loads the other', async () => {
    await open();
    type(BODY.replace('line 1', 'AAA from this tab'));
    await otherTab().put(draft({ raw: ORIGINAL.replace('line 9', 'BBB from the other tab') }), { expectedRev: 0 });
    await autosaved();
    flushSync();
    q<HTMLButtonElement>('[data-action="keep-tab"]')!.click();
    await autosaved();
    flushSync();
    expect(banner()).not.toBe('other-tab');
    expect((await store().get(PATH))!.raw).toContain('AAA from this tab');

    // Again, the other way round.
    type(editorText().replace('AAA', 'AAA2'));
    await otherTab().put(draft({ raw: ORIGINAL.replace('line 9', 'CCC from the other tab') }));
    await autosaved();
    flushSync();
    expect(banner()).toBe('other-tab');
    q<HTMLButtonElement>('[data-action="follow-tab"]')!.click();
    for (let i = 0; i < 40 && !editorText().includes('CCC'); i++) await settle(20);
    expect(editorText()).toContain('CCC from the other tab');
    expect((await store().get(PATH))!.raw).toContain('CCC from the other tab');
  });

  it('a tab whose text went back to the original does not delete the other tab’s draft', async () => {
    await open();
    type(BODY + 'x');
    // The other tab keeps real work before this tab's autosave…
    await otherTab().put(draft({ raw: ORIGINAL.replace('line 9', 'other tab work') }), { expectedRev: 0 });
    // …and this tab removes its character again: its text equals the original.
    type(BODY);
    await autosaved();
    expect((await store().get(PATH))?.raw).toContain('other tab work');
  });

  it('without the broadcast (the store’s write counter alone) the stale write is still refused', async () => {
    await open();
    type(BODY.replace('line 1', 'AAA from this tab'));
    await autosaved();
    const kept = (await store().get(PATH))!;
    expect(kept.raw).toContain('AAA');
    // A write this tab never hears about: straight into the database with a higher counter.
    const silent = createDraftStore(world.dbName);
    const channel = vi.spyOn(BroadcastChannel.prototype, 'postMessage').mockImplementation(() => {});
    await silent.put(draft({ raw: ORIGINAL.replace('line 9', 'silent other tab') }), { expectedRev: kept.rev });
    channel.mockRestore();
    silent.close();
    type(editorText() + 'more\n');
    await autosaved();
    flushSync();
    expect(banner()).toBe('other-tab');
    expect((await store().get(PATH))!.raw).toContain('silent other tab');
  });
});

describe('the save path (a source that can save)', () => {
  beforeEach(() => {
    world.canSave = true;
    world.save = async (req) => {
      const r = req as SaveRequest;
      world.files.set(r.path, r.raw);
      return { path: r.path, sha: (await gitBlobSha(r.raw))!, commitUrl: 'https://example.test/commit/1' };
    };
  });

  it('Publish appears only when the source can save, and follows a sign-in during the session', async () => {
    world.canSave = false;
    await open(PATH, 'review');
    expect(q('[data-action="publish"]')).toBeNull();
    world.canSave = true;
    world.authListeners.forEach((listener) => listener());
    flushSync();
    expect(q('[data-action="publish"]')).not.toBeNull();
  });

  it('sends the text with the sha it was based on; afterwards that text is the original', async () => {
    const originalSha = await gitBlobSha(ORIGINAL);
    await open(PATH, 'review');
    const edited = BODY.replace('line 3', 'line 3, edited');
    type(edited);
    await autosaved();
    expect(await store().get(PATH)).toBeDefined();

    q<HTMLButtonElement>('[data-action="publish"]')!.click();
    await settle(100);
    flushSync();
    expect(world.saves).toEqual([{ path: PATH, raw: FM + edited, baseSha: originalSha, message: 'Update Note “2026/a-note”' }]);
    // The draft is gone, the post reads "No changes", the sheet says how it went.
    expect(await store().get(PATH)).toBeUndefined();
    expect(state()).toBe('clean');
    expect(q('[data-review-state]')!.getAttribute('data-review-state')).toBe('unchanged');
    expect(target.textContent).toContain('Published');

    // A second edit is based on what was just saved, not on the old sha.
    const again = edited.replace('line 4', 'line 4, edited too');
    type(again);
    await autosaved();
    q<HTMLButtonElement>('[data-action="publish"]')!.click();
    await settle(100);
    expect(world.saves[1]).toEqual({ path: PATH, raw: FM + again, baseSha: await gitBlobSha(FM + edited), message: 'Update Note “2026/a-note”' });
    await autosaved();
    expect(await store().get(PATH)).toBeUndefined();
  });

  it('a save conflict loses nothing: the post is re-read and the usual handling takes over', async () => {
    await open(PATH, 'review');
    type(BODY.replace('line 2', 'line 2 (mine)'));
    await autosaved();
    const theirs = ORIGINAL.replace('line 2', 'line 2 (theirs)');
    world.save = async (req) => {
      world.files.set(PATH, theirs); // someone else got there first
      throw new SaveConflictError((req as SaveRequest).path, 'changed');
    };
    q<HTMLButtonElement>('[data-action="publish"]')!.click();
    for (let i = 0; i < 40 && banner() !== 'upstream-conflict'; i++) await settle(20);
    flushSync();
    expect(banner()).toBe('upstream-conflict');
    expect(editorText()).toContain('line 2 (mine)');
    expect((await store().get(PATH))!.raw).toContain('line 2 (mine)');
    expect(q<HTMLButtonElement>('[data-action="publish"]')!.disabled).toBe(true);
  });

  it('a new post: blocked while its path is taken, published to its real address otherwise', async () => {
    const taken = frontmatter.scaffold('notes', { values: { slug: 'a-note', title: 'Another' }, body: 'Hello\n', now: new Date('2026-11-18T10:00:00Z') });
    handoff.set(taken.ref.id, taken);
    await open(taken.ref.id, 'review');
    for (let i = 0; i < 40 && !q('[data-publish-blockers]'); i++) await settle(20);
    expect(q('[data-publish-blockers]')!.textContent).toContain(`There is already a post at ${PATH}`);
    expect(q<HTMLButtonElement>('[data-action="publish"]')!.disabled).toBe(true);
    await close();

    const fresh = frontmatter.scaffold('notes', { values: { slug: 'brand-new', title: 'Brand new' }, body: 'Hello\n', now: new Date('2026-11-18T10:00:00Z') });
    handoff.set(fresh.ref.id, fresh);
    await open(fresh.ref.id, 'review');
    for (let i = 0; i < 40 && q<HTMLButtonElement>('[data-action="publish"]')?.disabled !== false; i++) await settle(20);
    q<HTMLButtonElement>('[data-action="publish"]')!.click();
    await settle(150);
    const request = world.saves[0] as SaveRequest;
    expect(request.path).toBe('src/content/notes/2026/brand-new.md');
    expect(request.baseSha).toBeUndefined();
    expect(request.raw.endsWith('Hello\n')).toBe(true);
    // The draft is gone and the route is the post's real address.
    expect(await store().get(fresh.ref.id)).toBeUndefined();
    expect(decodeURIComponent(location.hash)).toBe('#/post/src/content/notes/2026/brand-new.md');
    await close();
    expect(await store().get(fresh.ref.id)).toBeUndefined();
  });

  it('frontmatter problems block it', async () => {
    world.files.set(PATH, ORIGINAL.replace('slug: a-note', 'slug: Not A Slug'));
    await open(PATH, 'review');
    type(BODY + 'more\n');
    flushSync();
    expect(q<HTMLButtonElement>('[data-action="publish"]')!.disabled).toBe(true);
    expect(q('[data-publish-blockers]')!.textContent).toMatch(/slug/i);
    expect(world.saves).toEqual([]);
  });
});

describe('delete, move, and a post that is gone (a source that can save)', () => {
  beforeEach(() => {
    world.canSave = true;
    world.save = async (req) => {
      const r = req as SaveRequest;
      if (r.delete) world.files.delete(r.path);
      else {
        if (r.previousPath) world.files.delete(r.previousPath);
        world.files.set(r.path, r.raw);
      }
      return { path: r.path, sha: r.delete ? '' : (await gitBlobSha(r.raw))!, deleted: r.delete, commitUrl: 'https://example.test/commit/2' };
    };
  });

  it('deleting asks first; only the confirmation sends the delete, named by the blob the post was opened at', async () => {
    await open(PATH, 'review');
    expect(q('[data-action="delete-post-confirm"]')).toBeNull();
    q<HTMLButtonElement>('[data-action="delete-post"]')!.click();
    flushSync();
    expect(q('[data-delete-post]')!.textContent).toContain(`Delete ${PATH} from the repository?`);
    await settle(50);
    expect(world.saves).toEqual([]);

    q<HTMLButtonElement>('[data-action="delete-post-confirm"]')!.click();
    await settle(150);
    expect(world.saves).toEqual([{ path: PATH, raw: '', delete: true, baseSha: await gitBlobSha(ORIGINAL), message: 'Delete Note “2026/a-note”' }]);
    // Back to the list, with nothing of the post left on this device.
    expect(location.hash).toBe('#/');
    expect(await store().get(PATH)).toBeUndefined();
  });

  it('a post that cannot be deleted from here has no such button (a new post; signed out)', async () => {
    world.canSave = false;
    await open(PATH, 'review');
    expect(q('[data-action="delete-post"]')).toBeNull();
    await close();
    world.canSave = true;
    const fresh = frontmatter.scaffold('notes', { values: { slug: 'fresh', title: 'Fresh' }, body: 'Hello\n', now: new Date('2026-11-18T10:00:00Z') });
    handoff.set(fresh.ref.id, fresh);
    await open(fresh.ref.id, 'review');
    expect(q('[data-action="delete-post"]')).toBeNull();
  });

  it('a changed slug offers to move the file; ticked, the save names both addresses', async () => {
    const edited = ORIGINAL.replace('slug: a-note', 'slug: renamed-note');
    world.store = createDraftStore(world.dbName);
    await store().put(draft({ raw: edited }));
    await open(PATH, 'review');
    const tick = q<HTMLInputElement>('[data-move-file]')!;
    expect(tick.checked).toBe(false);
    tick.click();
    flushSync();
    expect(q('[data-review-path]')!.textContent).toContain('→ src/content/notes/2026/renamed-note.md');
    q<HTMLButtonElement>('[data-action="publish"]')!.click();
    await settle(150);
    expect(world.saves).toEqual([
      {
        path: 'src/content/notes/2026/renamed-note.md',
        previousPath: PATH,
        raw: edited,
        baseSha: await gitBlobSha(ORIGINAL),
        message: 'Update Note “2026/renamed-note”',
      },
    ]);
    expect(decodeURIComponent(location.hash)).toBe('#/post/src/content/notes/2026/renamed-note.md');
    expect(await store().get(PATH)).toBeUndefined();
  });

  it('no move is offered when another post already has that address', async () => {
    world.files.set('src/content/notes/2026/taken.md', ORIGINAL.replace('slug: a-note', 'slug: taken'));
    world.store = createDraftStore(world.dbName);
    await store().put(draft({ raw: ORIGINAL.replace('slug: a-note', 'slug: taken') }));
    await open(PATH, 'review');
    for (let i = 0; i < 20; i++) await settle(10);
    flushSync();
    expect(q('[data-move-file]')).toBeNull();
  });

  it('a post that is gone from the source is published as a new file (no base to name)', async () => {
    const mine = ORIGINAL.replace('line 2', 'line 2 (mine)');
    world.store = createDraftStore(world.dbName);
    await store().put(draft({ raw: mine, baseSha: await gitBlobSha(ORIGINAL) }));
    world.files.delete(PATH);
    await open(PATH, 'review');
    expect(q('[data-action="delete-post"]')).toBeNull();
    q<HTMLButtonElement>('[data-action="publish"]')!.click();
    await settle(150);
    expect(world.saves).toEqual([{ path: PATH, raw: mine, baseSha: undefined, message: 'Create Note “2026/a-note”' }]);
    expect(world.files.get(PATH)).toBe(mine);
  });

  it('a failed save says why in the sheet and keeps the draft', async () => {
    await open(PATH, 'review');
    type(BODY + 'more\n');
    await autosaved();
    world.save = async () => {
      throw new SaveError('GitHub cannot be reached.', 'offline');
    };
    q<HTMLButtonElement>('[data-action="publish"]')!.click();
    await settle(100);
    flushSync();
    expect(q('[data-publish-error]')!.getAttribute('data-publish-error')).toBe('offline');
    expect(q('[data-publish-error]')!.textContent).toMatch(/Nothing was published/);
    expect((await store().get(PATH))!.raw).toBe(FM + BODY + 'more\n');
    expect(q<HTMLButtonElement>('[data-action="publish"]')!.disabled).toBe(false);
  });
});

describe('a publish that fails after the Review sheet was closed', () => {
  beforeEach(() => {
    world.canSave = true;
  });

  async function openHosted(sheet: 'review' | null) {
    const app = mount(WorkspaceHost, { target, props: { id: PATH, initialSheet: sheet } }) as unknown as { setSheet(next: 'review' | 'account' | null): void };
    mounted.push(app as unknown as Record<string, unknown>);
    for (let i = 0; i < 50 && !q('[data-stub-editor]'); i++) await settle(10);
    flushSync();
    return app;
  }

  it('is said on the writing screen, and again when Review is reopened; the draft stays', async () => {
    const app = await openHosted('review');
    type(BODY + 'more\n');
    await autosaved();
    let fail!: (err: unknown) => void;
    world.save = () => new Promise((_resolve, reject) => (fail = reject));
    q<HTMLButtonElement>('[data-action="publish"]')!.click();
    await settle(50);
    expect(world.saves).toHaveLength(1);

    // The writer taps away while the commit is under way…
    app.setSheet(null);
    flushSync();
    expect(q('[data-sheet="review"]')).toBeNull();
    // …and then it fails.
    fail(new SaveError('GitHub cannot be reached.', 'offline'));
    await settle(50);
    flushSync();

    expect(banner()).toBe('publish-failed');
    expect(q('[data-banner="publish-failed"]')!.getAttribute('data-publish-failed')).toBe('offline');
    expect(q('[data-banner="publish-failed"]')!.textContent).toMatch(/Nothing was published/);
    expect(state()).toBe('edited');
    expect((await store().get(PATH))!.raw).toBe(FM + BODY + 'more\n');

    app.setSheet('review');
    flushSync();
    expect(q('[data-publish-error]')!.getAttribute('data-publish-error')).toBe('offline');
    expect(banner()).not.toBe('publish-failed'); // said once: by the sheet while it is open

    // Typing again takes the message away: it was about the attempt before.
    app.setSheet(null);
    flushSync();
    expect(banner()).toBe('publish-failed');
    type(BODY + 'more, and more\n');
    expect(banner()).not.toBe('publish-failed');
  });

  it('a failed delete is said the same way', async () => {
    const app = await openHosted('review');
    let fail!: (err: unknown) => void;
    world.save = () => new Promise((_resolve, reject) => (fail = reject));
    q<HTMLButtonElement>('[data-action="delete-post"]')!.click();
    flushSync();
    q<HTMLButtonElement>('[data-action="delete-post-confirm"]')!.click();
    await settle(50);
    app.setSheet(null);
    flushSync();
    fail(new SaveError('GitHub refused the commit.', 'forbidden'));
    await settle(50);
    flushSync();
    expect(banner()).toBe('publish-failed');
    expect(q('[data-banner="publish-failed"]')!.textContent).toMatch(/Nothing was deleted/);
  });
});

describe('a new draft that was already published (the page went away before the draft was dropped)', () => {
  beforeEach(() => {
    world.canSave = true;
  });

  it('is not told to change its slug: the draft is dropped and the post opens', async () => {
    const fresh = frontmatter.scaffold('notes', { values: { slug: 'landed', title: 'Landed' }, body: 'Hello\n', now: new Date('2026-11-18T10:00:00Z') });
    const landedPath = fresh.ref.path;
    // The earlier publish landed: the repo holds exactly this text at the draft's address.
    world.files.set(landedPath, fresh.raw);
    world.store = createDraftStore(world.dbName);
    await store().put({ id: fresh.ref.id, path: landedPath, collection: 'notes', isNew: true, raw: fresh.raw, baseRaw: null, updatedAt: Date.now() });
    await open(fresh.ref.id, 'review');
    for (let i = 0; i < 50 && !location.hash.includes(encodeURIComponent(landedPath)); i++) await settle(20);
    expect(location.hash).toBe(`#/post/${encodeURIComponent(landedPath)}`);
    expect(await store().get(fresh.ref.id)).toBeUndefined();
    expect(world.saves).toEqual([]);
  });

  it('a different text at that address is still a taken path', async () => {
    const fresh = frontmatter.scaffold('notes', { values: { slug: 'landed', title: 'Landed' }, body: 'Hello\n', now: new Date('2026-11-18T10:00:00Z') });
    world.files.set(fresh.ref.path, fresh.raw + 'something else\n');
    world.store = createDraftStore(world.dbName);
    await store().put({ id: fresh.ref.id, path: fresh.ref.path, collection: 'notes', isNew: true, raw: fresh.raw, baseRaw: null, updatedAt: Date.now() });
    await open(fresh.ref.id, 'review');
    for (let i = 0; i < 40 && !q('[data-publish-blockers]'); i++) await settle(20);
    await settle(100);
    expect(q('[data-publish-blockers]')!.textContent).toContain('There is already a post at');
    expect(await store().get(fresh.ref.id)).toBeDefined();
  });
});

describe('a file that ends at its closing fence', () => {
  it('typing body text keeps the frontmatter a frontmatter', async () => {
    const bare = '---\nslug: a-note\ntitle: A note\ncreated: 2026-11-18T10:00:00+00:00\ntags: []\nis_draft: false\n---';
    world.files.set(PATH, bare);
    await open();
    expect(state()).toBe('clean');
    type('X');
    await autosaved();
    const stored = (await store().get(PATH))!;
    expect(stored.raw).toBe(bare + '\nX');
    expect(frontmatter.split(stored.raw).frontmatter).toBe(frontmatter.split(bare).frontmatter);
    // Removing it again gives the original back, byte for byte, and no draft.
    type('');
    await autosaved();
    expect(state()).toBe('clean');
    expect(await store().get(PATH)).toBeUndefined();
  });
});
