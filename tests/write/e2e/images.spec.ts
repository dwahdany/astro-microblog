/**
 * Images, in a real browser: a picture pasted, picked or dropped is taken in, shown from the bytes
 * on this device, kept with the draft, and committed with the post — GitHub pretended
 * (./github-mock.ts), the commit checked byte for byte.
 *
 * Runs in every project: desktop Chromium, Pixel 7 emulation and the iPhone profile on WebKit.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  EDITOR,
  NOTE,
  NOTE_TEXT,
  PNG_SIGNATURE,
  closeSheet,
  decode,
  draftText,
  kept,
  mockGithub,
  openList,
  openPost,
  openSheet,
  png,
  pngSize,
  signedIn,
  typeAtEnd,
} from './github-mock';

const review = (page: Page) => page.locator('[data-sheet="review"]');
const loadedImages = (page: Page) => page.locator('[data-write-editor] .cm-w-image[data-state="loaded"] img');
const notice = (page: Page) => page.locator('[data-banner="notice"]');
const FOLDER = 'src/content/notes/2026/hello';

/** Put the caret at the end of the post and hand the editor a paste (or a drop) carrying files. */
async function give(page: Page, kind: 'paste' | 'drop', files: { name: string; type: string; bytes: Buffer }[]) {
  await typeAtEnd(page, '');
  await page.evaluate(
    ({ kind, files, selector }) => {
      const transfer = new DataTransfer();
      for (const f of files) {
        const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
        transfer.items.add(new File([bytes], f.name, { type: f.type }));
      }
      const target = document.querySelector(selector)!;
      const event =
        kind === 'paste'
          ? new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true })
          : new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
      target.dispatchEvent(event);
    },
    { kind, files: files.map((f) => ({ name: f.name, type: f.type, base64: f.bytes.toString('base64') })), selector: EDITOR },
  );
}

/** The bytes behind an <img> the page shows (a blob: URL), as base64. */
const shownBytes = (page: Page, src: string): Promise<string> =>
  page.evaluate(async (url) => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary);
  }, src);

