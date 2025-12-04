// @ts-check
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind';

// https://astro.build/config
export default defineConfig({
  site: 'https://blog.example.com', // Update with your actual domain
  integrations: [tailwind()],
  build: {
    format: 'directory',
  },
});
