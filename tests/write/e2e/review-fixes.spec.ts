/**
 * Browser regression tests for the findings of the pre-release review (dev server only: drafts
 * are seeded through the app's own data module).
 *
 * The same findings are also pinned down without a browser — in the `__tests__` folders under
 * src/write and in tests/write/app-invariant.test.ts, where the real components run in jsdom. These specs add what
 * only a browser has: real key presses, real layout, real tabs.
 */
import { expect, test, type Page } from '@playwright/test';
import { EDITOR, downloadFromReview, openPost, openSheet, postUrl } from './helpers';

const POST = 'src/content/notes/2026/human-entropy.md';
const LONG = 'src/content/entries/2026/curation-leaks.md';
const DATA = '/src/write/data/index.ts';
const rows = (page: Page) => page.locator('[data-post-list] li');
const banner = (page: Page, name: string) => page.locator(`[data-banner="${name}"]`);
const state = (page: Page) => page.locator('[data-write-state]');

interface Seed {
  id: string;
  path: string;
  collection: string;
  raw: string;
  baseRaw: string | null;
  isNew?: boolean;
}

async function seedDraft(page: Page, seed: Seed) {
  await page.goto('/write/');
  await expect(rows(page).first()).toBeVisible();
  await page.evaluate(
    async ({ mod, seed }) => {
      const data = await import(/* @vite-ignore */ mod);
      await data.draftStore.put({ isNew: false, ...seed, updatedAt: Date.now() - 60_000 });
    },
    { mod: DATA, seed },
  );
}

const storedDraft = (page: Page, id: string) =>
  page.evaluate(async ({ mod, id }) => (await import(/* @vite-ignore */ mod)).draftStore.get(id), { mod: DATA, id });

const sourceText = (page: Page, path: string) =>
  page.evaluate(async ({ mod, path }) => ((await import(/* @vite-ignore */ mod)).contentSource.load(path) as Promise<{ raw: string }>).then((p) => p.raw), { mod: DATA, path });

/* ------------------------------------------------------------------ title */

test('Enter (the phone keyboard’s Done) in the title does not touch the post', async ({ page }) => {
  await openPost(page, POST);
  await expect(state(page)).toHaveAttribute('data-write-state', 'clean');
  await page.locator('[data-title-input]').click();
  await page.keyboard.press('Enter');
  // Focus moved to the text, and the key press went nowhere.
  await expect(page.locator(EDITOR)).toBeFocused();
  await page.waitForTimeout(500);
  await expect(state(page)).toHaveAttribute('data-write-state', 'clean');
  await openSheet(page, 'review');
  await expect(page.locator('[data-review-state]')).toHaveAttribute('data-review-state', 'unchanged');
  expect(await downloadFromReview(page)).toBe(await sourceText(page, POST));
});

/* ---------------------------------------------------------------- keyboard */

test('phone toolbar with the keyboard up: link, list, quote and image are on the first screen', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'phone layout only');
  await page.setViewportSize({ width: 360, height: 740 });
  await openPost(page, POST);
  await page.locator(EDITOR).click();
  // Stands in for the keyboard (Android: the viewport gets shorter while the text has focus).
  await page.setViewportSize({ width: 360, height: 420 });
  await expect(page.locator('[data-action="hide-keyboard"]')).toBeVisible();
  const strip = (await page.locator('[data-write-toolbar="bottom"] .scroll').boundingBox())!;
  for (const id of ['link', 'bulletList', 'quote', 'image']) {
    const box = (await page.locator(`[data-write-toolbar="bottom"] [data-command="${id}"]`).boundingBox())!;
    expect(box.x, `${id} starts inside the strip`).toBeGreaterThanOrEqual(strip.x - 0.5);
    expect(box.x + box.width, `${id} ends inside the strip`).toBeLessThanOrEqual(strip.x + strip.width + 0.5);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
  // Footnote and Undo are still pinned at the edges.
  await expect(page.locator('[data-write-toolbar="bottom"] [data-command="footnote"]')).toBeInViewport();
  await expect(page.locator('[data-write-toolbar="bottom"] [data-command="undo"]')).toBeInViewport();
});

