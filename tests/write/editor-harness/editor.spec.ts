/**
 * Behaviour of the editor in real browsers, against the standalone harness
 * (tests/write/editor-harness). Run with:
 *
 *   bunx playwright test -c tests/write/editor-harness/playwright.config.ts
 *
 * Every test runs on desktop Chromium, a Pixel 7 profile (Chromium + touch)
 * and, when installed, an iPhone profile on WebKit. Tests that need Chromium's
 * DevTools protocol (IME composition) skip themselves elsewhere.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import type { EditorHandle, EditorNoteState, EditorSelectionState } from '../../../src/write/contracts';

interface Harness {
  handle: EditorHandle;
  loaded: string;
  selection: EditorSelectionState;
  load(text: string, key?: string): void;
  changes: { doc: string; userEvent: boolean }[];
  opened: string[];
  notes: (EditorNoteState | null)[];
  notices: string[];
  box: HTMLElement;
  files: string[];
  read(path: string): Promise<string>;
  bodyOf(raw: string): string;
}
declare global {
  interface Window {
    __write: Harness;
  }
}

const content = (page: Page) => page.locator('[data-write-editor] .cm-content');
const panel = (page: Page) => page.locator('[data-note-panel]');
const noteText = (page: Page) => page.locator('[data-note-text]');
const chip = (page: Page, label: string) => page.locator(`[data-footnote-ref="${label}"]`);
const command = (page: Page, id: string) => page.locator(`[data-command="${id}"]`);

async function open(page: Page, doc?: string, query = '') {
  await page.goto(`/${query}`);
  await expect(content(page)).toBeVisible();
  await page.waitForFunction(() => !!window.__write?.handle);
  if (doc !== undefined) await load(page, doc);
}

async function load(page: Page, doc: string) {
  await page.evaluate((text) => window.__write.load(text), doc);
  await page.waitForFunction((text) => window.__write.handle.getDoc() === text, doc);
}

const getDoc = (page: Page) => page.evaluate(() => window.__write.handle.getDoc());
/**
 * The document, once input has settled. CodeMirror holds Enter/Backspace back for a moment on
 * iOS and Android (it waits to see what the virtual keyboard does), so reads right after a key
 * press must poll.
 */
const expectDoc = (page: Page, text: string) => expect.poll(() => getDoc(page), { timeout: 4000 }).toBe(text);

/**
 * Type like a person rather than a script. CodeMirror's Android path treats Enter/Backspace
 * specially and drops them when keys arrive within the same frame, which no thumb can do.
 */
async function type(page: Page, text: string) {
  await page.keyboard.type(text, { delay: 25 });
}
async function key(page: Page, name: string) {
  await page.waitForTimeout(60);
  await page.keyboard.press(name);
  await page.waitForTimeout(60);
}
const changeCount = (page: Page) => page.evaluate(() => window.__write.changes.length);
const selectionOf = (page: Page) => page.evaluate(() => window.__write.handle.getSelection());
const stateOf = (page: Page) => page.evaluate(() => ({ ...window.__write.selection }));

/** Tap on touch profiles, click otherwise. */
async function press(target: Locator, hasTouch: boolean | undefined) {
  if (hasTouch) await target.tap();
  else await target.click();
}

/** Put the caret (or a selection) somewhere and focus the editor, as a tap there would. */
async function caret(page: Page, anchor: number, head = anchor) {
  await page.evaluate(
    ([a, h]) => {
      window.__write.handle.focus();
      window.__write.handle.setSelection({ anchor: a, head: h });
    },
    [anchor, head],
  );
  // The focus tracker reports on the next tick; decorations follow it.
  await page.waitForFunction(() => document.activeElement?.classList.contains('cm-content'));
  await page.waitForTimeout(30);
}

/**
 * Text the reader sees (hidden markup is not in the DOM): each drawn line's text, one per line.
 * Not `innerText` of the whole editor: CodeMirror's out-of-flow widget buffers count as line breaks there.
 */
const visibleText = (page: Page) =>
  content(page).evaluate((el) =>
    [...el.children].map((line) => (line.classList.contains('cm-line') ? line.textContent : (line as HTMLElement).innerText)).join('\n'),
  );

async function undoAll(page: Page) {
  await page.evaluate(() => {
    const h = window.__write.handle;
    for (let i = 0; i < 500 && window.__write.selection.canUndo; i++) h.exec('undo');
  });
}

/* Any uncaught exception in the page fails the test it happened in. */
const pageErrors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const errors: string[] = [];
  pageErrors.set(page, errors);
  page.on('pageerror', (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
  expect(pageErrors.get(page) ?? [], 'uncaught errors in the page').toEqual([]);
});

/* -------------------------------------------------------------------------- */

