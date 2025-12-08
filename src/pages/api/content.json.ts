import type { APIRoute } from 'astro';
import { getAllContent, getItemUrl, getItemTitle } from '../../lib/content';

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const daysParam = url.searchParams.get('days');
  const days = daysParam ? parseInt(daysParam, 10) : 7;

  if (isNaN(days) || days < 1 || days > 365) {
    return new Response(JSON.stringify({ error: 'Invalid days parameter (1-365)' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  cutoffDate.setHours(0, 0, 0, 0);

  const allContent = await getAllContent();

  const recentContent = allContent
    .filter(item => new Date(item.item.data.created) >= cutoffDate)
    .map(item => ({
      type: item.type,
      title: getItemTitle(item),
      url: getItemUrl(item),
      created: item.item.data.created,
      tags: item.item.data.tags,
      // Include excerpt for entries, body preview for notes, quote for quotations
      excerpt: getExcerpt(item),
    }));

  return new Response(JSON.stringify({
    generated: new Date().toISOString(),
    days,
    count: recentContent.length,
    items: recentContent,
  }), {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300', // 5 minute cache
    },
  });
};

function getExcerpt(item: { type: string; item: { data: any; body?: string } }): string {
  switch (item.type) {
    case 'entry':
      return item.item.data.description || '';
    case 'blogmark':
      return item.item.data.commentary || '';
    case 'quotation':
      return item.item.data.quotation?.slice(0, 200) || '';
    case 'note':
      // Notes may have body content
      return item.item.body?.slice(0, 200) || '';
    default:
      return '';
  }
}
