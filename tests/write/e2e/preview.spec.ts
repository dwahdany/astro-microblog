/**
 * Preview, in a real browser, through the real app.
 *
 * Covers what unit tests cannot: the site's stylesheet actually styling the
 * frame, the sandbox actually stopping script, native footnote navigation,
 * and the reading position surviving Write ⇄ Preview.
 *
 * The only shell hooks used are the post route and the view switch
 * (`[data-mode=…]`); they are isolated in the helpers below.
 *
 * Console errors are not asserted: in dev the frame logs "Blocked script
 * execution" for the scripts the dev server injects into every page.
 */
import { expect, test, type FrameLocator, type Page } from '@playwright/test';

const FOOTNOTES = 'src/content/entries/2025/academic-conferences.md';
const MATH_IMAGES = 'src/content/entries/2026/curation-leaks.md';
const CODE_HTML = 'src/content/notes/2026/claudia.md';
const INTERNAL_LINK = 'src/content/notes/2025/normal-times.md';

/* ---- shell hooks --------------------------------------------------------- */

const postUrl = (id: string) => `/write/#/post/${encodeURIComponent(id)}`;

async function switchTo(page: Page, mode: 'write' | 'preview' | 'split') {
  await page.locator(`[data-mode="${mode}"]:visible`).first().click();
}

async function openPreview(page: Page, id: string): Promise<FrameLocator> {
  await page.goto(postUrl(id));
  await switchTo(page, 'preview');
  await expect(page.locator('[data-preview]')).toHaveAttribute('data-preview-state', 'ready');
  return page.frameLocator('iframe[title^="Preview"]');
}

/* ---- helpers that act from the app's side of the frame -------------------- */

/** Run `fn` in the APP page with the preview frame's window, as the app itself would reach it. */
function inApp<T, A>(page: Page, fn: (args: { win: Window; doc: Document; arg: A }) => T, arg?: A): Promise<T> {
  return page.evaluate(
    ({ source, arg }) => {
      const frame = document.querySelector<HTMLIFrameElement>('iframe[title^="Preview"]')!;
      // eslint-disable-next-line no-new-func
      return new Function('ctx', `return (${source})(ctx)`)({ win: frame.contentWindow, doc: frame.contentDocument, arg });
    },
    { source: fn.toString(), arg },
  ) as Promise<T>;
}

const topOf = (page: Page, selector: string) =>
  inApp(page, ({ doc, arg }) => Math.round(doc.querySelector(arg)!.getBoundingClientRect().top), selector);

/* -------------------------------------------------------------------------- */

test('shows the post header and body with the site stylesheet, and keeps that stylesheet out of the app', async ({ page }) => {
  const frame = await openPreview(page, FOOTNOTES);

  await expect(frame.locator('#write-preview-header h1')).toHaveText('Academic Conferences');
  await expect(frame.locator('#write-preview-header time')).toHaveText('Monday, July 14, 2025');
  await expect(frame.locator('#write-preview-header a[href="/tags/academia/"]')).toHaveText('#academia');
  await expect(frame.locator('#write-preview-body h2#goals')).toHaveText('Goals');
  // smartypants, as on the site
  await expect(frame.locator('#write-preview-body blockquote').first()).toContainText('“I’ll be on Whova');

  const styles = await inApp(page, ({ win, doc }) => {
    const css = (el: Element) => win.getComputedStyle(el);
    return {
      canvas: css(doc.documentElement).backgroundColor,
      font: css(doc.querySelector('#write-preview-body p')!).fontFamily,
      link: css(doc.querySelector('#write-preview-body p a')!).color,
      siteToken: css(doc.documentElement).getPropertyValue('--color-terminal-bg').trim(),
    };
  });
  expect(styles.canvas).toBe('rgb(15, 23, 42)');
  expect(styles.font).toContain('Roboto Mono');
  expect(styles.link).toBe('rgb(59, 130, 246)');
  expect(styles.siteToken).not.toBe('');

  // Fonts really load inside the frame (they would not with an opaque origin).
  await expect
    .poll(() => inApp(page, ({ doc }) => doc.fonts.check('16px "Roboto Mono"')))
    .toBe(true);

  // …and nothing of the site reaches the app document.
  const leaked = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-terminal-bg').trim());
  expect(leaked).toBe('');
});

