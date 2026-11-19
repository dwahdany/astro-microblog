import { describe as suite, expect, it } from 'vitest';
import { COLLECTIONS } from '../../contracts';
import { formatLike, parseTimestamp, sveltiaTimestamp } from '../dates';
import { byNewest, describe, parse, pathFor, plainExcerpt, slugify } from '../describe';
import { posts } from './content';

suite('parse', () => {
  it('keeps timestamps as written and reports keys in order', () => {
    const p = parse('slug: a\ncreated: 2026-04-22T12:00:00+00:00\nday: 2026-09-03\ntags: [x]\n');
    expect(p).toEqual({
      data: { slug: 'a', created: '2026-04-22T12:00:00+00:00', day: '2026-09-03', tags: ['x'] },
      keys: ['slug', 'created', 'day', 'tags'],
      issues: [],
    });
  });

  it('never throws; syntax errors come back with a line', () => {
    const bad = parse('slug: a\ntitle: "unterminated\n');
    expect(bad.data).toEqual({});
    expect(bad.issues.length).toBeGreaterThan(0);
    expect(bad.issues[0].line).toBeGreaterThanOrEqual(2);
    expect(bad.issues[0].message).not.toContain('\n');
    expect(parse('- a\n- b\n').issues[0].message).toMatch(/mapping/);
    expect(parse('')).toEqual({ data: {}, keys: [], issues: [] });
    expect(parse('# only a comment\n')).toEqual({ data: {}, keys: [], issues: [] });
    expect(parse('a: *missing\n').issues.length).toBeGreaterThan(0);
    expect(parse('a: 1\na: 2\n').issues.length).toBeGreaterThan(0);
  });
});

suite('slugify', () => {
  it.each([
    ['Héllo, Wörld!', 'hello-world'],
    ["What's the date?  — LessWrong", 'what-s-the-date-lesswrong'],
    ['  Straße & Æther  ', 'strasse-aether'],
    ['Curation Leaks: Your "Private" Curated Model Isn\'t', 'curation-leaks-your-private-curated-model-isn-t'],
    ['already-a-slug', 'already-a-slug'],
    ['ＦＵＬＬ　ｗｉｄｔｈ', 'full-width'],
    ['日本語', ''],
    ['', ''],
    ['---', ''],
    ['GPT-4o vs. Claude 3.5', 'gpt-4o-vs-claude-3-5'],
  ])('%j → %j', (text, slug) => {
    expect(slugify(text)).toBe(slug);
    if (slug) expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });
});

suite('pathFor', () => {
  it('uses {collection}/{year}/{slug}.md with the UTC year of created', () => {
    expect(pathFor('notes', 'pro', '2026-08-25T11:12:00+00:00')).toBe('src/content/notes/2026/pro.md');
    expect(pathFor('portfolio', 'x', '2024-08-21')).toBe('src/content/portfolio/2024/x.md');
    expect(pathFor('entries', 'x', '2026-01-01T00:30:00+02:00')).toBe('src/content/entries/2025/x.md');
    expect(pathFor('entries', 'x', new Date('2027-06-01T00:00:00Z'))).toBe('src/content/entries/2027/x.md');
    expect(pathFor('series', 'my-series', '2026-01-01')).toBe('src/content/series/my-series.md');
    expect(pathFor('notes', 'x', 'garbage')).toBe(`src/content/notes/${new Date().getUTCFullYear()}/x.md`);
  });

  it('agrees with where existing posts live — except posts backdated after creation', () => {
    // Sveltia files a post under the year it was CREATED IN and never moves it; one post
    // (a 2024 paper bookmarked in 2026) therefore sits in a folder that is not its `created` year.
    // Consequence for callers: pathFor is for NEW posts only; an existing post keeps its path.
    const off = posts.filter(([path, raw]) => {
      const ref = describe(path, raw);
      return pathFor(ref.collection, ref.slug, ref.created ?? '') !== path;
    });
    expect(off.map(([path]) => path)).toEqual(['src/content/blogmarks/2026/dppl-differentially-private-prototype-learning.md']);
  });
});