test.describe('rendering', () => {
  test('shows the sample rendered, with the text untouched and no change reported', async ({ page }) => {
    await open(page);
    await expect(page.locator('.cm-line.cm-h1')).toHaveText('The kitchen sink');
    await expect(chip(page, '1')).toBeVisible();
    await expect(chip(page, 'orphan')).toHaveClass(/cm-w-fn-orphan/);
    await expect(page.locator('.cm-w-bullet').first()).toBeVisible();
    await expect(page.locator('.cm-strong').first()).toHaveText('bold');
    await expect(page.locator('.cm-link').first()).toHaveText('link to the blog');

    const text = await visibleText(page);
    expect(text).not.toContain('**bold**');
    expect(text).not.toContain('](https://blog.wahdany.eu/about/)');
    expect(text).not.toContain('[^1]');

    await expectDoc(page, await page.evaluate(() => window.__write.loaded));
    expect(await changeCount(page)).toBe(0);
    await expect(page.locator('[data-harness-identical]')).toHaveAttribute('data-harness-identical', 'true');
  });

  test('renders lists, tasks, quotes, rules, code and tables further down', async ({ page }) => {
    await open(page);
    const scroller = page.locator('.cm-scroller');
    await scroller.evaluate((el) => (el.scrollTop = 600));
    await expect(page.locator('.cm-w-task[aria-checked="true"]')).toHaveCount(1);
    await expect(page.locator('.cm-w-task[aria-checked="false"]')).toHaveCount(2);
    await expect(page.locator('.cm-line.cm-quote').first()).toBeVisible();
    await scroller.evaluate((el) => (el.scrollTop = 1100));
    await expect(page.locator('.cm-w-hr')).toBeVisible();
    await expect(page.locator('.cm-w-fence')).toHaveText('js');
    // Tokens inside the fenced block are coloured once the language chunk has loaded.
    await expect(page.locator('.cm-line.cm-code span[class]').first()).toBeVisible();
    expect(await changeCount(page)).toBe(0);
  });

  test('typesets inline and display math with KaTeX, and flags bad TeX without breaking', async ({ page }) => {
    await open(page, 'Inline $e^{i\\pi}+1=0$ here.\n\n$$\n\\frac{a}{b}\n$$\n\nBad $\\frac{$ math.\n');
    await expect(page.locator('.cm-w-math .katex').first()).toBeVisible();
    await expect(page.locator('.cm-w-mathblock .katex-display')).toBeVisible();
    await expect(page.locator('.cm-w-math[data-state="error"]')).toHaveText('\\frac{');
    expect(await visibleText(page)).not.toContain('$$');
    expect(await changeCount(page)).toBe(0);
  });

  test('shows images below their source line, resolved through the asset resolver', async ({ page }) => {
    await open(page, 'Before\n\n![A logo|small](/favicon.svg)\n\n![Gone](nope/missing.png)\n\nAfter\n');
    const loaded = page.locator('.cm-w-image[data-state="loaded"] img');
    await expect(loaded).toHaveAttribute('alt', 'A logo');
    await expect(page.locator('.cm-w-image[data-size="small"]')).toHaveCount(1);
    await expect(page.locator('.cm-w-image[data-state="missing"]')).toContainText('nope/missing.png');
    await expect(page.locator('.cm-w-imgchip').first()).toHaveText('A logo');
    expect(await changeCount(page)).toBe(0);
  });

  test("loads a real post's relative images", async ({ page }) => {
    await open(page);
    const path = 'src/content/entries/2026/curation-leaks.md';
    test.skip(!(await page.evaluate((p) => window.__write.files.includes(p), path)), 'post not in this working tree');
    await page.locator('[data-harness-file]').selectOption(path);
    await page.waitForFunction(() => window.__write.handle.getDoc().includes('![Curation pipeline'));
    // Only what is near the viewport is drawn: bring the first image up.
    await page.evaluate(() => {
      const h = window.__write.handle;
      h.setSelection({ anchor: h.getDoc().indexOf('![Curation pipeline') }, { scrollIntoView: true });
    });
    await expect(page.locator('.cm-w-image[data-state="loaded"]').first()).toBeVisible();
    const natural = await page.locator('.cm-w-image[data-state="loaded"] img').first().evaluate((img) => (img as HTMLImageElement).naturalWidth);
    expect(natural).toBeGreaterThan(0);
    await expect(page.locator('.cm-w-math .katex').first()).toBeVisible();
    expect(await changeCount(page)).toBe(0);
  });
});

test.describe('live preview follows the caret', () => {
  const doc = 'Some **bold** and a [link](https://example.com) here.\n\n## Heading\n\nSecond `code` para.\n';

  test('markup is revealed where the caret is and hidden again when it leaves', async ({ page }) => {
    await open(page, doc);
    expect(await visibleText(page)).not.toContain('**');

    await caret(page, 8); // inside "bold"
    await expect.poll(() => visibleText(page)).toContain('**bold**');
    expect(await visibleText(page)).not.toContain('](https://example.com)');

    await caret(page, 22); // inside the link's text: brackets show, the address stays folded
    await expect.poll(() => visibleText(page)).toContain('[link](…)');
    expect(await visibleText(page)).not.toContain('**bold**');
    expect(await visibleText(page)).not.toContain('https://example.com');
    await caret(page, doc.indexOf('example.com')); // inside the address
    await expect.poll(() => visibleText(page)).toContain('[link](https://example.com)');

    await caret(page, doc.indexOf('code') + 1);
    await expect.poll(() => visibleText(page)).toContain('`code`');
    expect(await changeCount(page)).toBe(0);
  });

  test('a caret inside heading text leaves the # marks hidden; at the marks they show', async ({ page }) => {
    await open(page, doc);
    const at = doc.indexOf('Heading');
    await caret(page, at + 3);
    expect(await visibleText(page)).not.toContain('## ');
    await caret(page, at - 2); // right after "##"
    await expect.poll(() => visibleText(page)).toContain('## Heading');
  });

  test('nothing is revealed when the editor is not focused', async ({ page }) => {
    await open(page, doc);
    await caret(page, 8);
    await expect.poll(() => visibleText(page)).toContain('**bold**');
    await content(page).evaluate((el) => (el as HTMLElement).blur());
    await expect.poll(() => visibleText(page)).not.toContain('**');
    expect(await changeCount(page)).toBe(0);
  });

  test('a real tap in formatted text places the caret there and reveals it', async ({ page, hasTouch }) => {
    await open(page, doc);
    await press(page.locator('.cm-strong'), hasTouch);
    await expect.poll(() => visibleText(page)).toContain('**bold**');
    const { head } = await selectionOf(page);
    expect(head).toBeGreaterThanOrEqual(5);
    expect(head).toBeLessThanOrEqual(13);
    expect(await stateOf(page)).toMatchObject({ bold: true, empty: true });
  });

  test('display math opens its source when entered and shows a live preview under it', async ({ page, hasTouch }) => {
    const math = 'Before\n\n$$\na = b\n$$\n\nAfter\n';
    await open(page, math);
    await expect(page.locator('.cm-w-mathblock .katex-display')).toBeVisible();
    expect(await visibleText(page)).not.toContain('a = b');
    await press(page.locator('.cm-w-mathblock'), hasTouch);
    await expect(page.locator('.cm-line.cm-math-line')).toHaveCount(3);
    await expect(page.locator('.cm-w-mathblock-preview .katex-display')).toBeVisible();
    expect(await changeCount(page)).toBe(0);
  });
});

