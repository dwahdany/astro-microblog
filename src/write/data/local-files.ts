/**
 * DEV ONLY. The working tree's markdown, read through Vite.
 *
 * This module is reached exclusively through the dynamic import in ./index.ts
 * that sits behind `import.meta.env.DEV`, so no post text ends up in the
 * production bundle (re-check after touching either file:
 * `grep -rl "<a sentence from a post>" dist/client/_astro` must find nothing).
 *
 * Keys are Vite root-relative: '/src/content/entries/2026/curation-leaks.md'.
 * `?raw` yields the bytes on disk (asserted in tests/write/foundation.test.ts);
 * Astro's markdown plugin does not intercept it.
 */
export const files = import.meta.glob<string>('/src/content/**/*.md', {
  query: '?raw',
  import: 'default',
});
