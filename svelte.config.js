import { vitePreprocess } from '@astrojs/svelte';

// Used by the Astro Svelte integration, by vitest (vitest.config.ts) and by
// svelte-check. Svelte is only used by the writing app in src/write/.
export default {
  preprocess: vitePreprocess(),
};
