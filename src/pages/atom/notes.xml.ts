import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getCollection } from 'astro:content';
import { MONTHS_3 } from '../../lib/types';
import { formatShortDate } from '../../lib/content';

export async function GET(context: APIContext) {
  const notes = await getCollection('notes', ({ data }) => !data.is_draft);
  const sorted = notes.sort(
    (a, b) => new Date(b.data.created).getTime() - new Date(a.data.created).getTime()
  );

  return rss({
    title: 'Microblog - Notes',
    description: 'Short thoughts and micro-posts',
    site: context.site!,
    items: sorted.slice(0, 20).map((note) => {
      const date = new Date(note.data.created);
      const url = `/${date.getFullYear()}/${MONTHS_3[date.getMonth() + 1]}/${date.getDate()}/${note.data.slug}/`;
      return {
        title: note.data.title || `Note from ${formatShortDate(date)}`,
        pubDate: note.data.created,
        link: url,
        categories: note.data.tags,
      };
    }),
    customData: `<language>en-us</language>`,
  });
}
