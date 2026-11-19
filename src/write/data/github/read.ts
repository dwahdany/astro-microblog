/**
 * Reading the repo with the signed-in token: the branch head, the file tree under `src/content`,
 * and a file's bytes.
 *
 * `fetchContentTree` (one recursive tree request, listing directory by directory when GitHub cuts
 * it short) and `fetchBlobBytes` (the `raw` media type) are lifted from Sveltia CMS —
 * https://github.com/sveltia/sveltia-cms (fork dwahdany/sveltia-cms) at commit 06d5552aa,
 * `src/lib/services/backends/git/github/files.js` (46-126, 212-233).
 * Copyright (c) 2026 Kohei Yoshino. MIT License: see src/write/licenses/sveltia-MIT.txt.
 * Changes: TypeScript; the client is an argument; scoped to one directory; fork, root-dir option
 * and progress reporting dropped; a blob is read as BYTES (Sveltia's `response.text()` would drop a
 * byte-order mark). The head is read with REST (`git/ref`), not Sveltia's GraphQL query: it is one
 * request either way and works for every kind of token.
 */
import { mapConcurrently } from './concurrency';
import type { GithubClient } from './client';

export interface TreeFile {
  sha: string;
  size: number;
}

interface GitTreeEntry {
  path: string;
  type: string;
  sha: string;
  size?: number;
}

const encodeSegments = (path: string): string => path.split('/').map(encodeURIComponent).join('/');

/** The commit the branch points at. */
export async function fetchHead(client: GithubClient, signal?: AbortSignal): Promise<string> {
  const ref = await client.repoRest<{ object?: { sha?: unknown } }>(`/git/ref/heads/${encodeSegments(client.repo.branch)}`, {}, { signal });
  const sha = ref?.object?.sha;
  if (typeof sha !== 'string' || sha === '') throw new Error(`Branch ${client.repo.branch} has no head`);
  return sha;
}

async function fetchTree(client: GithubClient, treeRef: string, recursive: boolean, signal?: AbortSignal) {
  const query = recursive ? '?recursive=1' : '';
  // A tree-ish expression (`<commit>:<dir>`) addresses the directory's tree without looking its sha up first
  return client.repoRest<{ tree: GitTreeEntry[]; truncated?: boolean }>(`/git/trees/${encodeSegments(treeRef).replace('%3A', ':')}${query}`, {}, { signal });
}

/**
 * Every file under `dir` at commit (or branch) `ref`: repo path → blob sha and size. A tree too
 * big to be listed recursively in one response has its subtrees listed separately instead, as
 * GitHub suggests, so the result is always complete.
 * @throws When a single directory has too many files to list.
 */
export async function fetchContentTree(client: GithubClient, ref: string, dir: string, signal?: AbortSignal): Promise<Map<string, TreeFile>> {
  const files = new Map<string, TreeFile>();
  let pending = [{ sha: `${ref}:${dir}`, prefix: `${dir}/` }];

  // One level at a time, so the requests in flight stay within the concurrency limit
  while (pending.length) {
    const results = await mapConcurrently(pending, async ({ sha, prefix }) => {
      const { tree, truncated } = await fetchTree(client, sha, true, signal);

      if (!truncated) return { prefix, entries: tree, subtrees: [] as GitTreeEntry[] };

      // List this directory alone, and its subdirectories separately
      const { tree: children, truncated: tooBig } = await fetchTree(client, sha, false, signal);

      if (tooBig) throw new Error(`The directory '${prefix || '/'}' has too many files to list.`);

      return { prefix, entries: children, subtrees: children.filter(({ type }) => type === 'tree') };
    });

    pending = results.flatMap(({ prefix, subtrees }) => subtrees.map(({ path, sha }) => ({ sha, prefix: `${prefix}${path}/` })));

    for (const { prefix, entries } of results) {
      for (const entry of entries) {
        if (entry.type === 'blob') files.set(`${prefix}${entry.path}`, { sha: entry.sha, size: entry.size ?? 0 });
      }
    }
  }

  return files;
}

/**
 * The exact bytes of a blob. The `raw` media type asks for the file content itself, rather than
 * the base64-wrapped JSON the endpoint returns by default; it has no size cap short of 100 MB.
 */
export function fetchBlobBytes(client: GithubClient, sha: string, signal?: AbortSignal): Promise<Uint8Array> {
  return client.repoRest<Uint8Array>(`/git/blobs/${sha}`, { headers: { Accept: 'application/vnd.github.raw+json' } }, { responseType: 'bytes', signal });
}
