import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';
import { COLLECTIONS, CORE_FIELD_KEYS, CREATABLE_COLLECTIONS, type CollectionKind } from '../../contracts';
import { emptyValueFor, fieldDef, fieldDefs, scaffoldKeys, validate, writeOrder } from '../fields';
import { frontmatter } from '../frontmatter';
import { collectionOf } from '../paths';
import { posts } from './content';

interface CmsField {
  name: string;
  label: string;
  widget: string;
  required?: boolean;
  default?: unknown;
  hint?: string;
}
const cms = parseYaml(readFileSync('public/admin/config.yml', 'utf8')) as {
  collections: { name: string; path?: string; fields: CmsField[] }[];
};
const cmsFields = (name: string) => cms.collections.find((c) => c.name === name)!.fields.filter((f) => f.name !== 'body');

describe('field tables follow public/admin/config.yml', () => {
  const inCms = cms.collections.map((c) => c.name);

  it('covers the CMS collections (portfolio is file-only)', () => {
    expect(inCms.sort()).toEqual(COLLECTIONS.filter((c) => c !== 'portfolio').sort());
  });

  it.each(cms.collections.map((c) => c.name))('%s: the keys Sveltia writes, in its order', (name) => {
    const collection = name as CollectionKind;
    expect(scaffoldKeys(collection)).toEqual(cmsFields(name).map((f) => f.name));
    // Write order starts with the CMS keys; schema-only keys follow.
    expect(writeOrder(collection).slice(0, scaffoldKeys(collection).length)).toEqual(scaffoldKeys(collection));
  });

  it.each(cms.collections.map((c) => c.name))('%s: defaults and optional flags match', (name) => {
    const collection = name as CollectionKind;
    for (const f of cmsFields(name)) {
      const d = fieldDef(collection, f.name)!;
      expect(d.cms, f.name).toBe(true);
      // Anything Sveltia marks optional is optional here too.
      if (f.required === false) expect(d.required, f.name).toBe(false);
      if (f.name === 'tags') expect(d.default).toEqual(f.default);
      if (f.name === 'is_draft') expect(d.default).toBe(f.default);
    }
  });

  it('the creatable collections use the {{year}}/{{slug}} path', () => {
    for (const c of CREATABLE_COLLECTIONS) expect(cms.collections.find((x) => x.name === c)!.path).toBe('{{year}}/{{slug}}');
  });
});

describe('fields()', () => {
  it.each(COLLECTIONS)('%s: core keys lead in display order, then collection, then advanced', (collection) => {
    const defs = frontmatter.fields(collection);
    const groups = defs.map((d) => d.group);
    expect([...groups].sort((a, b) => 'core collection advanced'.indexOf(a) - 'core collection advanced'.indexOf(b))).toEqual(groups);
    const core = defs.filter((d) => d.group === 'core').map((d) => d.key);
    expect(core).toEqual(CORE_FIELD_KEYS.filter((k) => core.includes(k)));
    expect(new Set(defs.map((d) => d.key)).size).toBe(defs.length);
    expect([...defs.map((d) => d.key)].sort()).toEqual([...writeOrder(collection)].sort());
    for (const d of defs) {
      expect(d.label).not.toBe('');
      if (d.kind === 'select') expect(d.options?.length).toBeGreaterThan(0);
    }
  });

  it('quotations have no title; every collection has slug and created as required', () => {
    expect(fieldDef('quotations', 'title')).toBeUndefined();
    for (const c of COLLECTIONS) {
      expect(fieldDef(c, 'slug')?.required).toBe(true);
      expect(fieldDef(c, 'created')?.required).toBe(true);
    }
    expect(fieldDef('portfolio', 'created')?.kind).toBe('date');
    expect(fieldDef('entries', 'created')?.kind).toBe('datetime');
  });

  it('every key used by a real post is a known field of its collection', () => {
    const unknown: string[] = [];
    for (const [path, raw] of posts) {
      const collection = collectionOf(path)!;
      for (const key of frontmatter.parse(frontmatter.split(raw).frontmatter).keys)
        if (!fieldDef(collection, key)) unknown.push(`${path}: ${key}`);
    }
    expect(unknown).toEqual([]);
  });

  it('emptyValueFor mirrors what Sveltia leaves behind for an emptied field', () => {
    expect(emptyValueFor('notes', 'title')).toBe('');
    expect(emptyValueFor('notes', 'tags')).toEqual([]);
    expect(emptyValueFor('blogmarks', 'via_url')).toBe('');
    expect(emptyValueFor('photos', 'exif')).toBeNull();
    expect(emptyValueFor('photos', 'gallery')).toEqual([]);
    expect(emptyValueFor('entries', 'card_image')).toBe('');
    // Keys the CMS does not manage are removed instead.
    expect(emptyValueFor('notes', 'excerpt')).toBeUndefined();
    expect(emptyValueFor('entries', 'extra_head_html')).toBeUndefined();
    expect(emptyValueFor('portfolio', 'conviction')).toBeUndefined();
    expect(emptyValueFor('notes', 'nonsense')).toBeUndefined();
  });
});

