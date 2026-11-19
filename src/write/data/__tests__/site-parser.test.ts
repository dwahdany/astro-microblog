/**
 * The site reads frontmatter with js-yaml (Astro's parser), this app with the
 * `yaml` package. They disagree on a few plain scalars (`2026-01-01` is a Date
 * to js-yaml, `0b11` a number). Everything this app WRITES must mean the same
 * to both — otherwise a title typed here could break the site's build.
 *
 * js-yaml is not a dependency of the app (and must not become one); it is in
 * node_modules because Astro depends on it. If that ever changes these tests
 * skip rather than fail.
 */
import { describe, expect, it } from 'vitest';
import type { FrontmatterValue } from '../../contracts';
import { frontmatter } from '../frontmatter';
import { collectionOf } from '../paths';
import { patchYaml } from '../yaml-patch';
import { posts } from './content';

const moduleName = 'js-yaml'; // by name, so the type checker does not look for (absent) typings
const jsYaml: { load(text: string): unknown } | null = await import(/* @vite-ignore */ moduleName).then(
  (m) => (m.default ?? m) as { load(text: string): unknown },
  () => null,
);

describe.skipIf(!jsYaml)('what this app writes reads the same in the site parser (js-yaml)', () => {
  const load = (text: string) => jsYaml!.load(text) as Record<string, unknown>;

  const strings = [
    '', ' ', 'plain', 'Two words', '2026-01-01', '2026-1-1', '2026-04-22T12:00:00+00:00', '2026-04-22 12:00:00', '2001-12-14t21:59:43.10-05:00',
    '0b11', '0B11', '1_000', '0x_1F', '0o17', '017', '1__0', '1e3', '.5', '+1', '-0', '.inf', '-.INF', '.NaN', '1:30', '12:30:45', '190:20:30.15',
    'true', 'True', 'FALSE', 'yes', 'No', 'on', 'OFF', 'y', 'n', 'null', 'Null', '~', '<<', '=',
    'a: b', 'a #b', '#hash', '- dash', '? q', '[x]', '{x}', '@at', '`tick', '%pct', '&anchor', '*alias', '!tag', '|pipe', '>gt',
    "it's", '"quoted"', `both ' and "`, 'trailing ', ' leading', 'tab\there', 'colon:', 'colon :x', 'a\\b', 'back\\', 'emoji 😀 — dash',
    'multi\nline', 'multi\n\nline\n', '  indented\nline', 'x'.repeat(300) + ' y', '---', '...', 'key: [a, b]', "'", '"', ',', 'a, b',
    '1,000', '1.5.0', 'v1.2', '2026', '20260101', '1e', 'e3', '0x', '0b', '+', '-', '.', '_', '1_', '_1',
  ];

  it('a string set on a text field comes back as the same string', () => {
    for (const s of strings) {
      const out = patchYaml("title: ''\nslug: a\n", { title: s === '' ? 'x' : s });
      expect(load(out).title, JSON.stringify(s)).toBe(s === '' ? 'x' : s);
      const added = patchYaml('slug: a\n', { excerpt: s });
      expect(load(added).excerpt, JSON.stringify(s)).toBe(s);
      const inList = patchYaml('tags: []\n', { tags: ['first', s] });
      expect((load(inList).tags as unknown[])[1], JSON.stringify(s)).toBe(s);
      const nested = patchYaml('slug: a\n', { exif: { camera: s } });
      expect((load(nested).exif as Record<string, unknown>).camera, JSON.stringify(s)).toBe(s);
    }
  });

  it('existing quote styles are kept and still read correctly', () => {
    for (const s of strings.filter((x) => !x.includes('\n'))) {
      expect(load(patchYaml('title: "x"\n', { title: s })).title, JSON.stringify(s)).toBe(s);
      if (s !== 'x') expect(load(patchYaml("title: 'x'\n", { title: s })).title, JSON.stringify(s)).toBe(s);
    }
  });

  it('non-strings keep their type; dates in date fields become dates for the site', () => {
    const out = patchYaml('slug: a\n', { is_draft: true, cost_bps: 7.5, exif: null, tags: [], created: '2026-04-22T12:00:00+00:00', count: 3 });
    const data = load(out);
    expect(data).toMatchObject({ is_draft: true, cost_bps: 7.5, exif: null, tags: [], count: 3 });
    expect(data.created).toBeInstanceOf(Date);
    expect((data.created as Date).toISOString()).toBe('2026-04-22T12:00:00.000Z');
    expect(load(patchYaml('created: 2026-09-03\n', { created: '2026-09-04' })).created).toBeInstanceOf(Date);
  });

  it('both parsers agree on every real post, before and after an edit', () => {
    const normal = (v: unknown): unknown =>
      v instanceof Date ? v.getTime() : Array.isArray(v) ? v.map(normal) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normal(x)])) : v;
    const viaCore = (data: Record<string, unknown>) =>
      normal(Object.fromEntries(Object.entries(data).map(([k, v]) => [k, (k === 'created' || k === 'taken_at') && typeof v === 'string' && v !== '' ? new Date(v) : v])));
    const legDates = (v: unknown): unknown => v; // legs carry no dates in the current files

    for (const [path, raw] of posts) {
      const parts = frontmatter.split(raw);
      const before = frontmatter.parse(parts.frontmatter).data;
      expect(normal(load(parts.frontmatter)), path).toEqual(legDates(viaCore(before)));

      const edited = frontmatter.patch(parts, { title: '2026-01-01', tags: ['1984', 'ok'], extra: 'a: b' } as Record<string, FrontmatterValue>, collectionOf(path)!);
      const after = load(edited.frontmatter);
      expect(after.title, path).toBe('2026-01-01');
      expect(after.tags, path).toEqual(['1984', 'ok']);
      expect(after.extra, path).toBe('a: b');
      expect(normal(after), path).toEqual(viaCore(frontmatter.parse(edited.frontmatter).data));
    }
  });
});
