export const prerender = true;

import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getCollection } from 'astro:content';
import { portfolioConfig } from '../../data/portfolio.config';

export async function GET(context: APIContext) {
  const decisions = portfolioConfig.enabled
    ? await getCollection('portfolio', ({ data }) => !data.is_draft)
    : [];
  const sorted = decisions.sort(
    (a, b) => new Date(b.data.created).getTime() - new Date(a.data.created).getTime()
  );

  return rss({
    title: 'Microblog - Portfolio',
    description: 'Investment decisions, with the reasoning attached',
    site: context.site!,
    items: sorted.slice(0, 20).map((decision) => ({
      title: decision.data.title,
      pubDate: decision.data.created,
      link: `/portfolio/${decision.data.slug}/`,
      categories: decision.data.tags,
    })),
    customData: `<language>en-us</language>`,
  });
}
