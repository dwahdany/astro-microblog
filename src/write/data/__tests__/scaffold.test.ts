import { describe, expect, it } from 'vitest';
import { CREATABLE_COLLECTIONS, SLUG_PATTERN, assemblePost, type CreatableCollection, type FrontmatterValue } from '../../contracts';
import { scaffoldKeys, validate } from '../fields';
import { frontmatter } from '../frontmatter';
import { collectionOf } from '../paths';
import { posts } from './content';

const now = new Date('2026-11-18T09:30:12Z');

describe('scaffold', () => {
  it('note: exactly what Sveltia writes, except is_draft', () => {
    const post = frontmatter.scaffold('notes', { now, values: { slug: 'my-note' } });
    expect(post.raw).toBe("---\nslug: my-note\ntitle: ''\ncreated: 2026-11-18T09:30:00+00:00\ntags: []\nis_draft: true\n---\n\n");
    expect(post.ref.path).toBe('src/content/notes/2026/my-note.md');
  });

  it('entry', () => {
    const post = frontmatter.scaffold('entries', { now, values: { title: 'Researching With AI' }, body: 'Hello\n' });
    expect(post.raw).toBe(
      "---\nslug: researching-with-ai\ntitle: Researching With AI\ncreated: 2026-11-18T09:30:00+00:00\ntags: []\nis_draft: true\nseries: ''\ncard_image: ''\nexcerpt: ''\n---\n\nHello\n",
    );
  });

  it('blogmark', () => {
    const post = frontmatter.scaffold('blogmarks', {
      now,
      values: { link_url: 'https://example.com/a', link_title: "What's the date?  — LessWrong", tags: ['ai', 'rl'] },
    });
    expect(post.raw).toBe(
      "---\nslug: what-s-the-date-lesswrong\nlink_url: https://example.com/a\nlink_title: What's the date?  — LessWrong\ntitle: ''\ncreated: 2026-11-18T09:30:00+00:00\ntags:\n  - ai\n  - rl\nvia_url: ''\nvia_title: ''\nis_draft: true\n---\n\n",
    );
  });

  it('quotation', () => {
    const post = frontmatter.scaffold('quotations', { now, values: { source: 'Gwern Branwen' }, body: 'If Fable had lived' });
    expect(post.raw).toBe(
      "---\nslug: gwern-branwen\nsource: Gwern Branwen\nsource_url: ''\ncontext: ''\ncreated: 2026-11-18T09:30:00+00:00\ntags: []\nis_draft: true\n---\n\nIf Fable had lived",
    );
  });

  it.each(CREATABLE_COLLECTIONS)('%s: self-consistent, new, a draft, with a usable slug', (collection) => {
    const post = frontmatter.scaffold(collection, { now });
    expect(assemblePost(post.parts)).toBe(post.raw);
    expect(frontmatter.split(post.raw)).toEqual(post.parts);
    const { data, keys, issues } = frontmatter.parse(post.parts.frontmatter);
    expect(issues).toEqual([]);
    expect(keys).toEqual(scaffoldKeys(collection));
    expect(data.is_draft).toBe(true);
    expect(data.created).toBe('2026-11-18T09:30:00+00:00');
    expect(String(data.slug)).toMatch(SLUG_PATTERN);
    expect(String(data.slug)).toMatch(/^untitled-[0-9a-f]{6}$/);
    expect(post.eol).toBe('lf');
    expect(post.ref).toMatchObject({ isNew: true, draft: true, collection, path: `src/content/${collection}/2026/${data.slug}.md` });
    expect(post.ref.id).toMatch(new RegExp(`^new:${collection}:[0-9a-f-]{36}$`));
    // Only the fields the owner still has to fill in are reported.
    const missing = validate(collection, data).map((i) => i.key);
    expect(missing).toEqual({ entries: ['title'], notes: [], blogmarks: ['link_url', 'link_title'], quotations: ['source'] }[collection]);
  });

  it('ids are unique', () => {
    const ids = new Set(Array.from({ length: 50 }, () => frontmatter.scaffold('notes').ref.id));
    expect(ids.size).toBe(50);
  });

  it('initial values: quoting follows Sveltia, unknown-to-CMS keys go where patch puts them', () => {
    const post = frontmatter.scaffold('notes', {
      now,
      values: { title: 'DPPL: a "private" idea', slug: 'dppl', is_draft: false, excerpt: 'Short', created: '2025-01-02T03:04:00+00:00' },
    });
    expect(post.parts.frontmatter).toBe(
      "slug: dppl\ntitle: 'DPPL: a \"private\" idea'\ncreated: 2025-01-02T03:04:00+00:00\ntags: []\nis_draft: false\nexcerpt: Short\n",
    );
    expect(post.ref.path).toBe('src/content/notes/2025/dppl.md');
  });

  it('reproduces the frontmatter of real CMS-written posts from their own values', () => {
    // Posts whose keys are exactly the ones Sveltia writes today, in order.
    const comparable = posts.filter(([path, raw]) => {
      const collection = collectionOf(path)!;
      if (!(CREATABLE_COLLECTIONS as readonly string[]).includes(collection)) return false;
      const fm = frontmatter.split(raw).frontmatter;
      return /^[a-z_]+: "|^[a-z_]+: \[.+\]/m.test(fm) === false && frontmatter.parse(fm).keys.join() === scaffoldKeys(collection).join();
    });
    const per: Record<string, number> = {};
    for (const [path, raw] of comparable) {
      const collection = collectionOf(path) as CreatableCollection;
      const original = frontmatter.split(raw);
      const { data } = frontmatter.parse(original.frontmatter);
      const post = frontmatter.scaffold(collection, { values: data as Record<string, FrontmatterValue>, body: original.body });
      expect(post.parts.frontmatter, path).toBe(original.frontmatter);
      // (One post was backdated after creation, so its folder year is not its `created` year.)
      if (!path.includes('dppl-differentially-private-prototype-learning')) expect(post.ref.path, path).toBe(path);
      if (original.gap === '\n') expect(post.raw, path).toBe(raw);
      per[collection] = (per[collection] ?? 0) + 1;
    }
    console.info(`[data] scaffold vs real CMS-written posts: ${comparable.length} reproduced byte-for-byte in the frontmatter ${JSON.stringify(per)}`);
    expect(Object.keys(per).sort()).toEqual(['blogmarks', 'entries', 'notes', 'quotations']);
  });
});
