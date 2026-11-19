/**
 * Making a commit: GraphQL `createCommitOnBranch`, with the Git Data REST API as a fallback.
 *
 * The GraphQL path (the mutation, the size-adaptive split into several commits, the retry with
 * half the files after an upload failure, the head check after a refused commit) and the commit
 * message wording are lifted from Sveltia CMS — https://github.com/sveltia/sveltia-cms
 * (fork dwahdany/sveltia-cms) at commit 06d5552aa:
 *   `src/lib/services/backends/git/github/commits.js` (95-176, 192-258, 272-396)
 *   `src/lib/services/backends/git/shared/commits.js` (18-25, 58-61, 115-117, 328-337)
 * Copyright (c) 2026 Kohei Yoshino. MIT License: see src/write/licenses/sveltia-MIT.txt.
 * Changes: TypeScript; repo, branch, expected head and message are arguments instead of module
 * singletons; progress is a callback; editorial-workflow, fork and sign-off branches dropped; the
 * base64 encoder is inlined (UTF-8 for strings); a moved head is a typed `BranchMovedError`;
 * commit messages are built from this app's collection table instead of the CMS config.
 * The REST fallback (`commitWithRest`) is new code.
 *
 * NEVER FORCES. GraphQL commits name `expectedHeadOid`; the REST path updates the ref with
 * `force: false`. Either way GitHub refuses when the branch has moved, and that surfaces as
 * `BranchMovedError` — the caller decides whether to look again and retry on the new head.
 */
import { COLLECTION_INFO, CONTENT_ROOT, type CollectionKind } from '../../contracts';
import { classifyFailure, type GithubClient } from './client';
import { estimateRemainingCommits, getPayloadSize, isUploadFailure, sortAdditions, takeAdditions, type FileAddition } from './commit-split';
import { runConcurrently } from './concurrency';
import { fetchHead } from './read';

/* ------------------------------------------------------------------ changes */

export type FileChange =
  | { action: 'create' | 'update'; path: string; data: string | Uint8Array }
  /** The file moves from `previousPath` to `path` (an addition plus a deletion in one commit). */
  | { action: 'move'; path: string; previousPath: string; data: string | Uint8Array }
  | { action: 'delete'; path: string };

export interface CommitRequest {
  changes: FileChange[];
  /** Full message; the first line is the headline. */
  message: string;
  /** The commit this one must go on top of. */
  expectedHeadOid: string;
  signal?: AbortSignal;
  /** Commits made so far, and how many the save is expected to take. */
  onProgress?: (done: number, total: number) => void;
}

export interface CommitResult {
  /** The (last) commit made. */
  oid: string;
  committedDate?: string;
  /** New blob sha of every added file, where the API reported it. */
  files: Record<string, string | undefined>;
  /** 1 unless the changeset was split. */
  commits: number;
  via: 'graphql' | 'rest';
}

/**
 * The branch is not where the commit expected it. Nothing was forced. When the changeset was split
 * and some commits had landed before, `landed` names the last of them (the branch moved AFTER it).
 */
export class BranchMovedError extends Error {
  readonly code = 'BRANCH_MOVED';
  constructor(
    readonly expected: string,
    readonly actual?: string,
    readonly landed?: { oid: string; commits: number },
  ) {
    super('The branch has moved since the site data was loaded.');
    this.name = 'BranchMovedError';
  }
}

/** A commit failed after earlier commits of the same (split) save had landed. `cause` is the failure. */
export class PartialCommitError extends Error {
  readonly code = 'PARTIAL_COMMIT';
  constructor(
    readonly landed: { oid: string; commits: number },
    cause: unknown,
  ) {
    super('Some files were committed, but the save did not complete.', { cause });
    this.name = 'PartialCommitError';
  }
}

/* ------------------------------------------------------------------ base64 */

const utf8 = new TextEncoder();

/** Base64 of bytes, or of a string's UTF-8 encoding (so a BOM and every line ending survive). */
export function encodeBase64(data: string | Uint8Array): string {
  const bytes = typeof data === 'string' ? utf8.encode(data) : data;
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(binary);
}

