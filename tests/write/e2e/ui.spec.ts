/**
 * The shell's own behaviours (src/write/ui, src/write/theme): routing and
 * sheets, never losing work, the list, new posts, the properties sheet, looks,
 * and the quality bar (touch targets, no sideways scroll, keyboard, motion).
 * Runs in every project: desktop Chromium, Pixel 7 emulation and the iPhone profile on WebKit.
 */
import { expect, test, type Page } from '@playwright/test';

const POST = 'src/content/entries/2025/simple-ideas.md';
const postUrl = (id: string, sheet = '') => `/write/#/post/${encodeURIComponent(id)}${sheet ? `/${sheet}` : ''}`;
const EDITOR = '[data-write-pane="editor"] .cm-content';
const rows = (page: Page) => page.locator('[data-post-list] li');

async function openPost(page: Page, id = POST) {
  await page.goto(postUrl(id));
  await expect(page.locator(EDITOR)).toBeVisible();
}

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

async function newPost(page: Page, kind: 'entries' | 'notes' | 'blogmarks' | 'quotations') {
  await page.goto('/write/');
  await page.locator('[data-open="new"]').click();
  await page.locator(`[data-new="${kind}"]`).click();
  await expect(page.locator(EDITOR)).toBeVisible();
  // A new blogmark opens with its properties up (the link comes first); the tests start from the bare screen.
  if (kind === 'blogmarks') {
    await expect(page.locator('[data-sheet="properties"]')).toBeVisible();
    await closeSheet(page);
  }
}

const diffText = (page: Page) => page.locator('[data-review-diff]');

/* ------------------------------------------------------------------ routing */

test('sheets are part of the route: back closes them, reload keeps them', async ({ page }) => {
  await page.goto('/write/');
  await expect(rows(page).first()).toBeVisible();

  await page.locator('[data-open="new"]').click();
  await expect(page).toHaveURL(/#\/new$/);
  await expect(page.locator('[data-sheet="new"]')).toBeVisible();
  await page.goBack();
  await expect(page.locator('[data-sheet]')).toHaveCount(0);
  await expect(page).toHaveURL(/#\/$|\/write\/$/);

  // Deep link straight to a sheet; closing it stays on the post instead of leaving the app.
  await page.goto(postUrl(POST, 'properties'));
  await expect(page.locator('[data-sheet="properties"]')).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-sheet="properties"]')).toBeVisible();
  await page.locator('[data-sheet-close]').click();
  await expect(page.locator('[data-sheet]')).toHaveCount(0);
  await expect(page.locator(EDITOR)).toBeVisible();
  expect(page.url()).toContain(encodeURIComponent(POST));
  expect(page.url()).not.toContain('/properties');
});

test('a post that does not exist says so and offers the way back', async ({ page }) => {
  await page.goto(postUrl('new:notes:not-on-this-device'));
  await expect(page.getByRole('heading', { name: 'This draft is no longer on this device' })).toBeVisible();
  await page.getByRole('link', { name: 'All posts', exact: true }).click();
  await expect(rows(page).first()).toBeVisible();

  await page.goto(postUrl('src/content/notes/2026/no-such-post.md'));
  await expect(page.getByRole('heading', { name: 'This post was not found' })).toBeVisible();
});

/* ------------------------------------------------------- never losing work */

test('going back right after typing keeps the work and surfaces it at the top of the list', async ({ page }) => {
  await openPost(page);
  await page.locator(EDITOR).click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' Typed just before leaving.');
  // No waiting for the autosave debounce: leave immediately.
  await page.locator('[data-action="back"]').click();

  const first = rows(page).first();
  await expect(first).toContainText('Simple');
  await expect(first).toContainText('Changed here');
  await expect(page.locator('#group-local')).toHaveText('Kept on this device');

  await first.locator('a').click();
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'edited');
  await expect(page.locator('[data-banner="restored"]')).toBeVisible();
  await openSheet(page, 'review');
  await expect(diffText(page)).toContainText('Typed just before leaving.');
});

