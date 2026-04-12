// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';
import { rehypeImageSize } from './src/plugins/rehype-image-size';
import { rehypeInternalLinkPreview } from './src/plugins/rehype-internal-link-preview';

// https://astro.build/config
export default defineConfig({
  site: 'https://blog.wahdany.eu',
  integrations: [sitemap()],
  adapter: cloudflare({
    imageService: 'compile',
  }),
  output: 'server',
  build: {
    format: 'directory',
  },
  markdown: {
    rehypePlugins: [rehypeImageSize, rehypeInternalLinkPreview],
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
