/**
 * The data layer in a real browser, against the dev server: exact bytes from
 * Vite, real IndexedDB, real asset URLs.
 *
 * These tests drive src/write/data/index.ts directly (imported in the page
 * through Vite), not the UI, so they stay valid while the shell changes.
 * Nothing here talks to GitHub.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const DATA = '/src/write/data/index.ts';

async function ready(page: Page) {
  await page.goto('/write/');
  // The app has booted once the data module is in Vite's module graph; importing it again is then instant.
  // (Best effort: these tests only need the origin, so a shell that fails to mount does not fail them.)
  await page
    .waitForFunction(() => document.querySelector('astro-island')?.children.length, undefined, { timeout: 15_000 })
    .catch(() => undefined);
}

test('every post reaches the browser byte-identical, with its git blob sha', async ({ page }) => {
  await ready(page);
  const posts = await page.evaluate(async (mod) => {
    const data = await import(/* @vite-ignore */ mod);
    const refs = await data.contentSource.list();
    const out: { path: string; raw: string; reassembled: string; sha: string | undefined; fresh: string }[] = [];
    for (const ref of refs) {
      const loaded = await data.contentSource.load(ref.path);
      const p = loaded.parts;
      out.push({
        path: ref.path,
        raw: loaded.raw,
        reassembled: p.bom + p.open + p.frontmatter + p.close + p.gap + p.body,
        sha: loaded.ref.sha,
        fresh: await (await fetch('/' + ref.path, { cache: 'no-store' })).text(),
      });
    }
    return out;
  }, DATA);

  expect(posts.length).toBeGreaterThan(50);
  for (const post of posts) {
    const disk = readFileSync(post.path, 'utf8');
    expect(post.raw, post.path).toBe(disk);
    expect(post.reassembled, post.path).toBe(disk);
    expect(post.fresh, post.path).toBe(disk);
    expect(post.sha, post.path).toMatch(/^[0-9a-f]{40}$/);
  }
});

test('editing one property changes only that key\'s line', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async (mod) => {
    const data = await import(/* @vite-ignore */ mod);
    const loaded = await data.contentSource.load('src/content/entries/2025/simple-ideas.md');
    const join = (p: typeof loaded.parts) => p.bom + p.open + p.frontmatter + p.close + p.gap + p.body;
    const same = data.frontmatter.patch(loaded.parts, { title: data.frontmatter.parse(loaded.parts.frontmatter).data.title }, 'entries');
    const next = data.frontmatter.patch(loaded.parts, { title: 'Simple Ideas, retitled' }, 'entries');
    const diff = data.reviewDiff(loaded.raw, join(next));
    const changed = diff.hunks.flatMap((h: { lines: { kind: string; text: string }[] }) => h.lines).filter((l: { kind: string }) => l.kind !== 'context');
    return { noop: same === loaded.parts, added: diff.added, removed: diff.removed, body: diff.bodyChanged, changed, tagsLine: /^tags:.*$/m.exec(next.frontmatter)?.[0], tagsBefore: /^tags:.*$/m.exec(loaded.parts.frontmatter)?.[0] };
  }, DATA);

  expect(result.noop).toBe(true);
  expect(result.added).toBe(1);
  expect(result.removed).toBe(1);
  expect(result.body).toBe(false);
  expect(result.changed[1].text).toContain('Simple Ideas, retitled');
  // The stub used to rewrite `tags: [a, b]` as `tags: [ a, b ]` on any edit.
  expect(result.tagsLine).toBe(result.tagsBefore);
});

