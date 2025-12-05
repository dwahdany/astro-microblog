// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';
import cloudflare from '@astrojs/cloudflare';

// https://astro.build/config
export default defineConfig({
  site: 'https://blog.example.com', // Update with your actual domain
  integrations: [tailwind()],
  adapter: cloudflare(),
  output: 'server',
  build: {
    format: 'directory',
  },
});