test.describe('typing', () => {
  test('footnote references turn into chips as they are typed', async ({ page, hasTouch }) => {
    await open(page, '');
    await press(content(page), hasTouch);
    await type(page, 'A claim[^1] here.');
    await expect(chip(page, '1')).toBeVisible();
    await expect(chip(page, '1')).toHaveClass(/cm-w-fn-orphan/);
    await expectDoc(page, 'A claim[^1] here.');
    await type(page, '\n\n[^1]: The note.');
    await expect(chip(page, '1')).not.toHaveClass(/cm-w-fn-orphan/);
    await expectDoc(page, 'A claim[^1] here.\n\n[^1]: The note.');
  });

  test('markdown typed by hand renders as it is completed, and the text is exactly what was typed', async ({ page, hasTouch }) => {
    await open(page, '');
    await press(content(page), hasTouch);
    const typed = '## Title\n\nSome **bold** and *it* and `c` and $x^2$ done.';
    await type(page, typed);
    await expectDoc(page, typed);
    await expect(page.locator('.cm-line.cm-h2')).toHaveText('Title');
    await expect(page.locator('.cm-strong')).toHaveText('bold');
    await expect(page.locator('.cm-inline-code')).toHaveText('c');
    await expect(page.locator('.cm-w-math .katex')).toBeVisible();
  });

  test('Enter continues lists and tasks; Enter on an empty item ends the list', async ({ page, hasTouch }) => {
    await open(page, '');
    await press(content(page), hasTouch);
    await type(page, '- one');
    await key(page, 'Enter');
    await type(page, 'two');
    await expectDoc(page, '- one\n- two');
    await key(page, 'Enter');
    await key(page, 'Enter');
    await type(page, 'after');
    await expectDoc(page, '- one\n- two\n\nafter');

    await load(page, '');
    await press(content(page), hasTouch);
    await type(page, '1. a');
    await key(page, 'Enter');
    await type(page, 'b');
    await key(page, 'Enter');
    await type(page, '- [ ] t');
    await expectDoc(page, '1. a\n2. b\n3. - [ ] t');
  });

  test('Enter continues a quote and Backspace removes the marker', async ({ page, hasTouch }) => {
    await open(page, '');
    await press(content(page), hasTouch);
    await type(page, '> quoted');
    await key(page, 'Enter');
    await type(page, 'more');
    await expectDoc(page, '> quoted\n> more');
    await key(page, 'Enter');
    await expectDoc(page, '> quoted\n> more\n> ');
    await key(page, 'Backspace');
    await expect.poll(() => getDoc(page)).not.toContain('more\n> ');
  });

  test('typing then undoing returns the exact text', async ({ page, hasTouch }) => {
    await open(page);
    const before = await getDoc(page);
    await press(page.locator('.cm-line.cm-h1'), hasTouch);
    await type(page, ' and **more** text[^9]');
    expect(await getDoc(page)).not.toBe(before);
    await undoAll(page);
    await expectDoc(page, before);
    await expect(page.locator('[data-harness-identical]')).toHaveAttribute('data-harness-identical', 'true');
  });

  test('a footnote chip is one unit: the caret steps over it and Backspace removes it whole', async ({ page }) => {
    await open(page, 'ab[^1]cd\n\n[^1]: n\n');
    await caret(page, 6); // just after the chip
    await key(page, 'ArrowLeft');
    expect((await selectionOf(page)).head).toBe(2);
    await key(page, 'ArrowRight');
    expect((await selectionOf(page)).head).toBe(6);
    await key(page, 'Backspace');
    await expectDoc(page, 'abcd\n\n[^1]: n\n');
  });

  test('IME composition goes in intact next to hidden and revealed markup', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'composition is driven through the Chrome DevTools protocol');
    const doc = 'Some **bold** text\n\n- item one\n\n## Heading\n';
    await open(page, doc);
    const cdp = await page.context().newCDPSession(page);
    const compose = async (steps: string[], commit: string) => {
      for (const text of steps) {
        await cdp.send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length });
        await page.waitForTimeout(20);
      }
      await cdp.send('Input.insertText', { text: commit });
      await page.waitForTimeout(40);
    };

    // In plain text right after a hidden bold span.
    await caret(page, doc.indexOf(' text'));
    await compose(['n', 'に', 'にh', 'にほ', 'にほn', 'にほん'], '日本');
    let expected = doc.replace('** text', '**日本 text');
    await expectDoc(page, expected);

    // Inside the bold span (its marks are revealed while the caret is there).
    await caret(page, expected.indexOf('bold') + 4);
    await compose(['k', 'か'], '下');
    expected = expected.replace('bold**', 'bold下**');
    await expectDoc(page, expected);

    // In a list item, behind its bullet widget.
    await caret(page, expected.indexOf('item one') + 'item one'.length);
    await compose(['s', 'す', 'すし'], '寿司');
    expected = expected.replace('item one', 'item one寿司');
    await expectDoc(page, expected);

    // At the end of a heading whose marks are hidden.
    await caret(page, expected.indexOf('Heading') + 'Heading'.length);
    await compose(['a', 'あ'], '亜');
    expected = expected.replace('Heading', 'Heading亜');
    await expectDoc(page, expected);

    await expect(page.locator('.cm-strong')).toHaveText(/bold下/);
    await expect(page.locator('.cm-line.cm-h2')).toContainText('Heading亜');
  });
});

