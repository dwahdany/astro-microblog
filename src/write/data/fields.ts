/**
 * Field definitions per collection, for the properties sheet, for placing new
 * keys, for scaffolding and for validation.
 *
 * Sources of truth, transcribed by hand (there is no runtime link):
 *   - public/admin/config.yml  → labels, hints, which keys Sveltia writes and
 *     in which order, their defaults and "required" flags;
 *   - src/content.config.ts    → what the site's build actually enforces
 *     (zod): required keys, URL fields, enums, plus keys the CMS does not know
 *     (`extra_head_html`, `card_image`/`excerpt` on every collection, all of
 *     `portfolio`).
 * If either file changes, update the tables below; __tests__/fields.test.ts
 * re-reads config.yml and fails when the key order drifts.
 */
import {
  CORE_FIELD_KEYS,
  SLUG_PATTERN,
  type CollectionKind,
  type FieldSpec,
  type FrontmatterIssue,
  type FrontmatterValue,
} from '../contracts';

/** `FieldSpec` plus what the data layer knows beyond the shared contract. */
export interface FieldDef extends FieldSpec {
  /** True when public/admin/config.yml has this field (Sveltia writes the key even when empty). */
  cms: boolean;
}

type Row = Omit<FieldDef, 'group' | 'required' | 'cms'> & Partial<Pick<FieldDef, 'group' | 'required' | 'cms'>>;

const def = (row: Row): FieldDef => ({ group: 'collection', required: false, cms: true, ...row });

const SLUG = def({
  key: 'slug',
  label: 'Slug',
  kind: 'slug',
  required: true,
  group: 'core',
  hint: 'Lowercase letters, numbers and hyphens. Becomes the URL and the file name.',
  placeholder: 'my-post',
});
const CREATED = def({
  key: 'created',
  label: 'Created',
  kind: 'datetime',
  required: true,
  group: 'core',
  hint: 'Publication time (UTC in the file).',
});
const TAGS = def({ key: 'tags', label: 'Tags', kind: 'tags', group: 'core', default: [], placeholder: 'Add a tag' });
const DRAFT = def({
  key: 'is_draft',
  label: 'Draft',
  kind: 'boolean',
  group: 'core',
  default: false,
  hint: 'Drafts are not published.',
});
const title = (required: boolean, hint?: string, label = 'Title'): FieldDef =>
  def({ key: 'title', label, kind: 'string', required, group: 'core', hint, ...(required ? {} : { default: '' }) });

const CARD_IMAGE = (cms: boolean, hint?: string) =>
  def({
    key: 'card_image',
    label: 'Card image',
    kind: 'image',
    group: 'advanced',
    cms,
    hint: hint ?? 'Image for link previews. Path relative to the post, e.g. ./my-post/hero.png.',
    ...(cms ? { default: '' } : {}),
  });
const EXCERPT = (cms: boolean) =>
  def({
    key: 'excerpt',
    label: 'Excerpt',
    kind: 'text',
    group: 'advanced',
    cms,
    hint: 'Optional preview text for listings. If empty, the content is auto-truncated.',
    ...(cms ? { default: '' } : {}),
  });

/**
 * Keys per collection in WRITE ORDER: the order Sveltia serialises them
 * (= field order in config.yml), followed by keys only the content schema
 * knows. `portfolio` has no CMS collection; its order is that of the existing
 * files. New keys are inserted according to this order.
 */
