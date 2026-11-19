/**
 * Everything the published post page puts around the rendered body: the
 * breadcrumb, title, date and tags, the lead image / photo carousel, and the
 * collection-specific trailer.
 *
 * Markup and class names are copied from the site's templates so the site's
 * own stylesheet styles them inside the preview frame:
 *   entries, notes, blogmarks, quotations, photos  src/pages/[year]/[month]/[day]/[slug].astro
 *   tags                                           src/components/content/TagList.astro
 *   photos                                         src/components/content/PhotoCarousel.astro
 *   portfolio                                      src/pages/portfolio/[slug].astro
 *
 * KNOWN DIFFERENCES FROM THE PUBLISHED PAGE
 *  - The site header/footer, comments (Giscus) and the "Back to home" footer
 *    are not shown: the preview is the article only.
 *  - Dates are formatted in UTC, the zone the site is built in.
 *  - Photos: the carousel is scripted on the site; here it is the same
 *    swipeable track without the arrows, dots and counter (the frame runs no
 *    script), with the first slide's caption.
 *  - Portfolio: the move badge, the before/after weights and "How this has
 *    aged" come from the price engine at build time. The preview shows the
 *    declared legs — the same table the site falls back to without prices.
 *  - Series have no page on the site; the preview shows title and summary.
 *
 * Values come straight from the parsed frontmatter, so anything may be
 * missing or of the wrong type while the author is typing; nothing here throws.
 */
import type { PreviewContext } from '../contracts';
import { MONTHS_3 } from './link-targets';

export interface PostChrome {
  /** Document title for the frame. */
  title: string;
  /** Inner HTML of the article `<header class="mb-8">`. */
  header: string;
  /** HTML between the header and the body (card image, carousel, portfolio legs). */
  lead: string;
  /** HTML after the body (photo details, quotation context). */
  after: string;
  /** Quotations render their body inside a styled blockquote. */
  wrapBody: 'blockquote' | null;
  /** Frontmatter problems that would break the published page. */
  warnings: string[];
}

/** Classes of the site's quotation wrapper. */
export const QUOTE_CLASS = 'border-l-4 border-terminal-accent-green pl-4 italic text-xl mb-6';

export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const e = escapeHtml;

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

/** Only http(s) and mailto links are emitted; anything else becomes an inert `#`. */
function safeHref(value: unknown): string {
  const url = text(value).trim();
  return /^(https?:\/\/|mailto:|\/)/i.test(url) ? url : '#';
}

function tagList(tags: unknown): string[] {
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string' && t !== '') : [];
}

