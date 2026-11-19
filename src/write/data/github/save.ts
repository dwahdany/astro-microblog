/**
 * From a `SaveRequest` to a commit: look at the branch, check for conflicts, work out the file
 * changes, commit, and — when the branch moved under the commit — look again.
 *
 * New code. The sequence follows Sveltia CMS `backends/save.js:161-293` (reference only) and the
 * image path rules of `contents/draft/save/assets.js` / `assets/entry-folder.js:99-101`.
 *
 *   1. head H of the branch, and the file tree under src/content at H        (2 requests)
 *   2. conflict check against that tree (see `planSave`)
 *   3. one commit on top of H (GraphQL, or REST when GraphQL is refused)     (1 request, more for big images)
 *   4. if GitHub says the branch is no longer at H: back to 1, at most `attempts` times.
 *      The check in 2 runs again on the new head, so a change to THIS post made meanwhile is a
 *      conflict, while an unrelated commit (the price-cache bot) just means committing on top of it.
 *      Nothing is ever forced.
 *
 * A save is idempotent: when the tree already holds exactly what the request asks for (the commit
 * landed but its answer was lost, or an earlier split save got the images in), nothing — or only
 * the rest — is committed.
 */
import {
  CONTENT_ROOT,
  SaveConflictError,
  SaveError,
  type CollectionKind,
  type SaveFailure,
  type SaveRequest,
  type SaveResult,
} from '../../contracts';
import { EXTENSION_FOR_TYPE, imageFolder } from '../assets/names';
import { gitBlobSha } from '../git-sha';
import { collectionOf } from '../paths';
import { classifyFailure, type GithubClient } from './client';
import { BranchMovedError, PartialCommitError, commitMessage, type Committer, type FileChange } from './commit';
import { mapConcurrently } from './concurrency';
import { fetchBlobBytes, fetchContentTree, fetchHead, type TreeFile } from './read';

export type Tree = Map<string, TreeFile>;

export interface SavePlan {
  /** Nothing to commit: the repo already holds what was asked for. */
  noop: boolean;
  changes: FileChange[];
  message: string;
  /** Blob id the post will have ('' for a delete). */
  sha: string;
  /** Files the save writes: path → blob id and size (the post included). */
  written: Map<string, TreeFile>;
  /** Bytes of the written files other than the post (images), by path. */
  bytes: Map<string, Uint8Array>;
  /** Paths the save removes. */
  removed: string[];
}

const utf8 = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { ignoreBOM: true });
const IMAGE_EXTENSIONS = new Set(Object.values(EXTENSION_FOR_TYPE));
const isAbort = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';

function invalid(message: string): SaveError {
  return new SaveError(message, 'invalid');
}

function checkPath(path: string, what: string): void {
  const segments = path.split('/');
  if (!path.startsWith(CONTENT_ROOT + '/') || segments.some((s) => s === '' || s === '.' || s === '..') || /[\u0000-\u001f\\]/.test(path))
    throw invalid(`${what} would be written outside ${CONTENT_ROOT}: ${path}`);
}

async function shaOf(bytes: Uint8Array): Promise<string> {
  const sha = await gitBlobSha(bytes);
  // Without WebCrypto (an insecure context) nothing can be verified; the app never runs there (https or localhost).
  if (!sha) throw new SaveError('This browser cannot verify file contents (no WebCrypto), so nothing was published.', 'failed');
  return sha;
}

/**
 * Check the request against the tree and work out the file changes. Rejects with
 * `SaveConflictError` — nothing has been written at that point.
 *
 *   delete   the post must exist ('missing') and still be the blob that is being deleted ('changed')
 *   create   the path must be free ('exists')
 *   update   the post must exist ('missing') and still be the blob the edit was made on ('changed')
 *   rename   as update at the OLD path, and the new path must be free ('exists'); every file of
 *            the old image folder moves to the new one
 *   images   only directly in the post's own image folder, with an image extension; a path that
 *            already holds other bytes is a conflict ('exists'); the same bytes are not sent again
 *            but still count as carried by this save (`written`)
 *
 * `deleteSent`: an earlier attempt of this very save sent the delete commit and the branch then
 * turned out to have moved. A post that is absent now is then this save's own doing (the commit
 * landed, its answer was lost), not a conflict.
 */
