/**
 * The file's final line break, in a real browser.
 *
 * A file that ends with a line break shows an empty last line in the editor, and that is where a
 * tap below the text (or ⌘/Ctrl+End) puts the caret: AFTER the final line break. What is typed,
 * pasted or added there used to become the new end of the file, which then ended without a line
 * break. The app now owes the file that break (`composePost`): a file that ended with one still
 * does, whatever is added at the end; a file that did not is left as it is unless the writer types
 * one.
 *
 * GitHub is pretended (./github-mock.ts). Runs on desktop Chromium, Pixel 7 and the iPhone profile.
 */
import { expect, test, type Page } from '@playwright/test';
import { EDITOR, NOTE, NOTE_TEXT, draftText, kept, mockGithub, openPost, openSheet, png, seededGithub, signedIn } from './github-mock';

const BARE = 'src/content/notes/2026/bare.md';
/** A file whose last line has no line break. */
const BARE_TEXT = '---\nslug: bare\ntitle: Bare\ncreated: 2026-11-16T10:00:00+00:00\ntags: []\nis_draft: false\n---\n\nOnly line.';

const review = (page: Page) => page.locator('[data-sheet="review"]');

/** Put the caret where a finger does when it taps the empty space under the last paragraph. */
async function tapBelowText(page: Page, hasTouch: boolean | undefined) {
  const content = page.locator(EDITOR);
  const last = (await content.locator('.cm-line').last().boundingBox())!;
  const point = { x: last.x + 40, y: last.y + last.height + 60 };
  if (hasTouch) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
  await expect(content).toBeFocused();
}

test('typing under the last paragraph: the file still ends with its line break', async ({ page, context, hasTouch }) => {
  await mockGithub(context);
  await signedIn(context);
  await openPost(page, NOTE);
  await tapBelowText(page, hasTouch);
  await page.keyboard.type('Third line.', { delay: 20 });
  await expect.poll(() => draftText(page)).toBe(NOTE_TEXT + 'Third line.\n');
  await kept(page);

  // Review shows one added line and says nothing about a missing line break.
  await openSheet(page, 'review');
  await expect(review(page)).toContainText('Third line.');
  await expect(review(page)).not.toContainText('No line break at the end of the file');
});

test('a footnote added from the very end of the text: the file still ends with its line break', async ({ page, context, hasTouch }) => {
  await mockGithub(context);
  await openPost(page, NOTE);
  await tapBelowText(page, hasTouch);
  await page.keyboard.type('Claim', { delay: 20 });
  await page.locator('[data-command="footnote"]:visible').click();
  await expect(page.locator('[data-note-text]')).toBeFocused();
  await page.keyboard.type('Source.', { delay: 20 });
  await expect.poll(() => draftText(page)).toBe(NOTE_TEXT + 'Claim[^1]\n\n[^1]: Source.\n');
});

test('a picture pasted at the very end, published: the committed file ends with its line break', async ({ page, context, hasTouch }) => {
  const mock = await mockGithub(context);
  await signedIn(context);
  await openPost(page, NOTE);
  await tapBelowText(page, hasTouch);
  await page.evaluate(
    ({ base64, selector }) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], 'end.png', { type: 'image/png' }));
      document.querySelector(selector)!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    },
    { base64: png(60, 40).toString('base64'), selector: EDITOR },
  );
  await expect.poll(() => draftText(page)).toBe(NOTE_TEXT + '![](hello/end.png)\n');
  await kept(page);
  await openSheet(page, 'review');
  await expect(review(page)).not.toContainText('No line break at the end of the file');
  await review(page).locator('[data-action="publish"]').click();
  await expect(review(page).locator('[data-published]')).toBeVisible();
  expect(mock.gh.text(NOTE)).toBe(NOTE_TEXT + '![](hello/end.png)\n');
});

test('a file that never ended with a line break gets none — until the writer types one', async ({ page, context }) => {
  const gh = seededGithub();
  gh.push({ [BARE]: BARE_TEXT }, 'a file without a final line break');
  gh.reset();
  await mockGithub(context, gh);
  await openPost(page, BARE);
  await page.locator(EDITOR).click({ position: { x: 6, y: 6 } });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.type(' More.', { delay: 20 });
  await expect.poll(() => draftText(page)).toBe(BARE_TEXT + ' More.');
  await page.keyboard.press('Enter');
  await expect.poll(() => draftText(page)).toBe(BARE_TEXT + ' More.\n');
  // And taken out again, it is gone again: nothing is added that the writer did not type.
  await page.waitForTimeout(150);
  await page.keyboard.press('Backspace');
  await expect.poll(() => draftText(page)).toBe(BARE_TEXT + ' More.');
});

test('the line break at the end cannot be deleted away from a file that had it', async ({ page, context }) => {
  await mockGithub(context);
  await openPost(page, NOTE);
  await page.locator(EDITOR).click({ position: { x: 6, y: 6 } });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.type('x', { delay: 20 });
  await expect.poll(() => draftText(page)).toBe(NOTE_TEXT + 'x\n');
  // Back to the original text: nothing is kept, the post is unchanged.
  await page.waitForTimeout(150);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(150);
  await page.keyboard.press('Backspace'); // the caret joins the last paragraph: the editor's text has no final break now
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');
});