describe('validate', () => {
  it('finds nothing wrong with any published post', () => {
    for (const [path, raw] of posts) {
      const { data } = frontmatter.parse(frontmatter.split(raw).frontmatter);
      expect(validate(collectionOf(path)!, data), path).toEqual([]);
    }
  });

  const keysOf = (c: CollectionKind, data: Record<string, unknown>) => validate(c, data).map((i) => i.key);
  const ok = { slug: 'a-post', created: '2026-01-31T09:30:00+00:00' };

  it('required keys per collection', () => {
    expect(keysOf('entries', {})).toEqual(['title', 'slug', 'created']);
    expect(keysOf('notes', {})).toEqual(['slug', 'created']);
    expect(keysOf('blogmarks', {})).toEqual(['slug', 'created', 'link_url', 'link_title']);
    expect(keysOf('quotations', {})).toEqual(['slug', 'created', 'source']);
    expect(keysOf('photos', {})).toEqual(['slug', 'created', 'photo', 'alt']);
    expect(keysOf('series', {})).toEqual(['title', 'slug', 'created', 'summary']);
    expect(keysOf('portfolio', {})).toEqual(['title', 'slug', 'created']);
    expect(keysOf('entries', { ...ok, title: '' })).toEqual(['title']);
    expect(keysOf('entries', { ...ok, title: null })).toEqual(['title']);
    expect(keysOf('notes', { ...ok, title: '' })).toEqual([]);
  });

  it('slug pattern', () => {
    for (const slug of ['My-Post', 'a--b', '-a', 'a-', 'a b', 'ä', 'a_b', 'a/b']) expect(keysOf('notes', { ...ok, slug }), slug).toEqual(['slug']);
    for (const slug of ['a', 'a-b', 'what-s-the-date-lesswrong', '2026', 'a1-2b']) expect(keysOf('notes', { ...ok, slug }), slug).toEqual([]);
    expect(keysOf('notes', { ...ok, slug: 2026 })).toEqual(['slug']);
  });

  it('URL fields', () => {
    const bm = { ...ok, link_title: 'T' };
    expect(keysOf('blogmarks', { ...bm, link_url: 'https://example.com/a?b=c' })).toEqual([]);
    expect(keysOf('blogmarks', { ...bm, link_url: 'example.com' })).toEqual(['link_url']);
    expect(keysOf('blogmarks', { ...bm, link_url: '/relative' })).toEqual(['link_url']);
    expect(keysOf('blogmarks', { ...bm, link_url: 'https://e.com', via_url: '' })).toEqual([]);
    expect(keysOf('blogmarks', { ...bm, link_url: 'https://e.com', via_url: 'nope' })).toEqual(['via_url']);
    expect(keysOf('quotations', { ...ok, source: 'S', source_url: 'not a url' })).toEqual(['source_url']);
    expect(validate('blogmarks', { ...bm, link_url: 'example.com' })[0].message).toMatch(/https:\/\//);
  });

  it('dates', () => {
    for (const created of ['2026-01-31', '2026-01-31T09:30:00+00:00', '2025-12-11T11:13:00Z'])
      expect(keysOf('notes', { slug: 'a', created }), created).toEqual([]);
    for (const created of ['tomorrow', '2026-13-45', '31.01.2026 25:00', true, ['x']])
      expect(keysOf('notes', { slug: 'a', created }), String(created)).toEqual(['created']);
    expect(keysOf('photos', { ...ok, photo: 'a/b.png', alt: 'x', taken_at: '' })).toEqual([]);
    expect(keysOf('photos', { ...ok, photo: 'a/b.png', alt: 'x', taken_at: 'nope' })).toEqual(['taken_at']);
  });

  it('types the content schema would reject', () => {
    expect(keysOf('entries', { ...ok, title: 1984 })).toEqual(['title']);
    expect(keysOf('notes', { ...ok, tags: 'ai' })).toEqual(['tags']);
    expect(keysOf('notes', { ...ok, tags: ['ai', 3] })).toEqual(['tags']);
    expect(keysOf('notes', { ...ok, tags: ['ai', ' '] })).toEqual(['tags']);
    expect(keysOf('notes', { ...ok, is_draft: 'yes' })).toEqual(['is_draft']);
    expect(keysOf('portfolio', { ...ok, title: 'T', move: 'yolo' })).toEqual(['move']);
    expect(keysOf('portfolio', { ...ok, title: 'T', move: 'add', conviction: 'high', cost_bps: 5 })).toEqual([]);
    expect(keysOf('portfolio', { ...ok, title: 'T', cost_bps: -1 })).toEqual(['cost_bps']);
    expect(keysOf('portfolio', { ...ok, title: 'T', cost_bps: '5' })).toEqual(['cost_bps']);
  });

  it('messages name the field and say what to do', () => {
    const [issue] = validate('entries', { ...ok });
    expect(issue).toEqual({ key: 'title', message: 'Title is required.' });
  });
});