test('footnote links jump to the note and back', async ({ page }) => {
  const frame = await openPreview(page, FOOTNOTES);
  const ref = frame.locator('#write-preview-body a[data-footnote-ref]').first();
  const note = frame.locator('#write-preview-body li#user-content-fn-1');
  await expect(ref).toHaveAttribute('href', '#user-content-fn-1');
  await expect(note).not.toBeInViewport();

  await ref.scrollIntoViewIfNeeded();
  await ref.click();
  await expect(note).toBeInViewport();
  // A same-document jump: the frame is still the preview page.
  expect(await inApp(page, ({ win }) => win.location.pathname + win.location.hash)).toBe('/write/preview-frame/#user-content-fn-1');

  await note.locator('a[data-footnote-backref]').click();
  await expect(ref).toBeInViewport();
  await expect(note).not.toBeInViewport();
});

test('highlighted code and raw HTML render as on the site', async ({ page }) => {
  const frame = await openPreview(page, CODE_HTML);

  await expect(frame.locator('#write-preview-body details summary')).toHaveText('Sandbox Profile');

  const code = frame.locator('#write-preview-body pre.astro-code[data-language="bash"]').first();
  await expect(code).toBeVisible();
  expect(await code.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(36, 41, 46)');
  expect(await code.locator('span.line span').first().evaluate((el) => getComputedStyle(el).color)).toBe('rgb(179, 146, 240)');
});

test('math, the card image and sized images render as on the site', async ({ page }) => {
  const frame = await openPreview(page, MATH_IMAGES);

  await expect(frame.locator('#write-preview-header h1')).toHaveText('Curation Leaks: Your "Private" Curated Model Isn\'t');
  const hero = frame.locator('#write-preview-lead img');
  await expect(hero).toHaveClass('w-full rounded-lg mb-8');
  await expect.poll(() => hero.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);

  await expect(frame.locator('#write-preview-body .katex').first()).toBeVisible();
  expect(await frame.locator('#write-preview-body .katex').count()).toBeGreaterThan(20);
  expect(await frame.locator('#write-preview-body .katex-error').count()).toBe(0);

  const image = frame.locator('#write-preview-body img.img-medium').first();
  await image.scrollIntoViewIfNeeded();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  // .prose img.img-medium caps the width at 36rem (576px) and centres it.
  expect(await image.evaluate((img) => getComputedStyle(img).maxWidth)).toBe('min(576px, 100%)');

  // KaTeX's own font is in use (the stylesheet and its fonts are loaded in the frame).
  const katexFont = await frame.locator('#write-preview-body .katex').first().evaluate((el) => getComputedStyle(el).fontFamily);
  expect(katexFont).toContain('KaTeX_Main');
});

test('a link to another post gets the site’s "Previously" card', async ({ page }) => {
  const frame = await openPreview(page, INTERNAL_LINK);
  const card = frame.locator('#write-preview-body .internal-link-preview').first();
  await expect(card).toBeVisible();
  await expect(card.locator('.preview-label')).toContainText('↩ Previously');
  await expect(card.locator('a')).toHaveAttribute('href', /^\/20\d\d\/[A-Z][a-z]{2}\/\d{1,2}\/[^/]+\/$/);
});

test('nothing written into the preview can run script', async ({ page }) => {
  await openPreview(page, FOOTNOTES);
  const sandbox = await page.locator('iframe[title^="Preview"]').getAttribute('sandbox');
  expect(sandbox).not.toContain('allow-scripts');
  expect(sandbox).not.toContain('allow-top-navigation');

  const titleBefore = await page.title();

  // Bypass the renderer's own clean-up entirely: write hostile HTML straight
  // into the frame, the way a bug in the app would.
  await inApp(page, ({ doc }) => {
    const slot = doc.getElementById('write-preview-after')!;
    slot.innerHTML =
      `<img src="/definitely-missing.png" onerror="top.document.title='pwned-onerror'; top.pwned = 1">` +
      `<svg onload="top.document.title='pwned-svg'; top.pwned = 1"></svg>` +
      `<a id="evil" href="javascript:top.document.title='pwned-link'; top.pwned = 1; void 0">click me</a>` +
      `<iframe srcdoc="<script>top.document.title='pwned-srcdoc'; top.pwned = 1<\/script>"></iframe>` +
      `<details open ontoggle="top.document.title='pwned-toggle'; top.pwned = 1"><summary>x</summary></details>`;
    const script = doc.createElement('script');
    script.textContent = `top.document.title='pwned-script'; top.pwned = 1`;
    slot.append(script);
  });

  const frame = page.frameLocator('iframe[title^="Preview"]');
  await frame.locator('#evil').scrollIntoViewIfNeeded();
  await frame.locator('#evil').click();
  await page.waitForTimeout(800);

  expect(await page.title()).toBe(titleBefore);
  expect(await page.evaluate(() => (window as unknown as { pwned?: number }).pwned)).toBeUndefined();
  // …and the same check from inside the frame's own window.
  expect(await inApp(page, ({ win }) => (win as unknown as { pwned?: number }).pwned)).toBeUndefined();
});

test('links open in a new tab; the preview itself never navigates away', async ({ page, context }) => {
  const frame = await openPreview(page, FOOTNOTES);
  const external = frame.locator('#write-preview-body a[href^="https://"]').first();
  await expect(external).toHaveAttribute('target', '_blank');
  await expect(external).toHaveAttribute('rel', 'noopener noreferrer');

  // A site-relative link (a tag): opens as a normal, unsandboxed tab.
  const tag = frame.locator('#write-preview-header a[href="/tags/academia/"]');
  const [popup] = await Promise.all([context.waitForEvent('page'), tag.click()]);
  await popup.waitForLoadState('domcontentloaded');
  expect(new URL(popup.url()).pathname).toBe('/tags/academia/');
  await popup.close();

  expect(await inApp(page, ({ win }) => win.location.pathname)).toBe('/write/preview-frame/');
  await expect(frame.locator('#write-preview-header h1')).toHaveText('Academic Conferences');
});

test('the reading position survives leaving the preview and coming back', async ({ page }) => {
  await openPreview(page, FOOTNOTES);
  const target = '#write-preview-body h2#turning-goals-into-actions-or-why-i-am-skipping-presentations';

  // Let the first paint settle, then scroll like a reader would.
  await page.waitForTimeout(2500);
  await inApp(page, ({ win, doc, arg }) => {
    const y = doc.querySelector(arg)!.getBoundingClientRect().top + win.scrollY - 40;
    win.scrollTo(0, y);
  }, target);
  await page.waitForTimeout(900); // the position is noted a few times a second
  const before = await topOf(page, target);
  expect(Math.abs(before - 40)).toBeLessThan(5);
  const scrolled = await inApp(page, ({ win }) => win.scrollY);
  expect(scrolled).toBeGreaterThan(300);

  await switchTo(page, 'write');
  await expect(page.locator('iframe[title^="Preview"]')).toHaveCount(0);
  await switchTo(page, 'preview');
  await expect(page.locator('[data-preview]')).toHaveAttribute('data-preview-state', 'ready');

  // A brand-new frame document, back at the same heading.
  await expect.poll(() => topOf(page, target), { timeout: 5000 }).toBe(before);
  await page.waitForTimeout(2500); // still there once images and fonts have settled
  expect(Math.abs((await topOf(page, target)) - before)).toBeLessThanOrEqual(2);
});

test('side by side: typing updates only the changed block and does not move the reader', async ({ page }) => {
  await page.goto(postUrl(FOOTNOTES));
  const split = page.locator('[data-mode="split"]:visible');
  await expect(page.locator('[data-mode]:visible').first()).toBeVisible();
  test.skip((await split.count()) === 0, 'side-by-side view is only offered on wide screens');
  await split.first().click();
  await expect(page.locator('[data-preview]')).toHaveAttribute('data-preview-state', 'ready');
  const frame = page.frameLocator('iframe[title^="Preview"]');
  const target = '#write-preview-body h2#turning-goals-into-actions-or-why-i-am-skipping-presentations';

  await page.waitForTimeout(2500);
  await inApp(page, ({ win, doc, arg }) => {
    win.scrollTo(0, doc.querySelector(arg)!.getBoundingClientRect().top + win.scrollY - 40);
    // Tag live nodes; a re-render that replaced them would lose the tags.
    (doc.querySelector('#write-preview-body img') as unknown as { kept?: boolean }).kept = true;
    (doc.querySelector(arg) as unknown as { kept?: boolean }).kept = true;
  }, target);
  await page.waitForTimeout(600);
  const before = await topOf(page, target);

  // Type at the very end of the document: the text joins the last paragraph.
  await page.locator('[data-write-editor] .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' PREVIEWLIVE');
  await expect(frame.locator('#write-preview-body > p').last()).toContainText('See you around! PREVIEWLIVE');

  const after = await inApp(page, ({ doc, arg }) => ({
    image: (doc.querySelector('#write-preview-body img') as unknown as { kept?: boolean }).kept === true,
    heading: (doc.querySelector(arg) as unknown as { kept?: boolean }).kept === true,
    top: Math.round(doc.querySelector(arg)!.getBoundingClientRect().top),
  }), target);
  expect(after.image).toBe(true);
  expect(after.heading).toBe(true);
  expect(Math.abs(after.top - before)).toBeLessThanOrEqual(2);
});
