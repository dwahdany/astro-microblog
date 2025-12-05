// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import cloudflare from '@astrojs/cloudflare';
import { rehypeImageSize } from './src/plugins/rehype-image-size';

// https://astro.build/config
export default defineConfig({
  site: 'https://blog.example.com', // Update with your actual domain
  integrations: [tailwind()],
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
