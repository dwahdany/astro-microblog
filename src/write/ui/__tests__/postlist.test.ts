// @vitest-environment jsdom
/**
 * The post list mounted for real (real draft store on fake-indexeddb, real frontmatter code)
 * against a content source the test controls. Pins down two review findings:
 *   - kept changes for a post that is missing from the list could not be reached from the app
 *   - a post whose tags repeat broke the whole list (and the tag field of its properties)
 */
import 'fake-indexeddb/auto';
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContentSource, DraftRecord, DraftStore, PostRef } from '../../contracts';

const world = vi.hoisted(() => ({ files: new Map<string, string>(), dbName: 'postlist-test-0', store: null as unknown }));

vi.mock('../../data', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../data')>();
  const { createDraftStore } = await import('../../data/draft-store');
  const fm = original.frontmatter;
  const source: ContentSource = {
    kind: 'github',
    label: 'the test repo',
    canSave: false,
    async list(): Promise<PostRef[]> {
      return [...world.files].map(([path, raw]) => fm.describe(path, raw));
    },
    async load() {
      throw new Error('not used');
    },
    resolveAssetUrl: () => null,
    save: () => Promise.reject(new Error('read-only')),
    onAuthChange: () => () => {},
    status: () => ({ state: 'fresh' }),
    onStatus: () => () => {},
  };
  const draftStore = new Proxy({} as DraftStore, {
    get(_target, key: keyof DraftStore) {
      world.store ??= createDraftStore(world.dbName);
      return (world.store as DraftStore)[key];
    },
  });
  return { ...original, contentSource: source, draftStore };
});

import PostList from '../PostList.svelte';
import TagField from '../fields/TagField.svelte';
import { createDraftStore } from '../../data/draft-store';
import { filters, listMemory } from '../memory.svelte';

const post = (slug: string, body = 'Body\n', extra = '') =>
  `---\nslug: ${slug}\ntitle: ${slug}\ncreated: 2026-11-10T10:00:00+00:00\ntags: []\nis_draft: false\n${extra}---\n\n${body}`;
const HERE = 'src/content/notes/2026/here.md';
const GONE = 'src/content/notes/2026/gone.md';

const settle = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
let n = 0;
let target: HTMLElement;
let app: Record<string, unknown> | undefined;
const store = () => (world.store ??= createDraftStore(world.dbName)) as DraftStore & { close(): void };

const draft = (over: Partial<DraftRecord>): DraftRecord => ({
  id: GONE,
  path: GONE,
  collection: 'notes',
  isNew: false,
  raw: post('gone', 'Edited on this device\n'),
  baseRaw: post('gone'),
  updatedAt: Date.now() - 5 * 60_000,
  ...over,
});

async function show() {
  app = mount(PostList, { target, props: { sheet: null } });
  for (let i = 0; i < 50 && !target.querySelector('[data-post-list]'); i++) await settle(10);
  await settle(50);
  flushSync();
}
const rows = () => [...target.querySelectorAll<HTMLAnchorElement>('a[data-post-row]')];
const draftsChip = () => target.querySelector('[data-filter="drafts"] .n')!.textContent;

beforeEach(() => {
  world.files = new Map([[HERE, post('here')]]);
  world.dbName = `postlist-test-${++n}`;
  world.store = null;
  listMemory.posts = null;
  filters.query = '';
  filters.kind = 'all';
  filters.draftsOnly = false;
  target = document.createElement('div');
  document.body.append(target);
});

afterEach(async () => {
  if (app) await unmount(app);
  app = undefined;
  (world.store as { close?: () => void } | null)?.close?.();
  target.remove();
});

describe('kept changes for a post that is not in the list', () => {
  it('get a row of their own, built from the kept text, that opens them', async () => {
    await store().put(draft({}));
    await show();
    const kept = target.querySelector('#group-local')?.closest('section');
    expect(kept, 'the "Kept on this device" section').not.toBeNull();
    const row = kept!.querySelector<HTMLAnchorElement>('a[data-post-row]')!;
    expect(row.textContent).toContain('gone');
    expect(row.textContent).toContain('Changed here');
    expect(row.querySelector('[data-row-gone]')).not.toBeNull();
    expect(decodeURIComponent(row.getAttribute('href')!)).toBe(`#/post/${GONE}`);
    // The listed post is still there, once.
    expect(rows().map((r) => decodeURIComponent(r.getAttribute('href')!))).toEqual([`#/post/${GONE}`, `#/post/${HERE}`]);
  });

  it('"Drafts only" counts exactly what it shows', async () => {
    await store().put(draft({}));
    await show();
    expect(draftsChip()).toBe('1');
    target.querySelector<HTMLButtonElement>('[data-filter="drafts"]')!.click();
    flushSync();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].textContent).toContain('gone');
  });

  it('a draft that equals its original is not listed (nothing was changed)', async () => {
    await store().put(draft({ raw: post('gone') }));
    await show();
    expect(target.querySelector('#group-local')).toBeNull();
    expect(draftsChip()).toBe('0');
  });

  it('changes to a post that IS in the list show once, under "Kept on this device"', async () => {
    await store().put(draft({ id: HERE, path: HERE, raw: post('here', 'Edited\n'), baseRaw: post('here') }));
    await show();
    expect(rows()).toHaveLength(1);
    expect(rows()[0].querySelector('[data-row-gone]')).toBeNull();
  });
});

describe('a post whose tags repeat', () => {
  const repeated = post('twice', 'Body\n').replace('tags: []', 'tags:\n  - ai\n  - ai\n  - ml');

  it('in the source: the list still renders every row', async () => {
    world.files.set('src/content/notes/2026/twice.md', repeated);
    await show();
    expect(rows()).toHaveLength(2);
  });

  it('as a new draft on this device: the list still renders', async () => {
    await store().put(draft({ id: 'new:notes:1', path: 'src/content/notes/2026/twice.md', isNew: true, raw: repeated, baseRaw: null }));
    await show();
    expect(rows()).toHaveLength(2);
    expect(target.querySelector('#group-local')).not.toBeNull();
  });

  it('the tag field shows them all, and removing one removes that one', async () => {
    const changes: string[][] = [];
    const field = mount(TagField, { target, props: { id: 'tags', value: ['ai', 'ai', 'ml'], suggestions: ['ai', 'ml'], onChange: (tags: string[]) => changes.push(tags) } });
    flushSync();
    const chips = [...target.querySelectorAll('[data-tag]')];
    expect(chips.map((c) => c.getAttribute('data-tag'))).toEqual(['ai', 'ai', 'ml']);
    chips[1].querySelector('button')!.click();
    expect(changes).toEqual([['ai', 'ml']]);
    await unmount(field);
  });
});