function parseDate(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

/** lib/content.ts formatDisplayDate: "Wednesday, December 4, 2024". */
function displayDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

/** lib/content.ts formatShortDate: "Dec 4, 2024". */
function shortDate(date: Date): string {
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function tagsHtml(tags: string[]): string {
  const links = tags
    .map(
      (tag) =>
        `<a href="/tags/${e(encodeURI(tag))}/" class="text-sm text-terminal-accent-cyan hover:text-terminal-accent-green transition-colors">#${e(tag)}</a>`,
    )
    .join('');
  return `<div class="flex flex-wrap gap-1.5">${links}</div>`;
}

const DOT = '<span class="text-terminal-border">•</span>';
const H1_CLASS = 'text-2xl md:text-3xl font-bold text-terminal-text mb-4';
const META_CLASS = 'flex flex-wrap items-center gap-4 text-sm text-terminal-muted';
const CRUMB_CLASS = 'flex items-center gap-2 text-sm text-terminal-muted mb-4';
const CRUMB_LINK = 'hover:text-terminal-accent-cyan';

function timeHtml(date: Date | null): string {
  if (!date) return '<span>No date yet</span>';
  return `<time datetime="${e(date.toISOString())}">${e(displayDate(date))}</time>`;
}

function datedCrumbs(date: Date | null): string {
  if (!date) return `<div class="${CRUMB_CLASS}"><span>undated</span></div>`;
  const year = date.getUTCFullYear();
  const month = MONTHS_3[date.getUTCMonth()];
  const day = date.getUTCDate();
  return (
    `<div class="${CRUMB_CLASS}">` +
    `<a href="/${year}/" class="${CRUMB_LINK}">${year}</a><span>/</span>` +
    `<a href="/${year}/${month}/" class="${CRUMB_LINK}">${month}</a><span>/</span>` +
    `<a href="/${year}/${month}/${day}/" class="${CRUMB_LINK}">${day}</a>` +
    `</div>`
  );
}

function metaRow(date: Date | null, tags: string[], middle = ''): string {
  return `<div class="${META_CLASS}">${timeHtml(date)}${middle}${tags.length > 0 ? DOT + tagsHtml(tags) : ''}</div>`;
}

function image(ctx: PreviewContext, src: unknown, alt: string, cls: string, warnings: string[]): string {
  const path = text(src);
  if (path === '') return '';
  const url = ctx.resolveAsset(path);
  if (url === null) {
    warnings.push(`Image not found: ${path}`);
    return '';
  }
  return `<img src="${e(url)}" alt="${e(alt)}" loading="lazy" decoding="async" class="${cls}">`;
}

/* -------------------------------------------------------------------------- */

function photoLead(ctx: PreviewContext, fm: Record<string, unknown>, warnings: string[]): string {
  const gallery = Array.isArray(fm.gallery) ? fm.gallery : [];
  const slides = [
    { src: fm.photo, alt: text(fm.alt), caption: text(fm.caption) },
    ...gallery
      .filter((g): g is Record<string, unknown> => typeof g === 'object' && g !== null)
      .map((g) => ({ src: g.image, alt: text(g.alt), caption: text(g.caption) })),
  ];
  const total = slides.length;
  const slideHtml = slides
    .map(
      (slide, i) =>
        `<div class="carousel-slide snap-center shrink-0 w-full" role="group" aria-roledescription="slide" aria-label="${i + 1} of ${total}" data-index="${i}">` +
        image(ctx, slide.src, slide.alt, 'w-full h-auto max-h-[80vh] object-contain bg-black', warnings) +
        `</div>`,
    )
    .join('');
  const label = text(fm.title) || text(fm.alt);
  return (
    `<figure class="mb-8">` +
    `<div class="relative">` +
    `<div class="carousel-track flex snap-x snap-mandatory overflow-x-auto scroll-smooth rounded-lg border border-terminal-border bg-terminal-surface" role="region" aria-roledescription="carousel" aria-label="${e(label)}">${slideHtml}</div>` +
    (total > 1
      ? `<div class="absolute top-2 right-2 px-2 py-0.5 rounded-full bg-black/60 text-white text-xs font-medium backdrop-blur-sm">${total} photos · swipe</div>`
      : '') +
    `</div>` +
    `<figcaption class="mt-3 text-sm text-terminal-muted italic text-center min-h-[1.25rem]">${e(slides[0].caption)}</figcaption>` +
    `</figure>`
  );
}

function photoDetails(fm: Record<string, unknown>): string {
  const exif = typeof fm.exif === 'object' && fm.exif !== null ? (fm.exif as Record<string, unknown>) : null;
  const taken = parseDate(fm.taken_at);
  const location = text(fm.location);
  if (!location && !taken && !exif) return '';
  const row = (label: string, value: string) =>
    `<div class="flex gap-2"><dt class="text-terminal-accent-cyan">${label}</dt><dd>${value}</dd></div>`;
  const rows: string[] = [];
  if (location) rows.push(row('Location', e(location)));
  if (taken) rows.push(row('Taken', `<time datetime="${e(taken.toISOString())}">${e(shortDate(taken))}</time>`));
  if (exif) {
    for (const [key, label] of [
      ['camera', 'Camera'],
      ['lens', 'Lens'],
      ['focal_length', 'Focal length'],
      ['aperture', 'Aperture'],
      ['shutter', 'Shutter'],
      ['iso', 'ISO'],
    ] as const) {
      const value = text(exif[key]);
      if (value) rows.push(row(label, e(value)));
    }
  }
  return `<dl class="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2 text-sm border-t border-terminal-border pt-4 text-terminal-muted">${rows.join('')}</dl>`;
}

function portfolioLegs(fm: Record<string, unknown>): string {
  const legs = Array.isArray(fm.legs)
    ? fm.legs.filter((l): l is Record<string, unknown> => typeof l === 'object' && l !== null)
    : [];
  if (legs.length === 0) return '';
  const pct = (w: number) => `${(w * 100).toFixed(1)}%`;
  const declared = (leg: Record<string, unknown>) => {
    if (typeof leg.weight === 'number') return leg.weight === 0 ? 'exited' : pct(leg.weight);
    if (typeof leg.portion === 'number') return `sold ${pct(leg.portion)} of the position`;
    if (typeof leg.scale === 'number') return `×${leg.scale}`;
    return 'exited';
  };
  const rows = legs
    .map((leg) => {
      const ticker = text(leg.ticker);
      const name = text(leg.name);
      const isCash = ticker === 'CASH';
      return (
        `<tr class="border-b border-terminal-border/50 last:border-0">` +
        `<td class="px-3 py-2"><span class="text-terminal-text">${isCash ? 'Cash' : e(ticker)}</span>` +
        (!isCash && name && name !== ticker ? `<span class="text-terminal-muted"> · ${e(name)}</span>` : '') +
        `</td>` +
        `<td class="px-3 py-2 text-right text-terminal-muted">—</td>` +
        `<td class="px-3 py-2 text-right text-terminal-text tabular-nums">${e(declared(leg))}</td>` +
        `</tr>`
      );
    })
    .join('');
  return (
    `<section class="mb-8">` +
    `<h2 class="text-sm font-medium text-terminal-text mb-3 flex items-center gap-2"><span class="text-terminal-accent-green">&gt;</span><span>What it did to the book</span></h2>` +
    `<div class="overflow-x-auto rounded-lg border border-terminal-border bg-terminal-surface"><table class="w-full text-sm">` +
    `<thead><tr class="text-xs text-terminal-muted border-b border-terminal-border">` +
    `<th class="text-left font-normal px-3 py-2">Holding</th><th class="text-right font-normal px-3 py-2">Weight before</th><th class="text-right font-normal px-3 py-2">Weight after</th>` +
    `</tr></thead><tbody>${rows}</tbody></table></div>` +
    `</section>`
  );
}

/* -------------------------------------------------------------------------- */

export function renderChrome(ctx: PreviewContext): PostChrome {
  const fm = ctx.frontmatter ?? {};
  const warnings: string[] = [];
  const date = parseDate(fm.created);
  const tags = tagList(fm.tags);
  const titleText = text(fm.title);

  if (!date && ctx.collection !== 'series') {
    warnings.push(
      fm.created === undefined || fm.created === null || fm.created === ''
        ? 'No created date: the site cannot place this post.'
        : `The created date "${text(fm.created)}" is not a valid date.`,
    );
  }

  const h1 = (inner: string) => `<h1 class="${H1_CLASS}">${inner}</h1>`;
  const chrome: PostChrome = { title: titleText, header: '', lead: '', after: '', wrapBody: null, warnings };

  switch (ctx.collection) {
    case 'entries': {
      chrome.header = datedCrumbs(date) + h1(e(titleText)) + metaRow(date, tags);
      break;
    }
    case 'notes': {
      chrome.title = titleText || (date ? `Note from ${shortDate(date)}` : 'Note');
      chrome.header = datedCrumbs(date) + (titleText ? h1(e(titleText)) : '') + metaRow(date, tags);
      break;
    }
    case 'blogmarks': {
      const shown = titleText || text(fm.link_title);
      chrome.title = shown;
      const via = text(fm.via_url)
        ? `<p class="mt-2 text-sm text-terminal-muted">via <a href="${e(safeHref(fm.via_url))}" class="text-terminal-accent-cyan hover:text-terminal-accent-green" target="_blank" rel="noopener noreferrer">${e(text(fm.via_title) || 'link')}</a></p>`
        : '';
      chrome.header =
        datedCrumbs(date) +
        h1(
          `<a href="${e(safeHref(fm.link_url))}" class="text-terminal-accent-blue hover:text-terminal-accent-cyan" target="_blank" rel="noopener noreferrer">${e(shown)}</a>`,
        ) +
        metaRow(date, tags) +
        via;
      break;
    }
    case 'quotations': {
      chrome.title = `Quoting ${text(fm.source)}`;
      chrome.header = datedCrumbs(date) + h1(e(chrome.title)) + metaRow(date, tags);
      chrome.wrapBody = 'blockquote';
      if (text(fm.context)) chrome.after = `<p class="mt-4 text-terminal-muted italic">${e(text(fm.context))}</p>`;
      break;
    }
    case 'photos': {
      chrome.title = titleText || (date ? `Photo from ${shortDate(date)}` : 'Photo');
      chrome.header = datedCrumbs(date) + (titleText ? h1(e(titleText)) : '') + metaRow(date, tags);
      chrome.lead = photoLead(ctx, fm, warnings);
      chrome.after = photoDetails(fm);
      break;
    }
    case 'portfolio': {
      const conviction = text(fm.conviction);
      // The decision page shows the calendar day of `created`, pinned to midday UTC.
      const day = date ? new Date(`${date.toISOString().slice(0, 10)}T12:00:00Z`) : null;
      chrome.header =
        `<div class="${CRUMB_CLASS}"><a href="/portfolio/" class="${CRUMB_LINK}">portfolio</a><span>/</span><a href="/portfolio/#log" class="${CRUMB_LINK}">log</a></div>` +
        h1(e(titleText)) +
        metaRow(day, tags, conviction ? `${DOT}<span>conviction: ${e(conviction)}</span>` : '');
      chrome.lead = portfolioLegs(fm);
      break;
    }
    case 'series': {
      chrome.header =
        `<div class="${CRUMB_CLASS}"><span>series</span></div>` +
        h1(e(titleText)) +
        (text(fm.summary) ? `<p class="text-sm text-terminal-muted">${e(text(fm.summary))}</p>` : '');
      break;
    }
  }

  // Card image: every dated type except photos (which lead with the carousel).
  if (['entries', 'notes', 'blogmarks', 'quotations'].includes(ctx.collection)) {
    chrome.lead = image(ctx, fm.card_image, chrome.title, 'w-full rounded-lg mb-8', warnings);
  }

  return chrome;
}
