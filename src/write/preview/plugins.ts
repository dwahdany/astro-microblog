/**
 * The rehype plugins of the browser pipeline (see render.ts for the order and
 * for what each one stands in for on the site).
 *
 * Ports are kept as close to their originals as a browser allows, and the
 * originals are named so a future diff is easy:
 *   rehypeImageSize      src/plugins/rehype-image-size.ts (copy; a test runs both and compares)
 *   rehypeShiki          @astrojs/markdown-remark dist/rehype-shiki.js + highlight.js
 *   rehypeHeadingIds     @astrojs/markdown-remark dist/rehype-collect-headings.js (without MDX)
 *   rehypeInternalLinks  src/plugins/rehype-internal-link-preview.ts (lookup replaced; a test
 *                        runs both against the real content and compares)
 *   rehypeLocalImages    stands in for Astro's image pipeline (rehype-images.js + astro:assets)
 *   rehypeDefang         preview-only, has no counterpart on the site
 */
import GithubSlugger from 'github-slugger';
import { visit, SKIP } from 'unist-util-visit';
import type { Element, ElementContent, Root, RootContent } from 'hast';
import type { VFile } from 'vfile';
import type { AssetResolver } from '../contracts';
import { INTERNAL_LINK_PATTERN, type LinkTarget } from './link-targets';

type Parent = Root | Element;

function classList(node: Element): string[] {
  const value = node.properties.className ?? node.properties.class;
  if (Array.isArray(value)) return value.map(String);
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
}

function hasElement(tree: Root, test: (node: Element, parent: Parent | undefined) => boolean): boolean {
  let found = false;
  visit(tree, 'element', (node: Element, _index, parent) => {
    if (found) return SKIP;
    if (test(node, parent as Parent | undefined)) found = true;
  });
  return found;
}

/* -------------------------------------------------------------------------- *
 * Image sizes
 * -------------------------------------------------------------------------- */

const SIZE_CLASSES: Record<string, string> = { small: 'img-small', medium: 'img-medium', full: 'img-full' };
const SIZE_PATTERN = /\|(\w+)$/;

/**
 * `![alt|small](x.png)` → `class="img-small"`, the suffix removed from the alt.
 *
 * A copy of the site's plugin rather than an import: that file does not pass
 * this app's stricter type check, and it is not ours to change. The copy is
 * pinned by __tests__/parity.test.ts, which runs the site's file and this one
 * over the same trees.
 */
export function rehypeImageSize() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'img') return;
      const alt = node.properties?.alt;
      if (typeof alt !== 'string') return;
      const match = alt.match(SIZE_PATTERN);
      if (!match) return;
      const size = match[1];
      if (!SIZE_CLASSES[size]) return;

      node.properties.alt = alt.replace(SIZE_PATTERN, '').trim();
      // `class`, not `className`, exactly like the site's plugin.
      const existing = node.properties.class || node.properties.className;
      const classes: string[] = Array.isArray(existing)
        ? existing.map(String)
        : typeof existing === 'string'
          ? [existing]
          : [];
      classes.push(SIZE_CLASSES[size]);
      node.properties.class = classes.join(' ');
    });
  };
}

/* -------------------------------------------------------------------------- *
 * Syntax highlighting
 * -------------------------------------------------------------------------- */

const LANGUAGE_PATTERN = /\blanguage-(\S+)\b/;
/** Astro never highlights `math` blocks: remark-math emits them and rehype-katex consumes them. */
const EXCLUDED_LANGUAGES = ['math'];

interface CodeBlock {
  node: Element;
  parent: Element;
  grandParent: Parent;
  language: string;
}

