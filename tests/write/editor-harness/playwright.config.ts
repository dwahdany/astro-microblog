/**
 * Browser tests for the editor alone, against the standalone harness
 * (./vite.config.ts) — independent of the app shell and of Astro.
 *
 *   bunx playwright test -c tests/write/editor-harness/playwright.config.ts      (bun run test:write:editor)
 *   bunx playwright test -c tests/write/editor-harness/playwright.config.ts --project=pixel
 *
 * Projects: desktop Chromium, a Pixel 7 profile (Chromium, touch) and — when
 * Playwright's WebKit build is installed (`bunx playwright install webkit`) —
 * an iPhone profile on WebKit. Emulation gives touch events and a phone
 * viewport, not a real on-screen keyboard.
 *
 * WRITE_EDITOR_PORT picks the port (default 4331); a harness already running
 * there is reused.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices, webkit } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const port = Number(process.env.WRITE_EDITOR_PORT ?? 4331);

let hasWebkit = false;
try {
  hasWebkit = existsSync(webkit.executablePath());
} catch {
  hasWebkit = false;
}

export default defineConfig({
  testDir: here,
  outputDir: process.env.WRITE_PW_OUTPUT ?? resolve(repo, 'node_modules/.cache/write-editor-playwright'),
  fullyParallel: true,
  reporter: 'list',
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'pixel', use: { ...devices['Pixel 7'] } },
    ...(hasWebkit ? [{ name: 'iphone', use: { ...devices['iPhone 14'] } }] : []),
  ],
  webServer: {
    command: `bunx vite --config ${resolve(here, 'vite.config.ts')}`,
    cwd: repo,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: true,
    timeout: 60_000,
    env: { WRITE_EDITOR_PORT: String(port) },
  },
});
