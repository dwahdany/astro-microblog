/**
 * Local drafts in IndexedDB — the autosave behind "survives a reload".
 *
 * One record per post, keyed by `PostRef.id`: the repo path for an existing
 * post, `new:<collection>:<uuid>` for one that exists only here. A record
 * holds the full current text plus the text (and blob sha) it was started
 * from, so the app can diff, discard, and notice that the upstream file moved
 * on meanwhile (./draft-sync.ts).
 *
 * Database `write-drafts`, version 3:
 *   drafts   id → DraftRecord            (same store the v1 stub created; existing drafts carry over)
 *   index    id → DraftSummary           (what the list needs; lets `list()` skip the texts)
 *   assets   `t:<id>` → string[]         (v3: one tag per pending image, in order)
 *            `b:<id>` → StoredImage[]    (v3: the BYTES of the draft's pending images)
 * All stores are written in one transaction, so they cannot disagree.
 *
 * Pending images (`DraftRecord.assets`): the record in `drafts` keeps each image's facts (name,
 * type, size, sha …) but not its `data`. The bytes live in `assets`, as ArrayBuffers — NOT as
 * Blobs: WebKit cannot store a Blob in IndexedDB in a private or ephemeral session (the write
 * fails), while an ArrayBuffer is stored everywhere. They are rewritten only when the set of
 * images changes: an autosave after a keystroke reads the short tag list, finds it unchanged and
 * writes no image bytes. `get` builds the Blobs again. Deleting a draft deletes its images.
 *
 * A Blob's bytes can only be read asynchronously, and a transaction cannot wait for that. So the
 * bytes of every image this tab has seen are kept at hand (`knownBytes`, a WeakMap): filled when
 * a draft is read, by `rememberImageBytes` (image intake calls it), and — for a Blob met for the
 * first time in `put` — by reading it before the write starts. Only that first write of a new
 * image is not issued in the caller's own turn.
 *
 * Two tabs on one post: every record carries a write counter (`rev`). A write
 * that names the `rev` it is based on (`expectedRev`) is checked inside the
 * same transaction and refused with `DraftConflictError` when another tab got
 * there first, so a stale tab cannot overwrite or delete newer work. Changes
 * are also announced over a BroadcastChannel (`DraftEvent.origin: 'remote'`).
 *
 * Closing the tab: once the database is open, `put` issues its request in the
 * caller's own turn (no await before it), so a write started from `pagehide`
 * or `visibilitychange` is on its way before the page goes. The checked write
 * needs a read first; the unconditional one (no `expectedRev`) is a single
 * request and is the one to use while unloading.
 *
 * Failure behaviour, per the contract ("must not fail silently"):
 *   - `put`/`delete` REJECT with a `DraftStoreError` whose message can be
 *     shown as-is (storage full, storage unavailable in this browser mode).
 *   - reads never reject: no storage → `undefined` / `[]`.
 *   - when IndexedDB is unusable the record is still kept in memory, so the
 *     current session keeps working after the UI has shown the warning.
 */
import {
  DraftConflictError,
  type DraftEvent,
  type DraftRecord,
  type DraftStore,
  type DraftSummary,
  type DraftWriteOptions,
  type PendingImage,
} from '../contracts';
import { DraftStoreError } from './errors';

export const DRAFT_DB = 'write-drafts';
const DB_VERSION = 3;
const RECORDS = 'drafts';
const INDEX = 'index';
const ASSETS = 'assets';
const CHANNEL = 'write:drafts';

/** One image as the `assets` store keeps it. */
interface StoredImage {
  name: string;
  tag: string;
  type: string;
  bytes: ArrayBuffer;
}
const tagsKey = (id: string) => `t:${id}`;
const bytesKey = (id: string) => `b:${id}`;

/** Identifies an image's bytes: its git blob id, else what is known about it. */
const tagOf = (a: PendingImage): string => `${a.name}\n${a.sha ?? `${a.size}:${a.type}:${a.addedAt}`}`;

