/**
 * Compare the preview renderer with a real build of the site.
 *
 *   bun src/write/preview/tools/compare-site.ts [distClientDir] [--only <slug>] [--show]
 *
 * For every published post under src/content it takes the built page
 * (dist/client/<y>/<Mon>/<d>/<slug>/index.html, or /portfolio/<slug>/), cuts
 * out the article header and the `.prose` body, renders the same file with
 * ./render.ts and ./chrome.ts, and diffs the two DOMs structurally (attribute
 * order and insignificant whitespace ignored).
 *
 * The differences that are intended are normalised away and counted, so that
 * anything printed is a real divergence:
 *   - img: Astro's optimised `/_astro/….webp` src and its width/height
 *
 * Not part of the test suite: it needs a full `astro build` (minutes).
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { JSDOM } from 'jsdom';
import { parse as parseYaml } from 'yaml';
import type { CollectionKind, PreviewContext } from '../../contracts';
import { renderChrome } from '../chrome';
import { isLinkable, targetFromFile, type LinkTarget } from '../link-targets';
import { renderMarkdown } from '../render';

const repo = join(import.meta.dirname, '../../../..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const show = args.includes('--show');
const dist = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--only') ?? join(repo, 'dist/client');

const dom = new JSDOM('<!doctype html><body></body>');
const doc = dom.window.document;

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : name.endsWith('.md') ? [full] : [];
  });
}

function split(raw: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { data: {}, body: raw };
  // `core` schema keeps timestamps as strings, like the app's frontmatter.parse.
  return { data: (parseYaml(match[1], { schema: 'core' }) ?? {}) as Record<string, unknown>, body: raw.slice(match[0].length) };
}

/** Canonical text form of a DOM subtree. */
function canon(node: Node, out: string[], depth = 0): void {
  const pad = '  '.repeat(depth);
  if (node.nodeType === 3) {
    const value = (node.nodeValue ?? '').replace(/\s+/g, ' ');
    if (value.trim() !== '') out.push(`${pad}"${value.trim()}"`);
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const attrs = [...el.attributes]
    .filter((a) => !a.name.startsWith('data-astro-cid'))
    .map((a) => {
      let value = a.value;
      if (tag === 'img' && a.name === 'src') value = '«image»';
      if (a.name === 'class') value = value.split(/\s+/).filter(Boolean).sort().join(' ');
      return `${a.name}=${JSON.stringify(value)}`;
    })
    .filter((a) => !(tag === 'img' && /^(width|height)=/.test(a)))
    .sort();
  out.push(`${pad}<${tag}${attrs.length ? ' ' + attrs.join(' ') : ''}>`);
  // Whitespace is significant inside <pre>.
  if (tag === 'pre') out.push(`${pad}  ${JSON.stringify(el.textContent)}`);
  for (const child of el.childNodes) canon(child, out, depth + 1);
}

function canonHtml(html: string): string[] {
  const host = doc.createElement('div');
  host.innerHTML = html;
  const out: string[] = [];
  for (const child of host.childNodes) canon(child, out);
  return out;
}

function firstDiff(a: string[], b: string[]): { index: number; site: string[]; preview: string[] } | null {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return { index: i, site: a.slice(Math.max(0, i - 1), i + 4), preview: b.slice(Math.max(0, i - 1), i + 4) };
  }
  return null;
}

function countDiffs(a: string[], b: string[]): number {
  const setB = new Map<string, number>();
  for (const line of b) setB.set(line, (setB.get(line) ?? 0) + 1);
  let missing = 0;
  for (const line of a) {
    const left = setB.get(line) ?? 0;
    if (left > 0) setB.set(line, left - 1);
    else missing++;
  }
  return missing + [...setB.values()].reduce((s, v) => s + v, 0);
}

const contentRoot = join(repo, 'src/content');
const collections: CollectionKind[] = ['entries', 'notes', 'blogmarks', 'quotations', 'photos', 'portfolio'];
const files = collections.flatMap((collection) =>
  walk(join(contentRoot, collection))
    .filter((f) => !(collection === 'portfolio' && /\/_[^/]*$/.test(f)))
    .map((file) => ({ collection, file })),
);