test('when the browser refuses to store drafts, the app says so and stops you leaving empty-handed', async ({ page }) => {
  // Private-mode style failure: every IndexedDB open fails.
  await page.addInitScript(() => {
    const broken = () => {
      throw new DOMException('blocked for the test', 'SecurityError');
    };
    Object.defineProperty(IDBFactory.prototype, 'open', { value: broken });
  });
  await openPost(page);
  await page.locator(EDITOR).click();
  await page.keyboard.type('Unstorable.');
  await expect(page.locator('[data-keep-state]')).toHaveAttribute('data-keep-state', 'failed', { timeout: 5000 });
  await expect(page.locator('[data-banner="not-kept"]')).toBeVisible();

  // The first press of Back shows the ways out instead of leaving.
  await page.locator('[data-action="back"]').click();
  await expect(page.locator('[data-sheet="review"]')).toBeVisible();
  await expect(page.locator('[data-sheet="review"]')).toContainText('not storing your changes');
  await expect(page.locator('[data-action="copy"]')).toBeVisible();
  await expect(page.locator('[data-action="download"]')).toBeVisible();
});

test('a new post still opens, and warns, when the browser refuses to store drafts', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(IDBFactory.prototype, 'open', {
      value: () => {
        throw new DOMException('blocked for the test', 'SecurityError');
      },
    });
  });
  await newPost(page, 'notes');
  await page.locator(EDITOR).click();
  await page.keyboard.type('Written with nowhere to keep it.');
  await expect(page.locator('[data-banner="not-kept"]')).toBeVisible();
  await openSheet(page, 'review');
  await expect(diffText(page)).toContainText('Written with nowhere to keep it.');
});

test('the list shows what went wrong when posts cannot be loaded, and recovers on retry', async ({ page }) => {
  // Dev reads posts through one lazily imported module; fail it once.
  let fail = true;
  await page.route('**/src/write/data/local-files.ts*', (route) => (fail ? route.abort() : route.continue()));
  await page.goto('/write/');
  await expect(page.getByRole('heading', { name: 'The posts did not load' })).toBeVisible();
  await expect(page.locator('[data-post-list]')).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(rows(page).first()).toBeVisible();
});

test('download gives exactly the text shown in review; an untouched post downloads byte-identical', async ({ page }) => {
  await openPost(page);
  await openSheet(page, 'review');
  await expect(page.locator('[data-review-state]')).toHaveAttribute('data-review-state', 'unchanged');
  await expect(page.locator('[data-sheet="review"]')).toContainText('Publishing from here is not turned on yet');
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="download"]').click()]);
  expect(download.suggestedFilename()).toBe('simple-ideas.md');
  const { readFileSync } = await import('node:fs');
  expect(readFileSync(await download.path(), 'utf8')).toBe(readFileSync(POST, 'utf8'));
});

/* --------------------------------------------------------------------- list */

