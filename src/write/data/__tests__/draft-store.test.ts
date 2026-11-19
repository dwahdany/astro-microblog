import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { createStore, set } from 'idb-keyval';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DraftEvent, DraftRecord } from '../../contracts';
import { createDraftStore, summarise } from '../draft-store';
import { DraftConflictError } from '../../contracts';
import { DraftStoreError } from '../errors';

let n = 0;
const dbName = () => `test-drafts-${++n}`;
const tick = () => new Promise((r) => setTimeout(r, 20));

const record = (over: Partial<DraftRecord> = {}): DraftRecord => ({
  id: 'src/content/notes/2026/a.md',
  path: 'src/content/notes/2026/a.md',
  collection: 'notes',
  isNew: false,
  raw: '---\nslug: a\n---\n\nEdited\n',
  baseRaw: '---\nslug: a\n---\n\nOriginal\n',
  baseSha: 'abc123',
  updatedAt: 1000,
  selection: { anchor: 3, head: 5 },
  scrollTop: 120,
  ...over,
});

const stores: { close(): void }[] = [];
const open = (name = dbName(), factory?: IDBFactory) => {
  const store = createDraftStore(name, factory ? { indexedDB: factory } : {});
  stores.push(store);
  return store;
};
afterEach(() => {
  stores.splice(0).forEach((s) => s.close());
  vi.restoreAllMocks();
});

describe('draft store', () => {
  it('round-trips a record exactly, including base text, sha, caret and scroll', async () => {
    const store = open();
    const r = record();
    await store.put(r);
    // The store adds its write counter; everything else is exactly what was put.
    expect(await store.get(r.id)).toEqual({ ...r, rev: 1 });
    expect(await store.persistence()).toBe('indexeddb');
  });

  it('survives a "reload": a new store over the same database sees the draft', async () => {
    const name = dbName();
    const before = open(name);
    await before.put(record());
    await before.put(record({ id: 'new:notes:1', path: 'src/content/notes/2026/untitled.md', isNew: true, baseRaw: null, baseSha: undefined, updatedAt: 2000 }));
    before.close();
    const after = open(name);
    expect((await after.get('src/content/notes/2026/a.md'))?.raw).toBe('---\nslug: a\n---\n\nEdited\n');
    expect((await after.list()).map((s) => s.id)).toEqual(['new:notes:1', 'src/content/notes/2026/a.md']);
  });

  it('keeps text byte-exact: CRLF, BOM, astral characters, no final newline', async () => {
    const store = open();
    const raw = '﻿---\r\nslug: a\r\n---\r\n\r\n𝒳 😀\u0000 tab\there';
    await store.put(record({ raw }));
    expect((await store.get(record().id))!.raw).toBe(raw);
  });

  it('put is an upsert; one draft per post id', async () => {
    const store = open();
    await store.put(record({ raw: 'one', updatedAt: 1 }));
    await store.put(record({ raw: 'two', updatedAt: 2 }));
    expect((await store.get(record().id))!.raw).toBe('two');
    expect((await store.list()).length).toBe(1);
  });

  it('list: summaries only, newest first, with the dirty flag', async () => {
    const store = open();
    await store.put(record({ id: 'p1', path: 'p1', updatedAt: 10 }));
    await store.put(record({ id: 'p2', path: 'p2', updatedAt: 30, raw: 'same', baseRaw: 'same' }));
    await store.put(record({ id: 'new:entries:x', path: 'src/content/entries/2026/x.md', collection: 'entries', isNew: true, baseRaw: null, updatedAt: 20 }));
    const list = await store.list();
    expect(list).toEqual([
      { id: 'p2', path: 'p2', collection: 'notes', isNew: false, updatedAt: 30, dirty: false },
      { id: 'new:entries:x', path: 'src/content/entries/2026/x.md', collection: 'entries', isNew: true, updatedAt: 20, dirty: true },
      { id: 'p1', path: 'p1', collection: 'notes', isNew: false, updatedAt: 10, dirty: true },
    ]);
    expect(Object.keys(list[0])).not.toContain('raw');
  });

  it('delete removes the record and its summary; deleting nothing is fine', async () => {
    const store = open();
    await store.put(record());
    await store.delete(record().id);
    expect(await store.get(record().id)).toBeUndefined();
    expect(await store.list()).toEqual([]);
    await expect(store.delete('never-existed')).resolves.toBeUndefined();
  });

  it('get of an unknown id is undefined', async () => {
    expect(await open().get('nope')).toBeUndefined();
  });

  it('accepts reactive proxies (Svelte $state) and stores a plain copy without foreign fields', async () => {
    const store = open();
    const proxied = new Proxy(record({ selection: new Proxy({ anchor: 1, head: 2 }, {}) }), {});
    await store.put({ ...proxied, extra: () => 'not cloneable' } as DraftRecord);
    const back = await store.get(record().id);
    expect(back).toEqual(record({ selection: { anchor: 1, head: 2 }, rev: 1 }));
  });

  it('notifies subscribers of puts and deletes, and stops after unsubscribe', async () => {
    const store = open();
    const events: DraftEvent[] = [];
    const off = store.subscribe((e) => events.push(e));
    await store.put(record());
    await store.delete(record().id);
    off();
    await store.put(record());
    expect(events).toEqual([
      { type: 'put', id: record().id, origin: 'local' },
      { type: 'delete', id: record().id, origin: 'local' },
    ]);
  });

  it('another tab (a second store on the same database) hears about changes', async () => {
    const name = dbName();
    const tabA = open(name);
    const tabB = open(name);
    const heard: DraftEvent[] = [];
    tabB.subscribe((e) => heard.push(e));
    await tabA.put(record());
    await tick();
    expect(heard).toEqual([{ type: 'put', id: record().id, origin: 'remote' }]);
    expect((await tabB.get(record().id))?.raw).toBe(record().raw);
  });

  it('upgrades the database the Foundation stub created (idb-keyval, records only) and keeps its drafts', async () => {
    const name = dbName();
    const legacy = createStore(name, 'drafts');
    await set('p-old', record({ id: 'p-old', path: 'p-old', updatedAt: 5 }), legacy);
    await set('new:notes:old', record({ id: 'new:notes:old', isNew: true, baseRaw: null, updatedAt: 7 }), legacy);
    // idb-keyval keeps its connection open; a real page would have been reloaded.
    (await legacy('readonly', (s) => s.transaction.db)).close();

    const store = open(name);
    expect((await store.list()).map((s) => [s.id, s.dirty])).toEqual([
      ['new:notes:old', true],
      ['p-old', true],
    ]);
    expect((await store.get('p-old'))?.raw).toBe(record().raw);
  });
});