/** Bytes of the image Blobs this tab has seen, so a write never has to wait for them. */
const knownBytes = new WeakMap<Blob, ArrayBuffer>();

/**
 * Tell the draft store the bytes of an image Blob it will be asked to keep, so the first `put`
 * carrying it can start in the caller's own turn. Optional: an unknown Blob is read by `put`.
 */
export function rememberImageBytes(blob: Blob, bytes: ArrayBuffer | Uint8Array): void {
  knownBytes.set(blob, bytes instanceof Uint8Array ? (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer) : bytes);
}

export function summarise(r: DraftRecord): DraftSummary {
  const images = r.assets?.length ?? 0;
  const summary: DraftSummary = {
    id: r.id,
    path: r.path,
    collection: r.collection,
    isNew: r.isNew,
    updatedAt: r.updatedAt,
    dirty: r.isNew || r.raw !== r.baseRaw || images > 0,
  };
  if (images > 0) summary.images = images;
  return summary;
}

function plainImage(a: PendingImage): PendingImage {
  const out: PendingImage = {
    name: String(a.name),
    data: a.data, // a Blob: immutable, stored by the browser as it is
    type: String(a.type),
    size: Number(a.size),
    stripped: a.stripped === true,
    addedAt: Number(a.addedAt),
  };
  if (typeof a.sha === 'string') out.sha = a.sha;
  if (typeof a.width === 'number') out.width = a.width;
  if (typeof a.height === 'number') out.height = a.height;
  if (typeof a.originalName === 'string') out.originalName = a.originalName;
  if (typeof a.originalSize === 'number') out.originalSize = a.originalSize;
  if (typeof a.alt === 'string') out.alt = a.alt;
  return out;
}

/** The record as the `drafts` store keeps it: images without their bytes. */
function withoutImageData(r: DraftRecord): DraftRecord {
  if (!r.assets) return r;
  return { ...r, assets: r.assets.map(({ data: _data, ...facts }) => facts as PendingImage) };
}

/** Build the Blobs again on a record read from `drafts`. An image whose bytes are gone is dropped. */
function withImageData(r: DraftRecord, stored: StoredImage[] | undefined): DraftRecord {
  if (!r.assets || r.assets.length === 0) return r;
  const byTag = new Map((stored ?? []).map((item) => [item.tag, item]));
  const assets = r.assets.flatMap((a) => {
    const held = (a as Partial<PendingImage>).data;
    if (held) return [a];
    const item = byTag.get(tagOf(a));
    if (!item) return [];
    const data = new Blob([item.bytes], { type: item.type || a.type });
    knownBytes.set(data, item.bytes);
    return [{ ...a, data }];
  });
  const { assets: _old, ...rest } = r;
  return assets.length > 0 ? { ...rest, assets } : rest;
}

/**
 * A plain copy holding exactly the contract's fields. Callers pass objects
 * built from Svelte `$state`; a reactive proxy cannot be structured-cloned
 * into IndexedDB, so nothing foreign may be stored by reference.
 */
function plain(r: DraftRecord): DraftRecord {
  const out: DraftRecord = {
    id: String(r.id),
    path: String(r.path),
    collection: r.collection,
    isNew: r.isNew === true,
    raw: String(r.raw),
    baseRaw: r.baseRaw === null || r.baseRaw === undefined ? null : String(r.baseRaw),
    updatedAt: Number(r.updatedAt),
  };
  if (typeof r.baseSha === 'string') out.baseSha = r.baseSha;
  if (r.selection) out.selection = { anchor: Number(r.selection.anchor), head: Number(r.selection.head) };
  if (typeof r.scrollTop === 'number') out.scrollTop = r.scrollTop;
  if (r.conflict) out.conflict = typeof r.conflict.sha === 'string' ? { sha: r.conflict.sha } : {};
  if (Array.isArray(r.assets) && r.assets.length > 0) out.assets = r.assets.filter((a) => a && a.data instanceof Blob).map(plainImage);
  if (out.assets && out.assets.length === 0) delete out.assets;
  if (typeof r.rev === 'number' && Number.isFinite(r.rev)) out.rev = r.rev;
  return out;
}