suite('describe', () => {
  it('derives the list entry per collection', () => {
    const note = describe('src/content/notes/2026/x.md', "---\nslug: x\ntitle: ''\ncreated: 2026-01-02T03:04:00+00:00\ntags:\n  - a\n  - b\nis_draft: true\n---\n\nFirst **line** with a [link](https://e.com)[^1].\n\n[^1]: note\n", { sha: 'abc' });
    expect(note).toEqual({
      id: 'src/content/notes/2026/x.md',
      path: 'src/content/notes/2026/x.md',
      collection: 'notes',
      slug: 'x',
      title: 'First line with a link.',
      created: '2026-01-02T03:04:00+00:00',
      createdMs: Date.UTC(2026, 0, 2, 3, 4),
      tags: ['a', 'b'],
      draft: true,
      excerpt: 'First line with a link.',
      isNew: false,
      sha: 'abc',
    });
    expect(describe('src/content/blogmarks/2026/b.md', '---\nslug: b\nlink_title: The Link\ntitle: \'\'\n---\n').title).toBe('The Link');
    expect(describe('src/content/quotations/2026/q.md', '---\nslug: q\nsource: Someone\n---\nQuote').title).toBe('Someone');
    expect(describe('src/content/photos/2026/p.md', "---\nslug: p\ntitle: ''\nalt: A tower\n---\n").title).toBe('A tower');
    expect(describe('src/content/entries/2026/e.md', '---\nslug: e\ntitle: 1984\n---\n').title).toBe('1984');
  });

  it('falls back to the file name, and survives broken or missing frontmatter', () => {
    const broken = describe('src/content/notes/2026/from-file.md', '---\ntitle: "unterminated\n---\nBody text');
    expect(broken.slug).toBe('from-file');
    expect(broken.title).toBe('Body text');
    expect(broken.created).toBeNull();
    expect(broken.createdMs).toBeNull();
    expect(describe('src/content/entries/2026/bare.md', '').title).toBe('bare');
    expect(describe('src/content/notes/2026/n.md', '', { id: 'new:notes:1', isNew: true })).toMatchObject({ id: 'new:notes:1', isNew: true });
  });

  it('gives every published post a title, slug, collection and date', () => {
    for (const [path, raw] of posts) {
      const ref = describe(path, raw);
      expect(COLLECTIONS, path).toContain(ref.collection);
      expect(ref.title, path).not.toBe('');
      expect(ref.slug, path).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(ref.createdMs, path).not.toBeNull();
      expect(ref.excerpt.length, path).toBeLessThanOrEqual(160);
      expect(ref.excerpt, path).not.toMatch(/\]\(|^#|\n/);
    }
  });

  it('byNewest: newest first, undated last, stable', () => {
    const ref = (path: string, createdMs: number | null) => ({ ...describe(path, ''), createdMs });
    const sorted = [ref('b', null), ref('a', 5), ref('d', 9), ref('c', 5), ref('a0', null)].sort(byNewest).map((r) => r.path);
    expect(sorted).toEqual(['d', 'a', 'c', 'a0', 'b']);
  });
});

suite('plainExcerpt', () => {
  it('strips markdown, code, html, footnotes and images', () => {
    const md = '# Title\n\n![alt|small](a/b.png)\n\n```js\nconst hidden = 1;\n```\n\n> Quote **bold** and `code` with $x^2$ <span class="x">html</span>[^n].\n\n- item one\n1. item two\n\n[^n]: the note\n<!-- comment -->';
    expect(plainExcerpt(md)).toBe('Title Quote bold and code with x^2 html. item one item two');
  });

  it('truncates on a character boundary with an ellipsis', () => {
    const long = 'word '.repeat(100);
    const out = plainExcerpt(long);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith('…')).toBe(true);
  });

  it('an unterminated code fence does not hide the text before it', () => {
    expect(plainExcerpt('Intro\n\n```\ncode without end')).toBe('Intro');
  });
});

suite('timestamps', () => {
  it('sveltiaTimestamp is UTC, seconds zeroed, +00:00 — the format of the CMS-written files', () => {
    expect(sveltiaTimestamp(new Date('2026-11-18T09:30:12.345Z'))).toBe('2026-11-18T09:30:00+00:00');
    expect(sveltiaTimestamp(new Date('2026-01-01T00:59:59+02:00'))).toBe('2025-12-31T22:59:00+00:00');
    // Every existing +00:00 timestamp is reproduced from its own instant.
    let n = 0;
    for (const [path, raw] of posts) {
      const created = describe(path, raw).created!;
      // CMS-written values: minute precision. (A few imported posts carry real seconds.)
      if (!created.endsWith(':00+00:00')) continue;
      expect(sveltiaTimestamp(new Date(created)), path).toBe(created);
      n++;
    }
    expect(n).toBeGreaterThan(40);
  });

  it('formatLike keeps the shape of the value it replaces', () => {
    const d = new Date('2027-03-04T05:06:07.890Z');
    expect(formatLike('2026-11-11T10:43:00+00:00', d)).toBe('2027-03-04T05:06:07+00:00');
    expect(formatLike('2025-12-11T11:13:00Z', d)).toBe('2027-03-04T05:06:07Z');
    expect(formatLike('2026-09-03', d)).toBe('2027-03-04');
    expect(formatLike('2026-09-03T10:00:00+02:00', d)).toBe('2027-03-04T07:06:07+02:00');
    expect(formatLike('2026-09-03T10:00:00-0530', d)).toBe('2027-03-03T23:36:07-0530');
    expect(formatLike('2026-09-03 10:00', d)).toBe('2027-03-04 05:06');
    expect(formatLike('2026-09-03T10:00:00.000Z', d)).toBe('2027-03-04T05:06:07.890Z');
    expect(formatLike('2026-09-03T10:00:00.0Z', d)).toBe('2027-03-04T05:06:07.8Z');
    expect(formatLike(null, d)).toBe('2027-03-04T05:06:00+00:00');
    expect(formatLike('next week', d)).toBe('2027-03-04T05:06:00+00:00');
  });

  it('formatLike of an existing value and its own instant is the identity (every post)', () => {
    for (const [path, raw] of posts) {
      const created = describe(path, raw).created!;
      expect(formatLike(created, new Date(created)), path).toBe(created);
    }
  });

  it('parseTimestamp', () => {
    expect(parseTimestamp('2026-09-03')).toBe(Date.UTC(2026, 8, 3));
    expect(parseTimestamp('2025-12-11T11:13:00Z')).toBe(Date.UTC(2025, 11, 11, 11, 13));
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('nope')).toBeNull();
    expect(parseTimestamp(undefined)).toBeNull();
  });
});
