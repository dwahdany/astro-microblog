import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { DraftRecord, PendingImage } from '../../contracts';
import { DRAFT_DB, createDraftStore } from '../draft-store';
import { draftAfterSave, resolveDraft } from '../draft-sync';

let n = 0;
const dbName = () => `${DRAFT_DB}-assets-${++n}`;

const image = (name: string, bytes: number[], extra: Partial<PendingImage> = {}): PendingImage => ({
  name,
  data: new Blob([new Uint8Array(bytes)], { type: 'image/png' }),
  type: 'image/png',
  size: bytes.length,
  sha: `sha-of-${bytes.join('.')}`,
  stripped: true,
  addedAt: 1000,
  ...extra,
});

const draft = (overrides: Partial<DraftRecord> = {}): DraftRecord => ({
  id: 'new:notes:1',
  path: 'src/content/notes/2026/untitled.md',
  collection: 'notes',
  isNew: true,
  raw: '---\nslug: untitled\n---\n\nBody\n',
  baseRaw: null,
  updatedAt: 1,
  ...overrides,
});

const bytesOf = async (blob: Blob) => [...new Uint8Array(await blob.arrayBuffer())];

/** What the `assets` object store holds, read behind the store's back: key → value. */
function rawAssets(name: string): Promise<Map<string, unknown>> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(name);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const store = db.transaction('assets', 'readonly').objectStore('assets');
      const keys = store.getAllKeys();
      const values = store.getAll();
      values.onsuccess = () => {
        db.close();
        resolve(new Map(keys.result.map((key, i) => [String(key), values.result[i]])));
      };
    };
  });
}