test('the list groups by recency, filters by type and drafts, and explains an empty result', async ({ page }) => {
  await page.goto('/write/');
  await expect(rows(page).first()).toBeVisible();
  const headings = await page.locator('[data-post-list] h2').allTextContents();
  expect(headings.length).toBeGreaterThan(3);
  expect(new Set(headings).size).toBe(headings.length);

  // Search is over title, slug, tags and text; every term must match.
  await page.getByPlaceholder('Search titles, tags and text').fill('curation leaks');
  await expect(rows(page)).toHaveCount(1);
  await expect(rows(page).first().locator('mark')).toHaveText(/curation/i);

  await page.getByPlaceholder('Search titles, tags and text').fill('zzzz-nothing-like-this');
  await expect(rows(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'No posts match' })).toBeVisible();
  await page.locator('[data-action="clear-filters"]').click();
  await expect(rows(page).first()).toBeVisible();

  // Filters survive a reload.
  await page.locator('[data-kind="blogmarks"]').click();
  const blogmarks = await rows(page).count();
  await page.reload();
  await expect(page.locator('[data-kind="blogmarks"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(rows(page)).toHaveCount(blogmarks);
  for (const text of await page.locator('[data-post-list] .kind').allTextContents()) expect(text).toBe('Blogmark');
});

/* ---------------------------------------------------------------- new posts */

for (const [kind, singular] of [
  ['entries', 'Entry'],
  ['notes', 'Note'],
  ['blogmarks', 'Blogmark'],
  ['quotations', 'Quotation'],
] as const) {
  test(`new ${singular.toLowerCase()}: scaffolded as a draft, kept on this device, listed as not published`, async ({ page }) => {
    await newPost(page, kind);
    await expect(page.locator('[data-write-state]')).toContainText(singular);
    await openSheet(page, 'review');
    await expect(page.locator('[data-review-path]')).toHaveText(new RegExp(`^src/content/${kind}/\\d{4}/[a-z0-9-]+\\.md$`));
    await expect(diffText(page)).toContainText('is_draft: true');
    await expect(diffText(page)).toContainText('created: ');
    await closeSheet(page);

    await page.locator('[data-action="back"]').click();
    await expect(rows(page).first()).toContainText('Not published');
    await expect(rows(page).first().locator('.kind')).toHaveText(singular);
  });
}

test('a new entry’s slug and path follow the title until the slug is edited by hand', async ({ page }) => {
  await newPost(page, 'entries');
  await page.locator('[data-title-input]').fill('Hello, Brave New World!');
  await openSheet(page, 'properties');
  await expect(page.locator('#prop-slug')).toHaveValue('hello-brave-new-world');
  await expect(page.locator('[data-field="slug"]')).toContainText(/src\/content\/entries\/\d{4}\/hello-brave-new-world\.md/);

  await page.locator('#prop-slug').fill('my-own-slug');
  await page.locator('#prop-title').fill('A different title');
  await expect(page.locator('#prop-slug')).toHaveValue('my-own-slug');
  await closeSheet(page);
  await expect(page.locator('[data-title-input]')).toHaveValue('A different title');
});

test('deleting a new draft asks first, then removes it from this device', async ({ page }) => {
  await newPost(page, 'notes');
  await page.locator(EDITOR).click();
  await page.keyboard.type('Short-lived.');
  await openSheet(page, 'review');
  await page.locator('[data-action="discard"]').click();
  await expect(page.locator('[data-sheet="review"]')).toContainText('It exists nowhere else');
  await page.locator('[data-action="discard-confirm"]').click();
  await expect(rows(page).first()).toBeVisible();
  await expect(page.locator('[data-post-list]')).not.toContainText('Not published');
});

/* --------------------------------------------------------------- properties */

test('blogmark: pasting the link fills the link title and slug from the page', async ({ page }) => {
  let asked = '';
  await page.route('**/api/fetch-meta?**', async (route) => {
    asked = new URL(route.request().url()).searchParams.get('url') ?? '';
    await route.fulfill({ json: { title: 'An Example Page', slug: 'an-example-page' } });
  });
  await page.goto('/write/');
  await page.locator('[data-open="new"]').click();
  await page.locator('[data-new="blogmarks"]').click();
  // A link starts from its own fields: the sheet is already open, and the URL comes first in it.
  await expect(page.locator('[data-sheet="properties"]')).toBeVisible();
  expect(await page.locator('[data-sheet="properties"] [data-field]').first().getAttribute('data-field')).toBe('link_url');

  await page.locator('#prop-link_url').fill('https://example.com/a-page');
  await expect(page.locator('[data-meta-status]')).toHaveAttribute('data-meta-status', 'filled');
  expect(asked).toBe('https://example.com/a-page');
  await expect(page.locator('#prop-link_title')).toHaveValue('An Example Page');
  await expect(page.locator('#prop-slug')).toHaveValue('an-example-page');

  // A title the owner already wrote is never overwritten.
  await page.locator('#prop-link_title').fill('My own wording');
  await page.locator('#prop-link_url').fill('https://example.com/another-page');
  await expect(page.locator('[data-meta-status]')).toHaveAttribute('data-meta-status', 'nothing');
  await expect(page.locator('#prop-link_title')).toHaveValue('My own wording');
});

test('blogmark: a page that cannot be read says so and leaves the fields alone', async ({ page }) => {
  await page.route('**/api/fetch-meta?**', (route) => route.fulfill({ status: 500, json: { error: 'Failed to fetch URL' } }));
  await newPost(page, 'blogmarks');
  await openSheet(page, 'properties');
  await page.locator('#prop-link_url').fill('https://unreachable.example/');
  await expect(page.locator('[data-meta-status]')).toHaveAttribute('data-meta-status', 'failed');
  await expect(page.locator('#prop-link_title')).toHaveValue('');
});

test('tags: add from suggestions and by typing, remove with the chip’s button', async ({ page }) => {
  await openPost(page);
  await openSheet(page, 'properties');
  const field = page.locator('[data-tag-field]');
  const before = await field.locator('[data-tag]').allTextContents();
  expect(before.length).toBeGreaterThan(0);

  const suggestion = field.locator('[data-tag-suggestion]').first();
  const suggested = (await suggestion.getAttribute('data-tag-suggestion'))!;
  expect(before.map((t) => t.trim())).not.toContain(suggested);
  await suggestion.click();
  await expect(field.locator(`[data-tag="${suggested}"]`)).toBeVisible();

  await page.locator('#prop-tags').fill('brand-new-tag');
  await page.keyboard.press('Enter');
  await expect(field.locator('[data-tag="brand-new-tag"]')).toBeVisible();
  await field.locator(`[data-tag="${suggested}"] button`).click();
  await expect(field.locator(`[data-tag="${suggested}"]`)).toHaveCount(0);

  await closeSheet(page);
  await openSheet(page, 'review');
  await expect(diffText(page).locator('.line.add')).toContainText(['brand-new-tag']);
});

test('date and draft controls write only when something really changes', async ({ page }) => {
  await openPost(page);
  await openSheet(page, 'properties');
  const created = page.locator('#prop-created');
  const shown = await created.inputValue();
  expect(shown).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);

  // Committing the value that is already there is not an edit.
  await created.fill(shown);
  await created.dispatchEvent('change');
  await created.blur();
  await page.locator('#prop-is_draft').focus();
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');

  // Toggling the draft switch on and off again is back to the original.
  await page.locator('#prop-is_draft').click();
  await expect(page.locator('#prop-is_draft')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'edited');
  await page.locator('#prop-is_draft').click();
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');

  // "Now" writes the site's UTC format.
  await page.locator('[data-action="now"]').click();
  await expect(page.locator('[data-frontmatter-text]')).toContainText(/created: ['"]?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00/);
});

/* -------------------------------------------------------------------- looks */

test('a theme with both schemes follows the system; Console stays dark; a pinned scheme sticks', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await page.goto('/write/');
  await expect(rows(page).first()).toBeVisible();
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-write-theme', 'galley');
  await expect(html).toHaveAttribute('data-write-scheme', 'light');
  const bg = () => page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor);
  const lightBg = await bg();

  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(html).toHaveAttribute('data-write-scheme', 'dark');
  expect(await bg()).not.toBe(lightBg);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#14161a');

  await page.locator('[data-open="look"]').click();
  await page.locator('[data-theme-choice="console"]').click();
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(html).toHaveAttribute('data-write-scheme', 'dark');

  await page.locator('[data-theme-choice="riso"]').click();
  await expect(html).toHaveAttribute('data-write-scheme', 'light');
  await page.locator('[data-scheme-choice="dark"]').click();
  await expect(html).toHaveAttribute('data-write-scheme', 'dark');
  await page.reload();
  await expect(html).toHaveAttribute('data-write-theme', 'riso');
  await expect(html).toHaveAttribute('data-write-scheme', 'dark');
});