const byteSize = (data: string | Uint8Array): number => (typeof data === 'string' ? utf8.encode(data).byteLength : data.byteLength);

/* ---------------------------------------------------------------- messages */

/**
 * Default commit message templates.
 * @see https://decapcms.org/docs/configuration-options/#commit-message-templates
 */
const DEFAULT_COMMIT_MESSAGES = {
  create: 'Create {{collection}} “{{slug}}”',
  update: 'Update {{collection}} “{{slug}}”',
  delete: 'Delete {{collection}} “{{slug}}”',
} as const;

/**
 * Replace the `{{name}}` placeholders in the given commit message template with the given values,
 * in a single pass. The values are inserted as they are: `$&` and the like aren't read as
 * replacement patterns, and a placeholder that happens to appear in a value, e.g. in a slug, isn't
 * expanded. A placeholder without a value is left as it is.
 */
const fillTemplate = (template: string, values: Record<string, string>): string =>
  template.replace(/\{\{([\w-]+)\}\}/g, (placeholder, key: string) => (Object.hasOwn(values, key) ? values[key] : placeholder));

/**
 * What Sveltia calls the entry's slug in a commit message: the post's path inside its collection
 * folder, without `.md` — `2026/disksurvey` for `src/content/notes/2026/disksurvey.md`.
 */
export function entrySlug(path: string): string {
  const inside = path.startsWith(CONTENT_ROOT + '/') ? path.slice(CONTENT_ROOT.length + 1) : path;
  return inside.slice(inside.indexOf('/') + 1).replace(/\.md$/, '');
}

/**
 * Sveltia's wording, so history stays uniform: `Create Note “2026/disksurvey”`, plus ` +N` when
 * the commit touches N more files (new, moved or removed images).
 */
export function commitMessage(action: 'create' | 'update' | 'delete', collection: CollectionKind, path: string, otherFiles = 0): string {
  let message = fillTemplate(DEFAULT_COMMIT_MESSAGES[action], { slug: entrySlug(path), collection: COLLECTION_INFO[collection].singular });
  if (otherFiles > 0) message += ` +${otherFiles}`;
  return message;
}

/* ----------------------------------------------------------------- graphql */

/** GitHub's GraphQL API cannot resolve blob OIDs for files over this size (10 MB). */
const MAX_GRAPHQL_BLOB_SIZE = 10 * 1024 * 1024;

/**
 * Maximum size of the Base64-encoded file contents sent in a single commit mutation (16 MB).
 * GitHub's GraphQL API aborts a much larger request, which the browser only reports as a network
 * error, so the changes are split into several commits beyond this size.
 */
export const MAX_COMMIT_PAYLOAD_SIZE = 16 * 1024 * 1024;

/**
 * Size of the Base64-encoded file contents sent in the first commit mutation (2 MB). GitHub closes
 * a request whose body hasn't arrived within about ten seconds, so the size a commit can take
 * depends on the upload speed, which isn't known until something has been uploaded. The size of the
 * following commits is worked out from the speed of the previous one.
 */
export const INITIAL_COMMIT_PAYLOAD_SIZE = 2 * 1024 * 1024;

/**
 * Minimum size of the Base64-encoded file contents sent in a commit mutation (256 KB), so a slow
 * connection doesn't end up with a commit per small file.
 */
export const MIN_COMMIT_PAYLOAD_SIZE = 256 * 1024;

/** Time a commit mutation is meant to take (5 seconds), well within the time GitHub waits for a request body. */
const TARGET_COMMIT_DURATION = 5000;

/**
 * Work out the payload size of the next commit from how long the previous one took, so a commit
 * takes about {@link TARGET_COMMIT_DURATION} on the connection.
 */
export const getNextPayloadSize = (size: number, duration: number): number =>
  Math.min(MAX_COMMIT_PAYLOAD_SIZE, Math.max(MIN_COMMIT_PAYLOAD_SIZE, Math.floor((size / Math.max(duration, 1)) * TARGET_COMMIT_DURATION)));