describe('pending images persist with the draft', () => {
  it('survive a reload: the bytes come back exactly, with every fact about them', async () => {
    const name = dbName();
    const before = createDraftStore(name);
    const assets = [image('pic.png', [1, 2, 3], { width: 10, height: 20, originalName: 'Pic.PNG', alt: 'A pic' }), image('shot.png', [9, 8], { stripped: false })];
    await before.put(draft({ assets }));
    before.close();

    const after = createDraftStore(name);
    const stored = await after.get('new:notes:1');
    expect(stored?.assets).toHaveLength(2);
    expect(stored?.assets?.map(({ data: _d, ...facts }) => facts)).toEqual(assets.map(({ data: _d, ...facts }) => facts));
    expect(await bytesOf(stored!.assets![0].data)).toEqual([1, 2, 3]);
    expect(await bytesOf(stored!.assets![1].data)).toEqual([9, 8]);
    expect(stored!.assets![0].data.type).toBe('image/png');
    after.close();
  });

  it('the list knows a draft has images, and such a draft is dirty even when its text is unchanged', async () => {
    const store = createDraftStore(dbName());
    const raw = 'same\n';
    await store.put(draft({ id: 'a.md', path: 'a.md', isNew: false, raw, baseRaw: raw, assets: [image('p.png', [1])] }));
    await store.put(draft({ id: 'b.md', path: 'b.md', isNew: false, raw, baseRaw: raw }));
    const list = await store.list();
    expect(list.find((s) => s.id === 'a.md')).toMatchObject({ dirty: true, images: 1 });
    const plain = list.find((s) => s.id === 'b.md');
    expect(plain?.dirty).toBe(false);
    expect(plain && 'images' in plain).toBe(false);
    store.close();
  });

  it('the bytes are stored as ArrayBuffers (WebKit cannot store Blobs in a private session), with a separate tag list', async () => {
    const name = dbName();
    const store = createDraftStore(name);
    await store.put(draft({ assets: [image('pic.png', [1, 2, 3])] }));
    const stored = await rawAssets(name);
    expect([...stored.keys()].sort()).toEqual(['b:new:notes:1', 't:new:notes:1']);
    expect(stored.get('t:new:notes:1')).toEqual(['pic.png\nsha-of-1.2.3']);
    const items = stored.get('b:new:notes:1') as { name: string; type: string; bytes: ArrayBuffer }[];
    expect(items[0].bytes).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(items[0].bytes)]).toEqual([1, 2, 3]);
    expect(items[0]).toMatchObject({ name: 'pic.png', type: 'image/png' });
    store.close();
  });

  it('an autosave after typing rewrites the text but not the image bytes', async () => {
    const name = dbName();
    const store = createDraftStore(name);
    await store.put(draft({ assets: [image('pic.png', [1, 2, 3])] }));
    // Swap the stored bytes behind the store's back: a later write that left them alone will still show the marker.
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name);
      open.onsuccess = () => {
        const tx = open.result.transaction('assets', 'readwrite');
        tx.objectStore('assets').put([{ name: 'pic.png', tag: 'pic.png\nsha-of-1.2.3', type: 'image/png', bytes: new Uint8Array([42]).buffer }], 'b:new:notes:1');
        tx.oncomplete = () => (open.result.close(), resolve());
        tx.onerror = () => reject(tx.error);
      };
    });
    // The same images are passed in again with new text, several times (what typing does).
    let current = draft({ assets: [image('pic.png', [1, 2, 3])] });
    for (let i = 0; i < 3; i += 1) {
      current = { ...current, raw: current.raw + 'x', updatedAt: 2 + i };
      await store.put(current);
    }
    const items = (await rawAssets(name)).get('b:new:notes:1') as { bytes: ArrayBuffer }[];
    expect([...new Uint8Array(items[0].bytes)]).toEqual([42]); // untouched by the three writes
    expect((await store.get('new:notes:1'))?.raw.endsWith('xxx')).toBe(true);
    store.close();
  });

  it('a write that carries images it has seen before starts in the caller’s own turn (usable from pagehide)', async () => {
    const name = dbName();
    const store = createDraftStore(name);
    await store.put(draft({ assets: [image('pic.png', [1, 2, 3])] }));
    const held = await store.get('new:notes:1'); // what the writing screen holds after opening the draft
    const real = IDBObjectStore.prototype.put;
    let puts = 0;
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      puts += 1;
      return real.apply(this, args);
    };
    try {
      const pending = store.put({ ...held!, raw: 'typed just before closing', updatedAt: 9 });
      expect(puts).toBeGreaterThan(0); // issued before put() returned
      await pending;
    } finally {
      IDBObjectStore.prototype.put = real;
    }
    expect((await store.get('new:notes:1'))?.raw).toBe('typed just before closing');
    store.close();
  });

  it('adding, replacing and removing images is reflected exactly', async () => {
    const name = dbName();
    const store = createDraftStore(name);
    await store.put(draft({ assets: [image('a.png', [1])] }));
    await store.put(draft({ assets: [image('a.png', [1]), image('b.png', [2])] }));
    expect((await store.get('new:notes:1'))?.assets?.map((a) => a.name)).toEqual(['a.png', 'b.png']);
    // same name, other bytes (removed and another added under the freed name)
    await store.put(draft({ assets: [image('a.png', [7, 7]), image('b.png', [2])] }));
    expect(await bytesOf((await store.get('new:notes:1'))!.assets![0].data)).toEqual([7, 7]);
    await store.put(draft({ assets: [image('b.png', [2])] }));
    expect((await store.get('new:notes:1'))?.assets?.map((a) => a.name)).toEqual(['b.png']);
    await store.put(draft({ assets: [] }));
    const none = await store.get('new:notes:1');
    expect(none && 'assets' in none).toBe(false);
    expect((await rawAssets(name)).size).toBe(0);
    store.close();
  });

  it('deleting the draft deletes its images; other drafts keep theirs', async () => {
    const name = dbName();
    const store = createDraftStore(name);
    await store.put(draft({ id: 'one', assets: [image('a.png', [1])] }));
    await store.put(draft({ id: 'two', assets: [image('a.png', [2])] }));
    await store.delete('one');
    expect([...(await rawAssets(name)).keys()].sort()).toEqual(['b:two', 't:two']);
    expect(await bytesOf((await store.get('two'))!.assets![0].data)).toEqual([2]);
    store.close();
  });

  it('a refused write (another tab was first) leaves the stored images alone', async () => {
    const name = dbName();
    const tabA = createDraftStore(name);
    const tabB = createDraftStore(name);
    const rev = await tabA.put(draft({ assets: [image('a.png', [1])] }));
    await tabB.put(draft({ assets: [image('a.png', [1]), image('b.png', [2])] }), { expectedRev: rev });
    await expect(tabA.put(draft({ assets: [] }), { expectedRev: rev })).rejects.toThrow(/another tab/);
    expect((await tabA.get('new:notes:1'))?.assets?.map((a) => a.name)).toEqual(['a.png', 'b.png']);
    tabA.close();
    tabB.close();
  });

  it('a draft written before images existed (database version 2) opens unchanged', async () => {
    const name = dbName();
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(name, 2);
      open.onupgradeneeded = () => {
        open.result.createObjectStore('drafts');
        open.result.createObjectStore('index');
      };
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const tx = open.result.transaction(['drafts', 'index'], 'readwrite');
        const old = draft({ id: 'old.md', path: 'old.md', isNew: false, baseRaw: 'base', rev: 3 });
        tx.objectStore('drafts').put(old, 'old.md');
        tx.objectStore('index').put({ id: 'old.md', path: 'old.md', collection: 'notes', isNew: false, updatedAt: 1, dirty: true }, 'old.md');
        tx.oncomplete = () => {
          open.result.close();
          resolve();
        };
      };
    });
    const store = createDraftStore(name);
    expect(await store.get('old.md')).toMatchObject({ id: 'old.md', raw: draft().raw, rev: 3 });
    expect((await store.list()).map((s) => s.id)).toEqual(['old.md']);
    await store.put({ ...(await store.get('old.md'))!, assets: [image('n.png', [5])] }, { expectedRev: 3 });
    expect((await store.get('old.md'))?.assets?.[0].name).toBe('n.png');
    store.close();
  });

  it('without IndexedDB the images stay with the draft in memory for the session', async () => {
    const broken = { open: () => { throw new DOMException('nope', 'SecurityError'); } } as unknown as IDBFactory;
    const store = createDraftStore(dbName(), { indexedDB: broken });
    await expect(store.put(draft({ assets: [image('a.png', [1, 2])] }))).rejects.toThrow();
    const kept = await store.get('new:notes:1');
    expect(await bytesOf(kept!.assets![0].data)).toEqual([1, 2]);
    expect((await store.list())[0]).toMatchObject({ images: 1 });
  });

  it('ignores entries that are not images (no Blob) instead of failing the write', async () => {
    const store = createDraftStore(dbName());
    const broken = { name: 'x.png', type: 'image/png', size: 1, stripped: true, addedAt: 1 } as unknown as PendingImage;
    await store.put(draft({ assets: [broken, image('ok.png', [1])] }));
    expect((await store.get('new:notes:1'))?.assets?.map((a) => a.name)).toEqual(['ok.png']);
    store.close();
  });
});