function requestDone<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
    tx.onerror = () => reject(tx.error);
  });
}

function openDb(name: string, factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let gaveUp = false;
    let req: IDBOpenDBRequest;
    try {
      req = factory.open(name, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      const tx = req.transaction!;
      if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS);
      // v3: the bytes of pending images. Nothing to migrate: no earlier draft has any.
      if (!db.objectStoreNames.contains(ASSETS)) db.createObjectStore(ASSETS);
      if (!db.objectStoreNames.contains(INDEX)) {
        const index = db.createObjectStore(INDEX);
        // Coming from v1 (records only): build the index from what is there.
        const cursorReq = tx.objectStore(RECORDS).openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const record = cursor.value as DraftRecord | undefined;
          if (record && typeof record.id === 'string' && typeof record.raw === 'string') index.put(summarise(record), cursor.key);
          cursor.continue();
        };
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      if (gaveUp) {
        db.close(); // unblocked after we stopped waiting; the next call opens its own connection
        return;
      }
      // Another tab wants to upgrade: let it, and reopen on next use.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    // An older tab keeps the previous version open. Do not hang every draft operation on it.
    req.onblocked = () => {
      gaveUp = true;
      reject(new DOMException('Draft storage is held open by another tab', 'InvalidStateError'));
    };
  });
}

function toStoreError(err: unknown): DraftStoreError {
  if (err instanceof DraftStoreError) return err;
  const name = (err as { name?: string } | null)?.name;
  if (name === 'QuotaExceededError')
    return new DraftStoreError(
      'This draft could not be saved on this device: browser storage is full. Copy or download the markdown to keep your changes.',
      'quota',
      { cause: err },
    );
  return new DraftStoreError(
    'This draft could not be saved on this device. Copy or download the markdown to keep your changes.',
    'failed',
    { cause: err },
  );
}

const UNAVAILABLE =
  'Drafts cannot be stored in this browser (private mode or storage disabled). Your text stays open in this tab only — copy or download the markdown before closing it.';

export interface DraftStoreOptions {
  /** Defaults to the global `indexedDB`. */
  indexedDB?: IDBFactory;
}

/** Where drafts are kept: 'indexeddb' (survive reloads) or 'memory' (this tab only). Not part of the contract. */
export type DraftPersistence = 'indexeddb' | 'memory';

const revOf = (r: DraftRecord | undefined): number => (r && typeof r.rev === 'number' ? r.rev : 0);

