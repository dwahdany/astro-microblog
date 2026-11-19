/**
 * Smoke test of the /write shell against the dev server: the behaviours the
 * whole app hangs on (byte-identity, autosave/restore, review, new post,
 * properties, preview, themes).
 *
 * Hooks the shell exposes (keep them in step with src/write/ui):
 *   [data-post-list] li          list rows            [data-kind]         type filters
 *   [data-open="new|look|properties|review|more"]     buttons that open a sheet
 *   [data-sheet="…"]             the open sheet       [data-new="notes"]  kinds in the New post sheet
 *   [data-write-pane="editor"]   the writing surface  [data-mode]         write / split / preview
 *   [data-write-state]           clean | edited       [data-command]      toolbar commands
 *   [data-review-state], [data-review-diff], [data-action="copy|download|discard|discard-confirm"]
 *   [data-theme-choice], [data-scheme-choice]
 *
 * On a phone "Review changes" lives in the "more" sheet; `openSheet` handles both layouts.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const POST = 'src/content/entries/2025/simple-ideas.md';
const postUrl = (id: string) => `/write/#/post/${encodeURIComponent(id)}`;

const EDITOR = '[data-write-pane="editor"] .cm-content';

async function openPost(page: Page, id = POST) {
  await page.goto(postUrl(id));
  await expect(page.locator(EDITOR)).toBeVisible();
}

/** Open a sheet from the writing screen, going through "more" where the phone layout tucks it away. */
async function openSheet(page: Page, name: 'properties' | 'review' | 'look') {
  const direct = page.locator(`[data-open="${name}"]`);
  if (!(await direct.isVisible())) await page.locator('[data-open="more"]').click();
  await direct.click();
  await expect(page.locator(`[data-sheet="${name}"]`)).toBeVisible();
}

async function closeSheet(page: Page) {
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-sheet]')).toHaveCount(0);
}

async function reviewState(page: Page): Promise<string | null> {
  await openSheet(page, 'review');
  const state = await page.locator('[data-review-state]').getAttribute('data-review-state');
  await closeSheet(page);
  return state;
}

test('lists posts from every collection and filters them', async ({ page }) => {
  await page.goto('/write/');
  const rows = page.locator('[data-post-list] li');
  await expect(rows.first()).toBeVisible();
  const all = await rows.count();
  expect(all).toBeGreaterThan(50);

  await page.locator('[data-kind="quotations"]').click();
  const quotes = await rows.count();
  expect(quotes).toBeGreaterThan(0);
  expect(quotes).toBeLessThan(all);

  await page.locator('[data-kind="entries"]').click();
  await page.getByPlaceholder('Search titles, tags and text').fill('curation leaks');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Curation Leaks');
});

test('dev: the browser receives the exact bytes on disk', async ({ page }) => {
  await page.goto('/write/');
  for (const path of [POST, 'src/content/entries/2026/curation-leaks.md', 'src/content/portfolio/2026/opening-spgi-2026-08-04.md']) {
    const served = await page.evaluate(async (p) => (await import(/* @vite-ignore */ `/${p}?raw`)).default as string, path);
    expect(served, path).toBe(readFileSync(path, 'utf8'));
  }
});

test('opening a post and changing nothing leaves it byte-identical', async ({ page }) => {
  await openPost(page);
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');
  expect(await reviewState(page)).toBe('unchanged');

  // Focusing, moving the caret and switching views are not edits.
  await page.locator(EDITOR).click();
  await page.keyboard.press('ArrowDown');
  await page.locator('[data-mode="preview"]').click();
  await page.locator('[data-mode="write"]').click();
  expect(await reviewState(page)).toBe('unchanged');
});

