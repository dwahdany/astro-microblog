/**
 * The editor inside the real /write app (Astro dev server), as opposed to the
 * standalone harness, where its behaviour is tested in depth:
 *
 *   bunx playwright test -c tests/write/editor-harness/playwright.config.ts
 *
 * This file only checks the wiring: real posts, the app's asset resolver, the
 * app's toolbar. It leans on the editor's own DOM (`[data-write-editor]`) and
 * on two things the shell owns: the `#/post/<id>` route and the toolbar's
 * `data-command` buttons.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const FOOTNOTES = 'src/content/notes/2026/human-entropy.md';
const MATH = 'src/content/entries/2026/curation-leaks.md';

const editor = (page: Page) => page.locator('[data-write-editor]');
const content = (page: Page) => page.locator('[data-write-editor] .cm-content');

async function openPost(page: Page, id: string) {
  await page.goto(`/write/#/post/${encodeURIComponent(id)}`);
  await expect(content(page)).toBeVisible();
}

/** The body as the editor holds it: every line's text, joined (CodeMirror keeps one .cm-line per line). */
const bodyOf = (path: string) => readFileSync(path, 'utf8').replace(/^---\n[\s\S]*?\n---\n(?:[ \t]*\n)*/, '');

test('a post with footnotes shows chips; tapping one opens its note from the document', async ({ page, hasTouch }) => {
  await openPost(page, FOOTNOTES);
  const body = bodyOf(FOOTNOTES);
  const note = /^\[\^1\]: (.*)$/m.exec(body)![1];

  const chip = editor(page).locator('[data-footnote-ref="1"]').first();
  await chip.scrollIntoViewIfNeeded();
  await expect(chip).toBeVisible();
  await expect(chip).not.toHaveClass(/cm-w-fn-orphan/);
  if (hasTouch) await chip.tap();
  else await chip.click();

  const panel = editor(page).locator('[data-note-panel="1"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-note-text]')).toHaveValue(note);
});

test('the Footnote button adds the next number and moves into its note, inside the editor', async ({ page }) => {
  await openPost(page, FOOTNOTES);
  await content(page).click();
  await page.locator('[data-command="footnote"]').first().click();
  // The post has notes 1–3; nothing is renumbered, the new one is 4.
  const panel = editor(page).locator('[data-note-panel="4"]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-note-text]')).toBeFocused();
  await page.keyboard.type('Typed in the app.');
  await panel.locator('[data-note-action="done"]').click();
  await expect(panel).toBeHidden();
  await expect(content(page)).toBeFocused();

  // The text went into the document: reopening the note reads it back from the definition.
  const chip = editor(page).locator('[data-footnote-ref="4"]');
  await expect(chip).not.toHaveClass(/cm-w-fn-orphan/);
  await chip.click();
  await expect(panel.locator('[data-note-text]')).toHaveValue('Typed in the app.');
});

/** CodeMirror only draws the lines near the viewport: scroll until something shows up. */
async function scrollTo(page: Page, selector: string) {
  const scroller = editor(page).locator('.cm-scroller');
  const target = editor(page).locator(selector).first();
  for (let i = 0; i < 40 && (await target.count()) === 0; i++) {
    await scroller.evaluate((el) => (el.scrollTop += el.clientHeight * 0.7));
    await page.waitForTimeout(80);
  }
  return target;
}

test('a post with math and images renders both through the app', async ({ page }) => {
  await openPost(page, MATH);
  // KaTeX is a lazy chunk; a cold dev server may take a while to hand it over.
  await scrollTo(page, '.cm-w-math');
  await expect(editor(page).locator('.cm-w-math .katex').first()).toBeVisible({ timeout: 20_000 });
  const visible = await content(page).evaluate((el) => (el as HTMLElement).innerText);
  expect(visible).not.toContain('$\\mathcal{T}$');
  expect(visible).not.toContain('**It isn');

  // The first image must load via the app's asset resolver.
  await scrollTo(page, '.cm-w-image');
  await expect(editor(page).locator('.cm-w-image[data-state="loaded"]').first()).toBeVisible();
});

test('the editor fills its pane and never scrolls sideways', async ({ page }) => {
  await openPost(page, MATH);
  const metrics = await page.evaluate(() => {
    const scroller = document.querySelector('[data-write-editor] .cm-scroller')!;
    return {
      overflow: scroller.scrollWidth - scroller.clientWidth,
      page: document.documentElement.scrollWidth - window.innerWidth,
      scrolls: scroller.scrollHeight > scroller.clientHeight,
    };
  });
  expect(metrics.overflow).toBeLessThanOrEqual(1);
  expect(metrics.page).toBeLessThanOrEqual(0);
  expect(metrics.scrolls).toBe(true);
});