test.describe('footnotes', () => {
  const doc = 'Text[^1] more[^2].\n\n[^1]: One.\n[^2]: Two.\n';

  test('the Footnote button inserts the next number and its definition, then focuses the note', async ({ page, hasTouch }) => {
    await open(page, 'A claim here.\n');
    await caret(page, 7);
    await press(command(page, 'footnote'), hasTouch);
    await expectDoc(page, 'A claim[^1] here.\n\n[^1]: \n');
    await expect(panel(page)).toBeVisible();
    await expect(panel(page)).toHaveAttribute('data-note-panel', '1');
    await expect(noteText(page)).toBeFocused();

    await type(page, 'The note.');
    await expectDoc(page, 'A claim[^1] here.\n\n[^1]: The note.\n');

    await press(page.locator('[data-note-action="done"]'), hasTouch);
    await expect(panel(page)).toBeHidden();
    await expect(content(page)).toBeFocused();
    expect((await selectionOf(page)).head).toBe('A claim[^1]'.length);

    // A second one continues the numbering and the spacing; existing notes are untouched.
    await type(page, ' Another');
    await press(command(page, 'footnote'), hasTouch);
    await type(page, 'Second.');
    await expectDoc(page, 'A claim[^1] Another[^2] here.\n\n[^1]: The note.\n[^2]: Second.\n');

    await press(page.locator('[data-note-action="done"]'), hasTouch);
    await undoAll(page);
    await expectDoc(page, 'A claim here.\n');
  });

  test('tapping a chip opens its note; typing there edits only the definition text', async ({ page, hasTouch }) => {
    await open(page, doc);
    await press(chip(page, '2'), hasTouch);
    await expect(panel(page)).toHaveAttribute('data-note-panel', '2');
    await expect(noteText(page)).toHaveValue('Two.');
    await expect(chip(page, '2')).toHaveClass(/cm-w-fn-active/);
    expect(await changeCount(page)).toBe(0);

    await press(noteText(page), hasTouch);
    await noteText(page).press('End');
    await type(page, ' More');
    await expectDoc(page, 'Text[^1] more[^2].\n\n[^1]: One.\n[^2]: Two. More\n');

    // One history, the document's: a run of typing in the note is one undo step, from the toolbar too.
    await press(command(page, 'undo'), hasTouch);
    await expectDoc(page, doc);
    await expect(noteText(page)).toHaveValue('Two.');
    await press(command(page, 'redo'), hasTouch);
    await expectDoc(page, 'Text[^1] more[^2].\n\n[^1]: One.\n[^2]: Two. More\n');
    await expect(noteText(page)).toBeFocused();

    // A line break inside the note becomes an indented continuation line of the definition.
    await key(page, 'Enter');
    await type(page, 'Next line');
    await expectDoc(page, 'Text[^1] more[^2].\n\n[^1]: One.\n[^2]: Two. More\n    Next line\n');
    await expect(noteText(page)).toHaveValue('Two. More\nNext line');

    await noteText(page).press('Escape');
    await expect(panel(page)).toBeHidden();
    await undoAll(page);
    await expectDoc(page, doc);
  });

  test('on a touch screen a tap while reading only peeks; while writing it goes straight to the note', async ({ page, hasTouch }) => {
    test.skip(!hasTouch, 'touch behaviour');
    await open(page, doc);
    await chip(page, '1').tap();
    await expect(panel(page)).toBeVisible();
    await expect(noteText(page)).not.toBeFocused(); // keyboard stays down
    await page.locator('[data-note-action="done"]').tap();

    await caret(page, 2); // writing: editor focused, keyboard up
    await chip(page, '1').tap();
    await expect(noteText(page)).toBeFocused();
  });

  test('renaming a label updates the reference and the definition together', async ({ page, hasTouch }) => {
    await open(page, doc);
    await press(chip(page, '2'), hasTouch);
    const label = page.locator('[data-note-label]');
    await label.fill('src');
    await label.press('Enter');
    await expectDoc(page, 'Text[^1] more[^src].\n\n[^1]: One.\n[^src]: Two.\n');
    await expect(panel(page)).toHaveAttribute('data-note-panel', 'src');
    await expect(chip(page, 'src')).toBeVisible();

    // A label that is already another note is refused and nothing changes.
    await label.fill('1');
    await label.press('Enter');
    await expect(page.locator('[data-note-status]')).toContainText('already another note');
    await expectDoc(page, 'Text[^1] more[^src].\n\n[^1]: One.\n[^src]: Two.\n');
  });

  test('orphans are flagged, and typing a note for an orphan reference creates its definition', async ({ page, hasTouch }) => {
    await open(page, 'A[^a] b.\n\n[^z]: unused\n');
    await expect(chip(page, 'a')).toHaveClass(/cm-w-fn-orphan/);
    await expect(page.locator('[data-footnote-def="z"]')).toHaveClass(/cm-w-fn-orphan/);

    await press(chip(page, 'a'), hasTouch);
    await expect(page.locator('[data-note-status]')).toHaveText('No note yet');
    expect(await changeCount(page)).toBe(0);
    await press(noteText(page), hasTouch);
    await type(page, 'Now it has one.');
    await expectDoc(page, 'A[^a] b.\n\n[^z]: unused\n[^a]: Now it has one.\n');
    await expect(chip(page, 'a')).not.toHaveClass(/cm-w-fn-orphan/);
  });

  test('deleting a note removes its reference and definition and nothing else', async ({ page, hasTouch }) => {
    await open(page, doc);
    await press(chip(page, '1'), hasTouch);
    await press(page.locator('[data-note-action="delete"]'), hasTouch);
    await expectDoc(page, 'Text more[^2].\n\n[^2]: Two.\n');
    await expect(panel(page)).toBeHidden();
    await undoAll(page);
    await expectDoc(page, doc);
  });

  test('toolbar formatting applies inside the note while it has focus', async ({ page, hasTouch }) => {
    await open(page, doc);
    await press(chip(page, '2'), hasTouch);
    await press(noteText(page), hasTouch);
    await noteText(page).evaluate((el) => (el as HTMLTextAreaElement).setSelectionRange(0, 3));
    await press(command(page, 'italic'), hasTouch);
    await expectDoc(page, 'Text[^1] more[^2].\n\n[^1]: One.\n[^2]: *Two*.\n');
    await expect(noteText(page)).toBeFocused();
    await expect(noteText(page)).toHaveValue('*Two*.');
    // Block commands make no sense in a note and are refused.
    await press(command(page, 'heading'), hasTouch);
    await expectDoc(page, 'Text[^1] more[^2].\n\n[^1]: One.\n[^2]: *Two*.\n');
  });

  test('the docked panel on a phone does not cover the reference it belongs to', async ({ page, hasTouch }) => {
    test.skip(!hasTouch, 'phone layout');
    const filler = Array.from({ length: 30 }, (_, i) => `Paragraph ${i + 1} of filler text.`).join('\n\n');
    await open(page, `${filler}\n\nThe claim[^1] is here.\n\n${filler}\n\n[^1]: Note.\n`);
    await page.evaluate(() => {
      const h = window.__write.handle;
      h.setSelection({ anchor: h.getDoc().indexOf('The claim') }, { scrollIntoView: true });
    });
    await expect(chip(page, '1')).toBeVisible();
    await page.locator('.cm-scroller').evaluate((el) => {
      const line = [...el.querySelectorAll('.cm-line')].find((l) => l.textContent?.includes('The claim'))!;
      // Leave the reference near the bottom edge, where the panel will appear.
      el.scrollTop += line.getBoundingClientRect().bottom - el.getBoundingClientRect().bottom + 6;
    });
    await page.waitForTimeout(100);
    await chip(page, '1').tap();
    await expect(panel(page)).toHaveAttribute('data-note-mode', 'docked');
    await expect
      .poll(async () => {
        const c = await chip(page, '1').boundingBox();
        const p = await panel(page).boundingBox();
        return !!c && !!p && c.y + c.height <= p.y;
      })
      .toBe(true);
  });

  test('on a wide screen the note floats next to its reference', async ({ page, hasTouch }) => {
    test.skip(!!hasTouch, 'desktop layout');
    await open(page, doc);
    await chip(page, '2').click();
    await expect(panel(page)).toHaveAttribute('data-note-mode', 'floating');
    const c = (await chip(page, '2').boundingBox())!;
    const p = (await panel(page).boundingBox())!;
    expect(p.y).toBeGreaterThanOrEqual(c.y + c.height);
    expect(p.y - (c.y + c.height)).toBeLessThan(40);
    // Clicking back into the text puts it away.
    await page.locator('.cm-line').first().click();
    await expect(panel(page)).toBeHidden();
  });
});