/**
 * Split a commit message into the headline and the body, as the GraphQL API takes them separately
 * and joins them with a blank line. The body is left out if there is none.
 */
const splitCommitMessage = (message: string): { headline: string; body?: string } => {
  const [headline, ...rest] = message.split(/\r?\n/);
  const body = rest.join('\n').trim();

  return body ? { headline, body } : { headline };
};

interface Prepared {
  additions: FileAddition[];
  deletions: { path: string }[];
}

function prepare(changes: FileChange[]): Prepared {
  const additions: FileAddition[] = [];
  const deletions: { path: string }[] = [];
  changes.forEach((change, index) => {
    if (change.action !== 'delete') additions.push({ index, path: change.path, contents: encodeBase64(change.data), data: change.data });
    if (change.action === 'move') deletions.push({ path: change.previousPath });
    if (change.action === 'delete') deletions.push({ path: change.path });
  });
  return { additions, deletions };
}

/** Is the branch still at `expected`? Throws `BranchMovedError` when it is known to have moved. */
async function assertBranchNotMoved(client: GithubClient, expected: string, landed?: { oid: string; commits: number }): Promise<void> {
  // The head is looked up rather than the wording of the error relied upon. A failed lookup
  // returns quietly, leaving the original error to be reported.
  const head = await fetchHead(client).catch(() => undefined);
  if (head && head !== expected) throw new BranchMovedError(expected, head, landed);
}

/** Commit the given additions and deletions on top of the given head with `createCommitOnBranch`. */
async function createCommit(
  client: GithubClient,
  args: { expectedHeadOid: string; additions: FileAddition[]; deletions: { path: string }[]; message: string; signal?: AbortSignal },
): Promise<Record<string, any>> {
  const { expectedHeadOid, additions, deletions, message, signal } = args;
  // Part of the query to fetch new file SHAs; skip files over 10 MB to avoid a GitHub GraphQL
  // limitation where large blob OIDs cannot be resolved
  const fileShaQuery = additions
    .map(({ index, path, data }) => (byteSize(data) <= MAX_GRAPHQL_BLOB_SIZE ? `file_${index}: file(path: ${JSON.stringify(path)}) { oid }` : ''))
    .filter(Boolean)
    .join(' ');

  const query = `
    mutation($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) {
        commit {
          oid
          committedDate
          ${fileShaQuery}
        }
      }
    }
  `;

  const input = {
    branch: { repositoryNameWithOwner: `${client.repo.owner}/${client.repo.name}`, branchName: client.repo.branch },
    expectedHeadOid,
    fileChanges: { additions: additions.map(({ path, contents }) => ({ path, contents })), deletions },
    message: splitCommitMessage(message),
  };

  // The commit can be sent again after a transient error: one that has already landed is
  // refused, as the branch no longer points at `expectedHeadOid`
  const data = await client.graphql<{ createCommitOnBranch?: { commit?: Record<string, any> } }>(query, { input }, { retryable: true, signal });
  const commit = data?.createCommitOnBranch?.commit;
  if (!commit || typeof commit.oid !== 'string') throw new Error('GitHub did not report the new commit.');
  return commit;
}

export interface CommitterOptions {
  /** Monotonic clock in ms, for measuring upload speed. Defaults to `performance.now`. */
  clock?: () => number;
  /**
   * 'auto' (default): GraphQL, and the REST Git Data API from then on once GitHub clearly refuses
   * the mutation for this token ("Resource not accessible by …"). 'graphql' / 'rest' pin one.
   */
  strategy?: 'auto' | 'graphql' | 'rest';
  /** First commit's payload cap (tests). Default `INITIAL_COMMIT_PAYLOAD_SIZE`. */
  initialPayloadSize?: number;
}

export interface Committer {
  commit(request: CommitRequest): Promise<CommitResult>;
  /** Which API the next commit will try first. */
  strategy(): 'graphql' | 'rest';
}

const isAbort = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';

