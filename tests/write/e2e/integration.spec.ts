/**
 * Behaviour that only exists once the areas are joined up (dev server only —
 * drafts are seeded through the app's own data module, which the production
 * bundle does not expose):
 *
 *   - a theme switch restyles the editor and the note panel, not just the shell
 *   - changes kept on this device against a source file that has since changed:
 *     dropped when already applied, carried over when they do not collide,
 *     kept and flagged when they do, and still openable when the file is gone
 *   - a properties edit the data layer refuses is reported, and nothing is rewritten
 *   - a new post ends with a line break, like every file in the repo
 *   - nothing throws along the way
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { EDITOR, closeSheet, downloadFromReview, openPost, openSheet, postUrl } from './helpers';

const POST = 'src/content/notes/2026/human-entropy.md';
const DISK = readFileSync(POST, 'utf8');
const DATA = '/src/write/data/index.ts';

interface Seed {
  id: string;
  path: string;
  collection: string;
  raw: string;
  baseRaw: string | null;
  baseSha?: string;
}

/** Put a draft into this browser's draft store, as an earlier visit would have left it. */
async function seedDraft(page: Page, seed: Seed) {
  await page.goto('/write/');
  await expect(page.locator('[data-post-list] li').first()).toBeVisible();
  await page.evaluate(
    async ({ mod, seed }) => {
      const data = await import(/* @vite-ignore */ mod);
      await data.draftStore.put({ ...seed, isNew: false, updatedAt: Date.now() - 60_000 });
    },
    { mod: DATA, seed },
  );
}

const draftIds = (page: Page) =>
  page.evaluate(async (mod) => ((await import(/* @vite-ignore */ mod)).draftStore.list() as Promise<{ id: string }[]>).then((l) => l.map((d) => d.id)), DATA);

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  return errors;
}

