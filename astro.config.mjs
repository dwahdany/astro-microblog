// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { rehypeImageSize } from './src/plugins/rehype-image-size';
import { rehypeInternalLinkPreview } from './src/plugins/rehype-internal-link-preview';

// https://astro.build/config
export default defineConfig({
  site: 'https://blog.wahdany.eu',
  integrations: [sitemap()],
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
  },
});
