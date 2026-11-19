/**
 * renderChrome: the post header and surroundings per collection. Expected
 * markup is the built site's (see tools/compare-site.ts for the full check).
 */
import { describe, expect, it } from 'vitest';
import type { CollectionKind, PreviewContext } from '../../contracts';
import { renderChrome } from '../chrome';

function ctx(
  collection: CollectionKind,
  frontmatter: Record<string, unknown>,
  resolveAsset: PreviewContext['resolveAsset'] = (src) => `/assets/${src}`,
): PreviewContext {
  return { path: `src/content/${collection}/2026/x.md`, collection, frontmatter, resolveAsset };
}

describe('renderChrome', () => {
  it('entry: breadcrumb, title, long date and tags exactly as the site page', () => {
    const chrome = renderChrome(
      ctx('entries', { title: 'Academic Conferences', created: '2025-07-14T16:41:00+00:00', tags: ['academia', 'social'] }),
    );
    expect(chrome.header).toBe(
      '<div class="flex items-center gap-2 text-sm text-terminal-muted mb-4">' +
        '<a href="/2025/" class="hover:text-terminal-accent-cyan">2025</a><span>/</span>' +
        '<a href="/2025/Jul/" class="hover:text-terminal-accent-cyan">Jul</a><span>/</span>' +
        '<a href="/2025/Jul/14/" class="hover:text-terminal-accent-cyan">14</a></div>' +
        '<h1 class="text-2xl md:text-3xl font-bold text-terminal-text mb-4">Academic Conferences</h1>' +
        '<div class="flex flex-wrap items-center gap-4 text-sm text-terminal-muted">' +
        '<time datetime="2025-07-14T16:41:00.000Z">Monday, July 14, 2025</time>' +
        '<span class="text-terminal-border">•</span>' +
        '<div class="flex flex-wrap gap-1.5">' +
        '<a href="/tags/academia/" class="text-sm text-terminal-accent-cyan hover:text-terminal-accent-green transition-colors">#academia</a>' +
        '<a href="/tags/social/" class="text-sm text-terminal-accent-cyan hover:text-terminal-accent-green transition-colors">#social</a>' +
        '</div></div>',
    );
    expect(chrome.title).toBe('Academic Conferences');
    expect(chrome.wrapBody).toBeNull();
    expect(chrome.warnings).toEqual([]);
  });

  it('uses UTC for the day, like the production build (23:29Z stays on the 18th)', () => {
    const chrome = renderChrome(ctx('photos', { photo: 'a.png', alt: 'x', created: '2026-04-18T23:29:00+00:00', tags: [] }));
    expect(chrome.header).toContain('href="/2026/Apr/18/"');
    expect(chrome.header).toContain('Saturday, April 18, 2026');
  });

  it('escapes everything that comes from the frontmatter', () => {
    const chrome = renderChrome(
      ctx('entries', {
        title: '<img src=x onerror=alert(1)> "Private" & co',
        created: '2026-01-01',
        tags: ['<b>', 'a"b'],
      }),
    );
    expect(chrome.header).not.toContain('<img');
    expect(chrome.header).not.toContain('<b>');
    expect(chrome.header).toContain('&lt;img src=x onerror=alert(1)&gt; &quot;Private&quot; &amp; co');
    expect(chrome.header).toContain('#&lt;b&gt;');
  });

  it('note: no h1 without a title, an h1 with one', () => {
    expect(renderChrome(ctx('notes', { created: '2026-03-17T19:02:00+00:00', title: '' })).header).not.toContain('<h1');
    expect(renderChrome(ctx('notes', { created: '2026-03-17T19:02:00+00:00', title: null })).title).toBe('Note from Mar 17, 2026');
    expect(renderChrome(ctx('notes', { created: '2026-03-17T19:02:00+00:00', title: 'Ephemeral Agents' })).header).toContain(
      '<h1 class="text-2xl md:text-3xl font-bold text-terminal-text mb-4">Ephemeral Agents</h1>',
    );
  });

  it('blogmark: the title links out, falls back to link_title, and shows via', () => {
    const chrome = renderChrome(
      ctx('blogmarks', {
        created: '2026-01-06T09:00:00+00:00',
        link_url: 'https://example.com/paper',
        link_title: 'How to write ML papers',
        title: '',
        via_url: 'https://news.example.com/item',
        via_title: '',
      }),
    );
    expect(chrome.header).toContain(
      '<a href="https://example.com/paper" class="text-terminal-accent-blue hover:text-terminal-accent-cyan" target="_blank" rel="noopener noreferrer">How to write ML papers</a>',
    );
    expect(chrome.header).toContain('via <a href="https://news.example.com/item"');
    expect(chrome.header).toContain('>link</a></p>');
  });

  it('blogmark: a script URL never becomes a link', () => {
    const chrome = renderChrome(ctx('blogmarks', { created: '2026-01-06', link_url: 'javascript:alert(1)', link_title: 'x' }));
    expect(chrome.header).not.toContain('javascript:');
    expect(chrome.header).toContain('href="#"');
  });

  it('quotation: "Quoting <source>", blockquote wrapper, context after the body', () => {
    const chrome = renderChrome(ctx('quotations', { created: '2026-02-02', source: 'Ada Lovelace', context: 'In a letter' }));
    expect(chrome.header).toContain('>Quoting Ada Lovelace</h1>');
    expect(chrome.wrapBody).toBe('blockquote');
    expect(chrome.after).toBe('<p class="mt-4 text-terminal-muted italic">In a letter</p>');
  });

  it('card image: resolved and placed before the body with the site classes', () => {
    const chrome = renderChrome(
      ctx('entries', { title: 'Curation "Leaks"', created: '2026-04-22T12:00:00+00:00', card_image: './curation-leaks/hero.png' }),
    );
    expect(chrome.lead).toBe(
      '<img src="/assets/./curation-leaks/hero.png" alt="Curation &quot;Leaks&quot;" loading="lazy" decoding="async" class="w-full rounded-lg mb-8">',
    );
    expect(renderChrome(ctx('entries', { title: 'x', created: '2026-01-01', card_image: '' })).lead).toBe('');
  });

  it('card image that cannot be resolved: no image, a warning', () => {
    const chrome = renderChrome(ctx('entries', { title: 'x', created: '2026-01-01', card_image: 'nope.png' }, () => null));
    expect(chrome.lead).toBe('');
    expect(chrome.warnings).toEqual(['Image not found: nope.png']);
  });

  it('photo: cover and gallery as slides, details after the body', () => {
    const chrome = renderChrome(
      ctx('photos', {
        created: '2026-04-18T23:29:00+00:00',
        photo: 'gaudi/one.png',
        alt: 'A window',
        caption: 'Casa Batlló',
        gallery: [{ image: 'gaudi/two.png', alt: 'A street', caption: '' }],
        location: 'Barcelona, Spain',
        taken_at: '',
        exif: { camera: 'X100V', iso: 400 },
      }),
    );
    expect(chrome.lead.match(/<img /g)).toHaveLength(2);
    expect(chrome.lead).toContain('src="/assets/gaudi/one.png" alt="A window"');
    expect(chrome.lead).toContain('aria-label="2 of 2"');
    expect(chrome.lead).toContain('>Casa Batlló</figcaption>');
    expect(chrome.after).toContain('<dt class="text-terminal-accent-cyan">Location</dt><dd>Barcelona, Spain</dd>');
    expect(chrome.after).toContain('<dt class="text-terminal-accent-cyan">Camera</dt><dd>X100V</dd>');
    expect(chrome.after).toContain('<dt class="text-terminal-accent-cyan">ISO</dt><dd>400</dd>');
    expect(chrome.after).not.toContain('Taken');
  });

  it('portfolio: its own breadcrumb, midday-UTC date, conviction, declared legs', () => {
    const chrome = renderChrome(
      ctx('portfolio', {
        title: 'Exiting IBM',
        created: '2025-03-31',
        conviction: 'high',
        tags: [],
        legs: [
          { ticker: 'IBM', name: 'IBM Corp', action: 'sell' },
          { ticker: 'CASH', weight: 0.125 },
          { ticker: 'KO', portion: 0.5 },
        ],
      }),
    );
    expect(chrome.header).toContain('<a href="/portfolio/" class="hover:text-terminal-accent-cyan">portfolio</a>');
    expect(chrome.header).toContain('<time datetime="2025-03-31T12:00:00.000Z">Monday, March 31, 2025</time>');
    expect(chrome.header).toContain('<span>conviction: high</span>');
    expect(chrome.lead).toContain('What it did to the book');
    expect(chrome.lead).toContain('<span class="text-terminal-text">IBM</span><span class="text-terminal-muted"> · IBM Corp</span>');
    expect(chrome.lead).toContain('>exited</td>');
    expect(chrome.lead).toContain('<span class="text-terminal-text">Cash</span>');
    expect(chrome.lead).toContain('>12.5%</td>');
    expect(chrome.lead).toContain('>sold 50.0% of the position</td>');
  });

  it('never throws on half-typed frontmatter, and says what is wrong with the date', () => {
    for (const collection of ['entries', 'notes', 'blogmarks', 'quotations', 'photos', 'portfolio', 'series'] as const) {
      const chrome = renderChrome(ctx(collection, { title: 42, tags: 'oops', created: 'not a date', legs: 'x', gallery: 3, exif: 'y' }));
      expect(typeof chrome.header).toBe('string');
    }
    expect(renderChrome(ctx('entries', { title: 'x' })).warnings).toEqual(['No created date: the site cannot place this post.']);
    expect(renderChrome(ctx('entries', { title: 'x', created: 'soon' })).warnings).toEqual([
      'The created date "soon" is not a valid date.',
    ]);
    expect(renderChrome(ctx('entries', { title: 'x', tags: null, created: '2026-01-01' })).header).not.toContain('•');
  });
});
