/**
 * Production build only (WRITE_TARGET=prod): the GitHub content source inside
 * the real app. Each fresh browser context costs one unauthenticated GitHub
 * API call, so this file stays small.
 */
import { expect, test, type Page } from '@playwright/test';
import { EDITOR, openPost } from './helpers';

const POST = 'src/content/entries/2026/curation-leaks.md';
const rows = (page: Page) => page.locator('[data-post-list] li');
const GITHUB = /^https:\/\/(api\.github\.com|raw\.githubusercontent\.com)\//;

test('the built app lists and opens posts from GitHub; images and the preview load; a second visit refetches no post', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const github: string[] = [];
  page.on('request', (req) => GITHUB.test(req.url()) && github.push(req.url()));

  await page.goto('/write/');
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
  expect(await rows(page).count()).toBeGreaterThan(50);
  await expect(page.locator('[data-post-count]')).toContainText('dwahdany/astro-microblog@main');
  // One listing call; everything else is file content.
  expect(github.filter((u) => u.startsWith('https://api.github.com/')).length).toBe(1);

  await openPost(page, POST);
  // A relative image in the post resolves to the repo's raw file and loads.
  const image = page.locator('[data-write-editor] .cm-w-image[data-state="loaded"] img').first();
  const scroller = page.locator('[data-write-editor] .cm-scroller');
  for (let i = 0; i < 40 && (await image.count()) === 0; i++) {
    await scroller.evaluate((el) => (el.scrollTop += el.clientHeight * 0.7));
    await page.waitForTimeout(100);
  }
  await expect(image).toBeVisible();
  expect(await image.getAttribute('src')).toMatch(/^https:\/\/raw\.githubusercontent\.com\/dwahdany\/astro-microblog\/main\/src\/content\/entries\/2026\//);

  // The preview is styled by the site's stylesheet and runs no script.
  await page.locator('[data-mode="preview"]:visible').click();
  await expect(page.locator('[data-preview]')).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
  const frame = page.frameLocator('[data-write-pane="preview"] iframe');
  await expect(frame.locator('.katex').first()).toBeVisible();
  expect(await frame.locator('script').count()).toBe(0);

  // A second visit is served from this device: no listing call, no post fetches.
  github.length = 0;
  await page.goto('/write/');
  await page.reload();
  await expect(rows(page).first()).toBeVisible();
  expect(github.filter((u) => u.endsWith('.md'))).toEqual([]);
  expect(errors).toEqual([]);
});

test('with GitHub unreachable the app says the list is a kept copy, still opens posts, and recovers', async ({ page }) => {
  await page.goto('/write/');
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
  const count = await rows(page).count();
  await expect(page.locator('[data-source-state="stale"]')).toHaveCount(0);

  let blocked = true;
  await page.route(GITHUB, (route) => (blocked ? route.abort('internetdisconnected') : route.continue()));
  await page.getByRole('button', { name: 'Reload' }).click();
  const notice = page.locator('[data-source-state="stale"]');
  await expect(notice).toBeVisible();
  await expect(notice).not.toBeEmpty();
  expect(await rows(page).count()).toBe(count);

  // A post still opens from the copy on this device.
  await rows(page).first().locator('a').click();
  await expect(page.locator(EDITOR)).toBeVisible();
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');
  await page.locator('[data-action="back"]').click();
  await expect(notice).toBeVisible();

  blocked = false;
  await notice.getByRole('button', { name: 'Try again' }).click();
  await expect(notice).toHaveCount(0);
  expect(await rows(page).count()).toBe(count);
});

test('a first visit without GitHub explains itself and recovers on retry', async ({ page }) => {
  let blocked = true;
  await page.route(GITHUB, (route) => (blocked ? route.abort('internetdisconnected') : route.continue()));
  await page.goto('/write/');
  await expect(page.getByRole('heading', { name: 'The posts did not load' })).toBeVisible();
  blocked = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
});

test('a first visit that GitHub rate-limits still gets a list, from the manifest the build wrote', async ({ page }) => {
  // Review finding: one anonymous API call (60 per hour per IP, shared behind carrier NAT) stood
  // between a phone and its post list. raw.githubusercontent.com is not rate-limited and stays up.
  await page.route(/^https:\/\/api\.github\.com\//, (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      headers: { 'x-ratelimit-limit': '60', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800), 'access-control-allow-origin': '*', 'access-control-expose-headers': 'x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset' },
      body: JSON.stringify({ message: 'API rate limit exceeded' }),
    }),
  );
  const manifest = page.waitForResponse((res) => res.url().endsWith('/write/manifest.json'));
  await page.goto('/write/');
  expect((await manifest).status()).toBe(200);
  await expect(rows(page).first()).toBeVisible({ timeout: 30_000 });
  expect(await rows(page).count()).toBeGreaterThan(50);
  const notice = page.locator('[data-source-state="stale"]');
  await expect(notice).toContainText('last site build');
  await openPost(page, POST);
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');
});
