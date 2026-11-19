/**
 * The image panel in real browsers, against the standalone harness: tapping a picture opens it,
 * a size or alt text changes only that image's bracket text, Remove takes the image out.
 *
 *   bunx playwright test -c tests/write/editor-harness/playwright.config.ts images
 *
 * Runs on desktop Chromium, the Pixel 7 profile and (when installed) the iPhone profile on WebKit.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

const content = (page: Page) => page.locator('[data-write-editor] .cm-content');
const panel = (page: Page) => page.locator('[data-image-panel]');
const altField = (page: Page) => page.locator('[data-image-alt]');
const sizeRadio = (page: Page, size: 'default' | 'small' | 'medium' | 'full') => page.locator(`[data-image-size="${size}"]`);
const pictures = (page: Page) => page.locator('[data-write-editor] .cm-w-image');
const action = (page: Page, name: 'remove' | 'done') => page.locator(`[data-image-action="${name}"]`);

/** A picture of a given size that needs no file: the harness resolver hands `data:` addresses through. */
const svg = (width: number, height: number, colour = 'teal') =>
  `data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%20width=%22${width}%22%20height=%22${height}%22%3E%3Crect%20width=%22${width}%22%20height=%22${height}%22%20fill=%22${colour}%22/%3E%3C/svg%3E`;

async function open(page: Page, doc: string, query = '') {
  await page.goto(`/${query}`);
  await expect(content(page)).toBeVisible();
  await page.waitForFunction(() => !!window.__write?.handle);
  await page.evaluate((text) => window.__write.load(text), doc);
  await page.waitForFunction((text) => window.__write.handle.getDoc() === text, doc);
}
const getDoc = (page: Page) => page.evaluate(() => window.__write.handle.getDoc());
const expectDoc = (page: Page, text: string) => expect.poll(() => getDoc(page), { timeout: 4000 }).toBe(text);
const undo = (page: Page) => page.evaluate(() => window.__write.handle.exec('undo'));

/** Tap on touch profiles, click otherwise. */
async function press(target: Locator, hasTouch: boolean | undefined) {
  if (hasTouch) await target.tap();
  else await target.click();
}
/** Pick a size the way a finger or a mouse does: on its label. */
const pick = (page: Page, size: 'default' | 'small' | 'medium' | 'full', hasTouch: boolean | undefined) =>
  press(page.locator(`[data-image-sizes] label:has([data-image-size="${size}"])`), hasTouch);

const DOC = 'Before\n\n![A logo|small](/favicon.svg)\n\nAfter\n';