test('the line that was tapped stays in view when the keyboard comes up over it', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'phone layout only');
  await openPost(page, LONG);
  const scroller = page.locator('[data-write-editor] .cm-scroller');
  await scroller.evaluate((el) => (el.scrollTop = 900));
  await page.waitForTimeout(200);
  const size = page.viewportSize()!;
  // Tap a line of text about 80% of the way down the screen (text, not a picture: a tapped picture
  // opens the image panel and leaves the keyboard down).
  const point = await page.evaluate((wanted) => {
    let best: { x: number; y: number } | null = null;
    for (const line of document.querySelectorAll<HTMLElement>('[data-write-editor] .cm-line')) {
      if (!line.textContent?.trim()) continue;
      const r = line.getBoundingClientRect();
      const y = r.top + Math.min(r.height / 2, 14);
      if (!best || Math.abs(y - wanted) < Math.abs(best.y - wanted)) best = { x: r.left + 40, y };
    }
    return best!;
  }, size.height * 0.8);
  expect(point.y).toBeGreaterThan(size.height * 0.62); // under where the keyboard will be
  await page.touchscreen.tap(point.x, point.y);
  await expect(page.locator(EDITOR)).toBeFocused();
  // The keyboard takes 300px.
  await page.setViewportSize({ width: size.width, height: size.height - 300 });
  await expect
    .poll(async () => {
      const caret = await page.locator('[data-write-editor] .cm-cursor-primary').boundingBox();
      const box = await scroller.boundingBox();
      return !!caret && !!box && caret.y >= box.y && caret.y + caret.height <= box.y + box.height;
    })
    .toBe(true);
});

test('a phone on its side keeps the phone layout, and a footnote can be written with the keyboard up', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'phone layout only');
  await page.setViewportSize({ width: 844, height: 390 });
  await openPost(page, POST);
  // Wider than the desktop breakpoint, but not tall enough for the desktop chrome.
  await expect(page.locator('[data-write-toolbar="bottom"]')).toBeVisible();
  await expect(page.locator('[data-write-toolbar="top"]')).toHaveCount(0);
  await expect(page.locator('[data-write-status]')).toHaveCount(0);

  await page.locator(EDITOR).click();
  await page.locator('[data-command="footnote"]:visible').click();
  // The keyboard leaves about 190px.
  await page.setViewportSize({ width: 844, height: 190 });
  const note = page.locator('[data-note-panel]');
  await expect(note).toHaveAttribute('data-note-mode', 'cover');
  const text = note.locator('[data-note-text]');
  await expect(text).toBeFocused();
  await expect(text).toBeInViewport({ ratio: 1 });
  expect((await text.boundingBox())!.height).toBeGreaterThanOrEqual(24);
  await page.keyboard.type('Typed in landscape.');
  await expect(text).toHaveValue('Typed in landscape.');
  await note.locator('[data-note-action="done"]').click();
  await expect(page.locator('header.top')).toBeVisible();
});

test('toolbar buttons that cannot apply while a footnote is being edited are disabled', async ({ page }) => {
  await openPost(page, POST);
  await page.locator(EDITOR).click();
  await page.locator('[data-command="footnote"]:visible').click();
  await expect(page.locator('[data-note-text]')).toBeFocused();
  for (const id of ['footnote', 'heading', 'bulletList', 'quote', 'image', 'rule']) {
    await expect(page.locator(`[data-command="${id}"]:visible`).first(), id).toBeDisabled();
  }
  for (const id of ['bold', 'italic', 'link']) await expect(page.locator(`[data-command="${id}"]:visible`).first(), id).toBeEnabled();
});

/* ------------------------------------------------------------------ status */

test('the kept/edited status is never cut off at 360px', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'phone layout only');
  await page.setViewportSize({ width: 360, height: 740 });
  for (const theme of ['galley', 'console', 'riso']) {
    await page.goto('/write/');
    await page.evaluate((t) => localStorage.setItem('write:theme', t), theme);
    await openPost(page, POST);
    await page.locator(EDITOR).click();
    await page.keyboard.type('x');
    const keep = page.locator('header.top .keep');
    await expect(keep).toHaveText('Edited');
    expect(await keep.evaluate((el) => el.scrollWidth <= el.clientWidth + 1), `${theme}: status fits`).toBe(true);
    await page.keyboard.press('Backspace');
    await expect(state(page)).toHaveAttribute('data-write-state', 'clean');
  }
});

/* -------------------------------------------------------------------- list */

test('"Drafts only" is on the first screen of the filter strip on a phone', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'phone layout only');
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto('/write/');
  await expect(rows(page).first()).toBeVisible();
  await expect(page.locator('[data-filter="drafts"]')).toBeInViewport({ ratio: 1 });
});