// Exact link-card data for every linkable post, as Preview.svelte builds it on demand.
const linkTargets: LinkTarget[] = [];
for (const { collection, file } of files) {
  if (!isLinkable(collection)) continue;
  const { data, body } = split(readFileSync(file, 'utf8'));
  const target = targetFromFile(collection, data, body);
  if (target) linkTargets.push(target);
}

function builtPage(collection: CollectionKind, slug: string): string | null {
  if (collection === 'portfolio') {
    const p = join(dist, 'portfolio', slug, 'index.html');
    return existsSync(p) ? p : null;
  }
  for (const year of readdirSync(dist)) {
    if (!/^\d{4}$/.test(year)) continue;
    for (const month of readdirSync(join(dist, year))) {
      const monthDir = join(dist, year, month);
      if (!statSync(monthDir).isDirectory()) continue;
      for (const day of readdirSync(monthDir)) {
        const p = join(monthDir, day, slug, 'index.html');
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

let compared = 0;
let identicalBody = 0;
let identicalHeader = 0;
const skipped: string[] = [];
const report: string[] = [];

for (const { collection, file } of files) {
  const raw = readFileSync(file, 'utf8');
  const { data, body } = split(raw);
  const slug = String(data.slug ?? '');
  if (only && slug !== only) continue;
  const rel = relative(repo, file);
  if (data.is_draft === true) {
    skipped.push(`${rel} (draft)`);
    continue;
  }
  const page = builtPage(collection, slug);
  if (!page) {
    skipped.push(`${rel} (no built page)`);
    continue;
  }
  const site = new JSDOM(readFileSync(page, 'utf8')).window.document;
  const article = site.querySelector('article');
  const prose = article?.querySelector('div.prose');
  const header = article?.querySelector('header');
  if (!article || !prose || !header) {
    skipped.push(`${rel} (no article in built page)`);
    continue;
  }

  const ctx: PreviewContext & { linkTargets: LinkTarget[] } = {
    path: rel,
    collection,
    frontmatter: data,
    resolveAsset: (src) => `asset:${src}`,
    linkTargets,
  };
  const result = await renderMarkdown(body, ctx);
  const chrome = renderChrome(ctx);
  compared++;

  // Body: quotations wrap the content in a blockquote on the site.
  let siteBody = prose.innerHTML;
  if (chrome.wrapBody === 'blockquote') siteBody = prose.querySelector(':scope > blockquote')?.innerHTML ?? siteBody;
  const a = canonHtml(siteBody);
  const b = canonHtml(result.html);
  const bodyDiff = firstDiff(a, b);
  if (!bodyDiff) identicalBody++;

  // Header. The portfolio move badge is engine-computed and not previewed.
  const siteHeader = header.cloneNode(true) as Element;
  if (collection === 'portfolio') siteHeader.querySelector(':scope > div.mb-4:not(.flex)')?.remove();
  const ha = canonHtml(siteHeader.innerHTML);
  const hb = canonHtml(chrome.header);
  const headerDiff = firstDiff(ha, hb);
  if (!headerDiff) identicalHeader++;

  if (bodyDiff || headerDiff || show) {
    report.push(`\n${rel}  →  ${relative(dist, page)}`);
    if (bodyDiff) {
      report.push(`  BODY differs (${countDiffs(a, b)} lines of ${a.length}); first at line ${bodyDiff.index}:`);
      report.push('    site:    ' + bodyDiff.site.join('\n             '));
      report.push('    preview: ' + bodyDiff.preview.join('\n             '));
    } else report.push(`  body identical (${a.length} nodes)`);
    if (headerDiff) {
      report.push(`  HEADER differs; first at line ${headerDiff.index}:`);
      report.push('    site:    ' + headerDiff.site.join('\n             '));
      report.push('    preview: ' + headerDiff.preview.join('\n             '));
    } else report.push('  header identical');
    if (result.warnings.length) report.push('  warnings: ' + result.warnings.join(' | '));
  }
}

console.log(report.join('\n'));
console.log(`\nCompared ${compared} posts against ${dist}`);
console.log(`  body   identical: ${identicalBody}/${compared}`);
console.log(`  header identical: ${identicalHeader}/${compared}`);
if (skipped.length) console.log(`  skipped ${skipped.length}: ${skipped.join(', ')}`);
process.exit(identicalBody === compared && identicalHeader === compared ? 0 : 1);