test.describe('image panel', () => {
  test('tapping a picture opens the panel with its size and alt text; a size changes only the suffix, one undo step each', async ({ page, hasTouch }) => {
    await open(page, DOC);
    await expect(panel(page)).toBeHidden();
    await press(pictures(page).first(), hasTouch);
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toHaveAttribute('data-image-panel', '/favicon.svg');
    await expect(page.locator('[data-image-name]')).toHaveText('favicon.svg');
    await expect(altField(page)).toHaveValue('A logo');
    await expect(sizeRadio(page, 'small')).toBeChecked();
    // A phone gets a sheet along the bottom, a wide screen a card beside the picture.
    const width = page.viewportSize()!.width;
    await expect(panel(page)).toHaveAttribute('data-image-mode', width >= 720 ? 'floating' : 'docked');
    // The picture the panel is about is marked.
    await expect(pictures(page).first()).toHaveAttribute('data-panel-open', '');
    // Opening changed nothing.
    expect(await getDoc(page)).toBe(DOC);
    expect(await page.evaluate(() => window.__write.changes.length)).toBe(0);

    await pick(page, 'medium', hasTouch);
    await expectDoc(page, DOC.replace('|small', '|medium'));
    await expect(sizeRadio(page, 'medium')).toBeChecked();
    await expect(page.locator('.cm-w-image[data-size="medium"]')).toHaveCount(1);
    await pick(page, 'default', hasTouch);
    await expectDoc(page, DOC.replace('|small', ''));
    await expect(sizeRadio(page, 'default')).toBeChecked();
    await pick(page, 'full', hasTouch);
    await expectDoc(page, DOC.replace('|small', '|full'));
    await expect(panel(page)).toBeVisible();

    // Undo: one step per change, and the panel follows.
    await undo(page);
    await expectDoc(page, DOC.replace('|small', ''));
    await expect(sizeRadio(page, 'default')).toBeChecked();
    await undo(page);
    await expectDoc(page, DOC.replace('|small', '|medium'));
    await undo(page);
    await expectDoc(page, DOC);
    await expect(sizeRadio(page, 'small')).toBeChecked();
    expect(await page.evaluate(() => window.__write.selection.canUndo)).toBe(false);
  });

  test('alt text: brackets and pipes typed in the field are written safely and read back as typed', async ({ page, hasTouch }) => {
    await open(page, DOC);
    await press(pictures(page).first(), hasTouch);
    await press(altField(page), hasTouch);
    await altField(page).fill('');
    await expectDoc(page, DOC.replace('A logo', ''));
    await page.keyboard.type('A [logo] | or ] two', { delay: 15 });
    await expectDoc(page, 'Before\n\n![A \\[logo\\] | or \\] two|small](/favicon.svg)\n\nAfter\n');
    await expect(altField(page)).toHaveValue('A [logo] | or ] two');
    await expect(sizeRadio(page, 'small')).toBeChecked();
    // The picture is still one picture, with that alt text.
    await expect(pictures(page)).toHaveCount(1);
    await expect(page.locator('.cm-w-image img')).toHaveAttribute('alt', 'A \\[logo\\] | or \\] two');

    // Put away and opened again, it reads the same.
    await press(action(page, 'done'), hasTouch);
    await expect(panel(page)).toBeHidden();
    await press(pictures(page).first(), hasTouch);
    await expect(altField(page)).toHaveValue('A [logo] | or ] two');
  });

  test('typing in the alt field is undone as one step, from the field itself', async ({ page, hasTouch, browserName }) => {
    await open(page, 'Before\n\n![](/favicon.svg)\n\nAfter\n');
    await press(pictures(page).first(), hasTouch);
    await press(altField(page), hasTouch);
    await page.keyboard.type('A cat', { delay: 15 });
    await expectDoc(page, 'Before\n\n![A cat](/favicon.svg)\n\nAfter\n');
    await page.keyboard.press(browserName === 'webkit' ? 'Meta+z' : 'ControlOrMeta+z');
    await expectDoc(page, 'Before\n\n![](/favicon.svg)\n\nAfter\n');
    await expect(altField(page)).toHaveValue('');
    await expect(panel(page)).toBeVisible();
    await expect(altField(page)).toBeFocused();
  });

  test('an unknown suffix is alt text: the panel shows Default and a real size can be picked', async ({ page, hasTouch }) => {
    const doc = 'Before\n\n![A cat|large](/favicon.svg)\n\nAfter\n';
    await open(page, doc);
    await press(pictures(page).first(), hasTouch);
    await expect(sizeRadio(page, 'default')).toBeChecked();
    await expect(altField(page)).toHaveValue('A cat|large');
    await pick(page, 'small', hasTouch);
    await expectDoc(page, doc.replace('|large', '|large|small'));
    await expect(sizeRadio(page, 'small')).toBeChecked();
    await expect(altField(page)).toHaveValue('A cat|large');
    await pick(page, 'default', hasTouch);
    await expectDoc(page, doc);
  });

  test('Remove image takes the image and its line out, in one undo step', async ({ page, hasTouch }) => {
    await open(page, DOC);
    await press(pictures(page).first(), hasTouch);
    await press(action(page, 'remove'), hasTouch);
    await expectDoc(page, 'Before\n\nAfter\n');
    await expect(panel(page)).toBeHidden();
    await expect(pictures(page)).toHaveCount(0);
    await undo(page);
    await expectDoc(page, DOC);
  });

  test('images inside a link, a list and a blockquote: each picture opens its own panel', async ({ page, hasTouch }) => {
    const doc =
      `Text\n\n[![linked](${svg(200, 60, 'teal')})](https://example.com)\n\n` +
      `- item ![listed](${svg(200, 60, 'navy')}) end\n\n` +
      `> quoted ![quoted|full](${svg(200, 60, 'maroon')})\n\nAfter\n`;
    await open(page, doc);
    await expect(pictures(page)).toHaveCount(3);
    const expected = [
      { alt: 'linked', size: 'default', change: 'small', from: '![linked]', to: '![linked|small]' },
      { alt: 'listed', size: 'default', change: 'medium', from: '![listed]', to: '![listed|medium]' },
      { alt: 'quoted', size: 'full', change: 'default', from: '![quoted|full]', to: '![quoted]' },
    ] as const;
    let text = doc;
    for (const [index, image] of expected.entries()) {
      await press(pictures(page).nth(index), hasTouch);
      await expect(altField(page)).toHaveValue(image.alt);
      await expect(sizeRadio(page, image.size)).toBeChecked();
      await pick(page, image.change, hasTouch);
      text = text.replace(image.from, image.to);
      await expectDoc(page, text);
      await press(action(page, 'done'), hasTouch);
      await expect(panel(page)).toBeHidden();
    }
    // Removing the linked image takes its (now empty) link along.
    await press(pictures(page).first(), hasTouch);
    await press(action(page, 'remove'), hasTouch);
    await expectDoc(page, text.replace(/\[!\[linked\|small\]\([^)]*\)\]\(https:\/\/example\.com\)\n\n/, ''));
  });

  test('two images on one line: the second picture opens the second image', async ({ page, hasTouch }) => {
    const doc = `![one](${svg(120, 40, 'teal')}) and ![two](${svg(120, 40, 'navy')})\n`;
    await open(page, doc);
    await expect(pictures(page)).toHaveCount(2);
    await press(pictures(page).nth(1), hasTouch);
    await expect(altField(page)).toHaveValue('two');
    await pick(page, 'small', hasTouch);
    await expectDoc(page, doc.replace('![two]', '![two|small]'));
    await expect(pictures(page).nth(1)).toHaveAttribute('data-panel-open', '');
    await expect(pictures(page).nth(0)).not.toHaveAttribute('data-panel-open', '');
  });

  test('by keyboard: ⌘/Ctrl+Enter in an image opens the panel, arrows pick the size, Escape goes back to the text', async ({ page, hasTouch }) => {
    test.skip(!!hasTouch, 'hardware keyboard');
    await open(page, DOC);
    await page.evaluate(() => {
      window.__write.handle.focus();
      window.__write.handle.setSelection({ anchor: 12 }); // inside the alt text of the image
    });
    await page.waitForFunction(() => document.activeElement?.classList.contains('cm-content'));
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(panel(page)).toBeVisible();
    await expect(altField(page)).toBeFocused();
    // Back from the alt field to the size (one radio group, so one stop), and on to Medium with an arrow.
    await page.keyboard.press('Shift+Tab');
    await expect(sizeRadio(page, 'small')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expectDoc(page, DOC.replace('|small', '|medium'));
    await expect(sizeRadio(page, 'medium')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expectDoc(page, DOC.replace('|small', ''));
    // Remove and Done are buttons with names.
    await expect(page.getByRole('button', { name: 'Remove image' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Done' })).toBeVisible();
    await expect(page.getByRole('radiogroup', { name: 'Size' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Alt text' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    await expect(content(page)).toBeFocused();
    // The caret is where it was.
    expect((await page.evaluate(() => window.__write.handle.getSelection())).head).toBe(12);
  });

  test('a picture put in through the command opens its panel; typing on in the text puts it away', async ({ page }) => {
    await open(page, 'First.\n\n');
    await page.evaluate(() => {
      window.__write.handle.focus();
      window.__write.handle.setSelection({ anchor: 8 });
    });
    await page.waitForFunction(() => document.activeElement?.classList.contains('cm-content'));
    await page.evaluate(() => window.__write.handle.exec('image', { src: '/favicon.svg' }));
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toHaveAttribute('data-image-panel', '/favicon.svg');
    await expect(sizeRadio(page, 'default')).toBeChecked();
    // The text keeps the keyboard.
    await expect(content(page)).toBeFocused();
    await page.keyboard.type(' and on', { delay: 15 });
    await expectDoc(page, 'First.\n\n![](/favicon.svg) and on');
    await expect(panel(page)).toBeHidden();
    // The bare command (an address still to be typed) opens nothing.
    await page.evaluate(() => window.__write.handle.exec('image'));
    await expect(panel(page)).toBeHidden();
  });

  test('read-only: the panel shows, nothing can be changed', async ({ page, hasTouch }) => {
    await open(page, DOC, '?readonly');
    await press(pictures(page).first(), hasTouch);
    await expect(panel(page)).toBeVisible();
    await expect(sizeRadio(page, 'medium')).toBeDisabled();
    await expect(altField(page)).toHaveAttribute('readonly', '');
    await expect(action(page, 'remove')).toHaveCount(0);
    expect(await getDoc(page)).toBe(DOC);
  });

  for (const look of ['galley', 'galley-dark', 'console', 'riso', 'riso-dark'] as const) {
    test(`${look}: the panel fits a 360px phone, with touch-sized controls`, async ({ page, hasTouch }) => {
      await page.setViewportSize({ width: 360, height: 740 });
      await open(page, `Before\n\n![A wide picture|medium](${svg(900, 500)})\n\nAfter\n`, `?look=${look}`);
      await press(pictures(page).first(), hasTouch);
      await expect(panel(page)).toBeVisible();
      await expect(panel(page)).toHaveAttribute('data-image-mode', 'docked');
      const report = await page.evaluate(() => {
        const el = document.querySelector<HTMLElement>('[data-image-panel]')!;
        const box = el.getBoundingClientRect();
        const problems: string[] = [];
        if (box.left < 0 || box.right > window.innerWidth + 0.5) problems.push('panel wider than the screen');
        if (box.bottom > window.innerHeight + 0.5) problems.push('panel below the screen');
        if (el.scrollHeight > el.clientHeight + 1) problems.push('panel content is cut off');
        if (document.documentElement.scrollWidth > window.innerWidth) problems.push('page scrolls sideways');
        for (const control of el.querySelectorAll<HTMLElement>('button, [data-image-sizes] label, input[type="text"]')) {
          const r = control.getBoundingClientRect();
          const name = control.getAttribute('aria-label') ?? control.textContent?.trim() ?? control.tagName;
          if (r.height < 43.5) problems.push(`${name} is ${Math.round(r.height)}px tall`);
          if (r.left < box.left - 0.5 || r.right > box.right + 0.5) problems.push(`${name} sticks out`);
        }
        for (const label of el.querySelectorAll<HTMLElement>('[data-image-sizes] label span, .caption, [data-image-name]')) {
          if (label.scrollWidth > label.clientWidth + 1) problems.push(`"${label.textContent}" is cut off`);
        }
        const alt = el.querySelector<HTMLInputElement>('[data-image-alt]')!;
        if (parseFloat(getComputedStyle(alt).fontSize) < 16) problems.push('alt field below 16px (iOS zooms)');
        // The picture stays in view above the sheet.
        const picture = document.querySelector<HTMLElement>('.cm-w-image img')!.getBoundingClientRect();
        if (picture.top > box.top - 40) problems.push('the picture is hidden under the panel');
        return problems;
      });
      expect(report).toEqual([]);
    });
  }
});

/** Findings of the review of the image panel. */
test.describe('image panel: review findings', () => {
  const keyboardOpen = async (page: Page, at: number) => {
    await page.evaluate((anchor) => {
      window.__write.handle.focus();
      window.__write.handle.setSelection({ anchor });
    }, at);
    await page.waitForFunction(() => document.activeElement?.classList.contains('cm-content'));
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(panel(page)).toBeVisible();
  };

  for (const image of ['![old][]', '![old]'] as const) {
    test(`a reference image whose text is its label (${image}): size and alt text are left alone`, async ({ page, hasTouch }) => {
      test.skip(!!hasTouch, 'opened by keyboard: its placeholder is not a button');
      const doc = `Text\n\n${image}\n\n[old]: /favicon.svg\n`;
      await open(page, doc);
      await keyboardOpen(page, 9);
      await expect(page.locator('[data-image-status]')).toContainText('also the name of the image’s reference');
      for (const size of ['default', 'small', 'medium', 'full'] as const) await expect(sizeRadio(page, size)).toBeDisabled();
      await expect(altField(page)).toHaveValue('old');
      await expect(altField(page)).toHaveAttribute('readonly', '');
      await altField(page).focus();
      await page.keyboard.type('X', { delay: 15 });
      await page.locator('[data-image-sizes] label:has([data-image-size="small"])').click({ force: true });
      await page.waitForTimeout(150);
      expect(await getDoc(page)).toBe(doc);
      expect(await page.evaluate(() => window.__write.changes.length)).toBe(0);
      // It can still be taken out.
      await action(page, 'remove').click();
      await expectDoc(page, 'Text\n\n[old]: /favicon.svg\n');
    });
  }

  test('alt text typed key by key is shown as typed: backslashes are not doubled in the field, code keeps its bracket', async ({ page, hasTouch }) => {
    const cases = [
      // The backslash was written `\\\\` while it ended the alt text, and stays that way: the site reads one.
      { typed: 'C:\\dir', written: 'C:\\\\dir' },
      { typed: 'a\\]b', written: 'a\\\\\\]b' },
      { typed: 'a\\', written: 'a\\\\' },
      { typed: '`]`', written: '`]`' },
    ];
    for (const { typed, written } of cases) {
      await open(page, DOC.replace('A logo', ''));
      await press(pictures(page).first(), hasTouch);
      await press(altField(page), hasTouch);
      await page.keyboard.type(typed, { delay: 15 });
      await expectDoc(page, DOC.replace('A logo', written));
      await expect(altField(page)).toHaveValue(typed);
      await expect(page.locator('[data-image-status]')).toHaveText('');
      await expect(sizeRadio(page, 'small')).toBeChecked();
    }
  });

  test('one key in the alt field leaves brackets, links and code elsewhere in the alt text as they are written', async ({ page, hasTouch }) => {
    for (const altText of ['a [b] c', 'a `]` b', 'a [l](u) b']) {
      const doc = `Before\n\n![${altText}](/favicon.svg)\n\nAfter\n`;
      await open(page, doc);
      await press(pictures(page).first(), hasTouch);
      await press(altField(page), hasTouch);
      await page.keyboard.type('Z', { delay: 15 });
      await expectDoc(page, doc.replace('](/favicon.svg)', 'Z](/favicon.svg)'));
      await expect(altField(page)).toHaveValue(`${altText}Z`);
    }
  });

  test('wide screen: a put-away image panel is gone, also while a footnote floats', async ({ page }) => {
    test.skip(page.viewportSize()!.width < 720, 'the panels float on wide screens only');
    const doc = 'Before[^1]\n\n![A logo|small](/favicon.svg)\n\nAfter\n\n[^1]: A note.\n';
    const imagePanel = page.locator('[data-image-mode]');
    const gone = async () => {
      await expect(imagePanel).toBeHidden();
      expect(await imagePanel.evaluate((el: HTMLElement) => [getComputedStyle(el).display, el.style.left, el.style.top, el.className.includes('floating')])).toEqual(['none', '', '', false]);
    };
    await open(page, doc);
    // Never opened, a note floating.
    await page.locator('[data-footnote-ref="1"]').click();
    await expect(page.locator('[data-note-panel]')).toBeVisible();
    await gone();
    await page.keyboard.press('Escape');
    // Opened, put away with Done, then the note.
    await pictures(page).first().click();
    await expect(imagePanel).toHaveAttribute('data-image-mode', 'floating');
    await action(page, 'done').click();
    await gone();
    await page.locator('[data-footnote-ref="1"]').click();
    await expect(page.locator('[data-note-panel]')).toBeVisible();
    await gone();
    await page.keyboard.press('Escape');
    // Opened, then the note straight away: the note's own buttons take the click.
    await pictures(page).first().click();
    await expect(imagePanel).toBeVisible();
    await page.locator('[data-footnote-ref="1"]').click();
    await expect(page.locator('[data-note-panel]')).toBeVisible();
    await gone();
    await page.locator('[data-note-panel] [data-note-action="done"]').click({ timeout: 5000 });
    await expect(page.locator('[data-note-panel]')).toBeHidden();
    expect(await getDoc(page)).toBe(doc);
  });

  test('Tab runs through the panel in the order it reads: sizes, alt text, Remove, Done', async ({ page, hasTouch }) => {
    test.skip(!!hasTouch, 'hardware keyboard');
    await open(page, DOC);
    await pictures(page).first().click();
    await expect(altField(page)).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(action(page, 'remove')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(action(page, 'done')).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    await expect(altField(page)).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(sizeRadio(page, 'small')).toBeFocused();
    // On screen (floating row): sizes, alt text, Remove, Done from left to right.
    const lefts = await page.evaluate(() =>
      ['[data-image-sizes]', '[data-image-alt]', '[data-image-action="remove"]', '[data-image-action="done"]'].map((s) => document.querySelector(s)!.getBoundingClientRect().left),
    );
    expect([...lefts].sort((a, b) => a - b)).toEqual(lefts);
    expect(await getDoc(page)).toBe(DOC);
  });

  test('a phone on its side (740x360): the docked panel shows all its controls without scrolling inside', async ({ page, hasTouch }) => {
    await page.setViewportSize({ width: 740, height: 360 });
    await open(page, `Before\n\n![A wide picture|medium](${svg(900, 500)})\n\nAfter\n`);
    await press(pictures(page).first(), hasTouch);
    await expect(panel(page)).toBeVisible();
    const report = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-image-panel]')!;
      const box = el.getBoundingClientRect();
      const alt = el.querySelector<HTMLElement>('[data-image-alt]')!.getBoundingClientRect();
      return { mode: el.dataset.imageMode, scrolls: el.scrollHeight > el.clientHeight + 1, altInside: alt.bottom <= box.bottom + 0.5, below: box.bottom > window.innerHeight + 0.5 };
    });
    expect(report.scrolls).toBe(false);
    expect(report.altInside).toBe(true);
    expect(report.below).toBe(false);
  });

  test('Full is said on the picture (the column cannot show it wider); the other sizes are not labelled', async ({ page, hasTouch }) => {
    await open(page, `Before\n\n![A wide picture](${svg(900, 500)})\n\nAfter\n\nLast line.\n`);
    const label = () => pictures(page).first().evaluate((el) => getComputedStyle(el, '::before').content);
    const height = async () => (await pictures(page).first().boundingBox())!.height;
    await expect(pictures(page).first()).toHaveAttribute('data-state', 'loaded');
    expect(await label()).toBe('none');
    const plain = await height();
    await press(pictures(page).first(), hasTouch);
    await pick(page, 'full', hasTouch);
    await expect(page.locator('.cm-w-image[data-size="full"]')).toHaveCount(1);
    expect(await label()).toBe('"Full width"');
    expect(await height()).toBeGreaterThan(plain + 10);
    await pick(page, 'medium', hasTouch);
    await expect(page.locator('.cm-w-image[data-size="medium"]')).toHaveCount(1);
    expect(await label()).toBe('none');
    // The taller picture did not throw taps off: a tap on the last line lands in it.
    await pick(page, 'full', hasTouch);
    await press(action(page, 'done'), hasTouch);
    const line = page.locator('.cm-line', { hasText: 'Last line.' });
    await line.scrollIntoViewIfNeeded();
    const box = (await line.boundingBox())!;
    if (hasTouch) await page.touchscreen.tap(box.x + 24, box.y + box.height / 2);
    else await page.mouse.click(box.x + 24, box.y + box.height / 2);
    await expect
      .poll(async () => {
        const { head } = await page.evaluate(() => window.__write.handle.getSelection());
        const doc = await getDoc(page);
        return head >= doc.indexOf('Last line.') && head <= doc.indexOf('Last line.') + 10;
      })
      .toBe(true);
  });
});

/**
 * The final verifier's finding: after a picture was taken in, taps landed one paragraph off.
 * CodeMirror finds the line under a tap through its height map, and only re-reads heights when
 * `.cm-content` changed height — which it does not in a post shorter than the screen (the element
 * is at least as tall as the scroller). A picture that grew from its placeholder to its real size
 * after the last measure left the map 50px short. (widgets.ts: `imageSettled`.)
 */
test.describe('a picture that loads late', () => {
  for (const outcome of ['loads', 'fails'] as const) {
    test(`a tap below a picture that ${outcome} late lands on the line that was tapped`, async ({ page, hasTouch }) => {
      // The picture arrives well after the editor has drawn and measured its placeholder.
      await page.route('**/late-picture.svg', async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 700));
        if (outcome === 'fails') return route.fulfill({ status: 404, body: 'gone' });
        return route.fulfill({
          contentType: 'image/svg+xml',
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="260"><rect width="300" height="260" fill="teal"/></svg>',
        });
      });
      // A post shorter than the screen.
      const doc = 'Top.\n\n![late](/late-picture.svg)\n\nFirst line.\n\nSecond line.\n\nThird line.\n';
      await open(page, doc);
      await expect(pictures(page).first()).toHaveAttribute('data-state', outcome === 'loads' ? 'loaded' : 'missing');
      // Nothing else happens in the editor meanwhile: no key, no tap, no scroll.
      await page.waitForTimeout(250);
      for (const text of ['Second line.', 'First line.', 'Third line.']) {
        const line = page.locator('.cm-line', { hasText: text });
        const box = (await line.boundingBox())!;
        const point = { x: box.x + 24, y: box.y + box.height / 2 };
        if (hasTouch) await page.touchscreen.tap(point.x, point.y);
        else await page.mouse.click(point.x, point.y);
        await expect
          .poll(async () => {
            const { head } = await page.evaluate(() => window.__write.handle.getSelection());
            const from = doc.indexOf(text);
            return head >= from && head <= from + text.length ? text : `caret at ${head}, not in "${text}" (${from}–${from + text.length})`;
          })
          .toBe(text);
      }
      expect(await getDoc(page)).toBe(doc);
    });
  }

  test('changing the size or the alt text keeps the picture that is on screen (no reload, no flicker)', async ({ page, hasTouch }) => {
    const requests: string[] = [];
    page.on('request', (request) => request.url().includes('favicon.svg') && requests.push(request.url()));
    await open(page, DOC);
    await expect(pictures(page).first()).toHaveAttribute('data-state', 'loaded');
    await page.locator('.cm-w-image img').evaluate((img) => ((img as HTMLImageElement & { kept?: boolean }).kept = true));
    await press(pictures(page).first(), hasTouch);
    await pick(page, 'full', hasTouch);
    await expectDoc(page, DOC.replace('|small', '|full'));
    await expect(page.locator('.cm-w-image[data-size="full"]')).toHaveCount(1);
    await press(altField(page), hasTouch);
    await page.keyboard.type('!', { delay: 15 });
    await expectDoc(page, DOC.replace('A logo|small', 'A logo!|full'));
    await expect(page.locator('.cm-w-image img')).toHaveAttribute('alt', 'A logo!');
    // Still the very same element.
    expect(await page.locator('.cm-w-image img').evaluate((img) => (img as HTMLImageElement & { kept?: boolean }).kept)).toBe(true);
    expect(requests.length).toBeLessThanOrEqual(1);
  });
});
