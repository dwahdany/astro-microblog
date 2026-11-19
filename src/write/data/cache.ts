/**
 * A tiny persistent key-value cache for the GitHub source (IndexedDB through
 * idb-keyval). Strictly best-effort: every failure — private mode, quota, a
 * blocked database — degrades to "not cached" and never surfaces to callers.
 */
import { clear, createStore, delMany, getMany, keys, setMany, type UseStore } from 'idb-keyval';

export interface KeyValueCache {
  getMany(keys: string[]): Promise<unknown[]>;
  setMany(entries: [string, unknown][]): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
  keys(): Promise<string[]>;
  clear(): Promise<void>;
}

export const CACHE_DB = 'write-source-cache';

export function createIdbCache(dbName = CACHE_DB): KeyValueCache {
  let store: UseStore | undefined | null;
  const db = (): UseStore | null => {
    if (store !== undefined) return store;
    try {
      store = typeof indexedDB === 'undefined' ? null : createStore(dbName, 'kv');
    } catch {
      store = null;
    }
    return store;
  };
  const guard = async <T>(fallback: T, run: (s: UseStore) => Promise<T>): Promise<T> => {
    const s = db();
    if (!s) return fallback;
    try {
      return await run(s);
    } catch {
      return fallback;
    }
  };

  return {
    getMany: (ks) => guard(ks.map(() => undefined) as unknown[], (s) => getMany(ks, s)),
    setMany: (entries) => guard(undefined, (s) => setMany(entries, s)),
    deleteMany: (ks) => guard(undefined, (s) => delMany(ks, s)),
    keys: () => guard([] as string[], async (s) => (await keys(s)).filter((k): k is string => typeof k === 'string')),
    clear: () => guard(undefined, (s) => clear(s)),
  };
}

/** In-memory cache: for tests, and as the fallback where IndexedDB does not exist. */
export function createMemoryCache(): KeyValueCache & { map: Map<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    map,
    getMany: async (ks) => ks.map((k) => map.get(k)),
    setMany: async (entries) => {
      for (const [k, v] of entries) map.set(k, v);
    },
    deleteMany: async (ks) => {
      for (const k of ks) map.delete(k);
    },
    keys: async () => [...map.keys()],
    clear: async () => map.clear(),
  };
}
