/**
 * The build-time post manifest: where it is served and what it holds.
 *
 * `astro build` writes it next to the app (src/write/build/manifest.mjs): the
 * repo path, git blob sha and size of every markdown file under src/content
 * as of that build. The GitHub source uses it as its listing when the
 * anonymous GitHub API cannot answer (see ./github-source.ts).
 */
export const MANIFEST_URL = '/write/manifest.json';

/** Same shape the GitHub source keeps its own listing in. */
export interface PostManifest {
  v: 1;
  /** Epoch ms of the build. */
  fetchedAt: number;
  truncated: false;
  files: [path: string, sha: string, size: number][];
}