export function createDraftStore(
  dbName = DRAFT_DB,
  options: DraftStoreOptions = {},
): DraftStore & { persistence(): Promise<DraftPersistence>; close(): void } {
  let dbPromise: Promise<IDBDatabase | null> | undefined;
  /** The open connection, once there is one: lets a write start without awaiting anything. */
  let openConnection: IDBDatabase | null = null;
  /** Session fallback when IndexedDB is unusable; also used to answer reads after a failed open. */
  const memory = new Map<string, DraftRecord>();
  const listeners = new Set<(event: DraftEvent) => void>();
  let channel: BroadcastChannel | null | undefined;

  function database(): Promise<IDBDatabase | null> {
    if (!dbPromise) {
      const factory = options.indexedDB ?? (typeof indexedDB === 'undefined' ? undefined : indexedDB);
      dbPromise = factory
        ? openDb(dbName, factory).then(
            (db) => {
              openConnection = db;
              // A closed connection (version change, browser eviction) is reopened on next use.
              db.onclose = () => {
                dbPromise = undefined;
                openConnection = null;
              };
              const onversionchange = db.onversionchange;
              db.onversionchange = (e) => {
                onversionchange?.call(db, e);
                dbPromise = undefined;
                openConnection = null;
              };
              return db;
            },
            () => {
              dbPromise = undefined; // try again on the next call (e.g. once a blocking tab is gone)
              return null;
            },
          )
        : Promise.resolve(null);
    }
    return dbPromise;
  }

  function broadcast(): BroadcastChannel | null {
    if (channel !== undefined) return channel;
    channel = null;
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        channel = new BroadcastChannel(`${CHANNEL}:${dbName}`);
        channel.onmessage = (e: MessageEvent<{ type?: unknown; id?: unknown }>) => {
          const event = e.data;
          if (event && (event.type === 'put' || event.type === 'delete') && typeof event.id === 'string') {
            const remote: DraftEvent = { type: event.type, id: event.id, origin: 'remote' };
            listeners.forEach((l) => l(remote));
          }
        };
        // Node (tests): do not keep the process alive for the channel.
        (channel as unknown as { unref?: () => void }).unref?.();
      } catch {
        channel = null;
      }
    }
    return channel;
  }

  function emit(type: DraftEvent['type'], id: string): void {
    const event: DraftEvent = { type, id, origin: 'local' };
    listeners.forEach((l) => l(event));
    try {
      broadcast()?.postMessage({ type, id });
    } catch {
      /* other tabs will see the change when they next read */
    }
  }

  /**
   * One readwrite transaction over both stores. `run` is called in the caller's own turn when the
   * database is already open. It may throw (or call `tx.abort()` after noting why in `refusal`).
   */
  function write(
    run: (records: IDBObjectStore, index: IDBObjectStore, tx: IDBTransaction, assets: IDBObjectStore) => void,
    refusal: { error?: unknown } = {},
  ): Promise<void> {
    const start = (db: IDBDatabase | null): Promise<void> => {
      if (!db) return Promise.reject(new DraftStoreError(UNAVAILABLE, 'unavailable'));
      try {
        const tx = db.transaction([RECORDS, INDEX, ASSETS], 'readwrite');
        const done = txDone(tx);
        run(tx.objectStore(RECORDS), tx.objectStore(INDEX), tx, tx.objectStore(ASSETS));
        return done.catch((err) => {
          throw refusal.error ?? toStoreError(err);
        });
      } catch (err) {
        return Promise.reject(refusal.error ?? toStoreError(err));
      }
    };
    return openConnection ? start(openConnection) : database().then(start);
  }

  /** Apply `change` to the stored record unless `expectedRev` is given and stale. */
  function checkedWrite(
    id: string,
    expectedRev: number | undefined,
    change: (records: IDBObjectStore, index: IDBObjectStore, assets: IDBObjectStore) => void,
  ): Promise<void> {
    const refusal: { error?: unknown } = {};
    return write((records, index, tx, assets) => {
      if (expectedRev === undefined) {
        change(records, index, assets);
        return;
      }
      const read = records.get(id);
      read.onsuccess = () => {
        const current = read.result as DraftRecord | undefined;
        if (revOf(current) !== expectedRev) {
          refusal.error = new DraftConflictError(id, current);
          tx.abort();
          return;
        }
        change(records, index, assets);
      };
    }, refusal);
  }

  /** Make the `assets` store hold exactly this draft's images, writing bytes only when the set changed. */
  function storeImages(assets: IDBObjectStore, id: string, images: PendingImage[] | undefined): void {
    if (!images || images.length === 0) {
      assets.delete(tagsKey(id));
      assets.delete(bytesKey(id));
      return;
    }
    const tags = images.map(tagOf);
    // Only the tag list is read: the bytes stay where they are unless the set of images changed.
    const read = assets.get(tagsKey(id));
    read.onsuccess = () => {
      const stored = read.result as string[] | undefined;
      if (Array.isArray(stored) && stored.length === tags.length && stored.every((t, i) => t === tags[i])) return;
      const items: StoredImage[] = [];
      images.forEach((a, i) => {
        const bytes = knownBytes.get(a.data);
        if (bytes) items.push({ name: a.name, tag: tags[i], type: a.type, bytes });
      });
      assets.put(
        items.map((item) => item.tag),
        tagsKey(id),
      );
      assets.put(items, bytesKey(id));
    };
  }

  return {
    async get(id) {
      // A copy that could not be persisted is newer than anything stored.
      const unsaved = memory.get(id);
      if (unsaved) return unsaved;
      const db = await database();
      if (!db) return undefined;
      try {
        // Both requests are issued before anything is awaited, inside one transaction.
        const tx = db.transaction([RECORDS, ASSETS], 'readonly');
        const [record, stored] = await Promise.all([
          requestDone(tx.objectStore(RECORDS).get(id)) as Promise<DraftRecord | undefined>,
          requestDone(tx.objectStore(ASSETS).get(bytesKey(id))) as Promise<StoredImage[] | undefined>,
        ]);
        return record ? withImageData(record, stored) : undefined;
      } catch {
        return undefined;
      }
    },

    // Not `async`: the request must be issued before this function returns (see the header).
    put(record, options: DraftWriteOptions = {}) {
      const copy = plain(record);
      // The counter this write is based on: what the caller says is stored, else what the record carries.
      const rev = (options.expectedRev ?? revOf(copy)) + 1;
      copy.rev = rev;
      const held = memory.get(copy.id);
      if (held && options.expectedRev !== undefined && revOf(held) !== options.expectedRev) {
        return Promise.reject(new DraftConflictError(copy.id, held));
      }
      const store = () =>
        checkedWrite(copy.id, options.expectedRev, (records, index, assets) => {
          records.put(withoutImageData(copy), copy.id);
          index.put(summarise(copy), copy.id);
          storeImages(assets, copy.id, copy.assets);
        });
      // An image met for the first time: its bytes are read before the write can start.
      const unread = (copy.assets ?? []).filter((a) => !knownBytes.has(a.data));
      const written =
        unread.length === 0
          ? store()
          : Promise.all(unread.map(async (a) => void knownBytes.set(a.data, await a.data.arrayBuffer()))).then(store, (err) => {
              throw toStoreError(err);
            });
      return written.then(
        () => {
          memory.delete(copy.id);
          emit('put', copy.id);
          return rev;
        },
        (err) => {
          if (err instanceof DraftConflictError) throw err;
          // Keep the session usable, then tell the caller the truth.
          memory.set(copy.id, copy);
          emit('put', copy.id);
          throw err;
        },
      );
    },

    async delete(id, options: DraftWriteOptions = {}) {
      const held = memory.get(id);
      if (held && options.expectedRev !== undefined && revOf(held) !== options.expectedRev) throw new DraftConflictError(id, held);
      const had = memory.delete(id);
      try {
        await checkedWrite(id, options.expectedRev, (records, index, assets) => {
          records.delete(id);
          index.delete(id);
          assets.delete(tagsKey(id));
          assets.delete(bytesKey(id));
        });
      } catch (err) {
        if (err instanceof DraftConflictError) {
          if (held) memory.set(id, held);
          throw err;
        }
        // Nothing persistent to delete when storage is unavailable: the memory copy is gone, that is all there was.
        if (!((err as DraftStoreError).reason === 'unavailable')) throw err;
        if (!had) return;
      }
      emit('delete', id);
    },

    async list() {
      const db = await database();
      let stored: DraftSummary[] = [];
      if (db) {
        try {
          stored = (await requestDone(db.transaction(INDEX, 'readonly').objectStore(INDEX).getAll())) as DraftSummary[];
        } catch {
          stored = [];
        }
      }
      const inMemory = [...memory.values()].map(summarise);
      const ids = new Set(inMemory.map((s) => s.id));
      return [...inMemory, ...stored.filter((s) => !ids.has(s.id))].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1));
    },

    subscribe(listener) {
      listeners.add(listener);
      broadcast();
      return () => void listeners.delete(listener);
    },

    async persistence() {
      return (await database()) ? 'indexeddb' : 'memory';
    },

    close() {
      void dbPromise?.then((db) => db?.close());
      dbPromise = undefined;
      openConnection = null;
      channel?.close();
      channel = undefined;
    },
  };
}