function collectCodeBlocks(tree: Root): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  const walk = (node: Parent, ancestors: Parent[]) => {
    for (const child of node.children) {
      if (child.type !== 'element') continue;
      const parent = node;
      if (
        child.tagName === 'code' &&
        parent.type === 'element' &&
        parent.tagName === 'pre' &&
        parent.children.length === 1
      ) {
        let language = 'plaintext';
        for (const cls of classList(child)) {
          const match = LANGUAGE_PATTERN.exec(cls);
          if (match) {
            language = match[1];
            break;
          }
        }
        if (!EXCLUDED_LANGUAGES.includes(language)) {
          blocks.push({ node: child, parent, grandParent: ancestors[ancestors.length - 1], language });
        }
      }
      walk(child, [...ancestors, node]);
    }
  };
  walk(tree, []);
  return blocks;
}

function textOf(node: Element): string {
  let text = '';
  visit(node, 'text', (child) => {
    text += child.value;
  });
  return text;
}

/**
 * Highlights every `<pre><code>` exactly as the site does: Astro's own
 * `createShikiHighlighter` (theme github-dark, Oniguruma engine, the
 * `astro-code` class and inline-style transformer), loaded on first use so a
 * post without code blocks never downloads Shiki.
 *
 * Note that Astro highlights blocks WITHOUT a language too (as `plaintext`):
 * that is what gives every code block on the site its `#24292e` background.
 */
export function rehypeShiki(warnings: string[]) {
  return async (tree: Root) => {
    const blocks = collectCodeBlocks(tree);
    if (blocks.length === 0) return;

    const { createShikiHighlighter } = await import('@astrojs/markdown-remark/shiki');
    // Same arguments as Astro's markdownConfigDefaults.shikiConfig.
    const highlighter = await createShikiHighlighter({ langs: [], theme: 'github-dark', themes: {}, langAlias: {} });

    const unknown = new Set<string>();
    for (const { node, parent, grandParent, language } of blocks) {
      const meta = (node.data as { meta?: string } | undefined)?.meta ?? undefined;
      const result = await highlighter.codeToHast(textOf(node), language, {
        meta,
        wrap: false,
        transformers: [],
      });
      const replacement = result.children[0] as Element;
      // Astro falls back to plaintext (with a console warning) for a language Shiki does not know.
      if (
        language !== 'plaintext' &&
        replacement.properties?.dataLanguage === 'plaintext' &&
        !['plain', 'text', 'txt', 'ansi'].includes(language)
      ) {
        unknown.add(language);
      }
      const index = grandParent.children.indexOf(parent);
      if (index !== -1) grandParent.children[index] = replacement;
    }
    for (const language of unknown) {
      warnings.push(`Code language "${language}" is not known to the highlighter; the block is shown as plain text.`);
    }
  };
}

/* -------------------------------------------------------------------------- *
 * Math
 * -------------------------------------------------------------------------- */

/** rehype-katex, loaded only when the post contains math (KaTeX is ~270 kB). */
export function rehypeKatexLazy() {
  return async (tree: Root, file: VFile) => {
    const hasMath = hasElement(tree, (node) => node.tagName === 'code' && classList(node).includes('language-math'));
    if (!hasMath) return;
    const { default: rehypeKatex } = await import('rehype-katex');
    const transform = rehypeKatex() as unknown as (tree: Root, file: VFile) => void;
    transform(tree, file);
  };
}

/* -------------------------------------------------------------------------- *
 * Internal link cards
 * -------------------------------------------------------------------------- */

const TYPE_LABELS: Record<string, string> = {
  entry: 'post',
  blogmark: 'blogmark',
  note: 'note',
  quotation: 'quote',
};

