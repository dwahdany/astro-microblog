import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getCollection, render } from 'astro:content';
import { getItemUrl } from '../../lib/content';
import { MONTHS_3 } from '../../lib/types';

export async function GET(context: APIContext) {
  const entries = await getCollection('entries', ({ data }) => !data.is_draft);
  const sorted = entries.sort(
    (a, b) => new Date(b.data.created).getTime() - new Date(a.data.created).getTime()
  );

  return rss({
    title: 'Microblog - Entries',
    description: 'Long-form articles and tutorials',
    site: context.site!,
    items: sorted.slice(0, 20).map((entry) => {
      const date = new Date(entry.data.created);
      const url = `/${date.getFullYear()}/${MONTHS_3[date.getMonth() + 1]}/${date.getDate()}/${entry.data.slug}/`;
      return {
        title: entry.data.title,
        pubDate: entry.data.created,
        link: url,
        categories: entry.data.tags,
      };
    }),
    customData: `<language>en-us</language>`,
  });
}