describe('draft store: failures are reported, not swallowed', () => {
  it('no IndexedDB (private mode): put rejects with a message for the owner, the session copy still works', async () => {
    const broken = { open: () => { throw new DOMException('denied', 'SecurityError'); } } as unknown as IDBFactory;
    const store = open(dbName(), broken);
    const events: DraftEvent[] = [];
    store.subscribe((e) => events.push(e));

    const err = await store.put(record()).catch((e) => e);
    expect(err).toBeInstanceOf(DraftStoreError);
    expect(err).toMatchObject({ code: 'DRAFT_STORE', reason: 'unavailable' });
    expect(err.message).toMatch(/cannot be stored in this browser/);
    expect(await store.persistence()).toBe('memory');

    // The tab keeps working with what it has.
    expect(await store.get(record().id)).toEqual(record({ rev: 1 }));
    expect((await store.list()).map((s) => s.id)).toEqual([record().id]);
    await expect(store.delete(record().id)).resolves.toBeUndefined();
    expect(await store.get(record().id)).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(['put', 'delete']);
  });

  it('an open request that errors is treated the same way, and reads do not reject', async () => {
    const failing = {
      open() {
        const req = { error: new DOMException('nope', 'UnknownError') } as unknown as IDBOpenDBRequest;
        queueMicrotask(() => (req.onerror as unknown as () => void)?.());
        return req;
      },
    } as unknown as IDBFactory;
    const store = open(dbName(), failing);
    expect(await store.get('x')).toBeUndefined();
    expect(await store.list()).toEqual([]);
    await expect(store.put(record())).rejects.toBeInstanceOf(DraftStoreError);
  });

  it('storage full: put rejects with reason "quota"; the newer text is not lost for this session', async () => {
    const store = open();
    await store.put(record({ raw: 'saved earlier', updatedAt: 1 }));
    const spy = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError');
    });
    const err = await store.put(record({ raw: 'newer text', updatedAt: 2 })).catch((e) => e);
    expect(err).toBeInstanceOf(DraftStoreError);
    expect(err.reason).toBe('quota');
    expect(err.message).toMatch(/storage is full/);
    expect((await store.get(record().id))!.raw).toBe('newer text');
    expect((await store.list())[0].updatedAt).toBe(2);

    // Once storage works again the next autosave persists and replaces the session copy.
    spy.mockRestore();
    await store.put(record({ raw: 'third', updatedAt: 3 }));
    expect((await store.get(record().id))!.raw).toBe('third');
    expect((await store.list()).length).toBe(1);
  });

  it('summarise marks a draft clean only when it equals its base', () => {
    expect(summarise(record()).dirty).toBe(true);
    expect(summarise(record({ raw: 'x', baseRaw: 'x' })).dirty).toBe(false);
    expect(summarise(record({ raw: 'x', baseRaw: 'x', isNew: true })).dirty).toBe(true);
    expect(summarise(record({ raw: 'x\n', baseRaw: 'x\r\n' })).dirty).toBe(true);
  });
});

/**
 * Review finding: the same post open in two tabs. The later writer silently replaced the other
 * tab's kept text, and a tab whose text went back to the original deleted the other tab's draft.
 */
