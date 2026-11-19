/**
 * New-post scaffolding: the file Sveltia would create for a collection.
 *
 * Shape, taken from public/admin/config.yml and the CMS-written files in
 * src/content (e.g. notes/2026/disksurvey.md, blogmarks/2026/what-s-the-date-lesswrong.md,
 * quotations/2026/fable-fable.md, entries/2026/research-with-ai.md):
 *
 *   ---
 *   slug: my-note
 *   title: ''
 *   created: 2026-11-18T09:30:00+00:00
 *   tags: []
 *   is_draft: true
 *   ---
 *   <blank line>
 *   <body>
 *
 * Every key of the CMS collection is written, in config.yml order, empty ones
 * in their empty form (`''`, `[]`). `created` is "now" in UTC with seconds
 * zeroed. The one deliberate difference from Sveltia: `is_draft: true`
 * (Sveltia's default is false) — required by the contract, because this tool
 * is meant to commit straight to `main` later.
 */
import {
  assemblePost,
  type CreatableCollection,
  type FrontmatterValue,
  type LoadedPost,
  type PostParts,
  type ScaffoldInit,
} from '../contracts';
import { sveltiaTimestamp } from './dates';
import { describe, pathFor, slugify } from './describe';
import { fieldDef, scaffoldKeys, writeOrder } from './fields';
import { patchYaml } from './yaml-patch';
import { eol } from './split';
import { renderMapping } from './yaml-render';

function uuid(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // Non-secure contexts (http://192.168.x.x during phone testing) have no randomUUID.
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const text = (v: FrontmatterValue | undefined): string => (typeof v === 'string' ? v.trim() : '');

export function scaffold(collection: CreatableCollection, init: ScaffoldInit = {}): LoadedPost {
  const now = init.now ?? new Date();
  const id = uuid();

  const values: Record<string, FrontmatterValue> = {};
  for (const [key, value] of Object.entries(init.values ?? {})) if (value !== undefined) values[key] = value;
  if (text(values.created) === '') values.created = sveltiaTimestamp(now);
  if (values.is_draft === undefined) values.is_draft = true;
  if (text(values.slug) === '') {
    const seed = text(values.title) || text(values.link_title) || text(values.source);
    values.slug = slugify(seed) || `untitled-${id.slice(0, 6)}`;
  }

  const keys = scaffoldKeys(collection);
  const entries = keys.map(
    (key) => [key, key in values ? values[key] : (fieldDef(collection, key)?.default ?? '')] as const,
  );
  let frontmatter = renderMapping(entries);

  // Initial values for keys Sveltia would not write (e.g. `excerpt` on a note) go where patch would put them.
  const extra = Object.fromEntries(Object.entries(values).filter(([key]) => !keys.includes(key)));
  if (Object.keys(extra).length > 0) frontmatter = patchYaml(frontmatter, extra, { order: writeOrder(collection) });

  const parts: PostParts = {
    bom: '',
    open: '---\n',
    frontmatter,
    close: '---\n',
    gap: '\n',
    body: init.body ?? '',
  };
  const raw = assemblePost(parts);
  const path = pathFor(collection, String(values.slug), String(values.created));
  return {
    ref: describe(path, raw, { id: `new:${collection}:${id}`, isNew: true }),
    raw,
    parts,
    eol: eol(raw),
  };
}
