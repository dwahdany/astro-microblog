import { defineCollection, z, reference } from 'astro:content';
import { glob } from 'astro/loaders';

// Helper: treat empty strings and null as undefined (CMS outputs '' or null for empty optional fields)
const emptyToUndefined = (val: unknown) => (val === '' || val === null ? undefined : val);
const optionalString = () => z.preprocess(emptyToUndefined, z.string().optional());
const optionalUrl = () => z.preprocess(emptyToUndefined, z.string().url().optional());

// Helper to create base schema with image support
const createBaseSchema = (image: any) => ({
  slug: z.string(),
  created: z.coerce.date(),
  tags: z.array(z.string()).default([]),
  is_draft: z.boolean().default(false),
  card_image: image().optional(),
  excerpt: z.string().optional(),
});

// Entry - Long-form articles
const entries = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/entries' }),
  schema: ({ image }) => z.object({
    ...createBaseSchema(image),
    title: z.string(),
    series: z.string().optional(),
    extra_head_html: z.string().optional(),
  }),
});

// Blogmark - Links with commentary
const blogmarks = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blogmarks' }),
  schema: ({ image }) => z.object({
    ...createBaseSchema(image),
    link_url: z.string().url(),
    link_title: z.string(),
    title: optionalString(),
    via_url: optionalUrl(),
    via_title: optionalString(),
  }),
});

// Quotation - Quotes with source attribution
const quotations = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/quotations' }),
  schema: ({ image }) => z.object({
    ...createBaseSchema(image),
    source: z.string(),
    source_url: optionalUrl(),
    context: optionalString(),
  }),
});

// Note - Short micro-posts
const notes = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/notes' }),
  schema: ({ image }) => z.object({
    ...createBaseSchema(image),
    title: optionalString(),
  }),
});

// Photo - Photo posts (single image or a gallery/carousel) with optional EXIF
const photos = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/photos' }),
  schema: ({ image }) => z.object({
    ...createBaseSchema(image),
    title: optionalString(),
    // Cover image — required, used for thumbnails, OG image, and as the
    // first slide of the carousel when a `gallery` is present.
    photo: image(),
    alt: z.string(),
    caption: optionalString(),
    // Optional additional images for a carousel post. The cover (`photo`)
    // is always slide 1; these are appended in order.
    gallery: z.array(z.object({
      image: image(),
      alt: z.string(),
      caption: optionalString(),
    })).default([]),
    location: optionalString(),
    taken_at: z.preprocess(emptyToUndefined, z.coerce.date().optional()),
    // EXIF block — typically populated by a build-time script, not the CMS
    exif: z.preprocess(emptyToUndefined, z.object({
      camera: optionalString(),
      lens: optionalString(),
      focal_length: optionalString(),
      aperture: optionalString(),
      shutter: optionalString(),
      iso: z.preprocess(emptyToUndefined, z.number().optional()),
    }).optional()),
  }),
});

// Portfolio - Investment decision log. Each file is one decision: what it did
// to the book (frontmatter) and the reasoning behind it (body).
//
// Sizes are WEIGHTS, never share counts or amounts — this repo is public, and a
// weight path is all a time-weighted track record needs. See
// src/lib/portfolio/types.ts for why.
const portfolio = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/portfolio' }),
  schema: ({ image }) => z.object({
    ...createBaseSchema(image),
    title: z.string(),
    // Derived from `legs` when omitted; set explicitly to override the badge.
    move: z.enum(['open', 'add', 'trim', 'exit', 'rebalance', 'note']).optional(),
    conviction: z.enum(['low', 'medium', 'high']).optional(),
    // Trading cost for this decision in basis points of turnover.
    cost_bps: z.preprocess(emptyToUndefined, z.number().nonnegative().optional()),
    legs: z.array(
      z.object({
        // Yahoo Finance symbol, or the reserved pseudo-ticker CASH.
        ticker: z.string(),
        name: optionalString(),
        // Derived from the weight change when omitted.
        action: z.preprocess(emptyToUndefined, z.enum(['buy', 'sell']).optional()),
        // Defaults to the entry's `created` date.
        date: z.preprocess(emptyToUndefined, z.coerce.date().optional()),
        // Exactly one sizing field, or none for a full exit:
        //   weight  - post-trade share of the book, 0..1
        //   portion - fraction of the position sold, 0..1
        //   scale   - multiplier on the existing weight (2 = doubled)
        weight: z.preprocess(emptyToUndefined, z.number().min(0).max(1).optional()),
        portion: z.preprocess(emptyToUndefined, z.number().min(0).max(1).optional()),
        scale: z.preprocess(emptyToUndefined, z.number().positive().optional()),
      })
        .refine(
          (l) =>
            [l.weight, l.portion, l.scale].filter((v) => v !== undefined).length <= 1,
          { message: 'Give at most one of weight, portion, scale' }
        )
        .refine((l) => l.weight !== undefined || l.portion !== undefined || l.scale !== undefined || l.action === 'sell', {
          message: 'A leg with no size must be a sell (a full exit)',
        })
    ).default([]),
  }),
});

// Series - For grouping entries
const series = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/series' }),
  schema: z.object({
    slug: z.string(),
    title: z.string(),
    summary: z.string(),
    created: z.coerce.date(),
  }),
});

export const collections = { entries, blogmarks, quotations, notes, photos, series, portfolio };