test('each theme’s specimen in the Look sheet is drawn in that theme’s own tokens', async ({ page }) => {
  await page.goto('/write/#/look');
  await expect(page.locator('[data-sheet="look"]')).toBeVisible();
  const colours = await page.locator('[data-theme-choice] .specimen').evaluateAll((els) =>
    els.map((el) => `${getComputedStyle(el).backgroundColor} ${getComputedStyle(el.querySelector('.head')!).fontFamily}`),
  );
  expect(new Set(colours).size).toBe(3);
});

test('reduced motion turns the durations off', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/write/#/look');
  for (const theme of ['galley', 'console', 'riso']) {
    await page.locator(`[data-theme-choice="${theme}"]`).click();
    const seconds = await page.locator('[data-sheet="look"]').evaluate((el) => parseFloat(getComputedStyle(el).animationDuration));
    expect(seconds, theme).toBeLessThan(0.001);
  }
});

/* -------------------------------------------------------------- quality bar */

test('nothing scrolls sideways at 360px, on any screen or sheet, in any theme', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  const overflowing = () =>
    page.evaluate(() => {
      const doc = document.documentElement;
      const wide = [...document.querySelectorAll<HTMLElement>('[data-write-app] *')].filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.right <= doc.clientWidth + 0.5) return false;
        // Things inside a deliberately sideways-scrolling strip (filters, toolbar, tag suggestions) are fine.
        for (let p = el.parentElement; p; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if (o === 'auto' || o === 'scroll' || o === 'hidden') return false;
        }
        return true;
      });
      return { page: doc.scrollWidth - doc.clientWidth, wide: wide.map((el) => el.className || el.tagName).slice(0, 5) };
    });
  const check = async (where: string) => expect(await overflowing(), where).toEqual({ page: 0, wide: [] });

  for (const theme of ['galley', 'console', 'riso']) {
    await page.goto('/write/');
    await page.evaluate((t) => localStorage.setItem('write:theme', t), theme);
    await page.reload();
    await expect(rows(page).first()).toBeVisible();
    await check(`${theme} list`);
    await page.locator('[data-open="new"]').click();
    await check(`${theme} new`);
    await closeSheet(page);
    await page.locator('[data-open="look"]').click();
    await check(`${theme} look`);

    await openPost(page, 'src/content/entries/2026/curation-leaks.md');
    await check(`${theme} write`);
    await openSheet(page, 'properties');
    await check(`${theme} properties`);
    await closeSheet(page);
    await page.locator(EDITOR).click();
    await page.keyboard.type('x');
    await openSheet(page, 'review');
    await check(`${theme} review`);
    await closeSheet(page);
    await page.locator('[data-mode="preview"]').click();
    await expect(page.locator('[data-write-pane="preview"]')).toBeVisible();
    await expect(page.locator('[data-write-pane="editor"]')).toBeHidden();
    await check(`${theme} preview`);
  }
});

