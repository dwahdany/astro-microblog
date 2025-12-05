export const prerender = true;

import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getCollection } from 'astro:content';
import { MONTHS_3 } from '../../lib/types';

export async function GET(context: APIContext) {
  const quotations = await getCollection('quotations', ({ data }) => !data.is_draft);
  const sorted = quotations.sort(
    (a, b) => new Date(b.data.created).getTime() - new Date(a.data.created).getTime()
  );

  return rss({
    title: 'Microblog - Quotations',
    description: 'Memorable quotes and excerpts',
    site: context.site!,
    items: sorted.slice(0, 20).map((quotation) => {
      const date = new Date(quotation.data.created);
      const url = `/${date.getFullYear()}/${MONTHS_3[date.getMonth() + 1]}/${date.getDate()}/${quotation.data.slug}/`;
      return {
        title: `Quoting ${quotation.data.source}`,
        pubDate: quotation.data.created,
        link: url,
        categories: quotation.data.tags,
      };
    }),
    customData: `<language>en-us</language>`,
  });
}
