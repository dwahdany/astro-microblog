import { defineCollection, z, reference } from 'astro:content';
import { glob } from 'astro/loaders';

// Shared schema fields for all content types
const baseSchema = {
  slug: z.string(),
  created: z.coerce.date(),
  tags: z.array(z.string()).default([]),
  is_draft: z.boolean().default(false),
  card_image: z.string().optional(),
};

// Entry - Long-form articles
const entries = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/entries' }),
  schema: z.object({
    ...baseSchema,
    title: z.string(),
    series: z.string().optional(),
    extra_head_html: z.string().optional(),
  }),
});

// Blogmark - Links with commentary
const blogmarks = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/blogmarks' }),
  schema: z.object({
    ...baseSchema,
    link_url: z.string().url(),
    link_title: z.string(),
    title: z.string().optional(), // Optional page title override
    via_url: z.string().url().optional(),
    via_title: z.string().optional(),
  }),
});

// Quotation - Quotes with source attribution
const quotations = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/quotations' }),
  schema: z.object({
    ...baseSchema,
    source: z.string(),
    source_url: z.string().url().optional(),
    context: z.string().optional(),
  }),
});

// Note - Short micro-posts
const notes = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/notes' }),
  schema: z.object({
    ...baseSchema,
    title: z.string().optional(),
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