test.describe('toolbar commands', () => {
  test('format the selection and keep the editor focused', async ({ page, hasTouch }) => {
    await open(page, 'some plain words here\n');
    await caret(page, 5, 10);
    await press(command(page, 'bold'), hasTouch);
    await expectDoc(page, 'some **plain** words here\n');
    await expect(content(page)).toBeFocused();
    expect(await stateOf(page)).toMatchObject({ bold: true, empty: false });
    await press(command(page, 'bold'), hasTouch);
    await expectDoc(page, 'some plain words here\n');

    await press(command(page, 'heading'), hasTouch);
    await expectDoc(page, '## some plain words here\n');
    expect((await stateOf(page)).heading).toBe(2);
    await press(command(page, 'heading'), hasTouch);
    await press(command(page, 'heading'), hasTouch);
    await expectDoc(page, 'some plain words here\n');

    await press(command(page, 'bulletList'), hasTouch);
    await expectDoc(page, '- some plain words here\n');
    expect((await stateOf(page)).list).toBe('bullet');
    await press(command(page, 'taskList'), hasTouch);
    await expectDoc(page, '- [ ] some plain words here\n');
    await press(command(page, 'taskList'), hasTouch);
    await press(command(page, 'quote'), hasTouch);
    await expectDoc(page, '> some plain words here\n');
    await press(command(page, 'quote'), hasTouch);
    await expectDoc(page, 'some plain words here\n');
    await expect(content(page)).toBeFocused();

    await undoAll(page);
    await expectDoc(page, 'some plain words here\n');
  });

  test('bold, type, bold again: writes bold text and steps out of it', async ({ page, hasTouch }) => {
    await open(page, '');
    await press(content(page), hasTouch);
    await type(page, 'a ');
    await press(command(page, 'bold'), hasTouch);
    await type(page, 'b');
    await press(command(page, 'bold'), hasTouch);
    await type(page, ' c');
    await expectDoc(page, 'a **b** c');
  });

  test('link, image and rule commands through the handle', async ({ page }) => {
    await open(page, 'see this now\n');
    await caret(page, 4, 8);
    expect(await page.evaluate(() => window.__write.handle.exec('link'))).toBe(true);
    await expectDoc(page, 'see [this]() now\n');
    await type(page, 'https://example.com');
    await expectDoc(page, 'see [this](https://example.com) now\n');

    await load(page, 'text\n');
    await caret(page, 4);
    await page.evaluate(() => window.__write.handle.exec('rule'));
    await page.evaluate(() => window.__write.handle.exec('image', { src: 'post/pic.png', alt: 'Pic', size: 'small' }));
    await expectDoc(page, 'text\n\n---\n![Pic|small](post/pic.png)');
    await expect(page.locator('.cm-w-hr')).toBeVisible();
  });

  test('a task checkbox toggles the marker in the text', async ({ page, hasTouch }) => {
    await open(page, '- [ ] one\n- [x] two\n');
    await press(page.locator('.cm-w-task').first(), hasTouch);
    await expectDoc(page, '- [x] one\n- [x] two\n');
    await press(page.locator('.cm-w-task').nth(1), hasTouch);
    await expectDoc(page, '- [x] one\n- [ ] two\n');
  });

  test('keyboard shortcuts on desktop', async ({ page, hasTouch }) => {
    test.skip(!!hasTouch, 'hardware keyboard');
    await open(page, 'some words\n- a\n- b\n');
    await caret(page, 5, 10);
    await page.keyboard.press('ControlOrMeta+b');
    await expectDoc(page, 'some **words**\n- a\n- b\n');
    await page.keyboard.press('ControlOrMeta+i');
    await expectDoc(page, 'some ***words***\n- a\n- b\n');
    await caret(page, (await getDoc(page)).indexOf('- b') + 3);
    await page.keyboard.press('Tab');
    await expectDoc(page, 'some ***words***\n- a\n  - b\n');
    await page.keyboard.press('Shift+Tab');
    await expectDoc(page, 'some ***words***\n- a\n- b\n');
  });
});

test.describe('links', () => {
  const doc = 'Read [the post](https://example.com/post) today.\n';

  test('a tap places the caret; the tooltip opens the link without losing focus', async ({ page, hasTouch }) => {
    await open(page, doc);
    await press(page.locator('.cm-link'), hasTouch);
    await expect.poll(() => visibleText(page)).toContain('[the post](…)');
    expect(await page.evaluate(() => window.__write.opened.length)).toBe(0); // editing wins: nothing opened
    const tip = page.locator('[data-link-open]');
    await expect(tip).toBeVisible();
    await press(tip, hasTouch);
    expect(await page.evaluate(() => window.__write.opened)).toEqual(['https://example.com/post']);
    await expect(content(page)).toBeFocused();
    // Typing dismisses it.
    await type(page, 'x');
    await expect(tip).toBeHidden();
  });

  test('tapping the folded address opens it for editing', async ({ page, hasTouch }) => {
    await open(page, doc);
    await press(page.locator('.cm-link'), hasTouch);
    await press(page.locator('.cm-w-urlstub'), hasTouch);
    await expect.poll(() => visibleText(page)).toContain('[the post](https://example.com/post)');
    await expect(content(page)).toBeFocused();
    expect(await changeCount(page)).toBe(0);
  });

  test('⌘/Ctrl-click opens directly on desktop', async ({ page, hasTouch }) => {
    test.skip(!!hasTouch, 'mouse');
    await open(page, doc);
    await page.locator('.cm-link').click({ modifiers: ['ControlOrMeta'] });
    expect(await page.evaluate(() => window.__write.opened)).toEqual(['https://example.com/post']);
  });
});