test('an edit is diffed, autosaved and restored after reload; discarding returns to the original', async ({ page }) => {
  await openPost(page);
  await page.locator(EDITOR).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('A sentence typed by the smoke test.');
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'edited');

  await openSheet(page, 'review');
  await expect(page.locator('[data-review-diff] .line.add').last()).toContainText('A sentence typed by the smoke test.');
  await closeSheet(page);

  await page.waitForTimeout(700); // autosave debounce
  await page.reload();
  await expect(page.locator(EDITOR)).toContainText('A sentence typed by the smoke test.');
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'edited');

  // The edited post is announced as picked up from last time.
  await expect(page.locator('[data-banner="restored"]')).toBeVisible();

  await openSheet(page, 'review');
  await page.locator('[data-action="discard"]').click();
  await page.locator('[data-action="discard-confirm"]').click();
  await expect(page.locator('[data-sheet]')).toHaveCount(0);
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');
  await expect(page.locator(EDITOR)).not.toContainText('A sentence typed by the smoke test.');
});

test('toolbar commands edit the text without taking focus from the editor', async ({ page }) => {
  await openPost(page);
  await page.locator(EDITOR).click();
  await page.locator('[data-command="footnote"]').click();
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'edited');
  // Focus never left the writing surface (on a phone that would have dismissed the keyboard).
  expect(await page.evaluate(() => document.activeElement?.closest('[data-write-pane="editor"]') !== null)).toBe(true);
  // The live preview may render the reference as a superscript, so look at the text itself.
  await openSheet(page, 'review');
  await expect(page.locator('[data-review-diff]')).toContainText('[^1]');
  await expect(page.locator('[data-review-diff]')).toContainText('[^1]: ');
});

test('a new note gets scaffolded frontmatter and survives reload', async ({ page }) => {
  await page.goto('/write/');
  await page.locator('[data-open="new"]').click();
  await page.locator('[data-new="notes"]').click();
  await expect(page.locator(EDITOR)).toBeVisible();
  await page.locator(EDITOR).click();
  await page.keyboard.type('Hello from a new note.');
  await openSheet(page, 'review');
  await expect(page.locator('[data-review-diff]')).toContainText('is_draft: true');
  await expect(page.locator('[data-review-diff]')).toContainText('Hello from a new note.');
  await closeSheet(page);
  await page.waitForTimeout(700);
  await page.reload();
  await expect(page.locator(EDITOR)).toContainText('Hello from a new note.');
});

test('properties edits reach the frontmatter', async ({ page }) => {
  await openPost(page);
  await openSheet(page, 'properties');
  await page.locator('#prop-title').fill('Simple Ideas, retitled');
  await closeSheet(page);
  await openSheet(page, 'review');
  await expect(page.locator('[data-review-diff] .line.add').first()).toContainText('Simple Ideas, retitled');
});

// Contract (FrontmatterApi.patch): only the edited key's line may change — the tags line next to it
// (`tags: [research, academia]`) must come through byte for byte.
test('editing one property changes only that key\'s line', async ({ page }) => {
  await openPost(page);
  await openSheet(page, 'properties');
  await page.locator('#prop-title').fill('Simple Ideas, retitled');
  await closeSheet(page);
  await openSheet(page, 'review');
  await expect(page.locator('[data-review-diff] .line.add')).toHaveCount(1);
  await expect(page.locator('[data-review-diff] .line.del')).toHaveCount(1);
  await expect(page.locator('[data-review-diff] .line.add')).toContainText('Simple Ideas, retitled');
});

test('the preview frame renders the post with resolved images', async ({ page }) => {
  await openPost(page);
  await page.locator('[data-mode="preview"]').click();
  const frame = page.frameLocator('iframe[title^="Preview"]');
  const image = frame.locator('#write-preview-body img').first();
  await expect(image).toBeVisible();
  await expect(image).toHaveAttribute('src', '/src/content/entries/2025/simple-ideas/2025-02-image.png');
  expect(await image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
});

test('three themes switch by attribute alone and are remembered', async ({ page }) => {
  await page.goto('/write/');
  await page.locator('[data-open="look"]').click();
  const canvas = () => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  const seen = new Set<string>();
  for (const id of ['galley', 'console', 'riso']) {
    await page.locator(`[data-theme-choice="${id}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('data-write-theme', id);
    seen.add(await canvas());
  }
  expect(seen.size).toBe(3);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-write-theme', 'riso');
});
