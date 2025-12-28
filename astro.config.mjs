// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import cloudflare from '@astrojs/cloudflare';
import sitemap from '@astrojs/sitemap';
import { rehypeImageSize } from './src/plugins/rehype-image-size';

// https://astro.build/config
export default defineConfig({
  site: 'https://blog.wahdany.eu',
  integrations: [tailwind(), sitemap()],
  adapter: cloudflare({
    imageService: 'compile',
  }),
  output: 'server',
  build: {
    format: 'directory',
  },
  markdown: {
    rehypePlugins: [rehypeImageSize],
  },
});