test.describe('layout', () => {
  test('no horizontal scrolling, even with long unbreakable content', async ({ page }) => {
    const long = 'x'.repeat(400);
    const doc = [
      `A very long address https://example.com/${long} in text.`,
      '```\n' + `const s = "${long}";` + '\n```',
      `| a | b |\n| - | - |\n| ${long} | 2 |`,
      `$$\n${Array.from({ length: 40 }, (_, i) => `x_{${i}}`).join(' + ')}\n$$`,
      `Inline ${'$' + Array.from({ length: 40 }, (_, i) => `y_{${i}}`).join('+') + '$'} math.`,
      `- ${long}`,
      `> ${long}`,
      `# ${long}`,
    ].join('\n\n');
    await open(page, doc);
    // CodeMirror only draws what is near the viewport: walk the whole document.
    const scroller = page.locator('.cm-scroller');
    let sawMath = false;
    for (let step = 0; step < 60; step++) {
      await page.waitForTimeout(60);
      const widths = await page.evaluate(() => {
        const el = document.querySelector('.cm-scroller')!;
        return {
          page: document.documentElement.scrollWidth - window.innerWidth,
          scroller: el.scrollWidth - el.clientWidth,
          content: document.querySelector('.cm-content')!.getBoundingClientRect().right - el.getBoundingClientRect().right,
          atEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
          math: !!document.querySelector('.cm-w-mathblock .katex-display'),
        };
      });
      expect(widths.page, `page at step ${step}`).toBeLessThanOrEqual(0);
      expect(widths.scroller, `scroller at step ${step}`).toBeLessThanOrEqual(1);
      expect(widths.content, `content at step ${step}`).toBeLessThanOrEqual(1);
      sawMath ||= widths.math;
      if (widths.atEnd) break;
      await scroller.evaluate((el) => (el.scrollTop += el.clientHeight * 0.8));
    }
    expect(sawMath).toBe(true);

    await open(page);
    const sample = await page.evaluate(() => {
      const scroller = document.querySelector('.cm-scroller')!;
      return { page: document.documentElement.scrollWidth - window.innerWidth, scroller: scroller.scrollWidth - scroller.clientWidth };
    });
    expect(sample.page).toBeLessThanOrEqual(0);
    expect(sample.scroller).toBeLessThanOrEqual(1);
  });

  test('revealing and hiding markup does not move any line vertically', async ({ page }) => {
    const doc = [
      '## A heading',
      'Some **bold**, *it*, ~~gone~~, `code` and a [link](https://example.com).',
      '- a list item',
      '- [ ] a task',
      '1. numbered',
      '> a quote',
      'A claim[^1] with a chip.',
      '```js\nlet a = 1;\n```',
      '---',
      'LAST LINE',
      '[^1]: The note.',
    ].join('\n\n');
    await open(page, doc);
    await expect(page.locator('.cm-line.cm-code span[class]').first()).toBeVisible();

    const tops = () =>
      page.evaluate(() => {
        const scroller = document.querySelector('.cm-scroller')!;
        const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
        return [...document.querySelectorAll('.cm-content > .cm-line')].map((l) => Math.round((l.getBoundingClientRect().top - base) * 2) / 2);
      });
    const before = await tops();
    expect(before.length).toBeGreaterThan(15);

    const places = ['heading', 'bold', 'it*', 'gone', 'code`', 'link', 'list item', 'a task', 'numbered', 'a quote', 'claim', 'let a', 'LAST', 'The note'];
    for (const word of places) {
      await caret(page, doc.indexOf(word) + 2);
      expect(await tops(), `caret in "${word}"`).toEqual(before);
    }
    // At the line prefixes themselves (marks revealed) and on the rule and fence lines.
    for (const marker of ['## A', '- a list', '- [ ] a', '1. num', '> a quote', '```js', '---\n\nLAST', '[^1]: The']) {
      await caret(page, doc.indexOf(marker) + 1);
      expect(await tops(), `caret at "${marker}"`).toEqual(before);
    }
    await content(page).evaluate((el) => (el as HTMLElement).blur());
    await page.waitForTimeout(50);
    expect(await tops()).toEqual(before);
    expect(await changeCount(page)).toBe(0);
  });

  test('fills its parent and scrolls inside itself', async ({ page }) => {
    await open(page);
    const box = await page.evaluate(() => {
      const editor = document.querySelector('[data-write-editor]')!;
      const scroller = document.querySelector('.cm-scroller')!;
      return {
        editor: editor.getBoundingClientRect().height,
        parent: editor.parentElement!.getBoundingClientRect().height,
        scrollable: scroller.scrollHeight > scroller.clientHeight,
        bodyScroll: document.documentElement.scrollHeight - window.innerHeight,
      };
    });
    expect(Math.abs(box.editor - box.parent)).toBeLessThanOrEqual(1);
    expect(box.scrollable).toBe(true);
    expect(box.bodyScroll).toBeLessThanOrEqual(0);
  });

  test('every theme restyles the editor through tokens alone', async ({ page }) => {
    await open(page);
    const read = () =>
      page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const resolve = (token: string, prop: 'color' | 'fontFamily') => {
          const probe = document.createElement('span');
          probe.style[prop] = `var(${token})`;
          document.body.append(probe);
          const value = getComputedStyle(probe)[prop];
          probe.remove();
          return value;
        };
        const css = (sel: string, prop: 'color' | 'fontFamily') => getComputedStyle(document.querySelector(sel)!)[prop];
        return {
          ink: [css('.cm-editor', 'color'), resolve('--w-ink', 'color')],
          heading: [css('.cm-line.cm-h1', 'color'), resolve('--w-syn-heading', 'color')],
          link: [css('.cm-link', 'color'), resolve('--w-syn-link', 'color')],
          footnote: [css('.cm-w-fn', 'color'), resolve('--w-syn-footnote', 'color')],
          prose: [css('.cm-scroller', 'fontFamily'), resolve('--w-font-prose', 'fontFamily')],
          display: [css('.cm-line.cm-h1', 'fontFamily'), resolve('--w-font-display', 'fontFamily')],
          bg: root.getPropertyValue('--w-bg').trim(),
        };
      });
    const seen = new Set<string>();
    for (const look of ['galley', 'console', 'riso', 'galley-dark']) {
      await page.locator('[data-harness-look]').selectOption(look);
      // Colours ease over to the new theme; wait until they have arrived.
      await expect.poll(async () => (await read()).footnote[0] === (await read()).footnote[1]).toBe(true);
      const s = await read();
      for (const key of ['ink', 'heading', 'link', 'footnote', 'prose', 'display'] as const) {
        expect(s[key][0], `${look}: ${key}`).toBe(s[key][1]);
      }
      seen.add(`${s.ink[0]}|${s.prose[0]}|${s.bg}`);
    }
    expect(seen.size).toBe(4);
    expect(await changeCount(page)).toBe(0);
  });
});

