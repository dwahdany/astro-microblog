/**
 * Dev content source: the working tree, through the Vite dev server. Works
 * offline and shows uncommitted files.
 *
 *   text     the lazy `?raw` modules of ./local-files.ts (exact bytes on disk)
 *   images   Vite serves project files by root-relative path, so a relative
 *            image resolves to `/src/content/<dir>/<file>`
 *   sha      the git blob id of each file, computed locally — the same id the
 *            GitHub source reports, so drafts carry a comparable `baseSha`
 *
 * Freshness: a `?raw` module, once imported, is cached by the browser. So
 * `list({ refresh: true })` and every `load()` ask the dev server for the
 * file's current text instead (see `readFresh`), falling back to the module.
 * Files ADDED to the working tree appear after a page reload (the glob is
 * expanded when ./local-files.ts is served).
 */
import {
  CONTENT_ROOT,
  PostNotFoundError,
  ReadOnlyError,
  type ContentSource,
  type FrontmatterApi,
  type ListOptions,
  type LoadedPost,
  type PostRef,
  type SaveRequest,
  type SaveResult,
} from '../contracts';
import { byNewest } from './describe';
import { decodeUtf8, gitBlobSha } from './git-sha';
import type { PendingImages } from './assets/pending';
import { assetRepoPath, encodePath, isPostPath, resolveAsset } from './paths';
import { createStatus, type StatusReporter } from './status';

export type FileMap = Record<string, () => Promise<string>>;

export interface LocalSourceOptions {
  /**
   * Reads one file's current text from the dev server, bypassing the module
   * cache; resolves undefined when it cannot (then the cached module is used).
   * Defaults to `readFresh` in a browser and to "cannot" elsewhere.
   */
  readFresh?: (path: string, signal?: AbortSignal) => Promise<string | undefined>;
  /** `blob:` URLs for a draft's images that are not on disk (./assets/pending.ts). */
  images?: PendingImages;
}

/**
 * A file's current text straight from the dev server, which serves project
 * files by root-relative path (`/src/content/notes/2026/x.md` → the bytes on
 * disk, `text/markdown`). Anything unexpected — another content type (an HTML
 * fallback page), an error, no browser — yields undefined and the caller
 * falls back to the imported module.
 */
export async function readFresh(path: string, signal?: AbortSignal): Promise<string | undefined> {
  if (typeof window === 'undefined' || typeof fetch !== 'function') return undefined;
  try {
    const res = await fetch('/' + encodePath(path), { cache: 'no-store', signal });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || !/^text\/(?:markdown|plain)\b/.test(type)) return undefined;
    return decodeUtf8(await res.arrayBuffer());
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    return undefined;
  }
}

export function createLocalSource(
  loadFiles: () => Promise<FileMap>,
  fm: FrontmatterApi,
  options: LocalSourceOptions = {},
): ContentSource & StatusReporter {
  const fresh = options.readFresh ?? readFresh;
  const status = createStatus();
  let filesPromise: Promise<FileMap> | undefined;
  let listPromise: Promise<PostRef[]> | undefined;
  const files = () =>
    (filesPromise ??= loadFiles().catch((err) => {
      filesPromise = undefined; // a failed import is retried on the next call
      throw err;
    }));

  async function read(path: string, wantFresh: boolean, signal?: AbortSignal): Promise<string> {
    const loader = (await files())['/' + path];
    if (!loader) throw new PostNotFoundError(path);
    if (wantFresh) {
      const text = await fresh(path, signal);
      if (text !== undefined) return text;
    }
    return loader();
  }

  async function buildList(opts: ListOptions): Promise<PostRef[]> {
    const paths = Object.keys(await files())
      .map((key) => key.replace(/^\//, ''))
      .filter(isPostPath);
    const refs = await Promise.all(
      paths.map(async (path) => {
        const raw = await read(path, opts.refresh === true, opts.signal);
        return fm.describe(path, raw, { sha: await gitBlobSha(raw) });
      }),
    );
    status.set({ state: 'fresh', fetchedAt: Date.now() });
    return refs.sort(byNewest);
  }

  return {
    kind: 'local',
    label: 'Working tree',
    canSave: false,

    list(opts: ListOptions = {}) {
      if (opts.refresh) listPromise = undefined;
      listPromise ??= buildList(opts).catch((err) => {
        listPromise = undefined;
        throw err;
      });
      return listPromise.then((refs) => refs.slice());
    },

    async load(path, opts): Promise<LoadedPost> {
      if (!path.startsWith(CONTENT_ROOT + '/') || !path.endsWith('.md')) throw new PostNotFoundError(path);
      const raw = await read(path, true, opts?.signal);
      return { ref: fm.describe(path, raw, { sha: await gitBlobSha(raw) }), raw, parts: fm.split(raw), eol: fm.eol(raw) };
    },

    resolveAssetUrl(postPath, src) {
      if (options.images) {
        const repoPath = assetRepoPath(postPath, src);
        const local = repoPath ? options.images.url(repoPath) : null;
        if (local) return local;
      }
      // Site-absolute paths (`/x.png`, i.e. public/) are served by the dev server as they are.
      return resolveAsset(postPath, src, { repoBase: '/', siteBase: '' });
    },

    save(_req: SaveRequest): Promise<SaveResult> {
      return Promise.reject(new ReadOnlyError());
    },

    // The working tree is never written from the browser.
    onAuthChange: () => () => {},

    status: () => status.get(),
    onStatus: (listener) => status.subscribe(listener),
  };
}
