/**
 * Foundation invariants. These pin the contract, not a particular
 * implementation — they must keep passing whatever the implementation behind the entry points is.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COLLECTIONS,
  CREATABLE_COLLECTIONS,
  SLUG_PATTERN,
  THEME_IDS,
  THEME_TOKENS,
  assemblePost,
} from '../../src/write/contracts';
import { frontmatter } from '../../src/write/data/frontmatter';
import { isPostPath } from '../../src/write/data/paths';

// Every markdown file in the working tree, exactly as on disk.
const files = import.meta.glob<string>('/src/content/**/*.md', { query: '?raw', import: 'default', eager: true });
const posts = Object.entries(files).map(([key, raw]) => [key.slice(1), raw] as const);

describe('the markdown text is the only source of truth', () => {
  it('finds the content files', () => {
    expect(posts.length).toBeGreaterThan(50);
  });

  it('?raw gives the bytes on disk', () => {
    for (const [path, raw] of posts) expect(raw, path).toBe(readFileSync(path, 'utf8'));
  });

  it('split → assemble is byte-identical for every post', () => {
    for (const [path, raw] of posts) expect(assemblePost(frontmatter.split(raw)), path).toBe(raw);
  });

  it('split isolates a parseable frontmatter and a body that does not start with a blank line', () => {
    for (const [path, raw] of posts.filter(([p]) => isPostPath(p))) {
      const parts = frontmatter.split(raw);
      expect(parts.open, path).toBe('---\n');
      expect(parts.close, path).toBe('---\n');
      expect(frontmatter.parse(parts.frontmatter).issues, path).toEqual([]);
      expect(/^[ \t]*\r?\n/.test(parts.body), path).toBe(false);
    }
  });

  it.each([
    ['', 'empty'],
    ['just text\n', 'no frontmatter'],
    ['---\n', 'lone fence'],
    ['---\nslug: a\n', 'unterminated frontmatter'],
    ['---\n---\n', 'empty frontmatter'],
    ['---\nslug: a\n---', 'no newline after closing fence'],
    ['---\r\nslug: a\r\n---\r\n\r\nBody\r\n', 'CRLF'],
    ['﻿---\nslug: a\n---\nBody', 'BOM'],
    ['---\nslug: a\n---\n\n\n\nBody\n\n---\n\nmore\n', 'thematic break in body'],
    ['---\nslug: a\n--- \n \n\t\nBody', 'whitespace on fence and gap lines'],
  ])('split → assemble round-trips %j (%s)', (raw) => {
    expect(assemblePost(frontmatter.split(raw))).toBe(raw);
  });

  it('a patch that changes nothing returns the very same slices', () => {
    for (const [path, raw] of posts.filter(([p]) => isPostPath(p))) {
      const parts = frontmatter.split(raw);
      const { data } = frontmatter.parse(parts.frontmatter);
      const same = Object.fromEntries(Object.entries(data).filter(([, v]) => typeof v !== 'object' || v === null || Array.isArray(v)));
      expect(frontmatter.patch(parts, same as never), path).toBe(parts);
    }
  });
});

describe('describe', () => {
  it('gives every published post a title, slug and collection', () => {
    for (const [path, raw] of posts.filter(([p]) => isPostPath(p))) {
      const ref = frontmatter.describe(path, raw);
      expect(ref.id, path).toBe(path);
      expect(COLLECTIONS, path).toContain(ref.collection);
      expect(ref.title, path).not.toBe('');
      expect(ref.slug, path).not.toBe('');
      expect(ref.createdMs, path).not.toBeNull();
    }
  });

  it('skips files the site loader ignores', () => {
    expect(isPostPath('src/content/portfolio/_README.md')).toBe(false);
    expect(isPostPath('src/content/portfolio/2026/opening-spgi-2026-08-04.md')).toBe(true);
    expect(isPostPath('src/content/notes/2025/new-blog/IMG_6328.jpeg')).toBe(false);
  });
});

describe('scaffold', () => {
  it.each(CREATABLE_COLLECTIONS)('%s: a new post is a valid, self-consistent file', (collection) => {
    const post = frontmatter.scaffold(collection, { now: new Date('2026-11-18T09:30:12Z'), values: { title: 'Héllo, Wörld!' } });
    expect(assemblePost(post.parts)).toBe(post.raw);
    expect(assemblePost(frontmatter.split(post.raw))).toBe(post.raw);
    const { data, issues } = frontmatter.parse(post.parts.frontmatter);
    expect(issues).toEqual([]);
    expect(data.created).toBe('2026-11-18T09:30:00+00:00');
    expect(String(data.slug)).toMatch(SLUG_PATTERN);
    expect(post.ref.isNew).toBe(true);
    expect(post.ref.id).toMatch(new RegExp(`^new:${collection}:`));
    expect(post.ref.path).toBe(`src/content/${collection}/2026/${data.slug}.md`);
  });
});

describe('themes', () => {
  it.each(THEME_IDS)('%s defines every token exactly once', (id) => {
    const css = readFileSync(`src/write/theme/${id}.css`, 'utf8');
    const shared = readFileSync('src/write/theme/tokens.css', 'utf8');
    for (const token of THEME_TOKENS) {
      const inTheme = css.match(new RegExp(`^\\s*${token}:`, 'gm'))?.length ?? 0;
      const inShared = shared.match(new RegExp(`^\\s*${token}:`, 'gm'))?.length ?? 0;
      expect(inTheme + inShared, `${token} in ${id}`).toBeGreaterThanOrEqual(1);
      expect(inTheme, `${token} defined twice in ${id}`).toBeLessThanOrEqual(1);
    }
  });

  it('themes define no token the contract does not know', () => {
    for (const id of THEME_IDS) {
      const css = readFileSync(`src/write/theme/${id}.css`, 'utf8');
      const defined = [...css.matchAll(/^\s*(--w-[a-z0-9-]+):/gm)].map((m) => m[1]);
      for (const name of defined) expect(THEME_TOKENS as readonly string[], `${name} in ${id}`).toContain(name);
    }
  });
});
