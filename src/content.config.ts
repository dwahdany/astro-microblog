import { defineCollection, z, reference } from 'astro:content';
import { glob } from 'astro/loaders';

// Helper: treat empty strings as undefined (CMS outputs '' for empty optional fields)
const emptyToUndefined = (val: unknown) => (val === '' ? undefined : val);
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
    taken_at: z.coerce.date().optional(),
    // EXIF block — typically populated by a build-time script, not the CMS
    exif: z.object({
      camera: optionalString(),
      lens: optionalString(),
      focal_length: optionalString(),
      aperture: optionalString(),
      shutter: optionalString(),
      iso: z.preprocess(emptyToUndefined, z.number().optional()),
    }).optional(),
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

export const collections = { entries, blogmarks, quotations, notes, photos, series };