test('paste: taken in (downscaled, metadata gone), shown at once, kept across a reload, committed with the post', async ({ page, context }) => {
  const mock = await mockGithub(context);
  await signedIn(context);
  await openPost(page, NOTE);
  const original = png(2400, 1200);
  await give(page, 'paste', [{ name: 'Holiday Photo (1).PNG', type: 'image/png', bytes: original }]);

  // In the text, under a safe name, as the site writes image references.
  await expect.poll(() => draftText(page)).toBe(NOTE_TEXT + '![](hello/holiday-photo-1.png)\n');
  // What was done to it is said: before and after.
  await expect(notice(page)).toContainText('Added holiday-photo-1.png');
  await expect(notice(page)).toContainText('→');
  await expect(notice(page)).toContainText('2000 × 1000');
  await expect(notice(page)).toContainText('Location and camera data were removed');

  // Shown from this device before anything is committed — in the editor and in the preview.
  await page.locator(EDITOR).click();
  await page.keyboard.press('ArrowUp'); // the caret leaves the image's line: it renders
  await expect(loadedImages(page)).toHaveCount(1);
  const src = (await loadedImages(page).getAttribute('src'))!;
  expect(src).toMatch(/^blob:/);
  const shown = Buffer.from(await shownBytes(page, src), 'base64');
  expect(shown.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  expect(pngSize(shown)).toEqual({ width: 2000, height: 1000 });
  expect(shown.includes(Buffer.from('52.5200'))).toBe(false); // the metadata chunk did not survive
  expect(original.includes(Buffer.from('52.5200'))).toBe(true);
  expect(mock.writes()).toEqual([]);

  await kept(page);
  await page.locator('[data-mode="preview"]').click();
  const previewImage = page.frameLocator('[data-write-pane="preview"] iframe').locator('#write-preview-body img');
  await expect.poll(() => previewImage.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2000);
  await page.locator('[data-mode="write"]').click();

  // A reload: the draft and its picture are still here.
  await page.reload();
  await expect(page.locator(EDITOR)).toBeVisible();
  await expect(loadedImages(page)).toHaveCount(1);

  // Review lists it with its sizes; the commit message counts it.
  await openSheet(page, 'review');
  const listed = review(page).locator('[data-review-image="holiday-photo-1.png"]');
  await expect(listed.locator('[data-image-size]')).toContainText('→');
  await expect(listed.locator('[data-image-size]')).toContainText('2000 × 1000');
  await expect(review(page).locator('[data-commit-message]')).toHaveValue('Update Note “2026/hello” +1');
  const head = mock.gh.head();
  mock.gh.reset();
  await review(page).locator('[data-action="publish"]').click();
  await expect(review(page).locator('[data-published]')).toBeVisible();

  // One commit: the image (base64 of exactly the bytes that were shown) and the post that refers to it.
  const expectedText = NOTE_TEXT + '![](hello/holiday-photo-1.png)\n';
  const inputs = mock.inputs();
  expect(inputs).toHaveLength(1);
  expect(inputs[0].expectedHeadOid).toBe(head);
  expect(inputs[0].message).toEqual({ headline: 'Update Note “2026/hello” +1' });
  expect(inputs[0].fileChanges.deletions).toEqual([]);
  const additions: { path: string; contents: string }[] = inputs[0].fileChanges.additions;
  expect(additions.map((a) => a.path).sort()).toEqual([NOTE, `${FOLDER}/holiday-photo-1.png`]);
  const image = additions.find((a) => a.path.endsWith('.png'))!;
  expect(image.contents).toBe(shown.toString('base64'));
  expect(decode(additions.find((a) => a.path === NOTE)!.contents)).toBe(expectedText);
  expect(Buffer.from(mock.gh.file(`${FOLDER}/holiday-photo-1.png`)!)).toEqual(shown);

  // Afterwards nothing is pending and the picture still shows (raw.githubusercontent lags; the app does not).
  await closeSheet(page);
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');
  await expect(loadedImages(page)).toHaveCount(1);
  await openSheet(page, 'review');
  await expect(review(page).locator('[data-review-images]')).toHaveCount(0);
});

test('the Image button picks files; a reference removed before publishing takes its file out of the commit', async ({ page, context }) => {
  const mock = await mockGithub(context);
  await signedIn(context);
  await openPost(page, NOTE);
  await typeAtEnd(page, '');

  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-command="image"]:visible').click()]);
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles([
    { name: 'pic.png', mimeType: 'image/png', buffer: png(300, 200, 1) },
    { name: 'pic.png', mimeType: 'image/png', buffer: png(320, 240, 2) },
  ]);
  // Two pictures, two names (the second is numbered), each a paragraph of its own: the caret was on the
  // empty last line right under the text, so a line break sets the first apart from the paragraph above
  // (review finding: it used to be glued to it, and the site read it as part of that paragraph).
  await expect.poll(() => draftText(page)).toBe(NOTE_TEXT + '\n![](hello/pic.png)\n\n![](hello/pic-1.png)\n');
  // One sentence for the batch, naming both; the data-removal line is said once.
  await expect(notice(page)).toContainText('Added 2 pictures: pic.png, pic-1.png');
  await expect(notice(page)).toContainText('Location and camera data were removed.');
  await kept(page);

  await openSheet(page, 'review');
  await expect(review(page).locator('[data-review-image]')).toHaveCount(2);
  await closeSheet(page);

  // Take the second reference out again (it is the last thing in the text).
  await typeAtEnd(page, '');
  await page.keyboard.press(process.platform === 'darwin' ? 'Shift+Meta+ArrowLeft' : 'Shift+Home');
  await page.keyboard.press('Backspace');
  await expect.poll(() => draftText(page)).toBe(NOTE_TEXT + '\n![](hello/pic.png)\n\n');
  await kept(page);

  await openSheet(page, 'review');
  await expect(review(page).locator('[data-review-image]')).toHaveCount(1);
  await expect(review(page).locator('[data-commit-message]')).toHaveValue('Update Note “2026/hello” +1');
  await review(page).locator('[data-action="publish"]').click();
  await expect(review(page).locator('[data-published]')).toBeVisible();
  const paths = mock.inputs()[0].fileChanges.additions.map((a: { path: string }) => a.path).sort();
  expect(paths).toEqual([NOTE, `${FOLDER}/pic.png`]);
  expect(mock.gh.paths()).not.toContain(`${FOLDER}/pic-1.png`);

  // Nothing is left waiting on this device.
  await page.reload();
  await expect(page.locator(EDITOR)).toBeVisible();
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');
  await openSheet(page, 'review');
  await expect(review(page).locator('[data-review-images]')).toHaveCount(0);
});