test('kept changes for a post that is not in the list are listed and open', async ({ page }) => {
  const gone = 'src/content/notes/2026/gone.md';
  const base = '---\nslug: gone\ntitle: Gone\ncreated: 2026-01-01T10:00:00+00:00\ntags: []\nis_draft: false\n---\n\nOriginal.\n';
  await seedDraft(page, { id: gone, path: gone, collection: 'notes', raw: base.replace('Original.', 'Original, edited here.'), baseRaw: base });
  await page.reload();
  const row = page.locator('#group-local').locator('xpath=ancestor::section').locator('a[data-post-row]', { hasText: 'Gone' });
  await expect(row).toBeVisible();
  await expect(row.locator('[data-row-gone]')).toBeVisible();
  await expect(page.locator('[data-filter="drafts"] .n')).not.toHaveText('0');
  await row.click();
  await expect(page.locator(EDITOR)).toContainText('Original, edited here.');
  await expect(banner(page, 'upstream-missing')).toBeVisible();
});

test('a post whose tags repeat does not break the list or its properties', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const id = 'new:notes:dup-tags';
  const raw = '---\nslug: dup\ntitle: Dup\ncreated: 2026-01-01T10:00:00+00:00\ntags:\n  - ai\n  - ai\nis_draft: true\n---\n\nBody.\n';
  await seedDraft(page, { id, path: 'src/content/notes/2026/dup.md', collection: 'notes', raw, baseRaw: null, isNew: true });
  await page.reload();
  // The list fills in after the reload; a single count taken at once can see it empty.
  await expect.poll(() => rows(page).count()).toBeGreaterThan(50);
  await page.goto(postUrl(id, 'properties'));
  await expect(page.locator('[data-tag-field] [data-tag="ai"]')).toHaveCount(2);
  expect(errors).toEqual([]);
});

/* -------------------------------------------------------------- properties */

test('a new blogmark does not open in a red error state', async ({ page }) => {
  await page.goto('/write/#/new');
  await page.locator('[data-new="blogmarks"]').click();
  await expect(page.locator('[data-sheet="properties"]')).toBeVisible();
  await expect(page.locator('[data-issues]')).toHaveCount(0);
  await expect(page.locator('[data-sheet="properties"] .note.bad')).toHaveCount(0);
  await expect(page.locator('[data-sheet="properties"] [aria-invalid="true"]')).toHaveCount(0);
  await expect(page.locator('[data-field="link_url"] [data-required]')).toBeVisible();
  // Once a required field has been visited and left empty, it says so.
  await page.locator('#prop-link_url').focus();
  await page.locator('#prop-slug').focus();
  await expect(page.locator('[data-field="link_url"] .note.bad')).toBeVisible();
});

test('a long title can be read in full in the properties sheet', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'phone layout only');
  await page.setViewportSize({ width: 390, height: 780 });
  await page.goto(postUrl(POST, 'properties'));
  const title = page.locator('#prop-title');
  await expect(title).toBeVisible();
  const value = await title.inputValue();
  expect(value.length).toBeGreaterThan(30);
  // Nothing of it is scrolled out of the field.
  expect(await title.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await title.press('Enter');
  expect(await title.inputValue()).toBe(value);
  await expect(state(page)).toHaveAttribute('data-write-state', 'clean');
});

/* ----------------------------------------------------------------- preview */

test('the preview opens near where the writing was, not at the top', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'one pane at a time');
  await openPost(page, LONG);
  const scroller = page.locator('[data-write-editor] .cm-scroller');
  await scroller.evaluate((el) => (el.scrollTop = el.scrollHeight * 0.6));
  await page.waitForTimeout(200);
  await page.locator('[data-mode="preview"]:visible').click();
  await expect(page.locator('[data-preview]')).toHaveAttribute('data-preview-state', 'ready', { timeout: 20_000 });
  const frame = page.frameLocator('[data-write-pane="preview"] iframe');
  const top = () => frame.locator('html').evaluate(() => document.scrollingElement!.scrollTop);
  await expect.poll(top).toBeGreaterThan(400);

  // Read on a little, look at the text and come straight back: the writing has not moved, so the
  // preview is where it was being read — not back at the writing's place, and not at the top.
  await page.waitForTimeout(2500); // the preview stops holding its place once late layout is done
  const opened = await top();
  await frame.locator('html').evaluate((_, y) => (document.scrollingElement!.scrollTop = y), opened + 700);
  await page.waitForTimeout(900); // the position is noted a few times a second
  const read = await top();
  expect(read).toBeGreaterThan(opened + 300);
  await page.locator('[data-mode="write"]:visible').click();
  await expect(page.locator('[data-write-pane="preview"]')).toHaveCount(0);
  await page.locator('[data-mode="preview"]:visible').click();
  await expect(page.locator('[data-preview]')).toHaveAttribute('data-preview-state', 'ready', { timeout: 20_000 });
  await expect.poll(async () => Math.abs((await top()) - read), { timeout: 5000 }).toBeLessThan(60);
});

