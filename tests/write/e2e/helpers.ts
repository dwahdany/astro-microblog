/**
 * Shared by the integration specs (journey, invariant). Works against both
 * targets the Playwright config can serve:
 *
 *   dev   `astro dev`, posts read from the working tree           (default)
 *   prod  the production build, posts read from the public GitHub repo
 *
 * `original(path)` is the text the app is expected to have loaded, obtained
 * WITHOUT going through the app: the file on disk in dev, the same path on
 * raw.githubusercontent.com in prod.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Download, type Locator, type Page } from '@playwright/test';

export const TARGET: 'dev' | 'prod' = process.env.WRITE_TARGET === 'prod' ? 'prod' : 'dev';

const REPO_RAW = 'https://raw.githubusercontent.com/dwahdany/astro-microblog/main';
const CONTENT = 'src/content';

export const EDITOR = '[data-write-editor] .cm-content';

/** Every post the site publishes from the working tree (the loaders skip `_*.md`). */
export function contentPaths(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.md') && !entry.name.startsWith('_')) out.push(path.split('\\').join('/'));
    }
  };
  walk(CONTENT);
  return out.sort();
}

export const collectionOf = (path: string): string => path.slice(CONTENT.length + 1).split('/')[0];

const originals = new Map<string, Promise<string | null>>();

/** The source text for `path`, fetched independently of the app. Null when the target does not have the file. */
export function original(path: string): Promise<string | null> {
  let hit = originals.get(path);
  if (!hit) {
    hit =
      TARGET === 'dev'
        ? Promise.resolve(readFileSync(path, 'utf8'))
        : fetch(`${REPO_RAW}/${path}`).then(async (res) => {
            if (res.status === 404) return null;
            if (!res.ok) throw new Error(`raw.githubusercontent.com answered ${res.status} for ${path}`);
            return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
          });
    originals.set(path, hit);
  }
  return hit;
}

export const postUrl = (id: string, sheet?: string): string =>
  `/write/#/post/${encodeURIComponent(id)}${sheet ? `/${sheet}` : ''}`;

export async function openPost(page: Page, id: string): Promise<void> {
  await page.goto(postUrl(id));
  // The first production visit fetches the whole repo listing before a post can open.
  await expect(page.locator(EDITOR)).toBeVisible({ timeout: 30_000 });
}

/** Open a sheet from the writing screen, going through "more" where the phone layout tucks it away. */
export async function openSheet(page: Page, name: 'properties' | 'review' | 'look'): Promise<void> {
  const direct = page.locator(`[data-open="${name}"]`);
  if (!(await direct.isVisible())) await page.locator('[data-open="more"]').click();
  await direct.click();
  await expect(page.locator(`[data-sheet="${name}"]`)).toBeVisible();
}

export async function closeSheet(page: Page): Promise<void> {
  await page.locator('[data-sheet] [data-sheet-close]').click();
  await expect(page.locator('[data-sheet]')).toHaveCount(0);
}

/**
 * CodeMirror only draws the lines near the viewport. Scroll the editor from the top until `target`
 * exists, then bring it into view.
 */
export async function reveal(page: Page, target: Locator): Promise<Locator> {
  const scroller = page.locator('[data-write-editor] .cm-scroller');
  // CodeMirror may redraw while it settles (fonts, images, its own viewport): search again rather than
  // trip over a node that was drawn a moment ago and is gone now.
  await expect(async () => {
    if ((await target.count()) === 0) {
      await scroller.evaluate((el) => (el.scrollTop = 0));
      for (let i = 0; i < 60 && (await target.count()) === 0; i++) {
        await scroller.evaluate((el) => (el.scrollTop += el.clientHeight * 0.6));
        await page.waitForTimeout(100);
      }
    }
    await target.first().scrollIntoViewIfNeeded({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  return target.first();
}

/** Tap on a touch device, click otherwise — at `position` inside the element when given. */
export async function press(page: Page, selector: Locator, hasTouch: boolean, position?: { x: number; y: number }) {
  if (hasTouch) await selector.tap({ position });
  else await selector.click({ position });
}

/** The exact bytes of a download, as text (no newline or BOM handling). */
export async function downloadedText(download: Download): Promise<string> {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(readFileSync(await download.path()));
}

/** "Download .md" from the open Review sheet. */
export async function downloadFromReview(page: Page): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('[data-action="download"]').click()]);
  return downloadedText(download);
}

/**
 * Record what the app hands to the clipboard. WebKit has no clipboard
 * permission to grant in Playwright, so the write is captured at the API
 * boundary instead of being read back from the system clipboard.
 */
export async function captureClipboard(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const copies: string[] = [];
    Object.defineProperty(window, '__copied', { value: copies });
    const clipboard = { writeText: async (text: string) => void copies.push(text) };
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => clipboard });
    } catch {
      /* the fallback path (execCommand) is then what runs */
    }
  });
}

export const lastCopied = (page: Page): Promise<string | undefined> =>
  page.evaluate(() => (window as unknown as { __copied: string[] }).__copied.at(-1));

/** Line-level difference between two texts: the lines only in `before` and the lines only in `after`, in order. */
export function lineChanges(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split('\n');
  const b = after.split('\n');
  // Longest common subsequence over lines (posts are a few hundred lines at most).
  const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const removed: string[] = [];
  const added: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) removed.push(a[i++]);
    else added.push(b[j++]);
  }
  removed.push(...a.slice(i));
  added.push(...b.slice(j));
  return { removed, added };
}