export async function planSave(
  req: SaveRequest,
  tree: Tree,
  readBlob: (sha: string) => Promise<Uint8Array>,
  context: { deleteSent?: boolean } = {},
): Promise<SavePlan> {
  const { path } = req;
  checkPath(path, 'The post');
  if (!path.endsWith('.md')) throw invalid(`A post must be a .md file: ${path}`);
  const collection: CollectionKind | null = collectionOf(path);
  if (!collection) throw invalid(`${path} is not in a collection.`);
  const previous = req.previousPath !== undefined && req.previousPath !== path ? req.previousPath : undefined;
  if (previous !== undefined) checkPath(previous, 'The post');

  const changes: FileChange[] = [];
  const written = new Map<string, TreeFile>();
  const bytes = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const filesUnder = (folder: string) => [...tree].filter(([p]) => p.startsWith(folder + '/'));

  /* ---- delete ---- */
  if (req.delete) {
    const current = tree.get(path);
    if (!current && !context.deleteSent) throw new SaveConflictError(path, 'missing');
    if (current && req.baseSha !== undefined && current.sha !== req.baseSha) throw new SaveConflictError(path, 'changed', current.sha);
    if (current) changes.push({ action: 'delete', path });
    removed.push(path);
    if (!req.keepImages) {
      for (const [p] of filesUnder(imageFolder(path))) {
        changes.push({ action: 'delete', path: p });
        removed.push(p);
      }
    }
    return {
      noop: changes.length === 0,
      changes,
      message: req.message ?? commitMessage('delete', collection, path, Math.max(0, changes.length - 1)),
      sha: '',
      written,
      bytes,
      removed,
    };
  }

  /* ---- the post ---- */
  const rawBytes = utf8.encode(req.raw);
  // An unpaired surrogate (half an emoji) has no UTF-8 form: the encoder writes U+FFFD in its
  // place, and the repo would then hold a text other than the one on screen.
  if (rawBytes.includes(0xef) && utf8Decoder.decode(rawBytes) !== req.raw)
    throw invalid('The text contains a broken character (half of an emoji or a similar symbol). Delete it and type it again, then publish.');
  const sha = await shaOf(rawBytes);
  const creating = req.baseSha === undefined;
  const atTarget = tree.get(path);
  let postDone = false;

  if (creating) {
    if (previous !== undefined) throw invalid('A rename needs the blob the edit was based on (baseSha).');
    if (atTarget) {
      if (atTarget.sha !== sha) throw new SaveConflictError(path, 'exists', atTarget.sha);
      postDone = true; // an earlier attempt already created exactly this file
    }
  } else if (previous !== undefined) {
    const old = tree.get(previous);
    if (!old) {
      // Already moved by an earlier attempt whose answer was lost?
      if (atTarget?.sha === sha) postDone = true;
      else throw new SaveConflictError(previous, 'missing');
    } else {
      if (old.sha !== req.baseSha) throw new SaveConflictError(previous, 'changed', old.sha);
      if (atTarget) throw new SaveConflictError(path, 'exists', atTarget.sha);
    }
  } else {
    if (!atTarget) throw new SaveConflictError(path, 'missing');
    if (atTarget.sha === sha) postDone = true;
    else if (atTarget.sha !== req.baseSha) throw new SaveConflictError(path, 'changed', atTarget.sha);
  }

  /* ---- images ---- */
  const assetChanges: FileChange[] = [];

  // A rename takes the image folder along: <old dir>/<old stem>/* → <dir>/<stem>/*
  if (previous !== undefined) {
    const from = imageFolder(previous);
    const to = imageFolder(path);
    if (from !== to) {
      const moving = filesUnder(from);
      for (const [p, file] of moving) {
        const target = to + p.slice(from.length);
        const there = tree.get(target);
        if (there && there.sha !== file.sha) throw new SaveConflictError(target, 'exists', there.sha);
      }
      // GraphQL commits carry file contents, not blob ids, so a moved file's bytes are read first.
      const contents = await mapConcurrently(moving, ([, file]) => readBlob(file.sha), { concurrency: 4 });
      moving.forEach(([p, file], i) => {
        const target = to + p.slice(from.length);
        assetChanges.push({ action: 'move', path: target, previousPath: p, data: contents[i] });
        written.set(target, { sha: file.sha, size: file.size });
        bytes.set(target, contents[i]);
        removed.push(p);
      });
    }
  }

  const seen = new Set<string>();
  const ownFolder = imageFolder(path) + '/';
  for (const asset of req.assets ?? []) {
    checkPath(asset.path, 'An image');
    const name = asset.path.startsWith(ownFolder) ? asset.path.slice(ownFolder.length) : '';
    const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
    if (name === '' || name.includes('/') || !IMAGE_EXTENSIONS.has(extension))
      throw invalid(`An image cannot be written to ${asset.path}: images go into ${ownFolder} and must be JPEG, PNG, WebP, GIF or AVIF files.`);
    if (seen.has(asset.path)) throw invalid(`Two images share the path ${asset.path}.`);
    seen.add(asset.path);
    const data = new Uint8Array(await asset.data.arrayBuffer());
    const assetSha = await shaOf(data);
    const there = tree.get(asset.path) ?? written.get(asset.path);
    if (there) {
      if (there.sha !== assetSha) throw new SaveConflictError(asset.path, 'exists', there.sha);
      // Already in the repo (an earlier, split save got this far) or moved there by this save:
      // not sent again, but it is one of the images this save accounts for — the caller drops it
      // from the draft by `SaveResult.assets`.
      written.set(asset.path, { sha: assetSha, size: data.byteLength });
      bytes.set(asset.path, data);
      continue;
    }
    assetChanges.push({ action: 'create', path: asset.path, data });
    written.set(asset.path, { sha: assetSha, size: data.byteLength });
    bytes.set(asset.path, data);
  }

  /* ---- together ---- */
  if (!postDone) {
    changes.push(
      previous !== undefined ? { action: 'move', path, previousPath: previous, data: req.raw } : { action: creating ? 'create' : 'update', path, data: req.raw },
    );
    if (previous !== undefined) removed.push(previous);
  }
  changes.push(...assetChanges);
  written.set(path, { sha, size: rawBytes.byteLength });

  return {
    noop: changes.length === 0,
    changes,
    message: req.message ?? commitMessage(creating ? 'create' : 'update', collection, path, Math.max(0, changes.length - 1)),
    sha,
    written,
    bytes,
    removed,
  };
}