const WRITE_ORDER: Record<CollectionKind, readonly FieldDef[]> = {
  entries: [
    SLUG,
    title(true),
    CREATED,
    TAGS,
    DRAFT,
    def({ key: 'series', label: 'Series', kind: 'string', default: '', hint: 'Slug of the series this entry belongs to.' }),
    CARD_IMAGE(true),
    EXCERPT(true),
    def({
      key: 'extra_head_html',
      label: 'Extra <head> HTML',
      kind: 'text',
      group: 'advanced',
      cms: false,
      hint: 'Raw HTML added to the page head (scripts, styles).',
    }),
  ],
  blogmarks: [
    SLUG,
    def({ key: 'link_url', label: 'Link URL', kind: 'url', required: true, placeholder: 'https://…' }),
    def({ key: 'link_title', label: 'Link title', kind: 'string', required: true }),
    title(false, 'Optional title override for the page.', 'Title override'),
    CREATED,
    TAGS,
    def({ key: 'via_url', label: 'Via URL', kind: 'url', default: '', placeholder: 'https://…' }),
    def({ key: 'via_title', label: 'Via title', kind: 'string', default: '' }),
    DRAFT,
    CARD_IMAGE(false),
    EXCERPT(false),
  ],
  quotations: [
    SLUG,
    def({ key: 'source', label: 'Source', kind: 'string', required: true, hint: 'Who said or wrote this?' }),
    def({ key: 'source_url', label: 'Source URL', kind: 'url', default: '', placeholder: 'https://…' }),
    def({ key: 'context', label: 'Context', kind: 'string', default: '', hint: 'Optional context about when/where this was said.' }),
    CREATED,
    TAGS,
    DRAFT,
    CARD_IMAGE(false),
    EXCERPT(false),
  ],
  notes: [SLUG, title(false, 'Optional title for the note.'), CREATED, TAGS, DRAFT, CARD_IMAGE(false), EXCERPT(false)],
  photos: [
    SLUG,
    def({
      key: 'photo',
      label: 'Photo (cover)',
      kind: 'image',
      required: true,
      hint: 'The cover image, stored in a per-photo folder next to the markdown. Thumbnail and slide 1 of the carousel.',
    }),
    def({
      key: 'alt',
      label: 'Alt text (cover)',
      kind: 'text',
      required: true,
      hint: 'Describe the cover photo for screen readers and as a fallback.',
    }),
    def({
      key: 'gallery',
      label: 'Gallery',
      kind: 'yaml',
      default: [],
      hint: 'Additional images shown as a carousel (image, alt, caption). Leave empty for a single-image post.',
    }),
    title(false, 'Optional title shown above the photo.'),
    def({ key: 'caption', label: 'Caption', kind: 'text', default: '', hint: 'Optional caption shown below the photo.' }),
    def({ key: 'location', label: 'Location', kind: 'string', default: '' }),
    def({ key: 'taken_at', label: 'Taken at', kind: 'datetime', default: '' }),
    CREATED,
    TAGS,
    DRAFT,
    CARD_IMAGE(true, 'Optional override for the listing thumbnail. Defaults to the photo itself.'),
    def({
      key: 'exif',
      label: 'EXIF',
      kind: 'yaml',
      group: 'advanced',
      default: null,
      hint: 'Usually filled in by a build script (camera, lens, focal_length, aperture, shutter, iso).',
    }),
    EXCERPT(false),
  ],
  portfolio: [
    { ...SLUG, cms: false },
    { ...CREATED, kind: 'date', cms: false, hint: 'Decision date (YYYY-MM-DD).' },
    { ...title(true), cms: false },
    { ...TAGS, cms: false },
    { ...DRAFT, cms: false },
    def({
      key: 'move',
      label: 'Move',
      kind: 'select',
      cms: false,
      options: ['open', 'add', 'trim', 'exit', 'rebalance', 'note'],
      hint: 'Derived from the legs when left out; set to override the badge.',
    }),
    def({ key: 'conviction', label: 'Conviction', kind: 'select', cms: false, options: ['low', 'medium', 'high'] }),
    def({
      key: 'cost_bps',
      label: 'Cost (bps of turnover)',
      kind: 'number',
      cms: false,
      hint: 'Trading cost for this decision in basis points of turnover.',
    }),
    def({
      key: 'legs',
      label: 'Legs',
      kind: 'yaml',
      cms: false,
      hint: 'ticker plus one of weight / portion / scale. Weights only — never share counts or amounts (the repo is public).',
    }),
    EXCERPT(false),
    CARD_IMAGE(false),
  ],
  series: [
    SLUG,
    title(true),
    def({ key: 'summary', label: 'Summary', kind: 'text', required: true }),
    { ...CREATED },
  ],
};

const GROUP_RANK = { core: 0, collection: 1, advanced: 2 } as const;
const coreRank = (key: string) => {
  const i = (CORE_FIELD_KEYS as readonly string[]).indexOf(key);
  return i < 0 ? CORE_FIELD_KEYS.length : i;
};

/** Display order: the five core keys (title, slug, created, tags, is_draft), then the collection's own, then advanced. */
const DISPLAY: Record<CollectionKind, readonly FieldDef[]> = Object.fromEntries(
  Object.entries(WRITE_ORDER).map(([kind, defs]) => [
    kind,
    Object.freeze(
      defs
        .map((d, i) => [d, i] as const)
        .sort(
          ([a, ai], [b, bi]) =>
            GROUP_RANK[a.group] - GROUP_RANK[b.group] || (a.group === 'core' ? coreRank(a.key) - coreRank(b.key) : 0) || ai - bi,
        )
        .map(([d]) => d),
    ),
  ]),
) as Record<CollectionKind, readonly FieldDef[]>;

