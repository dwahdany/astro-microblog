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

export const collections = { entries, blogmarks, quotations, notes, series };