/**
 * GraphQL path. The changes normally go into a single commit, but a large changeset, typically a
 * post with many new images, is split into several commits made one after another, with the post
 * in the last one. The size of each commit follows the upload speed measured on the previous one,
 * and a commit that times out is retried with fewer files.
 * @see https://docs.github.com/en/graphql/reference/mutations#createcommitonbranch
 */
async function commitWithGraphql(client: GithubClient, request: CommitRequest, options: CommitterOptions): Promise<CommitResult> {
  const clock = options.clock ?? (() => performance.now());
  const { additions, deletions } = prepare(request.changes);
  const { queue, addedAgain } = sortAdditions(additions, new Set(deletions.map(({ path }) => path)));
  const { message, signal } = request;
  let expectedHeadOid = request.expectedHeadOid;
  let payloadSize = options.initialPayloadSize ?? INITIAL_COMMIT_PAYLOAD_SIZE;
  // Smallest payload that has timed out, which the following commits stay below, as the speed
  // measured on a slow or uneven connection can suggest a size that has already failed
  let timedOutSize = Infinity;
  let commitCount = 0;
  let commit: Record<string, any> = {};
  const fileShas: Record<string, any> = {};
  const landed = () => (commitCount > 0 ? { oid: expectedHeadOid, commits: commitCount } : undefined);

  // Commit the additions in groups, each on top of the previous one, sized so that each commit
  // takes a few seconds to upload. The deletions go into the last commit along with the post,
  // so a file isn't removed before the post stops referring to it. There is always at least one
  // commit, which can have no additions, so a changeset with only deletions is still committed
  do {
    // The files still waiting, at the current commit size, make up the commits yet to be made
    request.onProgress?.(commitCount, commitCount + estimateRemainingCommits(queue, payloadSize));

    const group = takeAdditions(queue, payloadSize);
    const isLast = !queue.length;
    const groupSize = getPayloadSize(group);
    const startTime = clock();

    try {
      commit = await createCommit(client, {
        expectedHeadOid,
        additions: isLast ? [...group, ...addedAgain] : group,
        deletions: isLast ? deletions : [],
        message,
        signal,
      });
    } catch (ex) {
      if (isAbort(ex)) throw ex;

      // The upload has taken too long on the connection. Put the files back and try again with
      // half of them, provided the branch is still where it was, so the commit hasn't landed
      if (group.length > 1 && isUploadFailure(ex) && (await fetchHead(client).catch(() => undefined)) === expectedHeadOid) {
        queue.unshift(...group);
        timedOutSize = Math.min(timedOutSize, groupSize);
        payloadSize = Math.floor(groupSize / 2);
        continue;
      }

      // GitHub says so in the error message, but the head is looked up rather than the wording relied upon
      await assertBranchNotMoved(client, expectedHeadOid, landed());

      // Some of the images have landed, but the post hasn't: say so. A retry finds them in the
      // tree and saves only what is missing.
      const partial = landed();
      throw partial ? new PartialCommitError(partial, ex) : ex;
    }

    payloadSize = Math.min(getNextPayloadSize(groupSize, clock() - startTime), timedOutSize - 1);
    commitCount += 1;
    Object.assign(fileShas, commit);
    expectedHeadOid = commit.oid;
  } while (queue.length);

  request.onProgress?.(commitCount, commitCount);

  return {
    oid: commit.oid,
    committedDate: typeof commit.committedDate === 'string' ? commit.committedDate : undefined,
    files: Object.fromEntries(additions.map(({ index, path }) => [path, fileShas[`file_${index}`]?.oid as string | undefined])),
    commits: commitCount,
    via: 'graphql',
  };
}

/* -------------------------------------------------------------------- rest */

/**
 * REST fallback (Git Data API): one blob per added file, a tree on top of the expected head's
 * tree, a commit with that head as its only parent, then the ref moved to it WITHOUT force.
 * Always a single commit: the files travel one per request, so no request grows with the changeset.
 * Blobs uploaded before a failure are unreferenced objects GitHub garbage-collects; nothing is
 * visible on the branch until the ref update succeeds.
 * @see https://docs.github.com/en/rest/git
 */
