export const prerender = true;

import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getCollection } from 'astro:content';
import { MONTHS_3 } from '../../lib/types';
import { formatShortDate } from '../../lib/content';

export async function GET(context: APIContext) {
  const photos = await getCollection('photos', ({ data }) => !data.is_draft);
  const sorted = photos.sort(
    (a, b) => new Date(b.data.created).getTime() - new Date(a.data.created).getTime()
  );

  return rss({
    title: 'Microblog - Photos',
    description: 'Photo posts',
    site: context.site!,
    items: sorted.slice(0, 20).map((photo) => {
      const date = new Date(photo.data.created);
      const url = `/${date.getFullYear()}/${MONTHS_3[date.getMonth() + 1]}/${date.getDate()}/${photo.data.slug}/`;
      return {
        title: photo.data.title || photo.data.alt || `Photo from ${formatShortDate(date)}`,
        pubDate: photo.data.created,
        link: url,
        categories: photo.data.tags,
      };
    }),
    customData: `<language>en-us</language>`,
  });
}