test('a new post: its pictures follow it when the title (and so the address) changes, and are committed under the final name', async ({ page, context }) => {
  const mock = await mockGithub(context);
  await signedIn(context);
  await openList(page);
  await page.locator('[data-open="new"]').click();
  await page.locator('[data-new="notes"]').click();
  await expect(page.locator(EDITOR)).toBeVisible();
  await page.locator('[data-title-input]').fill('First name');
  await page.locator(EDITOR).click();
  await page.keyboard.type('Look: ');
  await give(page, 'drop', [{ name: 'shot.png', type: 'image/png', bytes: png(120, 80) }]);
  await expect.poll(() => draftText(page)).toContain('Look: ![](first-name/shot.png)');

  // The title changes: the slug follows, the address follows, the reference follows.
  await page.locator('[data-title-input]').fill('Second name');
  await expect.poll(() => draftText(page)).toContain('Look: ![](second-name/shot.png)');
  expect(await draftText(page)).not.toContain('first-name/');
  await page.locator(EDITOR).click();
  await page.keyboard.press('ArrowUp');
  await kept(page);

  const year = new Date().getUTCFullYear();
  const path = `src/content/notes/${year}/second-name.md`;
  await openSheet(page, 'review');
  await expect(review(page).locator('[data-commit-message]')).toHaveValue(`Create Note “${year}/second-name” +1`);
  await review(page).locator('[data-action="publish"]').click();
  await expect(page.locator('[data-banner="published"]')).toContainText(`Published as ${path}`);

  const additions: { path: string; contents: string }[] = mock.inputs()[0].fileChanges.additions;
  expect(additions.map((a) => a.path).sort()).toEqual([path, `src/content/notes/${year}/second-name/shot.png`]);
  expect(Buffer.from(additions.find((a) => a.path.endsWith('.png'))!.contents, 'base64').subarray(0, 8)).toEqual(PNG_SIGNATURE);
  expect(decode(additions.find((a) => a.path === path)!.contents)).toContain('Look: ![](second-name/shot.png)');
  // At its real address the picture still shows.
  await expect(loadedImages(page)).toHaveCount(1);
});

test('the Image button with the caret in a sentence: the picture gets a paragraph of its own, and a slow one says it is being added', async ({ page, context }) => {
  await mockGithub(context);
  // A camera photo takes seconds to decode and downscale on a phone.
  await page.addInitScript(() => {
    const real = window.createImageBitmap.bind(window);
    window.createImageBitmap = ((...args: Parameters<typeof real>) => new Promise((resolve) => setTimeout(resolve, 1500)).then(() => real(...args))) as typeof window.createImageBitmap;
  });
  await openPost(page, NOTE);

  // The editor was never tapped: the caret is in front of "First line."
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-command="image"]:visible').click()]);
  await chooser.setFiles([{ name: 'top.png', mimeType: 'image/png', buffer: png(300, 200, 4) }]);
  await expect(page.locator('[data-banner="taking-images"]')).toContainText('Adding the picture');
  await expect(notice(page)).toContainText('Added top.png');
  await expect(page.locator('[data-banner="taking-images"]')).toHaveCount(0);
  await expect.poll(() => draftText(page)).toBe(NOTE_TEXT.replace('First line.', '![](hello/top.png)\n\nFirst line.'));

  // At the end of a sentence: a blank line goes in before the picture.
  // (Once the first picture is drawn: it pushes the text down, and the tap has to land on the text.)
  await expect(loadedImages(page)).toHaveCount(1);
  // The caret goes there by keyboard (the end of the text, then one step back over the last line break).
  await typeAtEnd(page, '');
  await page.keyboard.press('ArrowLeft');
  const [again] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-command="image"]:visible').click()]);
  await again.setFiles([{ name: 'end.png', mimeType: 'image/png', buffer: png(300, 200, 5) }]);
  await expect
    .poll(() => draftText(page))
    .toBe(NOTE_TEXT.replace('First line.', '![](hello/top.png)\n\nFirst line.').replace('Second line.', 'Second line.\n\n![](hello/end.png)'));
});

