import { describe, expect, it } from 'vitest';
import { assemblePost, type FrontmatterValue, type PostParts } from '../../contracts';
import { FrontmatterPatchError } from '../errors';
import { writeOrder } from '../fields';
import { frontmatter } from '../frontmatter';
import { collectionOf } from '../paths';
import { patchYaml } from '../yaml-patch';
import { changedRegion, keyBlocks, posts } from './content';

const parts = (fm: string, body = 'Body\n'): PostParts => ({ bom: '', open: '---\n', frontmatter: fm, close: '---\n', gap: '\n', body });
const set = (fm: string, changes: Record<string, FrontmatterValue | undefined>, order?: readonly string[]) =>
  patchYaml(fm, changes, { order });

/** A value of the same kind as `value` that differs from it. */
function altered(value: unknown): FrontmatterValue {
  if (typeof value === 'string') return value + ' (edited: it\'s "quoted" #1)';
  if (typeof value === 'boolean') return !value;
  if (typeof value === 'number') return value + 1;
  if (Array.isArray(value)) return [...(value as FrontmatterValue[]), 'added-item'];
  if (value === null) return 'now set';
  return { ...(value as Record<string, FrontmatterValue>), added: 'x' };
}

/** The file's known keys appear in Sveltia's order (hand-ordered files, e.g. excerpt before card_image, do not). */
function inCmsOrder(keys: string[], collection: Parameters<typeof writeOrder>[0]): boolean {
  const ranks = keys.map((k) => writeOrder(collection).indexOf(k)).filter((r) => r >= 0);
  return ranks.every((r, i) => i === 0 || ranks[i - 1] < r);
}

