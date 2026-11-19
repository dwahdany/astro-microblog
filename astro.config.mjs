// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';
import svelte from '@astrojs/svelte';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { rehypeImageSize } from './src/plugins/rehype-image-size';
import { rehypeInternalLinkPreview } from './src/plugins/rehype-internal-link-preview';
import writeManifest from './src/write/build/manifest.mjs';

// https://astro.build/config
export default defineConfig({
  site: 'https://blog.wahdany.eu',
  integrations: [
    // /write is the private writing app (noindex) — keep it out of the sitemap.
    sitemap({ filter: (page) => !/\/write(\/|$)/.test(new URL(page).pathname) }),
    // Svelte is used only by the writing app under src/write/.
    svelte(),
    // Lists the posts for /write when GitHub's anonymous API is rate-limited (build only).
    writeManifest(),
  ],
  adapter: cloudflare({
    imageService: 'compile',
    configPath: './wrangler.jsonc',
  }),
  output: 'server',
  build: {
    format: 'directory',
  },
  markdown: {
    remarkPlugins: [remarkMath],
    rehypePlugins: [rehypeImageSize, rehypeInternalLinkPreview, rehypeKatex],
  },
  vite: {
    plugins: [tailwindcss()],
    // Opt-in only: lets several dev servers run side by side in this checkout
    // without fighting over node_modules/.vite (see src/write/README.md).
    ...(process.env.WRITE_VITE_CACHE_DIR ? { cacheDir: process.env.WRITE_VITE_CACHE_DIR } : {}),
  },
});