const ORDER: Record<CollectionKind, readonly string[]> = Object.fromEntries(
  Object.entries(WRITE_ORDER).map(([kind, defs]) => [kind, Object.freeze(defs.map((d) => d.key))]),
) as Record<CollectionKind, readonly string[]>;

/** Field definitions in display order (core first). `frontmatter.fields` returns these. */
export function fieldDefs(collection: CollectionKind): readonly FieldDef[] {
  return DISPLAY[collection];
}

/** Keys in the order they are written to the file (Sveltia's field order). */
export function writeOrder(collection: CollectionKind): readonly string[] {
  return ORDER[collection];
}

export function fieldDef(collection: CollectionKind, key: string): FieldDef | undefined {
  return WRITE_ORDER[collection].find((d) => d.key === key);
}

/** Keys Sveltia writes into every new post of this collection, in order (the scaffold). */
export function scaffoldKeys(collection: CollectionKind): readonly string[] {
  return WRITE_ORDER[collection].filter((d) => d.cms).map((d) => d.key);
}

/**
 * What to pass to `frontmatter.patch` when the user empties a field:
 * Sveltia keeps the key with an empty value (`title: ''`, `tags: []`,
 * `exif: null`), so keys it manages are set to their empty form; keys it does
 * not know are removed (`undefined`).
 */
export function emptyValueFor(collection: CollectionKind, key: string): FrontmatterValue | undefined {
  const d = fieldDef(collection, key);
  if (!d || !d.cms) return undefined;
  if (d.default !== undefined) return d.default;
  if (d.kind === 'tags') return [];
  if (d.kind === 'boolean') return false;
  if (d.kind === 'yaml') return undefined;
  return '';
}

/* ---------------------------------------------------------------- validate */

const isEmpty = (v: unknown) => v === undefined || v === null || v === '';

function isValidDate(value: unknown): boolean {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string') return false;
  return !Number.isNaN(new Date(value).getTime());
}

function isUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Problems that would break the site's build (the zod schemas in
 * src/content.config.ts) or the URL, phrased for the owner. One issue per
 * key at most. An empty result means "ready to publish" as far as the
 * frontmatter goes.
 */
export function validate(collection: CollectionKind, data: Record<string, unknown>): FrontmatterIssue[] {
  const issues: FrontmatterIssue[] = [];
  for (const field of DISPLAY[collection]) {
    const message = check(field, data[field.key]);
    if (message) issues.push({ key: field.key, message });
  }
  return issues;
}

function check(field: FieldDef, value: unknown): string | null {
  const { label } = field;
  if (isEmpty(value)) return field.required ? `${label} is required.` : null;

  switch (field.kind) {
    case 'slug':
      if (typeof value !== 'string') return `${label} must be text; put it in quotes.`;
      return SLUG_PATTERN.test(value) ? null : `${label} can only use lowercase letters, numbers and single hyphens (my-post).`;
    case 'string':
    case 'text':
    case 'image':
      return typeof value === 'string' ? null : `${label} must be text; if it looks like a number or a date, put it in quotes.`;
    case 'url':
      if (typeof value !== 'string') return `${label} must be a URL.`;
      if (!isUrl(value)) return `${label} is not a valid URL; it should start with https://.`;
      return null;
    case 'datetime':
    case 'date':
      return isValidDate(value) ? null : `${label} is not a date the site can read (use ${field.kind === 'date' ? '2026-01-31' : '2026-01-31T09:30:00+00:00'}).`;
    case 'boolean':
      return typeof value === 'boolean' ? null : `${label} must be true or false.`;
    case 'tags':
      if (!Array.isArray(value)) return `${label} must be a list.`;
      if (value.some((t) => typeof t !== 'string')) return `${label} must all be text; put numbers in quotes.`;
      if (value.some((t) => (t as string).trim() === '')) return `${label} contains an empty tag.`;
      return null;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${label} must be a number.`;
      return value < 0 ? `${label} cannot be negative.` : null;
    case 'select':
      return typeof value === 'string' && (field.options ?? []).includes(value)
        ? null
        : `${label} must be one of: ${(field.options ?? []).join(', ')}.`;
    case 'yaml':
      return null;
  }
}