async function commitWithRest(client: GithubClient, request: CommitRequest): Promise<CommitResult> {
  const { expectedHeadOid, message, signal } = request;
  const { additions, deletions } = prepare(request.changes);
  const shas = new Map<string, string>();

  request.onProgress?.(0, 1);

  // Uploads are heavy on the server: a few at a time
  await runConcurrently(
    additions,
    async ({ path, contents }) => {
      const blob = await client.repoRest<{ sha?: unknown }>('/git/blobs', { method: 'POST', body: { content: contents, encoding: 'base64' }, signal }, { retryable: true });
      if (typeof blob?.sha !== 'string') throw new Error(`GitHub did not store ${path}.`);
      shas.set(path, blob.sha);
    },
    { concurrency: 3 },
  );

  const base = await client.repoRest<{ tree?: { sha?: unknown } }>(`/git/commits/${expectedHeadOid}`, {}, { signal });
  if (typeof base?.tree?.sha !== 'string') throw new Error('GitHub did not report the tree of the branch head.');

  const added = new Set(additions.map(({ path }) => path));
  const tree = [
    ...additions.map(({ path }) => ({ path, mode: '100644', type: 'blob', sha: shas.get(path) as string })),
    // `sha: null` removes the path. A path that is deleted and added again is simply the addition.
    ...deletions.filter(({ path }) => !added.has(path)).map(({ path }) => ({ path, mode: '100644', type: 'blob', sha: null })),
  ];
  const newTree = await client.repoRest<{ sha?: unknown }>('/git/trees', { method: 'POST', body: { base_tree: base.tree.sha, tree }, signal }, { retryable: true });
  if (typeof newTree?.sha !== 'string') throw new Error('GitHub did not create the tree.');

  const created = await client.repoRest<{ sha?: unknown; committer?: { date?: unknown } }>(
    '/git/commits',
    { method: 'POST', body: { message, tree: newTree.sha, parents: [expectedHeadOid] }, signal },
    { retryable: true },
  );
  if (typeof created?.sha !== 'string') throw new Error('GitHub did not create the commit.');

  try {
    // `force: false`: GitHub answers 422 ("Update is not a fast forward") when the branch has moved.
    await client.repoRest(
      `/git/refs/heads/${client.repo.branch.split('/').map(encodeURIComponent).join('/')}`,
      { method: 'PATCH', body: { sha: created.sha, force: false }, signal },
      { retryable: true },
    );
  } catch (ex) {
    if (isAbort(ex)) throw ex;
    const head = await fetchHead(client).catch(() => undefined);
    // The update landed after all (a retried request whose first answer was lost).
    if (head !== created.sha) {
      if (head && head !== expectedHeadOid) throw new BranchMovedError(expectedHeadOid, head);
      throw ex;
    }
  }

  request.onProgress?.(1, 1);

  return {
    oid: created.sha,
    committedDate: typeof created.committer?.date === 'string' ? created.committer.date : undefined,
    files: Object.fromEntries(additions.map(({ path }) => [path, shas.get(path)])),
    commits: 1,
    via: 'rest',
  };
}

/* --------------------------------------------------------------- committer */

/**
 * Commits through GraphQL, and through REST once GitHub has clearly said the mutation is not
 * available to this token. The choice is remembered for the life of the committer.
 */
export function createCommitter(client: GithubClient, options: CommitterOptions = {}): Committer {
  let use: 'graphql' | 'rest' = options.strategy === 'rest' ? 'rest' : 'graphql';
  const mayFallBack = (options.strategy ?? 'auto') === 'auto';

  return {
    strategy: () => use,
    async commit(request) {
      if (use === 'rest') return commitWithRest(client, request);
      try {
        return await commitWithGraphql(client, request, options);
      } catch (ex) {
        // Only when nothing has landed and the refusal is about access, not about this changeset.
        if (mayFallBack && !(ex instanceof PartialCommitError) && !(ex instanceof BranchMovedError) && classifyFailure(ex).kind === 'forbidden') {
          const result = await commitWithRest(client, request);
          use = 'rest';
          return result;
        }
        throw ex;
      }
    },
  };
}
