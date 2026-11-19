/**
 * Production content source: the public GitHub repo — read anonymously, or with the signed-in
 * token (5000 API requests an hour instead of 60 per IP), and written through `save()` once
 * someone is signed in (see ./github/save.ts and ./github/commit.ts).
 *
 *   listing   ONE call to the git-trees API for the `src/content` subtree
 *             (`…/git/trees/<branch>:src/content?recursive=1`, ~75 kB). It
 *             yields every file's path and blob sha. This is the only request
 *             that counts against GitHub's anonymous limit (60/hour per IP).
 *   content   raw.githubusercontent.com, one request per file, no rate limit —
 *             and only for files whose blob sha is not cached yet.
 *
 * Caching (see ./README.md):
 *   - text is cached by BLOB SHA, in memory and in IndexedDB. A sha names
 *     content, so an entry is never stale; a warm visit fetches no post text.
 *   - the listing is kept too (IndexedDB). It is reused as-is for 60 s (a
 *     reload costs nothing) and is the fallback when GitHub cannot be reached.
 *   - every fetched file is hashed locally (git blob sha). raw's CDN can lag
 *     up to five minutes behind a push; when the bytes do not match the sha
 *     the listing promised, the exact blob is fetched from the API instead,
 *     and a text is only ever cached under the sha it really has.
 *
 * Degradation: offline or rate-limited with a cache → the cached listing and
 * texts are served and `status()` says so. Without a cache (a first visit, or
 * site data was cleared) the listing falls back to the MANIFEST the site build
 * writes next to the app (`/write/manifest.json`: path + blob sha of every
 * post as of the last deploy), so a phone behind a carrier's shared address —
 * where the 60 anonymous API calls per hour are everyone's — still gets a
 * list; texts come from raw.githubusercontent.com, which is not rate-limited.
 * Only with neither does `list()` reject, with a `SourceUnavailableError`
 * whose message can be shown as-is.
 *
 * Signed in (`options.auth`): the listing and the exact-blob fallback carry the token; `canSave`
 * is true and `save()` commits. After a commit the listing, the text cache and the image overlay
 * are updated from what was committed, so the next `list()` / `load()` show the post as saved
 * without asking GitHub again. Signed out: `save()` rejects with `ReadOnlyError`.
 */
import {
  CONTENT_ROOT,
  PostNotFoundError,
  ReadOnlyError,
  SITE_ORIGIN,
  SaveConflictError,
  type ContentSource,
  type FrontmatterApi,
  type ListOptions,
  type LoadedPost,
  type PostRef,
  type AuthState,
  type SaveRequest,
  type SaveResult,
} from '../contracts';
import { imageFolder } from './assets/names';
import type { PendingImages } from './assets/pending';
import { createIdbCache, type KeyValueCache } from './cache';
import { classifyFailure, createGithubClient, type TokenSource } from './github/client';
import { createCommitter, type CommitterOptions } from './github/commit';
import { fetchBlobBytes, fetchContentTree } from './github/read';
import { runSave } from './github/save';
import { byNewest } from './describe';
import { SourceUnavailableError, isAbortError, type UnavailableReason } from './errors';
import { decodeUtf8, gitBlobSha } from './git-sha';
import { assetRepoPath, encodePath, isPostPath, resolveAsset } from './paths';
import { createStatus, type SourceStatus, type StatusReporter } from './status';

export interface Repo {
  owner: string;
  name: string;
  branch: string;
}

export interface GithubSourceOptions {
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Defaults to an IndexedDB-backed cache; pass a memory cache in tests. */
  cache?: KeyValueCache;
  now?: () => number;
  /** A stored listing younger than this is reused without asking GitHub (unless `refresh`). Default 60 s. */
  listingTtlMs?: number;
  /** Parallel raw downloads. Default 8. */
  concurrency?: number;
  /**
   * URL of the build-time manifest (see src/write/build/manifest.mjs), used as the listing when
   * the GitHub API cannot answer. Unset: no fallback beyond the cache.
   */
  manifestUrl?: string;
  /**
   * The session (./github/session.ts). With it the source sends the token when someone is signed
   * in, `canSave` follows the sign-in state and `save()` commits. Without it: anonymous, read-only.
   */
  auth?: SourceAuth;
  /** `blob:` URLs for images that are not in the repo yet / were just committed (./assets/pending.ts). */
  images?: PendingImages;
  /** Passed to the committer (tests: strategy, clock, first payload size). */
  commit?: CommitterOptions;
  /** How often a save looks again when the branch moved under it. Default 3. */
  saveAttempts?: number;
}

