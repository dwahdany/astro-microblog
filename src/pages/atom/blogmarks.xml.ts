import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getCollection } from 'astro:content';
import { MONTHS_3 } from '../../lib/types';

export async function GET(context: APIContext) {
  const blogmarks = await getCollection('blogmarks', ({ data }) => !data.is_draft);
  const sorted = blogmarks.sort(
    (a, b) => new Date(b.data.created).getTime() - new Date(a.data.created).getTime()
  );

  return rss({
    title: 'Microblog - Blogmarks',
    description: 'Interesting links with commentary',
    site: context.site!,
    items: sorted.slice(0, 20).map((blogmark) => {
      const date = new Date(blogmark.data.created);
      const url = `/${date.getFullYear()}/${MONTHS_3[date.getMonth() + 1]}/${date.getDate()}/${blogmark.data.slug}/`;
      return {
        title: blogmark.data.title || blogmark.data.link_title,
        pubDate: blogmark.data.created,
        link: url,
        categories: blogmark.data.tags,
      };
    }),
    customData: `<language>en-us</language>`,
  });
}