test('a file that is not a picture is refused with a reason, and nothing changes', async ({ page, context }) => {
  await mockGithub(context);
  await openPost(page, NOTE);
  await give(page, 'paste', [{ name: 'notes.png', type: 'image/png', bytes: Buffer.from('just some text, not a picture') }]);
  await expect(notice(page)).toBeVisible();
  await expect(page.locator(EDITOR)).toHaveText('First line.Second line.');
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');
  // A refusal does not vanish by itself (other notices go after 7 seconds): it stays until dismissed.
  await page.waitForTimeout(7_500);
  await expect(notice(page)).toBeVisible();
  await notice(page).getByRole('button', { name: 'OK' }).click();
  await expect(notice(page)).toHaveCount(0);
});

for (const theme of ['galley', 'console', 'riso'] as const) {
  test(`${theme}: account, review and the image notice fit a 360px phone`, async ({ page, context }) => {
    await mockGithub(context);
    await signedIn(context);
    await page.setViewportSize({ width: 360, height: 740 });
    await context.addInitScript((id) => localStorage.setItem('write:theme', id), theme);
    await openPost(page, NOTE);
    await expect(page.locator('html')).toHaveAttribute('data-write-theme', theme);
    await give(page, 'paste', [{ name: 'wide.png', type: 'image/png', bytes: png(900, 300) }]);
    await expect(notice(page)).toContainText('Added wide.png');
    await kept(page);

    const fits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.body.scrollWidth <= window.innerWidth);
    /** Controls in the open sheet that are smaller than a 44px touch target, or stick out of the sheet. */
    const problems = () =>
      page.evaluate(() => {
        const sheet = document.querySelector<HTMLElement>('[data-sheet]')!;
        const box = sheet.getBoundingClientRect();
        const out: string[] = [];
        for (const el of sheet.querySelectorAll<HTMLElement>('button, a.w-btn, input:not([type="checkbox"]):not([hidden]), summary')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          const label = `${el.tagName.toLowerCase()} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}"`;
          if (r.height < 43.5) out.push(`${label} is ${Math.round(r.height)}px tall`);
          if (r.left < box.left - 0.5 || r.right > box.right + 0.5) out.push(`${label} sticks out`);
        }
        return out;
      });

    expect(await fits()).toBe(true);
    await openSheet(page, 'review');
    await expect(review(page).locator('[data-review-image="wide.png"]')).toBeVisible();
    expect(await problems()).toEqual([]);
    expect(await fits()).toBe(true);
    await closeSheet(page);

    await openSheet(page, 'account');
    await expect(page.locator('[data-sheet="account"] [data-account="signed-in"]')).toBeVisible();
    expect(await problems()).toEqual([]);
    expect(await fits()).toBe(true);
    await page.locator('[data-sheet="account"] [data-action="sign-out"]').click();
    await page.locator('[data-sheet="account"] #account-token').fill('github_pat_wrong');
    await page.locator('[data-sheet="account"] [data-action="sign-in-token"]').click();
    await expect(page.locator('[data-sheet="account"] [data-account-problem]')).toBeVisible();
    expect(await problems()).toEqual([]);
    expect(await fits()).toBe(true);
  });
}

