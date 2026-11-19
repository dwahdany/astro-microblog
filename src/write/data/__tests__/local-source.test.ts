import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PostNotFoundError, ReadOnlyError, assemblePost } from '../../contracts';
import { frontmatter } from '../frontmatter';
import { gitBlobSha } from '../git-sha';
import { contentSource } from '../index';
import { createLocalSource, type FileMap } from '../local-source';
import { allFiles, posts } from './content';

const lazy = (entries: Record<string, string>): FileMap =>
  Object.fromEntries(Object.entries(entries).map(([path, raw]) => ['/' + path, () => Promise.resolve(raw)]));

describe('local source (the entry point in dev)', () => {
  it('is what ./index.ts exports under vitest/dev', () => {
    expect(contentSource.kind).toBe('local');
    expect(contentSource.canSave).toBe(false);
  });

  it('lists every published post of the working tree, newest first, without ignored files', async () => {
    const refs = await contentSource.list();
    expect(refs.length).toBe(posts.length);
    expect(new Set(refs.map((r) => r.path))).toEqual(new Set(posts.map(([p]) => p)));
    expect(refs.some((r) => r.path.endsWith('_README.md'))).toBe(false);
    for (let i = 1; i < refs.length; i++) expect(refs[i - 1].createdMs!).toBeGreaterThanOrEqual(refs[i].createdMs!);
    expect(contentSource.status().state).toBe('fresh');
  });

  it('load() returns the bytes on disk for EVERY post, and they reassemble', async () => {
    let n = 0;
    for (const [path] of posts) {
      const disk = readFileSync(path, 'utf8');
      const loaded = await contentSource.load(path);
      expect(loaded.raw, path).toBe(disk);
      expect(assemblePost(loaded.parts), path).toBe(disk);
      expect(loaded.ref.id, path).toBe(path);
      expect(loaded.ref.sha, path).toBe(await gitBlobSha(disk));
      n++;
    }
    console.info(`[data] open-without-change: ${n}/${posts.length} posts loaded through contentSource.load() are byte-identical to the file on disk`);
  });

  it('opening and patching nothing leaves every post unchanged', async () => {
    for (const [path, raw] of posts) {
      const loaded = await contentSource.load(path);
      const { data } = frontmatter.parse(loaded.parts.frontmatter);
      const same = frontmatter.patch(loaded.parts, data as never, loaded.ref.collection);
      expect(same, path).toBe(loaded.parts);
      expect(assemblePost(same), path).toBe(raw);
    }
  });

  it('rejects with PostNotFoundError for unknown paths', async () => {
    await expect(contentSource.load('src/content/notes/2026/does-not-exist.md')).rejects.toBeInstanceOf(PostNotFoundError);
    await expect(contentSource.load('package.json')).rejects.toBeInstanceOf(PostNotFoundError);
    await expect(contentSource.load('src/content/notes/2025/new-blog/IMG_6328.jpeg')).rejects.toBeInstanceOf(PostNotFoundError);
  });

  it('can load files the list hides (portfolio/_README.md) by path', async () => {
    const readme = allFiles.find(([p]) => p.endsWith('_README.md'));
    if (!readme) return;
    expect((await contentSource.load(readme[0])).raw).toBe(readme[1]);
  });

  it('resolves images to the dev server path of the file', () => {
    const r = (src: string) => contentSource.resolveAssetUrl('src/content/notes/2025/new-blog.md', src);
    expect(r('new-blog/IMG_6328.jpeg')).toBe('/src/content/notes/2025/new-blog/IMG_6328.jpeg');
    expect(r('./new-blog/IMG_6328.jpeg')).toBe('/src/content/notes/2025/new-blog/IMG_6328.jpeg');
    expect(r('new blog/a.png')).toBe('/src/content/notes/2025/new%20blog/a.png');
    expect(r('/og-default.png')).toBe('/og-default.png');
    expect(r('https://example.com/x.png')).toBe('https://example.com/x.png');
    expect(r('#top')).toBe('#top');
    expect(r('')).toBeNull();
    expect(r('../../../assets/x.png')).toBe('/src/assets/x.png');
    expect(r('../../../../../x.png')).toBeNull();
  });

  it('every relative image referenced by a real post resolves to a file that exists', async () => {
    let images = 0;
    for (const [path, raw] of posts) {
      const { body, frontmatter: fm } = frontmatter.split(raw);
      const refs = [...body.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?[^)]*\)/g)].map((m) => m[1]);
      const { data } = frontmatter.parse(fm);
      for (const key of ['card_image', 'photo']) if (typeof data[key] === 'string' && data[key] !== '') refs.push(data[key] as string);
      for (const src of refs) {
        if (/^(?:[a-z]+:|\/\/|\/|#)/i.test(src)) continue;
        const url = contentSource.resolveAssetUrl(path, src);
        expect(url, `${path}: ${src}`).not.toBeNull();
        expect(() => readFileSync(decodeURIComponent(url!.slice(1).split(/[?#]/)[0])), `${path}: ${src}`).not.toThrow();
        images++;
      }
    }
    console.info(`[data] relative images: ${images} references in real posts resolve to existing files`);
    expect(images).toBeGreaterThan(10);
  });

  it('save is defined and read-only', async () => {
    await expect(contentSource.save({ path: 'src/content/notes/2026/x.md', raw: 'x' })).rejects.toBeInstanceOf(ReadOnlyError);
  });
});

describe('local source: freshness', () => {
  const A = 'src/content/notes/2026/a.md';
  const text = (body: string) => `---\nslug: a\ncreated: 2026-01-01\n---\n${body}`;

  it('load() asks the dev server for the current text; list() does so on refresh', async () => {
    let disk = text('v1\n');
    const asked: string[] = [];
    const source = createLocalSource(async () => lazy({ [A]: text('v1\n') }), frontmatter, {
      readFresh: async (path) => {
        asked.push(path);
        return disk;
      },
    });
    expect((await source.list())[0].excerpt).toBe('v1');
    expect(asked).toEqual([]);

    disk = text('v2\n');
    expect((await source.list())[0].excerpt).toBe('v1'); // cached until asked
    expect((await source.load(A)).raw).toBe(disk);
    expect((await source.list({ refresh: true }))[0].excerpt).toBe('v2');
    expect(asked).toEqual([A, A]);
  });

  it('falls back to the imported module when the dev server cannot be asked', async () => {
    const source = createLocalSource(async () => lazy({ [A]: text('module\n') }), frontmatter, { readFresh: async () => undefined });
    expect((await source.load(A)).raw).toBe(text('module\n'));
    // Default reader outside a browser: no window, so the module text is used.
    const plain = createLocalSource(async () => lazy({ [A]: text('module\n') }), frontmatter);
    expect((await plain.load(A)).raw).toBe(text('module\n'));
  });

  it('a failed import of the file map is retried, not remembered', async () => {
    let fail = true;
    const source = createLocalSource(async () => {
      if (fail) throw new Error('vite down');
      return lazy({ [A]: text('ok\n') });
    }, frontmatter);
    await expect(source.list()).rejects.toThrow('vite down');
    fail = false;
    expect((await source.list()).length).toBe(1);
  });
});