describe('a draft with images against the source', () => {
  it('is not dropped when its text has nothing left to say', () => {
    const upstream = { raw: 'same\n', sha: 's1' };
    expect(resolveDraft({ isNew: false, raw: 'same\n', baseRaw: 'old\n', baseSha: 's0' }, upstream).kind).toBe('drop');
    expect(resolveDraft({ isNew: false, raw: 'same\n', baseRaw: 'old\n', baseSha: 's0', assets: [image('a.png', [1])] }, upstream)).toMatchObject({ kind: 'current', text: 'same\n', base: upstream });
    expect(resolveDraft({ isNew: false, raw: 'same\n', baseRaw: 'old\n', baseSha: 's0', assets: [] }, upstream).kind).toBe('drop');
  });
});

describe('draftAfterSave: the committed bytes become the base', () => {
  const NEW = 'src/content/notes/2026/my-note.md';
  const saved = (raw: string, assets: string[] = []) => ({ raw, result: { path: NEW, sha: 'new-sha', assets: assets.map((name) => ({ path: `src/content/notes/2026/my-note/${name}` })) } });

  it('nothing left → null (delete the draft)', () => {
    const d = draft({ raw: 'text\n', assets: [image('a.png', [1])] });
    expect(draftAfterSave(d, saved('text\n', ['a.png']))).toBeNull();
    expect(draftAfterSave(draft({ raw: 'text\n' }), saved('text\n'))).toBeNull();
    expect(draftAfterSave(d, { raw: '', result: { path: NEW, sha: '', deleted: true } })).toBeNull();
  });

  it('typed on while the commit ran → a draft of the now-existing post, based on what was committed', () => {
    const d = draft({ raw: 'text\nmore\n', conflict: { sha: 'x' }, rev: 7, baseSha: 'old', selection: { anchor: 3, head: 3 } });
    const next = draftAfterSave(d, saved('text\n'), 99);
    expect(next).toEqual({
      id: NEW,
      path: NEW,
      collection: 'notes',
      isNew: false,
      raw: 'text\nmore\n',
      baseRaw: 'text\n',
      baseSha: 'new-sha',
      updatedAt: 99,
      selection: { anchor: 3, head: 3 },
    });
  });

  it('images the commit did not carry stay with the draft', () => {
    const d = draft({ raw: 'text\n', assets: [image('a.png', [1]), image('unused.png', [2])] });
    const next = draftAfterSave(d, saved('text\n', ['a.png']));
    expect(next?.assets?.map((a) => a.name)).toEqual(['unused.png']);
    expect(next?.baseRaw).toBe('text\n');
    expect(next?.isNew).toBe(false);
  });
});