test.describe('contract', () => {
  test('typing works after switching documents and after setDoc (fresh input state each time)', async ({ page, hasTouch }) => {
    await open(page, '');
    await press(content(page), hasTouch);
    await type(page, 'ab');
    await key(page, 'Enter');
    await expectDoc(page, 'ab\n');
    for (const round of [1, 2]) {
      await load(page, ''); // a different docKey
      await press(content(page), hasTouch);
      await type(page, `round ${round}`);
      await expectDoc(page, `round ${round}`);
    }
    await page.evaluate(() => window.__write.handle.setDoc('x'));
    await press(content(page), hasTouch);
    await page.evaluate(() => window.__write.handle.setSelection({ anchor: 1 }));
    await type(page, 'yz');
    await expectDoc(page, 'xyz');
  });

  test('setDoc replaces the text, reports a non-user change and resets history', async ({ page }) => {
    await open(page, 'first\n');
    await caret(page, 5);
    await type(page, '!');
    expect((await stateOf(page)).canUndo).toBe(true);
    await page.evaluate(() => window.__write.handle.setDoc('second\n'));
    await expectDoc(page, 'second\n');
    const last = await page.evaluate(() => window.__write.changes.at(-1));
    expect(last).toEqual({ doc: 'second\n', userEvent: false });
    expect((await stateOf(page)).canUndo).toBe(false);

    await page.evaluate(() => window.__write.handle.setDoc('third\n', { keepHistory: true }));
    expect(await page.evaluate(() => window.__write.changes.at(-1))).toEqual({ doc: 'third\n', userEvent: false });
    await page.evaluate(() => window.__write.handle.exec('undo'));
    await expectDoc(page, 'second\n');
  });

  test('user typing is reported as a user change; selection and scroll accessors work', async ({ page }) => {
    await open(page);
    await caret(page, 3);
    await type(page, 'z');
    expect(await page.evaluate(() => window.__write.changes.at(-1)?.userEvent)).toBe(true);
    await page.evaluate(() => window.__write.handle.insertText('Q'));
    expect((await getDoc(page)).slice(0, 8)).toBe('# TzQhe ');
    await page.evaluate(() => window.__write.handle.setSelection({ anchor: 2, head: 5 }));
    expect(await selectionOf(page)).toEqual({ anchor: 2, head: 5 });
    await page.waitForTimeout(100); // let the scroll-into-view from typing finish
    await page.evaluate(() => window.__write.handle.setScrollTop(300));
    expect(await page.evaluate(() => window.__write.handle.getScrollTop())).toBe(300);
  });

  test('restores the given selection on mount and shows a placeholder in an empty document', async ({ page }) => {
    await open(page, undefined, '?sel=6-13');
    expect(await selectionOf(page)).toEqual({ anchor: 6, head: 13 });
    expect(await changeCount(page)).toBe(0);
    await load(page, '');
    await expect(page.locator('.cm-placeholder')).toHaveText('Start writing');
  });

  test('read-only: nothing can be edited, notes can still be read', async ({ page, hasTouch }) => {
    await open(page, undefined, '?readonly');
    const before = await getDoc(page);
    await expect(content(page)).toHaveAttribute('contenteditable', 'false');
    expect(await page.evaluate(() => window.__write.handle.exec('bold'))).toBe(false);
    await press(chip(page, '1'), hasTouch);
    await expect(noteText(page)).toHaveValue(/The first note/);
    await expect(noteText(page)).toHaveAttribute('readonly', '');
    await expect(page.locator('[data-note-action="delete"]')).toHaveCount(0);
    await expectDoc(page, before);
    expect(await changeCount(page)).toBe(0);
  });

  test('a desktop double-click selects a word and the toolbar state follows', async ({ page, hasTouch }) => {
    test.skip(!!hasTouch, 'mouse');
    await open(page, 'alpha **beta** gamma\n');
    await page.locator('.cm-strong').dblclick();
    const sel = await selectionOf(page);
    expect(await page.evaluate(([a, h]) => window.__write.handle.getDoc().slice(Math.min(a, h), Math.max(a, h)), [sel.anchor, sel.head])).toBe('beta');
    expect(await stateOf(page)).toMatchObject({ bold: true, empty: false });
    await expect(page.locator('.cm-selectionBackground').first()).toBeVisible();
  });
});

test.describe('invariant: every post round-trips', () => {
  test('load → read back is identical; type → undo is identical', async ({ page }) => {
    test.setTimeout(240_000);
    await open(page);
    const files = await page.evaluate(() => window.__write.files);
    expect(files.length).toBeGreaterThan(50);
    const failures: string[] = [];
    for (const path of files) {
      const body = await page.evaluate(async (p) => window.__write.bodyOf(await window.__write.read(p)), path);
      await load(page, body);
      // Let the first decoration pass, focus change and async pieces (KaTeX, images) run.
      await page.waitForTimeout(30);
      if ((await getDoc(page)) !== body) failures.push(`${path}: differs after load`);
      if ((await changeCount(page)) !== 0) failures.push(`${path}: onChange fired on load`);

      const at = Math.floor(body.length / 2);
      await caret(page, at);
      await type(page, 'x y');
      await key(page, 'Enter');
      const edited = await getDoc(page);
      if (edited === body) failures.push(`${path}: typing did nothing`);
      await undoAll(page);
      if ((await getDoc(page)) !== body) failures.push(`${path}: differs after type + undo`);
    }
    expect(failures).toEqual([]);
  });
});