/**
 * The final verifier's finding: after a slow intake, a tap on "Second line." put the caret on the
 * last line. The picture grew from its placeholder to its real size without CodeMirror measuring
 * again (in a post shorter than the screen the content box keeps its height, which is all a plain
 * `requestMeasure` looks at), so the line under the pointer was looked up in a stale height map.
 * The deterministic version of this is in the editor harness (images.spec.ts, "a picture that
 * loads late"); here it is the whole flow, as reported.
 */
test('after a slow picture intake a tap lands on the line that was tapped', async ({ page, context, hasTouch }) => {
  await mockGithub(context);
  // A camera photo takes seconds to decode and downscale on a phone.
  await page.addInitScript(() => {
    const real = window.createImageBitmap.bind(window);
    window.createImageBitmap = ((...args: Parameters<typeof real>) => new Promise((resolve) => setTimeout(resolve, 1500)).then(() => real(...args))) as typeof window.createImageBitmap;
  });
  await openPost(page, NOTE);

  // The editor was never tapped: the picture goes in above "First line."
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('[data-command="image"]:visible').click()]);
  await chooser.setFiles([{ name: 'top.png', mimeType: 'image/png', buffer: png(300, 200, 4) }]);
  await expect(notice(page)).toContainText('Added top.png');
  await expect(page.locator('[data-banner="taking-images"]')).toHaveCount(0);
  await expect(loadedImages(page)).toHaveCount(1);
  // Its panel opened, and does not lie over the text below the picture.
  await expect(page.locator('[data-image-panel]')).toBeVisible();

  // Tap "Second line." and type: the letter lands in that line, not in the one below or above.
  const second = page.locator(`${EDITOR} .cm-line`, { hasText: 'Second line.' });
  await second.scrollIntoViewIfNeeded();
  const box = (await second.boundingBox())!;
  const point = { x: box.x + 30, y: box.y + box.height / 2 };
  if (hasTouch) await page.touchscreen.tap(point.x, point.y);
  else await page.mouse.click(point.x, point.y);
  await expect(page.locator(EDITOR)).toBeFocused();
  // Going on in the text put the panel away.
  await expect(page.locator('[data-image-panel]')).toBeHidden();
  await page.keyboard.type('X', { delay: 30 });
  await expect.poll(() => draftText(page)).toContain('X');
  const line = (await draftText(page))!.split('\n').find((l) => l.includes('X'))!;
  expect(line.replace('X', '')).toBe('Second line.');
});

test('the image panel: a pasted picture opens it; size and alt text go into the text and the commit; Remove takes the picture out of both', async ({ page, context, hasTouch }) => {
  const mock = await mockGithub(context);
  await signedIn(context);
  await openPost(page, NOTE);
  const panel = page.locator('[data-image-panel]');
  const press = (selector: string) => (hasTouch ? page.locator(selector).tap() : page.locator(selector).click());
  const size = (name: string) => press(`[data-image-sizes] label:has([data-image-size="${name}"])`);

  await give(page, 'paste', [{ name: 'chart.png', type: 'image/png', bytes: png(640, 320) }]);
  await expect.poll(() => draftText(page)).toBe(NOTE_TEXT + '![](hello/chart.png)\n');
  // The panel is there for the new picture, without anyone tapping it.
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-image-panel', 'hello/chart.png');
  await expect(page.locator('[data-image-size="default"]')).toBeChecked();

  await size('small');
  await expect.poll(() => draftText(page)).toBe(NOTE_TEXT + '![|small](hello/chart.png)\n');
  await press('[data-image-alt]');
  await page.keyboard.type('Sales [2026] | by month', { delay: 15 });
  const written = NOTE_TEXT + '![Sales \\[2026\\] | by month|small](hello/chart.png)\n';
  await expect.poll(() => draftText(page)).toBe(written);
  await press('[data-image-action="done"]');
  await expect(panel).toBeHidden();
  // The picture is still the pending one, shown small.
  await expect(page.locator('[data-write-editor] .cm-w-image[data-size="small"][data-state="loaded"]')).toHaveCount(1);
  await kept(page);

  // The preview reads it the way the site does: the size as a class, the alt text without it.
  await page.locator('[data-mode="preview"]').click();
  const previewImage = page.frameLocator('[data-write-pane="preview"] iframe').locator('#write-preview-body img');
  await expect(previewImage).toHaveAttribute('alt', 'Sales [2026] | by month');
  await expect(previewImage).toHaveClass(/img-small/);
  await page.locator('[data-mode="write"]').click();

  // Published: one commit, the text exactly as written, the picture with it.
  await openSheet(page, 'review');
  await review(page).locator('[data-action="publish"]').click();
  await expect(review(page).locator('[data-published]')).toBeVisible();
  expect(mock.gh.text(NOTE)).toBe(written);
  expect(mock.gh.paths()).toContain(`${FOLDER}/chart.png`);
  await closeSheet(page);

  // Tap the picture: the panel again, with what the text says. Remove takes the image out.
  await press('[data-write-editor] .cm-w-image');
  await expect(panel).toBeVisible();
  await expect(page.locator('[data-image-alt]')).toHaveValue('Sales [2026] | by month');
  await expect(page.locator('[data-image-size="small"]')).toBeChecked();
  await press('[data-image-action="remove"]');
  await expect(panel).toBeHidden();
  await expect.poll(() => draftText(page)).toBe(NOTE_TEXT);
  await expect(page.locator('[data-write-editor] .cm-w-image')).toHaveCount(0);
});

