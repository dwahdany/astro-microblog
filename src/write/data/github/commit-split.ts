/**
 * Splitting a large changeset into several commits.
 *
 * Lifted from Sveltia CMS — https://github.com/sveltia/sveltia-cms (fork dwahdany/sveltia-cms)
 * at commit 06d5552aa, `src/lib/services/backends/git/shared/commit-split.js`.
 * Copyright (c) 2026 Kohei Yoshino. MIT License: see src/write/licenses/sveltia-MIT.txt.
 * Changes: TypeScript types; `FileAddition.data` is `string | Uint8Array` (text or bytes) instead of
 * Sveltia's `string | Blob`; `Array.prototype.toSorted` replaced by a copy + stable sort.
 */

/**
 * HTTP statuses the Git hosting service, or a proxy in front of it, answers a request with when it
 * has taken too long or is too large: 408 Request Timeout, 413 Content Too Large, 499 Client Closed
 * Request, 502 Bad Gateway and 504 Gateway Timeout.
 */
const UPLOAD_FAILURE_STATUSES = [408, 413, 499, 502, 504];

/** A file addition in a commit, along with the change it comes from. */
export interface FileAddition {
  /** Index of the addition in the changeset; aliases the file in the query for its new SHA. */
  index: number;
  /** File path. */
  path: string;
  /** File contents, Base64-encoded. */
  contents: string;
  /** Original file data: a string for a text file (a post), bytes for a binary one (an image). */
  data: string | Uint8Array;
}

/**
 * Sort file additions in the order they are committed. Assets come first and text files like
 * entries last, so an entry never lands in the repository before the files it refers to. A file
 * that is deleted and added again at the same path, which is resolved within a single commit, is
 * set aside, as it has to go into the last commit along with the deletions, however large it is;
 * otherwise the deletion would remove it again.
 * @returns Additions to be committed in order, and those that go into the last commit.
 */
export const sortAdditions = (
  additions: FileAddition[],
  deletedPaths: Set<string> = new Set(),
): { queue: FileAddition[]; addedAgain: FileAddition[] } => ({
  queue: additions
    .filter(({ path }) => !deletedPaths.has(path))
    .slice()
    .sort((a, b) => Number(typeof a.data === 'string') - Number(typeof b.data === 'string')),
  addedAgain: additions.filter(({ path }) => deletedPaths.has(path)),
});

/**
 * Take the file additions for the next commit from the start of the queue, as many as fit in the
 * given payload size. A single file over the size is taken on its own.
 * @param queue Additions yet to be committed. Modified in place.
 * @param maxSize Maximum size of the encoded file contents.
 */
export const takeAdditions = (queue: FileAddition[], maxSize: number): FileAddition[] => {
  const group: FileAddition[] = [];
  let size = 0;

  while (queue.length && (!group.length || size + queue[0].contents.length <= maxSize)) {
    const addition = queue.shift() as FileAddition;

    group.push(addition);
    size += addition.contents.length;
  }

  return group;
};

/** Get the payload size of the given additions: the total size of their encoded contents. */
export const getPayloadSize = (additions: FileAddition[]): number => additions.reduce((total, { contents }) => total + contents.length, 0);

/**
 * Estimate how many commits are left to make for the given additions at the given commit size. The
 * last commit is always made, even when it only has the entry files or deletions, so there is at
 * least one.
 */
export const estimateRemainingCommits = (queue: FileAddition[], payloadSize: number): number =>
  Math.max(1, Math.ceil(getPayloadSize(queue) / payloadSize));

/**
 * Check if a commit request has failed because it took too long or was too large, which the
 * browser typically reports as a network error, as the answer of the service, or the proxy in front
 * of it, comes without CORS headers.
 */
export const isUploadFailure = (ex: unknown): boolean => {
  const e = ex as { message?: unknown; cause?: { status?: unknown } } | null | undefined;
  return e?.message === 'Failed to send the request' || UPLOAD_FAILURE_STATUSES.includes(e?.cause?.status as number);
};
