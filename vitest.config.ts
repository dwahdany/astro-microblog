/**
 * Unit tests for the writing app (src/write). Deliberately NOT built on
 * Astro's getViteConfig: these tests need neither the Cloudflare adapter nor
 * Tailwind, and a plain Vite + Svelte setup starts in a fraction of the time.
 *
 * Environment is node by default. A test file that needs a DOM opts in with a
 * docblock on its first line:   // @vitest-environment jsdom
 * IndexedDB in node/jsdom:      import 'fake-indexeddb/auto';
 */
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [svelte()],
  // Resolve Svelte's browser build so components can be mounted in jsdom.
  resolve: { conditions: ['browser'] },
  test: {
    include: ['src/write/**/__tests__/**/*.test.ts', 'tests/write/**/*.test.ts'],
    exclude: ['tests/write/e2e/**', 'node_modules/**', 'dist/**'],
    environment: 'node',
  },
});