function createPreviewCard(meta: LinkTarget): Element {
  const dateStr = meta.date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const labelText = `↩ Previously · ${TYPE_LABELS[meta.type] || 'post'} · ${dateStr}`;

  const children: ElementContent[] = [
    {
      type: 'element',
      tagName: 'span',
      properties: { className: ['preview-label'] },
      children: [{ type: 'text', value: labelText }],
    },
  ];
  if (meta.title) {
    children.push({
      type: 'element',
      tagName: 'span',
      properties: { className: ['preview-title'] },
      children: [{ type: 'text', value: meta.title }],
    });
  }
  if (meta.excerpt) {
    children.push({
      type: 'element',
      tagName: 'span',
      properties: { className: [meta.title ? 'preview-excerpt' : 'preview-title'] },
      children: [{ type: 'text', value: meta.excerpt }],
    });
  }
  return {
    type: 'element',
    tagName: 'div',
    properties: { className: ['internal-link-preview', `preview-${meta.type}`] },
    children: [{ type: 'element', tagName: 'a', properties: { href: meta.url }, children }],
  };
}

/**
 * After every paragraph that links to a post on blog.wahdany.eu, insert the
 * site's "Previously" card. `lookup` replaces the plugin's filesystem search.
 */
export function rehypeInternalLinks(lookup: (slug: string) => LinkTarget | null | undefined) {
  return (tree: Root) => {
    const inserts: { index: number; parent: Parent; card: Element }[] = [];
    visit(tree, 'element', (node: Element, index, parent) => {
      if (node.tagName !== 'p' || index === undefined || !parent) return;
      visit(node, 'element', (child: Element) => {
        if (child.tagName !== 'a' || !child.properties?.href) return;
        const match = String(child.properties.href).match(INTERNAL_LINK_PATTERN);
        if (!match) return;
        const meta = lookup(match[4]);
        if (meta) inserts.push({ index, parent: parent as Parent, card: createPreviewCard(meta) });
      });
    });
    for (const { index, parent, card } of inserts.reverse()) {
      parent.children.splice(index + 1, 0, card as RootContent & ElementContent);
    }
  };
}

/* -------------------------------------------------------------------------- *
 * Images
 * -------------------------------------------------------------------------- */

function canParseUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Markdown images, resolved through the contract's asset resolver.
 *
 * On the site a relative image is imported by Astro, converted to WebP and
 * emitted as `<img src="/_astro/….webp" width height loading="lazy"
 * decoding="async">`, and an empty alt is dropped. Here the original file is
 * shown (no width/height: the browser learns them on load), with the same
 * loading/decoding/alt behaviour.
 *
 * Like Astro's pipeline this runs BEFORE raw HTML is parsed, so a hand-written
 * `<img src="relative.png">` is left alone — it would 404 on the site too.
 */
export function rehypeLocalImages(resolveAsset: AssetResolver, warnings: string[]) {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'img' || typeof node.properties?.src !== 'string') return;
      const written = node.properties.src;
      let path = written;
      try {
        path = decodeURI(written);
      } catch {
        /* keep the text as written */
      }
      if (canParseUrl(path)) return; // remote image: the site leaves it untouched

      const url = resolveAsset(path);
      if (url === null) {
        warnings.push(`Image not found: ${path}`);
        node.properties.dataWriteMissing = '';
        return;
      }
      node.properties.src = url;
      if (path.startsWith('/')) return; // public/ file: not processed by Astro

      node.properties.loading = 'lazy';
      node.properties.decoding = 'async';
      if (node.properties.alt === '') delete node.properties.alt;
    });
  };
}

/** After raw HTML is parsed: report hand-written `<img>` tags whose relative src cannot work. */
export function rehypeRawImageWarnings(warnings: string[]) {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'img' || typeof node.properties?.src !== 'string') return;
      const src = node.properties.src;
      if (node.properties.loading !== undefined || node.properties.dataWriteMissing !== undefined) return;
      if (src === '' || src.startsWith('/') || src.startsWith('#') || canParseUrl(src)) return;
      warnings.push(`<img src="${src}"> is raw HTML with a relative path; it will not load on the site. Use ![](${src}).`);
    });
  };
}

/* -------------------------------------------------------------------------- *
 * Heading ids
 * -------------------------------------------------------------------------- */

