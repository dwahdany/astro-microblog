/**
 * The whole app as one piece, on a real post: open → footnote chips → add a
 * footnote from the toolbar → edit an existing note through its chip → preview
 * → change a tag in properties → review → copy / download — and the resulting
 * file differs from the original in exactly the intended lines.
 *
 * Runs on every project (desktop, Pixel 7, iPhone/WebKit) and against both
 * targets (dev server, production build); see ./helpers.ts.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  EDITOR,
  captureClipboard,
  closeSheet,
  downloadFromReview,
  lastCopied,
  lineChanges,
  openPost,
  openSheet,
  original,
  press,
  reveal,
} from './helpers';

const POST = 'src/content/notes/2026/human-entropy.md';

// What the journey does to the file, and nothing else:
const ANCHOR = 'So, did it prevent the other agent from figuring it out? No.';
const NEW_NOTE = 'Added from the toolbar by the journey test.';
const NOTE_2 = '[^2]: I tried, but I have nothing to add to my defense.';
const NOTE_2_ADDED = ' Edited through the chip.';
const TAG_OUT = 'eval';
const TAG_IN = 'benchmarks';

const editor = (page: Page) => page.locator('[data-write-editor]');
const frame = (page: Page) => page.frameLocator('[data-write-pane="preview"] iframe');

test('open, footnote, note, preview, tag, review, copy and download change exactly the intended lines', async ({ page, hasTouch }) => {
  const before = await original(POST);
  expect(before, 'the post exists in the source').not.toBeNull();
  // The file this test was written against: three footnotes, the anchor paragraph and the tag to swap.
  expect(before).toContain(`\n${ANCHOR}\n`);
  expect(before).toContain(`\n${NOTE_2}\n`);
  expect(before).toContain(`\n  - ${TAG_OUT}\n`);
  expect(before).not.toContain('[^4]');

  const expected = before!
    .replace(`\n${ANCHOR}\n`, `\n${ANCHOR}[^4]\n`)
    .replace(`\n${NOTE_2}\n`, `\n${NOTE_2}${NOTE_2_ADDED}\n`)
    .replace(`\n  - ${TAG_OUT}\n`, '\n')
    .replace('\n  - security\n', `\n  - security\n  - ${TAG_IN}\n`)
    .replace(/\n$/, `\n[^4]: ${NEW_NOTE}\n`);

  await captureClipboard(page);
  await openPost(page, POST);
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');

  /* ---- footnote references are chips, not markup ---- */
  for (const n of ['1', '2', '3']) {
    const chip = await reveal(page, editor(page).locator(`[data-footnote-ref="${n}"]`));
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(n);
    await expect(chip).not.toHaveClass(/cm-w-fn-orphan/);
  }
  const shown = await page.locator(EDITOR).evaluate((el) => (el as HTMLElement).innerText);
  expect(shown).not.toMatch(/\[\^\d+\](?!:)/);

  /* ---- add a footnote from the toolbar, at the end of a paragraph ---- */
  const line = await reveal(page, editor(page).locator('.cm-line', { hasText: ANCHOR }));
  const box = (await line.boundingBox())!;
  // Bottom-right corner of the paragraph: past the end of its last visual line, so the caret lands at its end.
  await press(page, line, hasTouch, { x: box.width - 3, y: box.height - 6 });
  await expect(page.locator(EDITOR)).toBeFocused();
  await page.locator('[data-command="footnote"]:visible').click();

  const note4 = editor(page).locator('[data-note-panel="4"]');
  await expect(note4).toBeVisible();
  await expect(note4.locator('[data-note-text]')).toBeFocused();
  await page.keyboard.type(NEW_NOTE);
  await note4.locator('[data-note-action="done"]').click();
  await expect(note4).toBeHidden();
  await expect(editor(page).locator('[data-footnote-ref="4"]')).toHaveText('4');
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'edited');

  /* ---- edit an existing note through its chip ---- */
  const chip2 = await reveal(page, editor(page).locator('[data-footnote-ref="2"]'));
  await press(page, chip2, hasTouch);
  const note2 = editor(page).locator('[data-note-panel="2"]');
  await expect(note2).toBeVisible();
  const text2 = note2.locator('[data-note-text]');
  await expect(text2).toHaveValue(NOTE_2.slice('[^2]: '.length));
  // Coming from the text (keyboard up), the note takes the caret itself, at its end.
  await expect(text2).toBeFocused();
  await page.keyboard.type(NOTE_2_ADDED);
  await expect(text2).toHaveValue(NOTE_2.slice('[^2]: '.length) + NOTE_2_ADDED);
  await note2.locator('[data-note-action="done"]').click();
  await expect(note2).toBeHidden();

  /* ---- preview: the footnotes as the site renders them ---- */
  await page.locator('[data-mode="preview"]:visible').click();
  await expect(page.locator('[data-preview]')).toHaveAttribute('data-preview-state', 'ready', { timeout: 20_000 });
  const notes = frame(page).locator('section.footnotes ol > li');
  await expect(notes).toHaveCount(4);
  await expect(notes.nth(1)).toContainText('nothing to add to my defense. Edited through the chip.');
  // The site numbers notes by first use, not by label: the new [^4] is referenced before [^3], so it renders third.
  await expect(notes.nth(2)).toContainText(NEW_NOTE);
  await expect(notes.nth(2)).toHaveAttribute('id', 'user-content-fn-4');
  await expect(frame(page).locator('sup a[data-footnote-ref]')).toHaveText(['1', '2', '3', '4']);
  await expect(frame(page).locator('body')).not.toContainText('[^');
  await page.locator('[data-mode="write"]:visible').click();
  await expect(page.locator(EDITOR)).toBeVisible();

  /* ---- properties: swap one tag ---- */
  await openSheet(page, 'properties');
  const tags = page.locator('[data-tag-field]');
  await tags.locator(`[data-tag="${TAG_OUT}"] button`).click();
  await expect(tags.locator(`[data-tag="${TAG_OUT}"]`)).toHaveCount(0);
  await page.locator('#prop-tags').fill(TAG_IN);
  await page.keyboard.press('Enter');
  await expect(tags.locator(`[data-tag="${TAG_IN}"]`)).toBeVisible();
  await closeSheet(page);

  /* ---- review: exactly the intended lines ---- */
  await openSheet(page, 'review');
  await expect(page.locator('[data-review-state]')).toHaveAttribute('data-review-state', 'changed');
  const diff = page.locator('[data-review-diff]');
  /** The lines of one kind as the diff shows them, without the screen-reader prefix. */
  const texts = (kind: 'add' | 'del') =>
    diff.locator(`.line.${kind} .text`).evaluateAll((els) =>
      els.map((el) => {
        const copy = el.cloneNode(true) as HTMLElement;
        copy.querySelectorAll('.w-sr').forEach((sr) => sr.remove());
        return copy.textContent ?? '';
      }),
    );
  expect(await texts('del')).toEqual([`  - ${TAG_OUT}`, ANCHOR, NOTE_2]);
  expect(await texts('add')).toEqual([`  - ${TAG_IN}`, `${ANCHOR}[^4]`, `${NOTE_2}${NOTE_2_ADDED}`, `[^4]: ${NEW_NOTE}`]);

  /* ---- the ways out carry that exact text ---- */
  const downloaded = await downloadFromReview(page);
  expect(downloaded).toBe(expected);
  expect(lineChanges(before!, downloaded)).toEqual({
    removed: [`  - ${TAG_OUT}`, ANCHOR, NOTE_2],
    added: [`  - ${TAG_IN}`, `${ANCHOR}[^4]`, `${NOTE_2}${NOTE_2_ADDED}`, `[^4]: ${NEW_NOTE}`],
  });

  await page.locator('[data-sheet="review"] [data-action="copy"]').click();
  await expect(page.locator('[data-sheet="review"] [data-action="copy"]')).toContainText('Copied');
  expect(await lastCopied(page)).toBe(expected);

  /* ---- and all of it is still there after a reload ---- */
  await closeSheet(page);
  await expect(page.locator('[data-keep-state]')).toHaveAttribute('data-keep-state', 'kept');
  await page.reload();
  await expect(page.locator(EDITOR)).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-banner="restored"]')).toBeVisible();
  await openSheet(page, 'review');
  expect(await downloadFromReview(page)).toBe(expected);

  /* ---- discarding returns the file to the original, byte for byte ---- */
  await page.locator('[data-action="discard"]').click();
  await page.locator('[data-action="discard-confirm"]').click();
  await expect(page.locator('[data-sheet]')).toHaveCount(0);
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');
  await openSheet(page, 'review');
  await expect(page.locator('[data-review-state]')).toHaveAttribute('data-review-state', 'unchanged');
  expect(await downloadFromReview(page)).toBe(before);
});