test('every control is a 44px touch target on a phone', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  /** Controls whose hit area (including any ::before that extends it) is smaller than 44px either way. */
  const small = () =>
    page.evaluate(() => {
      // A point belongs to a control when it hits the control, something inside it, or its <label>.
      const owns = (el: Element, x: number, y: number) => {
        const hit = document.elementFromPoint(x, y);
        if (hit === null) return false;
        if (hit === el || el.contains(hit)) return true;
        const labels = (el as HTMLInputElement).labels;
        return labels ? [...labels].some((label) => label.contains(hit)) : false;
      };
      // Cut off by a sideways-scrolling strip (filters, toolbar): the visible part is not the whole target.
      const clipped = (el: Element, r: DOMRect) => {
        for (let p = el.parentElement; p; p = p.parentElement) {
          if (!/auto|scroll/.test(getComputedStyle(p).overflowX)) continue;
          const c = p.getBoundingClientRect();
          if (r.left < c.left + 12 || r.right > c.right - 20) return true; // 12/20px: the strip's fade
        }
        return false;
      };
      const out: string[] = [];
      const controls = document.querySelectorAll<HTMLElement>(
        '[data-write-app] :is(button, a[href], input, select, textarea, summary, [role="switch"], [role="radio"])',
      );
      for (const el of controls) {
        const r = el.getBoundingClientRect();
        // Not on screen, or only partly (the cut-off end of a sideways-scrolling strip).
        if (r.width === 0 || r.height === 0 || r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) continue;
        if (clipped(el, r)) continue;
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        if (!owns(el, cx, cy)) continue; // covered (behind a sheet) or scrolled under an edge
        let h = 1;
        for (let d = 1; d <= 30 && owns(el, cx, cy - d); d++) h++;
        for (let d = 1; d <= 30 && owns(el, cx, cy + d); d++) h++;
        let w = 1;
        for (let d = 1; d <= 30 && owns(el, cx - d, cy); d++) w++;
        for (let d = 1; d <= 30 && owns(el, cx + d, cy); d++) w++;
        if (h < 44 || w < 44) out.push(`${el.tagName.toLowerCase()}.${el.className} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24)}" ${w}x${h}`);
      }
      return out;
    });

  await page.goto('/write/');
  await expect(rows(page).first()).toBeVisible();
  expect(await small(), 'list').toEqual([]);
  await page.locator('[data-open="new"]').click();
  expect(await small(), 'new sheet').toEqual([]);
  await closeSheet(page);
  await page.locator('[data-open="look"]').click();
  expect(await small(), 'look sheet').toEqual([]);

  await openPost(page);
  // The editor's own surface (links and widgets inside the text) is sized by the editor itself.
  const smallShell = async () => (await small()).filter((s) => !s.includes('cm-'));
  expect(await smallShell(), 'write').toEqual([]);
  await openSheet(page, 'properties');
  expect(await smallShell(), 'properties').toEqual([]);
  await closeSheet(page);
  await page.locator(EDITOR).click();
  await page.keyboard.type('x');
  await openSheet(page, 'review');
  await page.locator('[data-action="discard"]').click();
  expect(await smallShell(), 'review').toEqual([]);
});