for (const theme of ['galley', 'console', 'riso'] as const) {
  test(`${theme}: the image panel fits a 360px phone inside the app, above the toolbar`, async ({ page, context, hasTouch }) => {
    await mockGithub(context);
    await page.setViewportSize({ width: 360, height: 740 });
    await context.addInitScript((id) => localStorage.setItem('write:theme', id), theme);
    await openPost(page, NOTE);
    await give(page, 'paste', [{ name: 'wide.png', type: 'image/png', bytes: png(900, 300) }]);
    const panel = page.locator('[data-image-panel]');
    await expect(panel).toBeVisible();
    await expect(panel).toHaveAttribute('data-image-mode', 'docked');
    const problems = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-image-panel]')!;
      const box = el.getBoundingClientRect();
      const out: string[] = [];
      if (document.documentElement.scrollWidth > window.innerWidth) out.push('the page scrolls sideways');
      if (box.left < 0 || box.right > window.innerWidth + 0.5) out.push('the panel is wider than the screen');
      if (el.scrollHeight > el.clientHeight + 1) out.push('the panel is cut off');
      // The sheet ends at the toolbar (its bottom padding may tuck a few pixels under the toolbar's edge,
      // as the note panel's does); none of its controls may be covered.
      const bars = [...document.querySelectorAll<HTMLElement>('[role="toolbar"]')].map((bar) => bar.getBoundingClientRect()).filter((r) => r.height > 0);
      if (bars.length === 0) out.push('no toolbar found');
      for (const control of el.querySelectorAll<HTMLElement>('button, [data-image-sizes] label, input[type="text"]')) {
        const r = control.getBoundingClientRect();
        if (bars.some((bar) => r.bottom > bar.top + 0.5 && r.top < bar.bottom - 0.5)) out.push(`${control.getAttribute('aria-label') ?? control.textContent?.trim()} is under the toolbar`);
      }
      for (const control of el.querySelectorAll<HTMLElement>('button, [data-image-sizes] label, input[type="text"]')) {
        const r = control.getBoundingClientRect();
        if (r.height < 43.5) out.push(`${control.getAttribute('aria-label') ?? control.textContent?.trim()} is ${Math.round(r.height)}px tall`);
      }
      for (const label of el.querySelectorAll<HTMLElement>('[data-image-sizes] label span, .caption')) {
        if (label.scrollWidth > label.clientWidth + 1) out.push(`"${label.textContent}" is cut off`);
      }
      return out;
    });
    expect(problems).toEqual([]);
    // And it works by touch: a size goes into the text.
    const medium = page.locator('[data-image-sizes] label:has([data-image-size="medium"])');
    if (hasTouch) await medium.tap();
    else await medium.click();
    await expect.poll(() => draftText(page)).toBe(NOTE_TEXT + '![|medium](hello/wide.png)\n');
  });
}