describe('patch over every real post', () => {
  it('the parser-free key locator used by these tests agrees with the YAML parser on every file', () => {
    for (const [path, raw] of posts) {
      const fm = frontmatter.split(raw).frontmatter;
      expect(keyBlocks(fm).map((b) => b.key), path).toEqual(frontmatter.parse(fm).keys);
    }
  });

  it('changing ONE key changes only the lines of that key (every key of every post)', () => {
    let patches = 0;
    for (const [path, raw] of posts) {
      const original = frontmatter.split(raw);
      const { data, keys } = frontmatter.parse(original.frontmatter);
      const blocks = keyBlocks(original.frontmatter);
      for (const key of keys) {
        const next = frontmatter.patch(original, { [key]: altered(data[key]) }, collectionOf(path)!);
        const where = `${path} › ${key}`;
        // Only the frontmatter slice is replaced.
        expect({ ...next, frontmatter: '' }, where).toEqual({ ...original, frontmatter: '' });
        expect(next.frontmatter, where).not.toBe(original.frontmatter);
        // The differing lines lie inside the key's own block.
        const block = blocks.find((b) => b.key === key)!;
        const region = changedRegion(original.frontmatter, next.frontmatter);
        expect(region.start, where).toBeGreaterThanOrEqual(block.start);
        expect(region.endBefore, where).toBeLessThanOrEqual(block.end);
        // And the data is what was asked for, nothing else.
        const after = frontmatter.parse(next.frontmatter);
        expect(after.issues, where).toEqual([]);
        expect(after.keys, where).toEqual(keys);
        expect(after.data, where).toEqual({ ...data, [key]: altered(data[key]) });
        patches++;
      }
    }
    console.info(`[data] patch isolation: ${patches} single-key edits over ${posts.length} posts touched only their own lines`);
    expect(patches).toBeGreaterThan(400);
  });

  it('removing a key deletes exactly its lines; putting it back restores the data and its position', () => {
    let exact = 0;
    let total = 0;
    for (const [path, raw] of posts) {
      const original = frontmatter.split(raw);
      const collection = collectionOf(path)!;
      const { data, keys } = frontmatter.parse(original.frontmatter);
      const blocks = keyBlocks(original.frontmatter);
      const lines = original.frontmatter.split('\n');
      for (const key of keys) {
        const where = `${path} › ${key}`;
        const block = blocks.find((b) => b.key === key)!;
        const removed = frontmatter.patch(original, { [key]: undefined }, collection);
        expect(removed.frontmatter, where).toBe([...lines.slice(0, block.start), ...lines.slice(block.end)].join('\n'));

        const restored = frontmatter.patch(removed, { [key]: data[key] as FrontmatterValue }, collection);
        const after = frontmatter.parse(restored.frontmatter);
        expect(after.data, where).toEqual(data);
        // Known keys come back where Sveltia orders them, which is where they were.
        if (inCmsOrder(keys, collection) && writeOrder(collection).includes(key)) expect(after.keys, where).toEqual(keys);
        total++;
        if (restored.frontmatter === original.frontmatter) exact++;
      }
    }
    console.info(`[data] remove + re-add: ${exact}/${total} keys come back byte-identical (the rest differ only in hand-written style)`);
    expect(total).toBeGreaterThan(400);
  });

  it('re-adding a key renders it exactly as Sveltia wrote it (files in pure CMS style)', () => {
    // CMS-written blocks: no double quotes, no flow lists with items, no comments.
    const cmsStyle = posts.filter(([, raw]) => {
      const fm = frontmatter.split(raw).frontmatter;
      return !/^[a-z_]+: "|^[a-z_]+: \[.+\]|#/m.test(fm);
    });
    let keysChecked = 0;
    for (const [path, raw] of cmsStyle) {
      const original = frontmatter.split(raw);
      const collection = collectionOf(path)!;
      if (collection === 'portfolio') continue;
      const { data, keys } = frontmatter.parse(original.frontmatter);
      for (const key of keys) {
        if (!writeOrder(collection).includes(key)) continue;
        const removed = frontmatter.patch(original, { [key]: undefined }, collection);
        const restored = frontmatter.patch(removed, { [key]: data[key] as FrontmatterValue }, collection);
        expect(restored.frontmatter, `${path} › ${key}`).toBe(original.frontmatter);
        keysChecked++;
      }
    }
    console.info(`[data] Sveltia style: ${keysChecked} keys in ${cmsStyle.length} CMS-written posts re-render byte-identically`);
    expect(cmsStyle.length).toBeGreaterThan(40);
  });

  it('tags keep their list style when edited', () => {
    let block = 0;
    let flow = 0;
    for (const [path, raw] of posts) {
      const original = frontmatter.split(raw);
      const { data } = frontmatter.parse(original.frontmatter);
      const tags = data.tags as string[];
      if (!Array.isArray(tags) || tags.length === 0) continue;
      const next = frontmatter.patch(original, { tags: [...tags, 'zz-new'] }).frontmatter;
      if (/^tags: \[/m.test(original.frontmatter)) {
        flow++;
        const before = /^tags: \[(.*)\]$/m.exec(original.frontmatter)![1];
        expect(next, path).toContain(`tags: [${before}, zz-new]\n`);
      } else {
        block++;
        const last = tags[tags.length - 1];
        expect(next, path).toContain(`  - ${last}\n  - zz-new\n`);
        // Dropping the first tag removes exactly one line.
        const dropped = frontmatter.patch(original, { tags: tags.slice(1) }).frontmatter;
        expect(dropped, path).toBe(original.frontmatter.replace(`tags:\n  - ${tags[0]}\n`, tags.length === 1 ? 'tags: []\n' : 'tags:\n'));
      }
    }
    expect(block).toBeGreaterThan(30);
    expect(flow).toBeGreaterThan(5);
  });
});

describe('patch: scalars', () => {
  it('replaces only the value characters and keeps the trailing comment', () => {
    expect(set('slug: a   # keep me\ntitle: T\n', { slug: 'b' })).toBe('slug: b   # keep me\ntitle: T\n');
  });

  it('keeps double quotes, escaping as needed', () => {
    expect(set('title: "AI Everything"\n', { title: 'Say "hi"' })).toBe('title: "Say \\"hi\\""\n');
    expect(set('title: "A"\n', { title: 'plain' })).toBe('title: "plain"\n');
  });

  it('keeps single quotes, doubling apostrophes', () => {
    expect(set("title: 'A'\n", { title: "it's" })).toBe("title: 'it''s'\n");
    expect(set("title: ''\n", { title: 'Now titled' })).toBe("title: 'Now titled'\n");
  });

  it('plain stays plain when the value allows it, and is quoted like Sveltia when it does not', () => {
    expect(set('title: Old\n', { title: 'New title' })).toBe('title: New title\n');
    expect(set('title: Old\n', { title: 'DPPL: Differentially Private' })).toBe("title: 'DPPL: Differentially Private'\n");
    expect(set('title: Old\n', { title: "What's the date?  — LessWrong" })).toBe("title: What's the date?  — LessWrong\n");
    expect(set('title: Old\n', { title: '' })).toBe("title: ''\n");
    expect(set('title: Old\n', { title: '#hashtag' })).toBe("title: '#hashtag'\n");
    expect(set('title: Old\n', { title: 'true' })).toBe("title: 'true'\n");
    expect(set('title: Old\n', { title: '1984' })).toBe("title: '1984'\n");
    expect(set('title: Old\n', { title: ' padded ' })).toBe("title: ' padded '\n");
    expect(set('title: Old\n', { title: '"I\'ll be there" she said' })).toBe("title: '\"I''ll be there\" she said'\n");
  });

  it('quotes strings the site parser (js-yaml) would read as a date or number — except in date fields', () => {
    expect(set('title: Old\n', { title: '2026-01-31' })).toBe("title: '2026-01-31'\n");
    expect(set('title: Old\n', { title: '0b101' })).toBe("title: '0b101'\n");
    expect(set('title: Old\n', { title: '1_000' })).toBe("title: '1_000'\n");
    expect(set('created: 2026-04-22T12:00:00+00:00\n', { created: '2026-05-01T08:15:00+00:00' })).toBe('created: 2026-05-01T08:15:00+00:00\n');
    expect(set('created: 2025-12-11T11:13:00Z\n', { created: '2025-12-12T11:13:00Z' })).toBe('created: 2025-12-12T11:13:00Z\n');
    expect(set('created: 2026-09-03\n', { created: '2026-09-04' })).toBe('created: 2026-09-04\n');
    expect(set('created: "2026-09-03"\n', { created: '2026-09-04' })).toBe('created: "2026-09-04"\n');
  });

  it('booleans, numbers and null', () => {
    expect(set('is_draft: false\n', { is_draft: true })).toBe('is_draft: true\n');
    expect(set('cost_bps: 5\n', { cost_bps: 7.5 })).toBe('cost_bps: 7.5\n');
    expect(set('exif: null\n', { exif: { camera: 'X100' } })).toBe('exif:\n  camera: X100\n');
    expect(set("taken_at: ''\n", { taken_at: null })).toBe('taken_at: null\n');
    expect(set('exif:\n  camera: X100\n  iso: 200\nnext: 1\n', { exif: null })).toBe('exif: null\nnext: 1\n');
  });

  it('fills an empty value in place', () => {
    expect(set('title:\nslug: a\n', { title: 'T' })).toBe('title: T\nslug: a\n');
    expect(set('title:   # todo\nslug: a\n', { title: 'T' })).toBe('title: T   # todo\nslug: a\n');
    expect(set('title: \nslug: a\n', { title: 'T' })).toBe('title: T \nslug: a\n');
  });

  it('a value written on the next line is replaced where it stands', () => {
    expect(set('title:\n  Old text\nslug: a\n', { title: 'New' })).toBe('title:\n  New\nslug: a\n');
  });

  it('multi-line text becomes a block scalar; back to one line it collapses', () => {
    const multi = set('excerpt: One line\nslug: a\n', { excerpt: 'First\nSecond' });
    expect(multi).toBe('excerpt: |-\n  First\n  Second\nslug: a\n');
    expect(set(multi, { excerpt: 'Single again' })).toBe('excerpt: Single again\nslug: a\n');
    expect(set('excerpt: |\n  a\n  b\nslug: a\n', { excerpt: 'x\ny\n' })).toBe('excerpt: |\n  x\n  y\nslug: a\n');
  });

  it('folded and multi-line quoted scalars are rewritten whole, neighbours untouched', () => {
    expect(set('a: 1\ntext: >-\n  one\n  two\n\nb: 2\n', { text: 'short' })).toBe('a: 1\ntext: short\n\nb: 2\n');
    expect(set("a: 1\ntext: 'multi\n  line'\nb: 2\n", { text: 'short' })).toBe("a: 1\ntext: 'short'\nb: 2\n");
  });
});

describe('patch: lists and maps', () => {
  it('flow lists stay flow, with their padding', () => {
    expect(set('tags: [research, academia]\n', { tags: ['research', 'academia', 'ml'] })).toBe('tags: [research, academia, ml]\n');
    // The comment after the list belongs to the line, not to the value: it stays (review finding).
    expect(set('tags: [ a, b ]   # c\nx: 1\n', { tags: ['b'] })).toBe('tags: [ b ]   # c\nx: 1\n');
    expect(set('tags: [a, b] # c\nslug: a\n', { tags: ['a', 'b', 'c'] })).toBe('tags: [a, b, c] # c\nslug: a\n');
    expect(set('tags: [a, b] # c\n', { tags: [] })).toBe('tags: [] # c\n');
    expect(set('legs: { a: 1, b: 2 } # keep\n', { legs: { a: 1, b: 3 } })).toBe('legs: { a: 1, b: 3 } # keep\n');
    expect(set('tags: [a]\n', { tags: [] })).toBe('tags: []\n');
  });

  it('block lists stay block, with their indentation', () => {
    expect(set('tags:\n  - ai\n  - ml\nx: 1\n', { tags: ['ai', 'ml', 'new: tag'] })).toBe("tags:\n  - ai\n  - ml\n  - 'new: tag'\nx: 1\n");
    expect(set('tags:\n- ai\n- ml\nx: 1\n', { tags: ['ml', 'ai', 'z'] })).toBe('tags:\n- ml\n- ai\n- z\nx: 1\n');
    expect(set('tags:\n    - ai\nx: 1\n', { tags: ['ai', 'z'] })).toBe('tags:\n    - ai\n    - z\nx: 1\n');
  });

  it('an empty list grows in Sveltia\'s block style; a list emptied becomes []', () => {
    expect(set('tags: []\nis_draft: false\n', { tags: ['ai'] })).toBe('tags:\n  - ai\nis_draft: false\n');
    expect(set('tags:\n  - ai\nis_draft: false\n', { tags: [] })).toBe('tags: []\nis_draft: false\n');
    expect(set('tags:\nis_draft: false\n', { tags: ['ai'] })).toBe('tags:\n  - ai\nis_draft: false\n');
  });

  it('unchanged items keep their quoting and comments', () => {
    const src = "tags:\n  - 'quoted'\n  - \"dq\"   # why\n  - plain\n";
    expect(set(src, { tags: ['quoted', 'dq', 'plain', 'more'] })).toBe("tags:\n  - 'quoted'\n  - \"dq\" # why\n  - plain\n  - more\n");
  });

  it('nested structures: unchanged entries keep number formats', () => {
    const src = 'legs:\n  - ticker: KO\n    weight: 0.000\n  - ticker: NET\n    weight: 0.230\nmove: open\n';
    const out = set(src, {
      legs: [
        { ticker: 'KO', weight: 0 },
        { ticker: 'NET', weight: 0.23 },
        { ticker: 'UBER', weight: 0.12 },
      ],
    });
    expect(out).toBe('legs:\n  - ticker: KO\n    weight: 0.000\n  - ticker: NET\n    weight: 0.230\n  - ticker: UBER\n    weight: 0.12\nmove: open\n');
  });

  it('a gallery in Sveltia style gains an entry in the same style', () => {
    const src = "gallery:\n  - image: g/a.png\n    alt: First\n    caption: ''\ntitle: ''\n";
    const out = set(src, {
      gallery: [
        { image: 'g/a.png', alt: 'First', caption: '' },
        { image: 'g/b.png', alt: 'Second: the sequel', caption: '' },
      ],
    });
    expect(out).toBe("gallery:\n  - image: g/a.png\n    alt: First\n    caption: ''\n  - image: g/b.png\n    alt: 'Second: the sequel'\n    caption: ''\ntitle: ''\n");
  });
});

describe('patch: adding and removing keys', () => {
  const order = writeOrder('entries'); // slug title created tags is_draft series card_image excerpt extra_head_html

  it('a new key goes after the nearest preceding key of Sveltia\'s order', () => {
    const src = 'slug: a\ntitle: T\ncreated: 2026-01-01T00:00:00+00:00\ntags: []\nis_draft: false\n';
    expect(set(src, { series: 's' }, order)).toBe(src + 'series: s\n');
    expect(set(src, { excerpt: 'E' }, order)).toBe(src + 'excerpt: E\n');
    const noTitle = 'slug: a\ncreated: 2026-01-01T00:00:00+00:00\n';
    expect(set(noTitle, { title: 'T' }, order)).toBe('slug: a\ntitle: T\ncreated: 2026-01-01T00:00:00+00:00\n');
  });

  it('skips over absent neighbours and lists that span lines', () => {
    const src = 'slug: a\ntags:\n  - x\n  - y\nexcerpt: E\n';
    expect(set(src, { is_draft: true }, order)).toBe('slug: a\ntags:\n  - x\n  - y\nis_draft: true\nexcerpt: E\n');
    expect(set(src, { card_image: './a/b.png' }, order)).toBe('slug: a\ntags:\n  - x\n  - y\ncard_image: ./a/b.png\nexcerpt: E\n');
  });

  it('with no preceding key present it goes before the nearest following one', () => {
    expect(set('title: T\nexcerpt: E\n', { slug: 'a' }, order)).toBe('slug: a\ntitle: T\nexcerpt: E\n');
  });

  it('several new keys land in order, even when they anchor on each other', () => {
    const out = set('slug: a\n', { excerpt: 'E', title: 'T', tags: ['x'], series: '', unknown_key: 1 }, order);
    expect(out).toBe("slug: a\ntitle: T\ntags:\n  - x\nseries: ''\nexcerpt: E\nunknown_key: 1\n");
  });

  it('unknown keys, or no order at all, append at the end', () => {
    expect(set('slug: a\ntitle: T\n', { zebra: 'z' }, order)).toBe('slug: a\ntitle: T\nzebra: z\n');
    expect(set('title: T\n', { slug: 'a' })).toBe('title: T\nslug: a\n');
  });

  it('comments and blank lines around other keys are left alone', () => {
    const src = '# header\nslug: a\n\n# about the title\ntitle: T   # inline\n\n# trailer\n';
    expect(set(src, { created: '2026-01-01' }, order)).toBe('# header\nslug: a\n\n# about the title\ntitle: T   # inline\ncreated: 2026-01-01\n\n# trailer\n');
    expect(set(src, { slug: undefined })).toBe('# header\n\n# about the title\ntitle: T   # inline\n\n# trailer\n');
    expect(set(src, { zebra: 1 }, order)).toBe(src + 'zebra: 1\n');
  });

  it('the portfolio legs with their comments survive edits to other keys', () => {
    const src = 'slug: s\ncreated: 2026-09-03\ntitle: Rebalancing\ntags: []\nis_draft: false\nmove: rebalance\nlegs:\n  - ticker: KO\n    weight: 0.000   # was 6.0%\n  - ticker: NET\n    weight: 0.230   # was 15.0%\n';
    const out = set(src, { title: 'Rebalancing KO', conviction: 'high', is_draft: true }, writeOrder('portfolio'));
    expect(out).toBe(src.replace('title: Rebalancing', 'title: Rebalancing KO').replace('is_draft: false', 'is_draft: true').replace('move: rebalance\n', 'move: rebalance\nconviction: high\n'));
  });

  it('removing every key leaves an empty block', () => {
    expect(set('a: 1\nb: 2\n', { a: undefined, b: undefined })).toBe('');
  });

  it('adds to an empty or comment-only block', () => {
    expect(set('', { slug: 'a', title: 'T' }, order)).toBe('slug: a\ntitle: T\n');
    expect(set('# just a comment\n', { slug: 'a' }, order)).toBe('# just a comment\nslug: a\n');
  });

  it('handles a last line without a line break', () => {
    expect(set('slug: a\ntitle: T', { excerpt: 'E', series: 's' }, order)).toBe('slug: a\ntitle: T\nseries: s\nexcerpt: E\n');
    expect(set('slug: a\ntitle: T', { title: 'U' })).toBe('slug: a\ntitle: U');
    expect(set('slug: a\ntitle: T', { title: undefined })).toBe('slug: a\n');
    expect(set('slug: a\ntags: [x]', { tags: ['x', 'y'], zebra: 1 })).toBe('slug: a\ntags: [x, y]\nzebra: 1\n');
  });

  it('mixed add + change + remove in one call', () => {
    const src = "slug: a\ntitle: 'T'\ncreated: 2026-01-01\ntags: [x]\nis_draft: false\n";
    expect(set(src, { title: 'U', created: undefined, series: 's', tags: [] }, order)).toBe("slug: a\ntitle: 'U'\ntags: []\nis_draft: false\nseries: s\n");
  });
});

describe('patch: line endings and indentation', () => {
  it('CRLF blocks stay CRLF, including added lines', () => {
    const src = 'slug: a\r\ntitle: T\r\ntags:\r\n  - x\r\n';
    expect(set(src, { title: 'U' })).toBe('slug: a\r\ntitle: U\r\ntags:\r\n  - x\r\n');
    expect(set(src, { tags: ['x', 'y'] })).toBe('slug: a\r\ntitle: T\r\ntags:\r\n  - x\r\n  - y\r\n');
    expect(set(src, { is_draft: true }, writeOrder('notes'))).toBe(src + 'is_draft: true\r\n');
    expect(set(src, { title: undefined })).toBe('slug: a\r\ntags:\r\n  - x\r\n');
    expect(set(src, { excerpt: 'a\nb' })).toBe(src + 'excerpt: |-\r\n  a\r\n  b\r\n');
  });

  it('an indented mapping keeps its indentation', () => {
    const src = '  slug: a\n  tags:\n    - x\n';
    expect(set(src, { tags: ['x', 'y'], title: 'T' }, writeOrder('notes'))).toBe('  slug: a\n  title: T\n  tags:\n    - x\n    - y\n');
  });
});

describe('patch: contract behaviour on PostParts', () => {
  it('no effective change returns the very same object', () => {
    const p = parts("slug: a\ntitle: ''\ntags:\n  - x\nexif: null\n");
    expect(frontmatter.patch(p, {})).toBe(p);
    expect(frontmatter.patch(p, { slug: 'a', title: '', tags: ['x'], exif: null })).toBe(p);
    expect(frontmatter.patch(p, { missing: undefined })).toBe(p);
  });

  it('distinguishes null, empty string and a missing key', () => {
    const p = parts("title: ''\nexif: null\n");
    expect(frontmatter.patch(p, { title: null }).frontmatter).toBe('title: null\nexif: null\n');
    expect(frontmatter.patch(p, { exif: '' }).frontmatter).toBe("title: ''\nexif: ''\n");
    expect(frontmatter.patch(p, { excerpt: '' }).frontmatter).toBe("title: ''\nexif: null\nexcerpt: ''\n");
  });

  it('only the frontmatter slice changes', () => {
    const p = parts('slug: a\n', 'Body with --- and\n\n---\n\nmore\n');
    const next = frontmatter.patch(p, { slug: 'b' });
    expect(next).toEqual({ ...p, frontmatter: 'slug: b\n' });
    expect(assemblePost(next)).toBe('---\nslug: b\n---\n\nBody with --- and\n\n---\n\nmore\n');
  });

  it('creates the block for a file without frontmatter, using its line ending', () => {
    const lf = frontmatter.split('Just a body\n');
    expect(assemblePost(frontmatter.patch(lf, { slug: 'a', title: 'T' }, 'notes'))).toBe('---\nslug: a\ntitle: T\n---\n\nJust a body\n');
    const crlf = frontmatter.split('Just a body\r\nmore\r\n');
    expect(assemblePost(frontmatter.patch(crlf, { slug: 'a' }))).toBe('---\r\nslug: a\r\n---\r\n\r\nJust a body\r\nmore\r\n');
    const empty = frontmatter.split('');
    expect(assemblePost(frontmatter.patch(empty, { slug: 'a' }))).toBe('---\nslug: a\n---\n');
    const bom = frontmatter.split('﻿Body');
    expect(assemblePost(frontmatter.patch(bom, { slug: 'a' }))).toBe('﻿---\nslug: a\n---\n\nBody');
    expect(frontmatter.patch(lf, { slug: undefined })).toBe(lf);
  });

  it('a patched file still splits into the same slices', () => {
    for (const [path, raw] of posts.slice(0, 20)) {
      const p = frontmatter.split(raw);
      const next = frontmatter.patch(p, { title: 'Round trip', zebra: ['a', 'b'] }, collectionOf(path)!);
      expect(frontmatter.split(assemblePost(next)), path).toEqual(next);
    }
  });
});

describe('patch: refuses rather than damages', () => {
  const refuses = (fm: string, changes: Record<string, FrontmatterValue | undefined>, reason: string) => {
    let error: unknown;
    try {
      patchYaml(fm, changes);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(FrontmatterPatchError);
    expect((error as FrontmatterPatchError).reason).toBe(reason);
  };

  it('invalid YAML', () => {
    refuses('title: "unterminated\nslug: a\n', { slug: 'b' }, 'syntax');
    refuses('a: 1\na: 2\n', { a: 3 }, 'syntax');
    refuses('tags: [a\n', { tags: [] }, 'syntax');
  });

  it('frontmatter that is not a block mapping', () => {
    refuses('{slug: a, title: T}\n', { slug: 'b' }, 'shape');
    refuses('- a\n- b\n', { slug: 'b' }, 'shape');
    refuses('just a string\n', { slug: 'b' }, 'shape');
  });

  it('explicit-key form on the key being edited', () => {
    refuses('? slug\n: a\ntitle: T\n', { slug: 'b' }, 'shape');
    // …but other keys of that document can still be edited.
    expect(set('? slug\n: a\ntitle: T\n', { title: 'U' })).toBe('? slug\n: a\ntitle: U\n');
  });

  it('an anchor that is still referenced', () => {
    refuses('base: &b x\nother: *b\n', { base: undefined }, 'verify');
  });

  it('tagged and anchored values are rewritten whole (tag dropped), aliases resolve or the edit is refused', () => {
    expect(set('a: !!str 123\nb: 1\n', { a: 'x' })).toBe('a: x\nb: 1\n');
    refuses('base: &b x\nother: *b\n', { base: 'y' }, 'verify');
    expect(set('base: &b x\nother: *b\n', { other: 'z' })).toBe('base: &b x\nother: z\n');
  });

  it('through the public API the original parts are untouched when it throws', () => {
    const p = parts('title: "unterminated\n');
    const copy = { ...p };
    expect(() => frontmatter.patch(p, { title: 'x' })).toThrow(FrontmatterPatchError);
    expect(p).toEqual(copy);
  });
});

/** Review finding: `---\rtitle: a\r---\rbody\r` patched to `---\rtitle: b---\rbody\r` (the fence was lost). */
describe('patch: bare CR line endings are refused, never mangled', () => {
  const crFiles = ['---\rtitle: a\r---\rbody\r', '---\rtitle: a\rslug: x\r---\rbody\r', '---\ntitle: a\rslug: x\n---\nbody\n'];

  it.each(crFiles)('%j: a change throws and the parts are untouched', (raw) => {
    const before = frontmatter.split(raw);
    const snapshot = { ...before };
    expect(() => frontmatter.patch(before, { title: 'b' })).toThrow(FrontmatterPatchError);
    expect(() => frontmatter.patch(before, { title: 'b' })).toThrow(/bare CR/);
    expect(() => frontmatter.patch(before, { added: 'x' })).toThrow(FrontmatterPatchError);
    expect(before).toEqual(snapshot);
    expect(assemblePost(before)).toBe(raw);
  });

  it('a change that changes nothing still returns the same object', () => {
    const before = frontmatter.split('---\rtitle: a\r---\rbody\r');
    const same = (() => {
      try {
        return frontmatter.patch(before, {});
      } catch {
        return null;
      }
    })();
    expect(same).toBe(before);
  });

  it('a body-only CR file gets no frontmatter added either', () => {
    const before = frontmatter.split('just\ra body\r');
    expect(() => frontmatter.patch(before, { slug: 'a' })).toThrow(/bare CR/);
  });

  it('CRLF files are unaffected', () => {
    const before = frontmatter.split('---\r\ntitle: a\r\n---\r\nbody\r\n');
    expect(assemblePost(frontmatter.patch(before, { title: 'b' }))).toBe('---\r\ntitle: b\r\n---\r\nbody\r\n');
  });
});