test('switching the theme restyles the editor and the note panel', async ({ page, hasTouch }) => {
  const errors = watchErrors(page);
  await openPost(page, POST);
  const chip = page.locator('[data-write-editor] [data-footnote-ref="1"]').first();
  if (hasTouch) await chip.tap();
  else await chip.click();
  await expect(page.locator('[data-note-panel="1"]')).toBeVisible();

  const looks = async () =>
    page.evaluate(() => {
      const css = (selector: string) => getComputedStyle(document.querySelector(selector)!);
      const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return {
        theme: document.documentElement.getAttribute('data-write-theme'),
        font: css('[data-write-editor] .cm-content').fontFamily,
        proseToken: token('--w-font-prose'),
        ink: css('[data-write-editor] .cm-content').color,
        page: css('[data-write-editor] .cm-scroller').backgroundColor + '|' + css('[data-write-pane="editor"]').backgroundColor,
        chip: css('[data-write-editor] [data-footnote-ref]').color,
        note: css('[data-note-panel] [data-note-text]').color + '|' + css('[data-note-panel]').backgroundColor,
      };
    });

  const seen = new Map<string, Awaited<ReturnType<typeof looks>>>();
  for (const theme of ['galley', 'console', 'riso'] as const) {
    // Without leaving the post: the Look sheet over the open editor.
    await page.goto(postUrl(POST, 'look'));
    await page.locator(`[data-theme-choice="${theme}"]`).click();
    await expect(page.locator('html')).toHaveAttribute('data-write-theme', theme);
    await page.locator('[data-sheet="look"] [data-sheet-close]').click();
    await expect(page.locator('[data-sheet]')).toHaveCount(0);
    // The editor is the same instance, with the note still open.
    await expect(page.locator('[data-note-panel="1"]')).toBeVisible();
    const look = await looks();
    // The editor's text is set in the theme's prose face, straight from the token.
    expect(look.font.replace(/["'\s]/g, '')).toBe(look.proseToken.replace(/["'\s]/g, ''));
    seen.set(theme, look);
  }
  const distinct = (key: 'font' | 'ink' | 'chip' | 'note') => new Set([...seen.values()].map((l) => l[key])).size;
  expect(distinct('font')).toBe(3);
  expect(distinct('ink')).toBe(3);
  expect(distinct('chip')).toBe(3);
  expect(distinct('note')).toBe(3);
  // …and none of that was an edit.
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');
  expect(errors).toEqual([]);
});

test('a note opened right after closing another one stays open', async ({ page, hasTouch }) => {
  // Regression: the editor's focus state used to trail a programmatic refocus by up to 300 ms on touch
  // screens; a chip tapped in that window opened its note, which was then put away again.
  await openPost(page, POST);
  const tap = (selector: string) => {
    const target = page.locator(selector).first();
    return hasTouch ? target.tap() : target.click();
  };
  await tap('[data-write-editor] .cm-line');
  await tap('[data-write-editor] [data-footnote-ref="1"]');
  await expect(page.locator('[data-note-panel="1"]')).toBeVisible();
  await page.locator('[data-note-panel="1"] [data-note-action="done"]').click();
  await tap('[data-write-editor] [data-footnote-ref="2"]');
  const second = page.locator('[data-note-panel="2"]');
  await expect(second).toBeVisible();
  await page.waitForTimeout(800); // well past the focus tracker's settle time
  await expect(second).toBeVisible();
  await expect(second.locator('[data-note-text]')).toBeFocused();
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');
});

test('kept changes that the source already contains are dropped silently', async ({ page }) => {
  // An earlier visit edited the post; meanwhile exactly that text was committed.
  await seedDraft(page, { id: POST, path: POST, collection: 'notes', raw: DISK, baseRaw: DISK.replace('N=1', 'N=0') });
  expect(await draftIds(page)).toContain(POST);
  await openPost(page, POST);
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');
  await expect(page.locator('[data-banner]')).toHaveCount(0);
  await expect.poll(() => draftIds(page)).not.toContain(POST);
});

test('kept changes are carried over when the source changed elsewhere in the file', async ({ page }) => {
  // The draft was started from an older file (title differed) and added a sentence at the end of a paragraph.
  const oldBase = DISK.replace('(kind of but not really)', '(not really)');
  const mine = oldBase.replace('back to regular prompting.', 'back to regular prompting. Mine.');
  expect(oldBase).not.toBe(DISK);
  await seedDraft(page, { id: POST, path: POST, collection: 'notes', raw: mine, baseRaw: oldBase });
  await openPost(page, POST);
  await expect(page.locator('[data-banner="upstream-merged"]')).toBeVisible();
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'edited');
  await openSheet(page, 'review');
  // Only the owner's own change is left to review; the newer title is kept.
  expect(await downloadFromReview(page)).toBe(DISK.replace('back to regular prompting.', 'back to regular prompting. Mine.'));
  await expect(page.locator('[data-review-diff] .line.add')).toHaveCount(1);
  await expect(page.locator('[data-review-diff] .line.del')).toHaveCount(1);
});

test('kept changes that collide with a changed source are kept as written and flagged', async ({ page }) => {
  const oldBase = DISK.replace('N=1', 'N=0');
  const mine = oldBase.replace('N=0', 'N=2');
  await seedDraft(page, { id: POST, path: POST, collection: 'notes', raw: mine, baseRaw: oldBase });
  await openPost(page, POST);
  await expect(page.locator('[data-banner="upstream-conflict"]')).toBeVisible();
  await openSheet(page, 'review');
  expect(await downloadFromReview(page)).toBe(mine);
  // Review is against the post as it is now.
  await expect(page.locator('[data-review-diff] .line.del')).toContainText(['N=1']);
  await expect(page.locator('[data-review-diff] .line.add')).toContainText(['N=2']);
});

test('changes kept for a post that has left the source can still be opened and taken out', async ({ page }) => {
  const gone = 'src/content/notes/2026/no-longer-here.md';
  const base = '---\nslug: no-longer-here\ncreated: 2026-01-01T10:00:00+00:00\ntags: []\nis_draft: false\n---\n\nOriginal.\n';
  const mine = base.replace('Original.', 'Original, with my edit.');
  await seedDraft(page, { id: gone, path: gone, collection: 'notes', raw: mine, baseRaw: base });
  await page.goto(postUrl(gone));
  await expect(page.locator(EDITOR)).toContainText('Original, with my edit.');
  await expect(page.locator('[data-banner="upstream-missing"]')).toBeVisible();
  await openSheet(page, 'review');
  expect(await downloadFromReview(page)).toBe(mine);
});

test('a properties edit the data layer refuses is reported and rewrites nothing', async ({ page }) => {
  const errors = watchErrors(page);
  // Flow-style frontmatter parses, but patch() will not splice into it.
  const body = DISK.slice(DISK.indexOf('\n---\n') + 5);
  const odd = `---\n{ slug: human-entropy, title: Odd, created: "2026-02-26T12:35:00+00:00", tags: [a], is_draft: false }\n---\n${body}`;
  await seedDraft(page, { id: POST, path: POST, collection: 'notes', raw: odd, baseRaw: DISK });
  await openPost(page, POST);
  await expect(page.locator('[data-title-input]')).toHaveValue('Odd');

  await page.locator('[data-title-input]').fill('Changed');
  await expect(page.locator('[data-banner="patch-refused"]')).toBeVisible();
  await openSheet(page, 'properties');
  await expect(page.locator('[data-patch-problem]')).toBeVisible();
  await page.locator('#prop-is_draft').click();
  await expect(page.locator('[data-patch-problem]')).toBeVisible();
  await closeSheet(page);

  await openSheet(page, 'review');
  expect(await downloadFromReview(page)).toBe(odd);
  expect(errors).toEqual([]);
});

test('frontmatter that is not valid YAML is shown as text and cannot be edited through the form or the title', async ({ page }) => {
  const errors = watchErrors(page);
  const broken = DISK.replace('title: Can Agents', 'title: "Can Agents');
  await seedDraft(page, { id: POST, path: POST, collection: 'notes', raw: broken, baseRaw: DISK });
  await openPost(page, POST);
  await expect(page.locator('[data-title-input]')).toHaveCount(0);
  await openSheet(page, 'properties');
  await expect(page.locator('[data-sheet="properties"]')).toContainText('not valid YAML');
  await expect(page.locator('[data-sheet="properties"] input')).toHaveCount(0);
  await closeSheet(page);
  // The body is still editable, and the broken block survives it untouched.
  await page.locator(EDITOR).click();
  await page.keyboard.press('ControlOrMeta+Home');
  await page.keyboard.type('X');
  await openSheet(page, 'review');
  const text = await downloadFromReview(page);
  expect(text).toBe(broken.replace('\n---\n\nI wanted', '\n---\n\nXI wanted'));
  expect(errors).toEqual([]);
});

test('a new post ends with a line break, and an untouched new post stays as scaffolded', async ({ page }) => {
  await page.goto('/write/');
  await page.locator('[data-open="new"]').click();
  await page.locator('[data-new="notes"]').click();
  await expect(page.locator(EDITOR)).toBeVisible();
  await openSheet(page, 'review');
  const scaffold = await downloadFromReview(page);
  expect(scaffold).toMatch(/^---\nslug: untitled-[0-9a-f]{6}\ntitle: ''\ncreated: \d{4}-\d\d-\d\dT\d\d:\d\d:00\+00:00\ntags: \[\]\nis_draft: true\n---\n\n$/);
  await closeSheet(page);

  await page.locator(EDITOR).click();
  await page.keyboard.type('Hello');
  await openSheet(page, 'review');
  expect(await downloadFromReview(page)).toBe(`${scaffold}Hello\n`);
  await expect(page.locator('[data-review-diff]')).not.toContainText('No line break');
  await closeSheet(page);

  // After a reload the kept text is the same text.
  await expect(page.locator('[data-keep-state]')).toHaveAttribute('data-keep-state', 'kept');
  await page.reload();
  await expect(page.locator(EDITOR)).toContainText('Hello');
  await openSheet(page, 'review');
  expect(await downloadFromReview(page)).toMatch(/\n---\n\nHello\n$/);
});

test('punctuation after a link, code span or footnote chip never starts a line', async ({ page }) => {
  // Hidden markup and chips used to be places where the line could break, leaving ". First, …" on its own line.
  await page.setViewportSize({ width: 390, height: 2400 }); // tall, so CodeMirror draws the whole post
  await openPost(page, POST);
  let checked = 0;
  for (let width = 330; width <= 430; width += 10) {
    await page.setViewportSize({ width, height: 2400 });
    await page.waitForTimeout(150);
    const result = await page.evaluate(() => {
      const stranded: string[] = [];
      let checked = 0;
      const root = document.querySelector('[data-write-editor] .cm-content')!;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
        if (!/^[.,;:!?)\]]/.test(node.data) || node.previousSibling?.nodeType !== Node.ELEMENT_NODE) continue;
        // The last character drawn before this text node, within the same line.
        let before: Text | null = null;
        for (let p: Node | null = node.previousSibling; p && !before; p = p.previousSibling) {
          if (p.nodeType === Node.TEXT_NODE && (p as Text).data.length) before = p as Text;
          else if (p.nodeType === Node.ELEMENT_NODE && p.textContent) {
            const inner = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
            for (let t = inner.nextNode() as Text | null; t; t = inner.nextNode() as Text | null) if (t.data.length) before = t;
          }
        }
        if (!before) continue;
        const a = document.createRange();
        a.setStart(before, before.data.length - 1);
        a.setEnd(before, before.data.length);
        const b = document.createRange();
        b.setStart(node, 0);
        b.setEnd(node, 1);
        const ra = a.getClientRects()[0];
        const rb = b.getClientRects()[0];
        if (!ra || !rb) continue;
        checked++;
        if (rb.top > ra.top + ra.height * 0.5) stranded.push(`${before.data.slice(-16)}⏎${node.data.slice(0, 10)}`);
      }
      return { stranded, checked };
    });
    expect(result.stranded, `at ${width}px`).toEqual([]);
    checked += result.checked;
  }
  expect(checked).toBeGreaterThanOrEqual(30);
});