/* ------------------------------------------------------------------ drafts */

test('a draft in conflict with the source stays flagged after typing and after a reload', async ({ page }) => {
  const disk = await (async () => {
    await page.goto('/write/');
    await expect(rows(page).first()).toBeVisible();
    return sourceText(page, POST);
  })();
  const oldBase = disk.replace('N=1', 'N=0');
  await seedDraft(page, { id: POST, path: POST, collection: 'notes', raw: oldBase.replace('N=0', 'N=2'), baseRaw: oldBase });
  await openPost(page, POST);
  await expect(banner(page, 'upstream-conflict')).toBeVisible();

  await page.locator(EDITOR).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('One more sentence.');
  await expect(page.locator('[data-keep-state]')).toHaveAttribute('data-keep-state', 'kept');
  await expect(banner(page, 'upstream-conflict')).toBeVisible();
  const stored = (await storedDraft(page, POST)) as { baseRaw: string; conflict?: object };
  expect(stored.baseRaw).toBe(oldBase);
  expect(stored.conflict).toBeTruthy();

  await page.reload();
  await expect(page.locator(EDITOR)).toBeVisible();
  await expect(banner(page, 'upstream-conflict')).toBeVisible();

  // Resolved explicitly, it stays resolved.
  await banner(page, 'upstream-conflict').locator('[data-action="keep-mine"]').click();
  await expect(banner(page, 'upstream-conflict')).toHaveCount(0);
  await page.reload();
  await expect(page.locator(EDITOR)).toBeVisible();
  await expect(banner(page, 'upstream-conflict')).toHaveCount(0);
  await expect(state(page)).toHaveAttribute('data-write-state', 'edited');
});

test('the same post in two tabs: no silent overwrite', async ({ context, page }) => {
  await openPost(page, POST);
  const other = await context.newPage();
  await openPost(other, POST);

  // Tab A edits; tab B (untouched, in the background) follows once it is looked at.
  await page.locator(EDITOR).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('AAA-from-tab-a');
  await expect(page.locator('[data-keep-state]')).toHaveAttribute('data-keep-state', 'kept');
  await other.bringToFront();
  await expect(other.locator(EDITOR)).toContainText('AAA-from-tab-a');

  // Both type at once: whichever stores second is told, and asks.
  await other.locator(EDITOR).click();
  await other.keyboard.press('ControlOrMeta+End');
  await other.keyboard.type('BBB-from-tab-b');
  await expect(other.locator('[data-keep-state]')).toHaveAttribute('data-keep-state', 'kept');
  await page.bringToFront();
  // No click here: A's editor still has the focus and its caret at the end. (A click lands in the
  // middle of the screen, which on a phone is inside the last line, so the X split B's word.)
  await page.keyboard.type('X');
  // A either followed B before typing (then nothing is lost), or is asked which version to keep.
  await page.waitForTimeout(700);
  const asked = await banner(page, 'other-tab').isVisible();
  const stored = (await storedDraft(page, POST)) as { raw: string };
  // Nothing of B's is lost either way: every character of it is in the stored text, in order
  // (A's X may sit anywhere, since following B moves A's caret).
  const tail = stored.raw.slice(stored.raw.indexOf('AAA-from-tab-a'));
  // (B opened the text A had stored. The file ends with a line break and keeps it, so B's end of
  // text is the empty last line: its words start a new line.)
  expect(tail.replace('X', '')).toBe('AAA-from-tab-a\nBBB-from-tab-b\n');
  if (asked) {
    await banner(page, 'other-tab').locator('[data-action="follow-tab"]').click();
    await expect(page.locator(EDITOR)).toContainText('BBB-from-tab-b');
  }
  await other.close();
});