/** The part of the session the source uses. */
export interface SourceAuth extends TokenSource {
  state(): AuthState;
  onChange(listener: (state: AuthState) => void): () => void;
}

interface TreeFile {
  sha: string;
  size: number;
}

interface Listing {
  fetchedAt: number;
  /** Repo path → blob, for every file under src/content (posts and their images). */
  files: Map<string, TreeFile>;
  /** GitHub cut the tree short (over 100,000 entries or 7 MB): some posts may be missing. Said in `status()`. */
  truncated: boolean;
  /** 'manifest': from the site build, not from GitHub. */
  origin?: 'manifest';
}

/** What is persisted for a listing (a Map does survive structured clone, but plain data ages better). */
interface StoredListing {
  v: 1;
  fetchedAt: number;
  truncated: boolean;
  files: [path: string, sha: string, size: number][];
}

export type GithubSource = ContentSource &
  StatusReporter & {
    /** Resolves when background cache writes and cleanup have settled (tests). */
    idle(): Promise<void>;
    /**
     * File names in the post's image folder (`<dir>/<stem>/`) as of the listing in use: what a
     * new image's name must not collide with, and what moves along when the post is renamed.
     * Empty before the first `list()`.
     */
    imageNames(postPath: string): string[];
    /** Commits made so far and how many the running save expects to make (split saves). Returns unsubscribe. */
    onSaveProgress(listener: (done: number, total: number) => void): () => void;
  };

const API = 'https://api.github.com';
const BLOB = 'blob:';

