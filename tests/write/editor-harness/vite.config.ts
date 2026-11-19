/**
 * Standalone harness for the editor (no Astro, no app shell):
 *
 *   bunx vite --config tests/write/editor-harness/vite.config.ts      → http://localhost:4331/
 *
 * Serves tests/write/editor-harness/index.html, which mounts Editor.svelte with
 * a throwaway toolbar, the real theme tokens and every post in src/content.
 * WRITE_EDITOR_PORT overrides the port.
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const port = Number(process.env.WRITE_EDITOR_PORT ?? 4331);

export default defineConfig({
  root: here,
  // The themes load Roboto Mono from the site's public/fonts.
  publicDir: resolve(repo, 'public'),
  cacheDir: resolve(repo, 'node_modules/.vite-write-editor-harness'),
  plugins: [svelte({ configFile: resolve(repo, 'svelte.config.js') })],
  define: { __REPO_ROOT__: JSON.stringify(repo) },
  server: { port, strictPort: true, host: '127.0.0.1', fs: { allow: [repo] } },
  preview: { port, strictPort: true },
  build: { outDir: resolve(repo, 'node_modules/.cache/write-editor-harness'), emptyOutDir: true },
});