export interface SaveRunnerOptions {
  client: GithubClient;
  committer: Committer;
  /** How many times to look again when the branch moves under the commit. Default 3. */
  attempts?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface SaveOutcome {
  result: SaveResult;
  plan: SavePlan;
  /** The branch head after the save. */
  head: string;
  /** The tree the save was planned on (as of the head BEFORE the commit). */
  tree: Tree;
}

/** A typed, showable error for whatever the commit threw. */
export function toSaveError(err: unknown, repoLabel: string, partial = false): SaveError {
  if (err instanceof SaveError) return err;
  const f = classifyFailure(err);
  const details = { status: f.status, partial, retryAt: f.retryAt, cause: err };
  const tail = partial ? ' Some images were already committed; publishing again will finish the job.' : ' Nothing was published.';
  const messages: Record<SaveFailure, string> = {
    'signed-out': 'You are signed out. Sign in again to publish.' + (partial ? tail : ''),
    forbidden: `GitHub refused the commit: this sign-in may not write to ${repoLabel}.${f.detail ? ` (${f.detail})` : ''}${tail}`,
    offline: 'GitHub could not be reached — check the connection and publish again.' + tail,
    'rate-limited': 'GitHub is limiting requests right now. Try again in a few minutes.' + tail,
    'too-large': 'GitHub refused the commit because it is too large.' + tail,
    invalid: 'The save was not valid.' + tail,
    failed: `Publishing failed${f.detail ? `: ${f.detail}` : f.status ? ` (GitHub answered ${f.status})` : ''}.${tail}`,
  };
  const reason: SaveFailure =
    f.kind === 'unauthorized'
      ? 'signed-out'
      : f.kind === 'forbidden'
        ? 'forbidden'
        : f.kind === 'offline'
          ? 'offline'
          : f.kind === 'rate-limited'
            ? 'rate-limited'
            : f.kind === 'too-large'
              ? 'too-large'
              : 'failed';
  return new SaveError(messages[reason], reason, details);
}

/** Run a save to the end. Rejects with `SaveConflictError` or `SaveError` (or an AbortError). */
export async function runSave(req: SaveRequest, options: SaveRunnerOptions): Promise<SaveOutcome> {
  const { client, committer } = options;
  const { signal } = req;
  const label = `${client.repo.owner}/${client.repo.name}`;
  const attempts = Math.max(1, options.attempts ?? 3);
  let landed = false;
  /** This save sent a delete commit whose fate is unknown (the branch was found moved afterwards). */
  let deleteSent = false;

  for (let attempt = 1; ; attempt += 1) {
    let head: string;
    let tree: Tree;
    try {
      head = await fetchHead(client, signal);
      tree = await fetchContentTree(client, head, CONTENT_ROOT, signal);
    } catch (err) {
      if (isAbort(err)) throw err;
      throw toSaveError(err, label, landed);
    }

    let plan: SavePlan;
    try {
      plan = await planSave(req, tree, (sha) => fetchBlobBytes(client, sha, signal), { deleteSent });
    } catch (err) {
      if (isAbort(err) || err instanceof SaveConflictError || err instanceof SaveError) throw err;
      throw toSaveError(err, label, landed);
    }

    const done = (commit?: { oid: string; commits: number; via: 'graphql' | 'rest' }): SaveOutcome => {
      const result: SaveResult = { path: req.path, sha: plan.sha };
      if (req.delete) result.deleted = true;
      if (commit) {
        result.commitSha = commit.oid;
        result.commitUrl = `https://github.com/${label}/commit/${commit.oid}`;
        result.commits = commit.commits;
        result.via = commit.via;
      } else result.commits = 0;
      const assets = [...plan.written].filter(([p]) => p !== req.path).map(([p, f]) => ({ path: p, sha: f.sha }));
      if (assets.length > 0) result.assets = assets;
      if (plan.removed.length > 0) result.removed = plan.removed.slice();
      return { result, plan, head: commit?.oid ?? head, tree };
    };

    if (plan.noop) return done();

    try {
      const commit = await committer.commit({ changes: plan.changes, message: plan.message, expectedHeadOid: head, signal, onProgress: options.onProgress });
      return done(commit);
    } catch (err) {
      if (isAbort(err)) throw err;
      if (err instanceof BranchMovedError) {
        if (err.landed) landed = true;
        if (req.delete) deleteSent = true;
        if (attempt < attempts) continue;
        throw new SaveConflictError(req.path, 'branch-moved');
      }
      if (err instanceof PartialCommitError) throw toSaveError(err.cause, label, true);
      throw toSaveError(err, label, landed);
    }
  }
}
