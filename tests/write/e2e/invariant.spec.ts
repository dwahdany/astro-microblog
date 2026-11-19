/**
 * THE invariant, through the whole app: open a real post, touch it the way a
 * reader would (focus, move the caret, glance at the preview, open the
 * properties) but edit nothing — and the file the app would hand back is the
 * source file, byte for byte.
 *
 * Every published post is opened on the desktop project in dev. The phone
 * projects and the production target take a spread of at least 24 across all
 * collections (WRITE_INVARIANT_ALL=1 opens every post everywhere).
 */
import { expect, test } from '@playwright/test';
import { EDITOR, TARGET, closeSheet, collectionOf, contentPaths, downloadFromReview, openPost, openSheet, original, press } from './helpers';

const ALL = contentPaths();

/** Largest and smallest of each collection first, then every n-th, so the spread covers all kinds and sizes. */
function sample(paths: string[], atLeast: number): string[] {
  const byKind = new Map<string, string[]>();
  for (const p of paths) byKind.set(collectionOf(p), [...(byKind.get(collectionOf(p)) ?? []), p]);
  const picked = new Set<string>();
  const perKind = Math.ceil(atLeast / byKind.size);
  for (const list of byKind.values()) {
    const step = Math.max(1, Math.floor(list.length / perKind));
    for (let i = 0; i < list.length && [...picked].filter((p) => list.includes(p)).length < perKind; i += step) picked.add(list[i]);
  }
  for (const p of paths) {
    if (picked.size >= atLeast) break;
    picked.add(p);
  }
  return [...picked].sort();
}

test('opening posts without editing them leaves every one byte-identical', async ({ page, hasTouch }, testInfo) => {
  const everything = process.env.WRITE_INVARIANT_ALL === '1' || (TARGET === 'dev' && testInfo.project.name === 'desktop');
  const paths = everything ? ALL : sample(ALL, 24);
  test.setTimeout(60_000 + paths.length * 8_000);

  const kinds = new Set(paths.map(collectionOf));
  expect(paths.length).toBeGreaterThanOrEqual(20);
  expect([...kinds].sort()).toEqual([...new Set(ALL.map(collectionOf))].sort());

  const checked: string[] = [];
  for (const [index, path] of paths.entries()) {
    const source = await original(path);
    if (source === null) continue; // in the working tree but not pushed yet: not in the production source
    await test.step(path, async () => {
      await openPost(page, path);
      await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');

      // Things that must not count as edits.
      await press(page, page.locator(EDITOR), hasTouch, { x: 40, y: 30 });
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowDown');
      if (index % 3 === 0) {
        await page.locator('[data-mode="preview"]:visible').click();
        await expect(page.locator('[data-preview]')).toHaveAttribute('data-preview-state', 'ready', { timeout: 30_000 });
        await page.locator('[data-mode="write"]:visible').click();
      }
      if (index % 3 === 1) {
        await openSheet(page, 'properties');
        await closeSheet(page);
      }

      await openSheet(page, 'review');
      await expect(page.locator('[data-review-state]')).toHaveAttribute('data-review-state', 'unchanged');
      const text = await downloadFromReview(page);
      expect(text === source, `${path}: downloaded text differs from the source (${text.length} vs ${source.length} chars)`).toBe(true);
      await closeSheet(page);
      await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');
    });
    checked.push(path);
  }

  expect(checked.length).toBeGreaterThanOrEqual(20);
  testInfo.annotations.push({ type: 'posts-checked', description: `${checked.length} (${[...new Set(checked.map(collectionOf))].sort().join(', ')})` });
  console.log(`[invariant] ${testInfo.project.name}/${TARGET}: ${checked.length} posts byte-identical`);
});
