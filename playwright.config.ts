/**
 * Browser tests for /write.
 *
 * Two targets (WRITE_TARGET):
 *   dev   (default) the Astro dev server; posts come from the working tree.
 *         `bun run test:write:e2e`
 *   prod  the production build served by `astro preview` (workerd, like the
 *         deployed site); posts come from the public GitHub repo. Run
 *         `bun run build` first. Only the journey, invariant and prod specs
 *         run here: the others reach into dev-only modules, and every fresh
 *         browser context costs one unauthenticated GitHub API call (60/hour).
 *         `bun run test:write:e2e:prod`
 *
 * WRITE_PORT picks the port (default 4310 dev, 4325 prod) so several servers
 * can run side by side; an already-running server on that port is reused.
 *
 * Projects: desktop Chromium, a Pixel 7 profile (Chromium, touch) and — when
 * Playwright's WebKit is installed (`bunx playwright install webkit`) — an
 * iPhone profile on WebKit at 390x844. These are emulations: none of them
 * shows an on-screen keyboard.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

const target = process.env.WRITE_TARGET === 'prod' ? 'prod' : 'dev';
const port = Number(process.env.WRITE_PORT ?? (target === 'prod' ? 4325 : 4310));

function hasWebKit(): boolean {
  const dir = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), process.platform === 'darwin' ? 'Library/Caches/ms-playwright' : '.cache/ms-playwright');
  return existsSync(dir) && readdirSync(dir).some((name) => name.startsWith('webkit-'));
}

export default defineConfig({
  testDir: 'tests/write/e2e',
  testMatch: target === 'prod' ? ['journey.spec.ts', 'invariant.spec.ts', 'prod.spec.ts'] : undefined,
  testIgnore: target === 'prod' ? undefined : ['prod.spec.ts'],
  outputDir: process.env.WRITE_PW_OUTPUT ?? `node_modules/.cache/write-playwright${target === 'prod' ? '-prod' : ''}`,
  fullyParallel: true,
  // The production target shares one GitHub rate limit; keep it gentle.
  workers: target === 'prod' ? 3 : undefined,
  reporter: 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://localhost:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'phone', use: { ...devices['Pixel 7'] } },
    ...(hasWebKit() ? [{ name: 'iphone', use: { ...devices['iPhone 14'], viewport: { width: 390, height: 844 } } }] : []),
  ],
  webServer: {
    command: target === 'prod' ? `bun run preview --port ${port}` : `bun run dev --port ${port}`,
    url: `http://localhost:${port}/write/`,
    reuseExistingServer: true,
    timeout: 120_000,
    env: target === 'prod' ? {} : { WRITE_VITE_CACHE_DIR: process.env.WRITE_VITE_CACHE_DIR ?? `node_modules/.vite-write-${port}` },
  },
});