test('a draft survives a reload in IndexedDB and knows what it was based on', async ({ page }) => {
  await ready(page);
  const id = 'src/content/notes/2026/disksurvey.md';
  const stored = await page.evaluate(
    async ([mod, id]) => {
      const data = await import(/* @vite-ignore */ mod);
      const base = await data.contentSource.load(id);
      await data.draftStore.put({
        id,
        path: id,
        collection: 'notes',
        isNew: false,
        raw: base.raw + '\nA line typed on the phone.\n',
        baseRaw: base.raw,
        baseSha: base.ref.sha,
        updatedAt: 1234,
        selection: { anchor: 7, head: 9 },
        scrollTop: 40,
      });
      return { persistence: await data.draftPersistence(), list: await data.draftStore.list() };
    },
    [DATA, id],
  );
  expect(stored.persistence).toBe('indexeddb');
  expect(stored.list).toEqual([{ id, path: id, collection: 'notes', isNew: false, updatedAt: 1234, dirty: true }]);

  await page.reload();
  await ready(page);
  const after = await page.evaluate(
    async ([mod, id]) => {
      const data = await import(/* @vite-ignore */ mod);
      const draft = await data.draftStore.get(id);
      const upstream = await data.contentSource.load(id);
      const state = data.draftBaseState(draft, { raw: upstream.raw, sha: upstream.ref.sha });
      const moved = data.draftBaseState(draft, { raw: upstream.raw + 'someone else edited\n', sha: 'different' });
      await data.draftStore.delete(id);
      return { draft, baseIsDisk: draft.baseRaw === upstream.raw, state, moved, left: (await data.draftStore.list()).length };
    },
    [DATA, id],
  );
  const disk = readFileSync(id, 'utf8');
  expect(after.draft.raw).toBe(disk + '\nA line typed on the phone.\n');
  expect(after.draft.selection).toEqual({ anchor: 7, head: 9 });
  expect(after.draft.scrollTop).toBe(40);
  expect(after.baseIsDisk).toBe(true);
  expect(after.state).toBe('current');
  expect(after.moved).toBe('diverged');
  expect(after.left).toBe(0);
});

test('relative images of real posts resolve to files the server delivers', async ({ page }) => {
  await ready(page);
  const results = await page.evaluate(async (mod) => {
    const data = await import(/* @vite-ignore */ mod);
    const cases: [string, string][] = [
      ['src/content/notes/2025/new-blog.md', 'new-blog/IMG_6328.jpeg'],
      ['src/content/entries/2025/simple-ideas.md', 'simple-ideas/2025-02-image.png'],
      ['src/content/entries/2026/curation-leaks.md', './curation-leaks/hero.png'],
    ];
    const out = [];
    for (const [post, src] of cases) {
      const url = data.contentSource.resolveAssetUrl(post, src);
      const res = await fetch(url);
      out.push({ src, url, status: res.status, type: res.headers.get('content-type') });
    }
    return out;
  }, DATA);
  for (const r of results) {
    expect(r.status, r.src).toBe(200);
    expect(r.type, r.src).toMatch(/^image\//);
  }
  expect(results[2].url).toBe('/src/content/entries/2026/curation-leaks/hero.png');
});

test('a new post is scaffolded in Sveltia\'s shape and is read-only toward GitHub', async ({ page }) => {
  await ready(page);
  const result = await page.evaluate(async (mod) => {
    const data = await import(/* @vite-ignore */ mod);
    const post = data.frontmatter.scaffold('blogmarks', { now: new Date('2026-11-18T09:30:12Z'), values: { link_url: 'https://example.com', link_title: 'An Example: with a colon' } });
    const save = await data.contentSource.save({ path: post.ref.path, raw: post.raw }).then(
      () => 'saved',
      (e: Error & { code?: string }) => e.code,
    );
    return { raw: post.raw, path: post.ref.path, id: post.ref.id, canSave: data.contentSource.canSave, save };
  }, DATA);
  expect(result.raw).toBe(
    "---\nslug: an-example-with-a-colon\nlink_url: https://example.com\nlink_title: 'An Example: with a colon'\ntitle: ''\ncreated: 2026-11-18T09:30:00+00:00\ntags: []\nvia_url: ''\nvia_title: ''\nis_draft: true\n---\n\n",
  );
  expect(result.path).toBe('src/content/blogmarks/2026/an-example-with-a-colon.md');
  expect(result.id).toMatch(/^new:blogmarks:[0-9a-f-]{36}$/);
  expect(result.canSave).toBe(false);
  expect(result.save).toBe('READ_ONLY');
});