/**
 * Regression tests for the pre-release review, the parts that need a real browser (layout, real
 * key presses, real requests). Their text-level counterparts run without a browser in
 * src/write/editor/__tests__/{lineBreaks,review-fixes,editor-component}.test.ts.
 */
test.describe('review findings', () => {
  test('mixed line endings: a typed character is the only change, and undo restores the file', async ({ page, hasTouch }) => {
    const doc = 'one\r\ntwo\nthree\rfour\r\n';
    await open(page, doc);
    expect(await getDoc(page)).toBe(doc);
    expect(await changeCount(page)).toBe(0);
    await press(content(page), hasTouch);
    await caret(page, 3);
    await type(page, 'X');
    await expectDoc(page, 'oneX\r\ntwo\nthree\rfour\r\n');
    await undoAll(page);
    await expectDoc(page, doc);
  });

  test('LF text pasted into a CRLF document becomes lines in the document’s own ending', async ({ page }) => {
    await open(page, 'first\r\nlast\r\n');
    await caret(page, 6);
    await content(page).evaluate((el) => {
      const data = new DataTransfer();
      data.setData('text/plain', 'pasted one\npasted two\n');
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    });
    await expectDoc(page, 'first\r\npasted one\r\npasted two\r\nlast\r\n');
    expect(await page.locator('.cm-line').allTextContents()).toEqual(expect.arrayContaining(['pasted one', 'pasted two']));
  });

  test('Footnote with an unclosed code fence at the end: typing the note keeps ONE definition', async ({ page }) => {
    await open(page, 'Some text here.\n\n```js\nlet a = 1;\n');
    await caret(page, 'Some text here.'.length);
    await command(page, 'footnote').click();
    await expect(noteText(page)).toBeFocused();
    await type(page, 'hello');
    await expectDoc(page, 'Some text here.[^1]\n\n```js\nlet a = 1;\n```\n\n[^1]: hello\n');
  });

  test('Footnote inside a code block does nothing and says why', async ({ page }) => {
    const doc = '```js\nlet a = 1;\n```\n\nText\n';
    await open(page, doc);
    await caret(page, 10);
    await command(page, 'footnote').click();
    await expectDoc(page, doc);
    expect(await page.evaluate(() => window.__write.notices.length)).toBe(1);
    await expect(panel(page)).toBeHidden();
  });

  test('typing an image address requests nothing until the caret leaves it', async ({ page }) => {
    const images: string[] = [];
    page.on('request', (req) => req.resourceType() === 'image' && images.push(req.url()));
    await open(page, 'Text\n\n');
    await caret(page, 6);
    await command(page, 'image').click();
    await type(page, 'https://example.com/img/photo.png');
    await page.waitForTimeout(300);
    expect(images).toEqual([]);
    await expect(page.locator('.cm-w-image[data-state="typing"]')).toBeVisible();
    await caret(page, 0);
    await expect.poll(() => images).toEqual(['https://example.com/img/photo.png']);
  });

  test('the caret is brought back into view when the box shrinks under it (the keyboard opening)', async ({ page, hasTouch }) => {
    const filler = Array.from({ length: 80 }, (_, i) => `Paragraph ${i + 1} of filler text.`).join('\n\n');
    await open(page, filler);
    const scroller = page.locator('.cm-scroller');
    const box = (await scroller.boundingBox())!;
    // A line near the bottom of the visible text.
    const at = { x: box.width / 2, y: box.height * 0.85 };
    if (hasTouch) await scroller.tap({ position: at });
    else await scroller.click({ position: at });
    await expect(content(page)).toBeFocused();
    await page.evaluate(() => {
      const surface = window.__write.box;
      surface.style.flex = 'none';
      surface.style.height = `${Math.round(surface.getBoundingClientRect().height * 0.45)}px`;
    });
    await expect
      .poll(async () => {
        const cursor = await page.locator('.cm-cursor-primary').boundingBox();
        const visible = await scroller.boundingBox();
        return !!cursor && !!visible && cursor.y >= visible.y && cursor.y + cursor.height <= visible.y + visible.height;
      })
      .toBe(true);
    expect(await changeCount(page)).toBe(0);
  });

  test('in a very short box the note panel covers it, and its text field is fully visible', async ({ page }) => {
    await open(page, 'Text[^1] more.\n\n[^1]: Note.\n');
    await page.evaluate(() => {
      const surface = window.__write.box;
      surface.style.flex = 'none';
      surface.style.height = '140px';
    });
    await caret(page, 4);
    await chip(page, '1').click();
    await expect(panel(page)).toHaveAttribute('data-note-mode', 'cover');
    await expect(noteText(page)).toBeInViewport({ ratio: 1 });
    const surface = (await page.locator('[data-harness-surface]').boundingBox())!;
    const text = (await noteText(page).boundingBox())!;
    expect(text.y).toBeGreaterThanOrEqual(surface.y);
    expect(text.y + text.height).toBeLessThanOrEqual(surface.y + surface.height + 0.5);
    expect(text.height).toBeGreaterThanOrEqual(24);
    expect(await page.evaluate(() => window.__write.notes.at(-1))).toMatchObject({ label: '1', cover: true });
  });

  test('⌘/Ctrl+Enter opens the footnote next to the caret and ticks a task', async ({ page, hasTouch }) => {
    test.skip(!!hasTouch, 'hardware keyboard');
    await open(page, 'Text[^1] more.\n\n- [ ] task\n\n[^1]: Note.\n');
    await caret(page, 'Text[^1]'.length);
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(panel(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await caret(page, 'Text[^1] more.\n\n- [ ] ta'.length);
    await page.keyboard.press('ControlOrMeta+Enter');
    await expectDoc(page, 'Text[^1] more.\n\n- [x] task\n\n[^1]: Note.\n');
  });
});