test('the toolbar stays on the bottom edge of the visible area when it shrinks, and the header does not move', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'desktop', 'phone layout only');
  // Stands in for Android's keyboard (interactive-widget=resizes-content): the viewport gets shorter.
  await openPost(page);
  const box = async (selector: string) => (await page.locator(selector).boundingBox())!;
  const full = page.viewportSize()!;
  const headerBefore = await box('header.top');
  expect(Math.round((await box('[data-write-toolbar="bottom"]')).y + (await box('[data-write-toolbar="bottom"]')).height)).toBe(full.height);

  await page.setViewportSize({ width: full.width, height: 420 });
  await expect.poll(async () => Math.round((await box('[data-write-toolbar="bottom"]')).y + (await box('[data-write-toolbar="bottom"]')).height)).toBe(420);
  expect(await box('header.top')).toEqual(headerBefore);
  // The footnote button is still on screen and usable.
  await expect(page.locator('[data-command="footnote"]')).toBeInViewport();
});

test('keyboard: slash searches, arrows walk the list, sheets trap focus and hand it back', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'hardware keyboard');
  await page.goto('/write/');
  await expect(rows(page).first()).toBeVisible();
  await page.keyboard.press('/');
  await expect(page.getByPlaceholder('Search titles, tags and text')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(rows(page).first().locator('a')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(rows(page).nth(1).locator('a')).toBeFocused();
  // A focused row shows a visible ring.
  const outline = await rows(page).nth(1).locator('a').evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(outline).not.toBe('none');

  await page.locator('[data-open="new"]').focus();
  await page.keyboard.press('Enter');
  const sheet = page.locator('[data-sheet="new"]');
  await expect(sheet).toBeVisible();
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press('Tab');
    expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  }
  await page.keyboard.press('Shift+Tab');
  expect(await sheet.evaluate((el) => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-open="new"]')).toBeFocused();

  await rows(page).first().locator('a').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator(EDITOR)).toBeVisible();
});

test('side by side shows the editor and the preview together on a wide screen', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'wide layout only');
  await page.setViewportSize({ width: 1440, height: 900 });
  await openPost(page);
  await page.locator('[data-mode="split"]').click();
  const editor = (await page.locator('[data-write-pane="editor"]').boundingBox())!;
  const preview = (await page.locator('[data-write-pane="preview"]').boundingBox())!;
  expect(editor.x + editor.width).toBeLessThanOrEqual(preview.x + 1);
  expect(Math.abs(editor.width - preview.width)).toBeLessThan(4);
  // The choice is remembered, and falls back to writing when the window is too narrow for two panes.
  await page.reload();
  await expect(page.locator('[data-write-pane="preview"]')).toBeVisible();
  await page.setViewportSize({ width: 1000, height: 800 });
  await expect(page.locator('[data-write-pane="preview"]')).toHaveCount(0);
  await expect(page.locator(EDITOR)).toBeVisible();
});