const RAW_NODE_TYPES = new Set(['text', 'raw']);
const CODE_TAG_NAMES = new Set(['code', 'pre']);

/** Astro's rehypeHeadingIds for .md files: github-slugger over the heading text, existing ids kept. */
export function rehypeHeadingIds() {
  return (tree: Root) => {
    const slugger = new GithubSlugger();
    visit(tree, (node) => {
      if (node.type !== 'element') return;
      const { tagName } = node;
      if (tagName[0] !== 'h') return;
      const [, level] = /h([0-6])/.exec(tagName) ?? [];
      if (!level) return;

      let text = '';
      visit(node, (child, _index, parent) => {
        if (child.type === 'element' || parent == null) return;
        const { type, value } = child as { type: string; value: string };
        if (type === 'raw' && /^\n?<.*>\n?$/.test(value)) return;
        if (RAW_NODE_TYPES.has(type)) {
          if (CODE_TAG_NAMES.has((parent as Element).tagName)) text += value;
          else text += value.replace(/\{/g, '${');
        }
      });

      node.properties = node.properties || {};
      if (typeof node.properties.id !== 'string') node.properties.id = slugger.slug(text);
    });
  };
}

/* -------------------------------------------------------------------------- *
 * Defang
 * -------------------------------------------------------------------------- */

/** Elements that execute code, or re-target every URL / navigation of the document. */
const REMOVED_ELEMENTS = new Set(['script', 'base', 'meta', 'object', 'embed']);
const URL_PROPERTIES = ['href', 'src', 'action', 'formAction', 'xLinkHref', 'data', 'poster', 'ping', 'cite'];

/** javascript:, vbscript: and any data: that is not an image — after stripping what browsers ignore in a scheme. */
export function isScriptUrl(value: string): boolean {
  // eslint-disable-next-line no-control-regex
  const compact = value.replace(/[\u0000- \u007f-\u009f]+/g, '').toLowerCase();
  if (compact.startsWith('javascript:') || compact.startsWith('vbscript:')) return true;
  return compact.startsWith('data:') && !compact.startsWith('data:image/');
}

/**
 * Belt and braces, NOT the security boundary. The boundary is the frame: the
 * preview document is sandboxed without `allow-scripts` and carries a
 * `script-src 'none'` policy, so nothing in a post can run even if this pass
 * misses it. This pass exists so that `PreviewResult.html` is also harmless
 * for a caller that puts it somewhere else.
 *
 * The published site does NOT do this — raw HTML there is emitted as written,
 * scripts included.
 */
export function rehypeDefang(warnings: string[]) {
  return (tree: Root) => {
    const removed = new Set<string>();
    let handlers = 0;
    let frames = 0;

    visit(tree, 'element', (node: Element, index, parent) => {
      if (REMOVED_ELEMENTS.has(node.tagName) && parent && index !== undefined) {
        removed.add(node.tagName);
        (parent as Parent).children.splice(index, 1);
        return [SKIP, index];
      }
      if (node.tagName === 'iframe') frames++;
      for (const key of Object.keys(node.properties ?? {})) {
        const value = node.properties[key];
        if (/^on/i.test(key)) {
          delete node.properties[key];
          handlers++;
        } else if (key === 'srcDoc' || key === 'srcdoc') {
          delete node.properties[key];
        } else if (URL_PROPERTIES.includes(key) && typeof value === 'string' && isScriptUrl(value)) {
          delete node.properties[key];
          handlers++;
        }
      }
    });

    if (removed.size > 0) {
      warnings.push(
        `Left out of the preview: ${[...removed].map((tag) => `<${tag}>`).join(', ')}. The published page will include it.`,
      );
    }
    if (handlers > 0) {
      warnings.push('Inline scripts (event handlers or script URLs) are removed in the preview.');
    }
    if (frames > 0) {
      warnings.push('Embedded frames cannot run scripts inside the preview, so an embed may look empty here.');
    }
  };
}