describe('draft store: two tabs on one post', () => {
  it('counts writes: put resolves with the new rev and stores it', async () => {
    const store = open();
    expect(await store.put(record(), { expectedRev: 0 })).toBe(1);
    expect(await store.put(record({ raw: 'two' }), { expectedRev: 1 })).toBe(2);
    expect((await store.get(record().id))?.rev).toBe(2);
    // Unconditional writes count on from what the record carries.
    expect(await store.put(record({ raw: 'three', rev: 2 }))).toBe(3);
  });

  it('a stale tab cannot overwrite what another tab kept', async () => {
    const name = dbName();
    const tabA = open(name);
    const tabB = open(name);
    // A edits and keeps; B opens the post, picks up A's draft and adds to it.
    const revA = await tabA.put(record({ raw: 'A1' }), { expectedRev: 0 });
    const seenByB = await tabB.get(record().id);
    await tabB.put(record({ raw: 'A1 + B paragraph' }), { expectedRev: seenByB!.rev });

    // Back in A (still showing its older text): the next autosave is refused.
    const err = await tabA.put(record({ raw: 'A2' }), { expectedRev: revA }).catch((e) => e);
    expect(err).toBeInstanceOf(DraftConflictError);
    expect((err as DraftConflictError).current?.raw).toBe('A1 + B paragraph');
    expect((await tabB.get(record().id))?.raw).toBe('A1 + B paragraph');
    expect((await tabA.get(record().id))?.raw).toBe('A1 + B paragraph');
  });

  it('a tab that never had changes cannot delete another tab’s draft', async () => {
    const name = dbName();
    const tabA = open(name);
    const tabB = open(name);
    await tabA.put(record({ raw: 'A work' }), { expectedRev: 0 });
    // B opened before A wrote, typed a character and removed it again: its text equals the original.
    await expect(tabB.delete(record().id, { expectedRev: 0 })).rejects.toBeInstanceOf(DraftConflictError);
    // …and its first keystroke is refused too.
    await expect(tabB.put(record({ raw: 'B' }), { expectedRev: 0 })).rejects.toBeInstanceOf(DraftConflictError);
    expect((await tabA.get(record().id))?.raw).toBe('A work');
    expect((await tabA.list()).map((s) => s.id)).toEqual([record().id]);
  });

  it('a refused write does not announce a change', async () => {
    const name = dbName();
    const tabA = open(name);
    const tabB = open(name);
    await tabA.put(record({ raw: 'A' }), { expectedRev: 0 });
    await tick();
    const events: DraftEvent[] = [];
    tabA.subscribe((e) => events.push(e));
    tabB.subscribe((e) => events.push(e));
    await tabB.put(record({ raw: 'B' }), { expectedRev: 0 }).catch(() => {});
    await tick();
    expect(events).toEqual([]);
  });

  it('the other tab hears every write as "remote", the writer as "local"', async () => {
    const name = dbName();
    const tabA = open(name);
    const tabB = open(name);
    const a: DraftEvent[] = [];
    const b: DraftEvent[] = [];
    tabA.subscribe((e) => a.push(e));
    tabB.subscribe((e) => b.push(e));
    await tabA.put(record(), { expectedRev: 0 });
    await tabA.delete(record().id, { expectedRev: 1 });
    await tick();
    expect(a.map((e) => [e.type, e.origin])).toEqual([['put', 'local'], ['delete', 'local']]);
    expect(b.map((e) => [e.type, e.origin])).toEqual([['put', 'remote'], ['delete', 'remote']]);
  });

  it('a draft written before the counter existed counts as rev 0', async () => {
    const name = dbName();
    const custom = createStore(name, 'drafts');
    const { rev: _none, ...legacy } = record({ rev: 1 });
    await set(legacy.id, legacy, custom);
    (await custom('readonly', (st) => st.transaction.db)).close();
    const store = open(name);
    const got = await store.get(legacy.id);
    expect(got?.rev).toBeUndefined();
    expect(await store.put(record({ raw: 'next' }), { expectedRev: got?.rev ?? 0 })).toBe(1);
  });

  it('keeps the conflict marker with the record', async () => {
    const store = open();
    await store.put(record({ conflict: { sha: 'newsha' } }));
    expect((await store.get(record().id))?.conflict).toEqual({ sha: 'newsha' });
    await store.put(record({ conflict: {} }));
    expect((await store.get(record().id))?.conflict).toEqual({});
  });
});

/** Review finding: closing the tab right after typing could lose the last keystrokes. */
describe('draft store: a write issued while the page is going away', () => {
  it('with the database open, an unconditional put issues its request before returning', async () => {
    const store = open();
    await store.persistence(); // the app has listed or read drafts by the time anything is typed
    const transaction = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    void store.put(record({ raw: 'last keystrokes' }));
    // No await between the call and here: the request is already with IndexedDB.
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledTimes(2); // the record and its summary
    await tick();
    expect((await store.get(record().id))?.raw).toBe('last keystrokes');
  });
});