function clock(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return new Date(ms).toISOString().slice(11, 16) + ' UTC';
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

export function createGithubSource(repo: Repo, fm: FrontmatterApi, options: GithubSourceOptions = {}): GithubSource {
  const doFetch: typeof fetch = (input, init) => (options.fetch ?? globalThis.fetch)(input, init);
  const cache = options.cache ?? createIdbCache();
  const now = options.now ?? Date.now;
  const ttl = options.listingTtlMs ?? 60_000;
  const concurrency = options.concurrency ?? 8;

  const label = `${repo.owner}/${repo.name}@${repo.branch}`;
  const rawBase = `https://raw.githubusercontent.com/${repo.owner}/${repo.name}/${repo.branch}/`;
  const repoApi = `${API}/repos/${repo.owner}/${repo.name}`;
  const treeUrl = `${repoApi}/git/trees/${encodeURIComponent(repo.branch)}:${CONTENT_ROOT}?recursive=1`;
  const listingKey = `listing:${label}`;

  const auth = options.auth;
  const signedIn = (): boolean => auth?.state().status === 'signed-in';
  const client = createGithubClient({ repo, auth, fetch: doFetch });
  const committer = createCommitter(client, options.commit);
  const progressListeners = new Set<(done: number, total: number) => void>();
  /**
   * Paths this session removed (a delete, the old address of a rename). raw.githubusercontent.com
   * keeps serving them for minutes; `load` must not bring such a file back.
   */
  const removedHere = new Set<string>();

  const status = createStatus();
  /** Text by blob sha, for this session. */
  const texts = new Map<string, string>();
  let listing: Listing | undefined;
  let listPromise: Promise<PostRef[]> | undefined;
  let rateLimit: SourceStatus['rateLimit'];
  let background: Promise<unknown> = Promise.resolve();
  const later = (work: Promise<unknown>) => {
    background = Promise.allSettled([background, work]);
  };

  /* ---------------------------------------------------------------- cache */

  async function storedListing(): Promise<Listing | undefined> {
    const [value] = await cache.getMany([listingKey]);
    const stored = value as StoredListing | undefined;
    if (!stored || stored.v !== 1 || !Array.isArray(stored.files)) return undefined;
    return {
      fetchedAt: stored.fetchedAt,
      truncated: stored.truncated,
      files: new Map(stored.files.map(([path, sha, size]) => [path, { sha, size }])),
    };
  }

  function storeListing(l: Listing): Promise<void> {
    const stored: StoredListing = {
      v: 1,
      fetchedAt: l.fetchedAt,
      truncated: l.truncated,
      files: [...l.files].map(([path, f]) => [path, f.sha, f.size]),
    };
    return cache.setMany([[listingKey, stored]]);
  }

  async function cachedText(sha: string): Promise<string | undefined> {
    const hit = texts.get(sha);
    if (hit !== undefined) return hit;
    const [value] = await cache.getMany([BLOB + sha]);
    if (typeof value !== 'string') return undefined;
    texts.set(sha, value);
    return value;
  }

  /** Drop cached texts no file of the current listing refers to any more. */
  async function collectGarbage(l: Listing): Promise<void> {
    const live = new Set([...l.files.values()].map((f) => BLOB + f.sha));
    const dead = (await cache.keys()).filter((k) => k.startsWith(BLOB) && !live.has(k));
    if (dead.length > 0) await cache.deleteMany(dead);
  }

  /* -------------------------------------------------------------- network */

  function noteRateLimit(res: Response): void {
    const limit = Number(res.headers.get('x-ratelimit-limit'));
    const remaining = Number(res.headers.get('x-ratelimit-remaining'));
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (res.headers.get('x-ratelimit-limit') !== null && Number.isFinite(limit) && Number.isFinite(remaining))
      rateLimit = { limit, remaining, resetAt: Number.isFinite(reset) ? reset * 1000 : 0 };
  }

  function rateLimitReset(res: Response): number | undefined {
    if (res.status !== 403 && res.status !== 429) return undefined;
    const retryAfter = Number(res.headers.get('retry-after'));
    if (res.headers.get('retry-after') !== null && Number.isFinite(retryAfter)) return now() + retryAfter * 1000;
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      return Number.isFinite(reset) && reset > 0 ? reset * 1000 : now() + 60 * 60_000;
    }
    return undefined;
  }

  interface Failure {
    reason: UnavailableReason;
    message: string;
    retryAt?: number;
    status?: number;
  }

  function describeFailure(res: Response | undefined): Failure {
    if (!res) return { reason: 'offline', message: 'GitHub cannot be reached — this device seems to be offline.' };
    const retryAt = rateLimitReset(res);
    if (retryAt !== undefined)
      return {
        reason: 'rate-limited',
        message: signedIn()
          ? `GitHub is limiting requests until ${clock(retryAt)}.`
          : `GitHub is limiting anonymous requests from this network until ${clock(retryAt)}.`,
        retryAt,
        status: res.status,
      };
    return { reason: 'http', message: `GitHub answered with an error (${res.status}).`, status: res.status };
  }

  const unavailable = (f: Failure, tail = ' Nothing is cached on this device yet, so there is nothing to show.') =>
    new SourceUnavailableError(f.message + tail, f.reason, f.retryAt, f.status);

  /** The listing the site build wrote, when there is one and it can be fetched. */
  async function manifestListing(signal?: AbortSignal): Promise<Listing | undefined> {
    if (!options.manifestUrl) return undefined;
    try {
      const res = await doFetch(options.manifestUrl, { signal, cache: 'no-cache' });
      if (!res.ok) return undefined;
      const stored = (await res.json()) as StoredListing | undefined;
      if (!stored || stored.v !== 1 || !Array.isArray(stored.files) || typeof stored.fetchedAt !== 'number') return undefined;
      const files = new Map<string, TreeFile>();
      for (const entry of stored.files) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string') files.set(entry[0], { sha: entry[1], size: Number(entry[2]) || 0 });
      }
      return files.size > 0 ? { fetchedAt: stored.fetchedAt, truncated: false, files, origin: 'manifest' } : undefined;
    } catch (err) {
      if (isAbortError(err)) throw err;
      return undefined;
    }
  }

  const day = (ms: number): string => {
    try {
      return new Date(ms).toLocaleDateString([], { day: 'numeric', month: 'short' });
    } catch {
      return new Date(ms).toISOString().slice(0, 10);
    }
  };

  function markStale(f: Failure, l: Listing | undefined): void {
    status.set({
      state: 'stale',
      reason: f.reason,
      message: !l
        ? f.message
        : l.origin === 'manifest'
          ? `${f.message} Showing the posts as of the last site build (${day(l.fetchedAt)}, ${clock(l.fetchedAt)}); newer ones may be missing.`
          : `${f.message} Showing the copy saved at ${clock(l.fetchedAt)}.`,
      fetchedAt: l?.fetchedAt,
      retryAt: f.retryAt,
      rateLimit,
    });
  }

  /** The listing, from GitHub when possible, else from the cache (marking the status stale). */
  async function loadListing(opts: ListOptions): Promise<Listing> {
    const cached = listing ?? (await storedListing());
    if (!opts.refresh && cached && now() - cached.fetchedAt < ttl) {
      listing = cached;
      status.set({ state: 'fresh', fetchedAt: cached.fetchedAt, rateLimit });
      return cached;
    }

    // Signed in: the same listing with the token (not counted against the 60 anonymous requests an
    // hour), complete even when GitHub cuts the tree short. If the session turns out to be over,
    // or anything else goes wrong, the anonymous request below still gets its chance.
    if (signedIn()) {
      try {
        const files = await fetchContentTree(client, repo.branch, CONTENT_ROOT, opts.signal);
        const fresh: Listing = { fetchedAt: now(), files, truncated: false };
        listing = fresh;
        status.set({ state: 'fresh', fetchedAt: fresh.fetchedAt, rateLimit });
        later(storeListing(fresh).then(() => collectGarbage(fresh)));
        return fresh;
      } catch (err) {
        if (isAbortError(err)) throw err;
      }
    }

    let res: Response | undefined;
    try {
      res = await doFetch(treeUrl, {
        signal: opts.signal,
        headers: { Accept: 'application/vnd.github+json' },
        // `refresh` must not be answered from the browser's 60 s HTTP cache.
        cache: opts.refresh ? 'no-cache' : 'default',
      });
    } catch (err) {
      if (isAbortError(err)) throw err;
    }
    if (res) noteRateLimit(res);

    if (res?.ok) {
      let body: { tree?: { path: string; type: string; sha: string; size?: number }[]; truncated?: boolean } | undefined;
      try {
        body = await res.json();
      } catch (err) {
        if (isAbortError(err)) throw err;
        // Not JSON: a captive portal or proxy answered instead of GitHub.
      }
      if (body && Array.isArray(body.tree)) {
        const files = new Map<string, TreeFile>();
        for (const e of body.tree) {
          if (e.type === 'blob') files.set(`${CONTENT_ROOT}/${e.path}`, { sha: e.sha, size: e.size ?? 0 });
        }
        const fresh: Listing = { fetchedAt: now(), files, truncated: body.truncated === true };
        listing = fresh;
        if (fresh.truncated) {
          // Never seen for this repo (the limit is 100,000 entries), but a short list must not pass as the whole one.
          status.set({
            state: 'stale',
            reason: 'http',
            message: 'GitHub returned only part of the file list, so some posts may be missing here.',
            fetchedAt: fresh.fetchedAt,
            rateLimit,
          });
        } else status.set({ state: 'fresh', fetchedAt: fresh.fetchedAt, rateLimit });
        later(storeListing(fresh).then(() => collectGarbage(fresh)));
        return fresh;
      }
      res = undefined;
    }

    const failure = describeFailure(res);
    // GitHub did not answer. Fall back to the newest listing there is: the copy kept on this
    // device, or the one the site build wrote (always there, even on a first visit).
    const built = await manifestListing(opts.signal);
    const fallback = cached && built ? (built.fetchedAt > cached.fetchedAt ? built : cached) : (cached ?? built);
    if (!fallback) throw unavailable(failure);
    listing = fallback;
    markStale(failure, fallback);
    return fallback;
  }

  async function fetchBytes(url: string, init: RequestInit): Promise<{ res: Response; bytes?: Uint8Array }> {
    const res = await doFetch(url, init);
    return res.ok ? { res, bytes: new Uint8Array(await res.arrayBuffer()) } : { res };
  }

  /**
   * One file's text from the network. `expectedSha` (from the listing) makes
   * the result exact: bytes that hash to something else are replaced by the
   * blob fetched by sha from the API. Returns the sha the text REALLY has.
   */
  async function download(path: string, expectedSha: string | undefined, signal?: AbortSignal): Promise<{ raw: string; sha?: string }> {
    let bytes: Uint8Array | undefined;
    let sha: string | undefined;
    let failure: Failure | undefined;

    try {
      const got = await fetchBytes(rawBase + encodePath(path), { signal });
      if (got.bytes) {
        bytes = got.bytes;
        sha = await gitBlobSha(bytes);
      } else if (got.res.status !== 404) failure = describeFailure(got.res);
    } catch (err) {
      if (isAbortError(err)) throw err;
      failure = describeFailure(undefined);
    }

    const lagging = expectedSha !== undefined && !failure && (!bytes || (sha !== undefined && sha !== expectedSha));
    if (lagging) {
      // raw's CDN has not caught up with the listing: fetch exactly this blob (1 API request,
      // with the token when signed in).
      try {
        let exact: Uint8Array | undefined;
        if (signedIn()) {
          exact = await fetchBlobBytes(client, expectedSha as string, signal).catch((err) => {
            if (isAbortError(err)) throw err;
            // Not there (404) is an answer; anything else must not turn into "no such post".
            if (classifyFailure(err).kind !== 'not-found') failure = { reason: 'http', message: 'GitHub could not be reached for this post.' };
            return undefined;
          });
        } else {
          const got = await fetchBytes(`${repoApi}/git/blobs/${expectedSha}`, {
            signal,
            headers: { Accept: 'application/vnd.github.raw+json' },
          });
          noteRateLimit(got.res);
          exact = got.bytes;
        }
        if (exact) {
          const exactSha = await gitBlobSha(exact);
          if (exactSha === undefined || exactSha === expectedSha) {
            bytes = exact;
            sha = exactSha ?? expectedSha;
          }
        }
      } catch (err) {
        if (isAbortError(err)) throw err;
      }
    }

    if (!bytes) {
      if (failure) throw unavailable(failure, '');
      throw new PostNotFoundError(path);
    }
    const raw = decodeUtf8(bytes);
    if (sha !== undefined) {
      // Verified content address: safe to keep forever.
      texts.set(sha, raw);
      later(cache.setMany([[BLOB + sha, raw]]));
    }
    return { raw, sha };
  }

  const loaded = (path: string, raw: string, sha: string | undefined): LoadedPost => ({
    ref: fm.describe(path, raw, { sha }),
    raw,
    parts: fm.split(raw),
    eol: fm.eol(raw),
  });

  /* ------------------------------------------------------------- contract */

  async function buildList(opts: ListOptions): Promise<PostRef[]> {
    const l = await loadListing(opts);
    const posts = [...l.files].filter(([path]) => isPostPath(path));

    // Texts already on this device: memory first, then one IndexedDB read for the rest.
    const unknown = posts.filter(([, f]) => !texts.has(f.sha));
    if (unknown.length > 0) {
      const hits = await cache.getMany(unknown.map(([, f]) => BLOB + f.sha));
      hits.forEach((value, i) => {
        if (typeof value === 'string') texts.set(unknown[i][1].sha, value);
      });
    }

    let firstFailure: unknown;
    const refs = await mapLimit(posts, concurrency, async ([path, f]): Promise<PostRef | null> => {
      const hit = texts.get(f.sha);
      if (hit !== undefined) return fm.describe(path, hit, { sha: f.sha });
      try {
        const { raw, sha } = await download(path, f.sha, opts.signal);
        return fm.describe(path, raw, { sha });
      } catch (err) {
        if (isAbortError(err)) throw err;
        firstFailure ??= err;
        return null;
      }
    });

    const found = refs.filter((r): r is PostRef => r !== null);
    const missing = refs.length - found.length;
    if (missing > 0) {
      const failure: Failure =
        firstFailure instanceof SourceUnavailableError
          ? { reason: firstFailure.reason, message: firstFailure.message, retryAt: firstFailure.retryAt }
          : { reason: 'http', message: 'Some posts could not be read from GitHub.' };
      if (found.length === 0) throw unavailable(failure);
      status.set({
        state: 'stale',
        reason: failure.reason,
        message: `${failure.message} ${missing} of ${refs.length} posts could not be loaded and are missing from the list.`,
        fetchedAt: l.fetchedAt,
        retryAt: failure.retryAt,
        rateLimit,
      });
    }
    return found.sort(byNewest);
  }

  /**
   * Make the caches say what the commit made true: the listing (from the complete tree the save
   * was planned on, plus what it wrote, minus what it removed), the committed text under its new
   * blob sha, and the committed images in the overlay (raw's CDN will lag behind for minutes).
   */
  function applySave(req: SaveRequest, outcome: Awaited<ReturnType<typeof runSave>>): void {
    const { plan, tree } = outcome;
    const files = new Map(tree);
    for (const path of plan.removed) {
      files.delete(path);
      removedHere.add(path);
    }
    for (const [path, file] of plan.written) {
      files.set(path, file);
      removedHere.delete(path);
    }
    const next: Listing = { fetchedAt: now(), files, truncated: false };
    listing = next;
    listPromise = undefined; // the next list() is rebuilt from this listing — no request
    status.set({ state: 'fresh', fetchedAt: next.fetchedAt, rateLimit });
    const writes: Promise<unknown>[] = [storeListing(next)];
    if (!req.delete && plan.sha) {
      texts.set(plan.sha, req.raw);
      writes.push(cache.setMany([[BLOB + plan.sha, req.raw]]));
    }
    if (options.images) {
      for (const [path, data] of plan.bytes) options.images.keep(path, new Blob([data as BlobPart]));
    }
    later(Promise.all(writes).then(() => collectGarbage(next)));
  }

  /**
   * Another tab of this app may have published since this tab last looked: a save stores its
   * listing (`applySave`), and so does every fresh fetch. Take over a stored listing that is newer
   * than this tab's, so a post opened here is the post as that tab left it — not the blob this
   * tab remembers, which would read as the publish undone. One local read, no request.
   */
  async function followOtherTabs(): Promise<void> {
    if (!listing) return;
    const mine = listing;
    const stored = await storedListing().catch(() => undefined);
    if (!stored || listing !== mine || stored.fetchedAt <= mine.fetchedAt) return;
    // What the newer listing no longer has was deleted or moved: raw's CDN must not bring it back.
    for (const path of mine.files.keys()) if (!stored.files.has(path)) removedHere.add(path);
    for (const path of stored.files.keys()) removedHere.delete(path);
    listing = stored;
    listPromise = undefined;
  }

  return {
    kind: 'github',
    label,
    get canSave() {
      return signedIn();
    },

    list(opts: ListOptions = {}) {
      if (opts.refresh) listPromise = undefined;
      if (!listPromise) {
        const attempt: Promise<PostRef[]> = buildList(opts).catch((err) => {
          // Do not cache a failure — but only forget THIS attempt: a refresh may have replaced it meanwhile.
          if (listPromise === attempt) listPromise = undefined;
          throw err;
        });
        listPromise = attempt;
      }
      // Callers get their own array: sorting or filtering it must not affect the cache.
      return listPromise.then((refs) => refs.slice());
    },

    async load(path, opts): Promise<LoadedPost> {
      if (!path.startsWith(CONTENT_ROOT + '/') || !path.endsWith('.md')) throw new PostNotFoundError(path);

      await followOtherTabs();
      // Consistent with the list shown in this session: same sha → same text.
      const known = listing?.files.get(path);
      if (!known && removedHere.has(path)) throw new PostNotFoundError(path);
      if (known) {
        const hit = await cachedText(known.sha);
        if (hit !== undefined) return loaded(path, hit, known.sha);
      }

      try {
        const { raw, sha } = await download(path, known?.sha, opts?.signal);
        return loaded(path, raw, sha);
      } catch (err) {
        if (!(err instanceof SourceUnavailableError)) throw err;
        // Could not reach GitHub: an earlier session may have this post.
        const earlier = known ?? (await storedListing())?.files.get(path);
        const hit = earlier ? await cachedText(earlier.sha) : undefined;
        if (earlier && hit !== undefined) {
          markStale({ reason: err.reason, message: err.message, retryAt: err.retryAt }, listing);
          return loaded(path, hit, earlier.sha);
        }
        throw new SourceUnavailableError(
          `${err.message} This post is not cached on this device.`,
          err.reason,
          err.retryAt,
          err.status,
        );
      }
    },

    resolveAssetUrl(postPath, src) {
      // An image of a draft, or one just committed, is shown from the bytes on this device.
      if (options.images) {
        const repoPath = assetRepoPath(postPath, src);
        const local = repoPath ? options.images.url(repoPath) : null;
        if (local) return local;
      }
      return resolveAsset(postPath, src, { repoBase: rawBase, siteBase: SITE_ORIGIN });
    },

    async save(req: SaveRequest): Promise<SaveResult> {
      if (!signedIn()) throw new ReadOnlyError('Sign in to publish. Until then, copy or download the markdown.');
      let outcome: Awaited<ReturnType<typeof runSave>>;
      try {
        outcome = await runSave(req, {
          client,
          committer,
          attempts: options.saveAttempts,
          onProgress: (done, total) => progressListeners.forEach((l) => l(done, total)),
        });
      } catch (err) {
        // The save found the post changed (or gone) in the repo. The listing this session holds still
        // names the old blob, and `load` would fetch exactly that one again — the caller, re-reading
        // the post to show the conflict, would be handed the stale text. Make the listing say what
        // the save saw.
        if (err instanceof SaveConflictError && listing && err.path === (req.previousPath ?? req.path)) {
          if (err.reason === 'changed' && err.currentSha) {
            listing.files.set(err.path, { sha: err.currentSha, size: listing.files.get(err.path)?.size ?? 0 });
            listPromise = undefined;
          } else if (err.reason === 'missing') {
            listing.files.delete(err.path);
            removedHere.add(err.path);
            listPromise = undefined;
          }
        }
        throw err;
      }
      applySave(req, outcome);
      return outcome.result;
    },

    onAuthChange(listener) {
      if (!auth) return () => {};
      // Fires when `canSave` flips or another account signs in — not for every token refresh.
      let before = `${signedIn()}:${auth.state().user?.login ?? ''}`;
      return auth.onChange(() => {
        const after = `${signedIn()}:${auth.state().user?.login ?? ''}`;
        if (after === before) return;
        before = after;
        listener();
      });
    },

    imageNames(postPath) {
      const folder = imageFolder(postPath) + '/';
      const names: string[] = [];
      for (const path of listing?.files.keys() ?? []) {
        if (path.startsWith(folder) && !path.slice(folder.length).includes('/')) names.push(path.slice(folder.length));
      }
      return names;
    },

    onSaveProgress(listener) {
      progressListeners.add(listener);
      return () => void progressListeners.delete(listener);
    },

    status: () => status.get(),
    onStatus: (listener) => status.subscribe(listener),
    idle: async () => {
      // Work queued while waiting is awaited too.
      let seen: unknown;
      do {
        seen = background;
        await seen;
      } while (seen !== background);
    },
  };
}
