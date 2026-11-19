/**
 * The two site plugins that are ported rather than imported are pinned here:
 * each test runs the SITE's file (src/plugins/…) and the port over the same
 * input and requires identical trees. If the site plugin changes, this fails
 * and the port has to follow.
 *
 * The site files are loaded through a computed specifier on purpose: they are
 * outside this app's type-check scope (and one uses node:fs).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Element, Root } from 'hast';
import { LINKABLE_COLLECTIONS, targetFromFile, type LinkTarget } from '../link-targets';
import { rehypeImageSize, rehypeInternalLinks } from '../plugins';

const repo = join(import.meta.dirname, '../../../..');
const sitePlugin = (name: string) => import(/* @vite-ignore */ join(repo, 'src/plugins', `${name}.ts`));

const img = (alt: unknown, extra: Record<string, unknown> = {}): Element => ({
  type: 'element',
  tagName: 'img',
  properties: { src: 'a.png', alt, ...extra } as Element['properties'],
  children: [],
});
const tree = (...children: Element[]): Root => ({ type: 'root', children });

describe('rehypeImageSize is the same as src/plugins/rehype-image-size.ts', () => {
  const cases: Element[] = [
    img('A diagram|small'),
    img('|medium'),
    img('x|full'),
    img('x|large'),
    img('no suffix'),
    img(''),
    img(undefined),
    img('pipe | in the middle|small '),
    img('x|small', { className: ['existing'] }),
    img('x|small', { class: 'existing' }),
    { type: 'element', tagName: 'p', properties: {}, children: [img('nested|medium')] },
  ];

  it('produces identical trees for every case', async () => {
    const { rehypeImageSize: site } = await sitePlugin('rehype-image-size');
    for (const node of cases) {
      const a = tree(structuredClone(node));
      const b = tree(structuredClone(node));
      site()(a);
      rehypeImageSize()(b);
      expect(b, JSON.stringify(node.properties)).toEqual(a);
    }
  });
});

describe('rehypeInternalLinks is the same as src/plugins/rehype-internal-link-preview.ts', () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : name.endsWith('.md') ? [full] : [];
    });
  }

  /** Card data for every linkable post, derived the way Preview.svelte does (core-schema YAML, body after the fence). */
  const targets: LinkTarget[] = [];
  for (const collection of LINKABLE_COLLECTIONS) {
    for (const file of walk(join(repo, 'src/content', collection))) {
      const raw = readFileSync(file, 'utf8');
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
      if (!match) continue;
      const data = (parseYaml(match[1], { schema: 'core' }) ?? {}) as Record<string, unknown>;
      const target = targetFromFile(collection, data, raw.slice(match[0].length));
      if (target) targets.push(target);
    }
  }
  const bySlug = new Map<string, LinkTarget>();
  for (const target of targets) if (!bySlug.has(target.slug)) bySlug.set(target.slug, target);

  const paragraphLinkingTo = (target: LinkTarget): Root =>
    tree(
      {
        type: 'element',
        tagName: 'p',
        properties: {},
        children: [
          { type: 'text', value: 'See ' },
          {
            type: 'element',
            tagName: 'a',
            properties: { href: `https://blog.wahdany.eu${target.url}` },
            children: [{ type: 'text', value: 'this' }],
          },
        ],
      },
      { type: 'element', tagName: 'p', properties: {}, children: [{ type: 'text', value: 'after' }] },
    );

  /** hast allows class names as a string or a list; compare what would be serialised. */
  function normalise(node: unknown): unknown {
    return JSON.parse(
      JSON.stringify(node, (key, value) => (key === 'className' && Array.isArray(value) ? value.join(' ') : value)),
    );
  }

  it('found posts to compare', () => {
    expect(targets.length).toBeGreaterThan(40);
  });

  it('builds the same card as the site for every linkable post in src/content', async () => {
    const { rehypeInternalLinkPreview: site } = await sitePlugin('rehype-internal-link-preview');
    const previousTz = process.env.TZ;
    // The site formats card dates in the build machine's zone; production builds in UTC.
    process.env.TZ = 'UTC';
    try {
      const siteTransform = site();
      const portTransform = rehypeInternalLinks((slug) => bySlug.get(slug));
      let cards = 0;
      for (const target of bySlug.values()) {
        const a = paragraphLinkingTo(target);
        const b = paragraphLinkingTo(target);
        siteTransform(a);
        portTransform(b);
        expect(normalise(b), target.slug).toEqual(normalise(a));
        if (a.children.length === 3) cards++;
      }
      expect(cards).toBe(bySlug.size);
    } finally {
      process.env.TZ = previousTz;
    }
  });

  it('agrees with the site on what is not an internal link', async () => {
    const { rehypeInternalLinkPreview: site } = await sitePlugin('rehype-internal-link-preview');
    for (const href of [
      'https://blog.wahdany.eu/2025/Oct/6/no-such-post/',
      'https://blog.wahdany.eu/ai-everything/',
      'https://example.com/2025/Oct/6/bubbles/',
      '/2025/Oct/6/bubbles/',
    ]) {
      const make = () =>
        tree({
          type: 'element',
          tagName: 'p',
          properties: {},
          children: [{ type: 'element', tagName: 'a', properties: { href }, children: [] }],
        });
      const a = make();
      const b = make();
      site()(a);
      rehypeInternalLinks((slug) => bySlug.get(slug))(b);
      expect(normalise(b), href).toEqual(normalise(a));
      expect(a.children).toHaveLength(1);
    }
  });
});
