import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getAllContent, getItemTitle, getItemUrl } from '../../lib/content';
import { render } from 'astro:content';

export async function GET(context: APIContext) {
  const allContent = await getAllContent();
  const items = allContent.slice(0, 30);

  return rss({
    title: 'Microblog',
    description: 'A personal microblog with notes, links, quotes, and articles.',
    site: context.site!,
    items: await Promise.all(
      items.map(async (item) => {
        const { Content } = await render(item.item);
        return {
          title: getItemTitle(item),
          pubDate: item.item.data.created,
          link: getItemUrl(item),
          categories: item.item.data.tags,
        };
      })
    ),
    customData: `<language>en-us</language>`,
  });
}
