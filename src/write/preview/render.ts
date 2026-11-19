/**
 * The preview renderer: markdown → the HTML the published site would put
 * inside its `.prose` container.
 *
 * WHY THIS RUNS IN THE BROWSER
 * The site's real pipeline cannot be called at runtime. It lives in Astro's
 * Vite build (Node): `@astrojs/markdown-remark` does not even load in the
 * workerd runtime this project uses in dev and production ("Failed to load url
 * tty" — there is no `nodejs_compat`), the site's own link-card plugin reads
 * src/content with `fs`, and images are resolved by a Vite transform. A
 * browser pipeline also keeps working offline, which matters on a phone.
 *
 * WHAT IT MIRRORS
 * Astro 6 / @astrojs/markdown-remark 7.1 `createMarkdownProcessor` with this
 * repo's astro.config.mjs, plugin for plugin and in the same order:
 *
 *   site                               here
 *   ---------------------------------  ---------------------------------------
 *   remark-parse                       same package
 *   remark-gfm            (default)    same package
 *   remark-smartypants    (default)    same package, same pinned version
 *   remark-math           (config)     same package
 *   remark-collect-images (internal)   — (folded into rehypeLocalImages)
 *   remark-rehype {allowDangerousHtml} same package, same options
 *   rehype-shiki          (default)    Astro's own highlighter, lazy-loaded
 *   rehypeImageSize       (config)     copy, pinned to the site's file by a test
 *   rehypeInternalLinkPreview (config) port, pinned by a test; lookup from ctx, not fs
 *   rehype-katex          (config)     same package, lazy-loaded
 *   rehype-images         (internal)   rehypeLocalImages via ctx.resolveAsset
 *   rehype-heading-ids    (internal)   port
 *   rehype-raw                         same package
 *   —                                  rehypeDefang (preview only)
 *   rehype-stringify {allowDangerousHtml} same package, same options
 *
 * KNOWN DIFFERENCES FROM THE PUBLISHED HTML
 *  - Images: the original file is shown instead of Astro's optimised WebP, and
 *    there are no width/height attributes.
 *  - `<script>`, `<base>`, `<meta>`, `<object>`, `<embed>`, inline event
 *    handlers and script URLs are removed (the site emits them as written).
 *  - Link cards use UTC dates (the build's zone); with only `ctx.posts`
 *    available a titled post's card has no excerpt line (see link-targets.ts).
 *  - Nothing else is known to differ; tools/compare-site.ts checks every post
 *    against a real build.
 */
import rehypeRaw from 'rehype-raw';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import remarkSmartypants from 'remark-smartypants';
import { unified } from 'unified';
import type { PreviewContext, PreviewResult } from '../contracts';
import { findPostRefBySlug, targetFromPostRef, type LinkTarget } from './link-targets';
import {
  rehypeDefang,
  rehypeHeadingIds,
  rehypeImageSize,
  rehypeInternalLinks,
  rehypeKatexLazy,
  rehypeLocalImages,
  rehypeRawImageWarnings,
  rehypeShiki,
} from './plugins';

/**
 * `PreviewContext` plus what only the preview area knows about. Passing a
 * plain `PreviewContext` is always fine.
 */
export interface PreviewRenderContext extends PreviewContext {
  /**
   * Exact card data for internal links (see link-targets.ts). When absent the
   * cards are approximated from `posts`; when both are absent there are none.
   */
  linkTargets?: readonly LinkTarget[];
}

function linkLookup(ctx: PreviewRenderContext): (slug: string) => LinkTarget | null {
  const exact = new Map<string, LinkTarget>();
  for (const target of ctx.linkTargets ?? []) if (!exact.has(target.slug)) exact.set(target.slug, target);
  return (slug) => {
    const hit = exact.get(slug);
    if (hit) return hit;
    const ref = ctx.posts ? findPostRefBySlug(ctx.posts, slug) : undefined;
    return ref ? targetFromPostRef(ref) : null;
  };
}

export async function renderMarkdown(markdown: string, ctx: PreviewRenderContext): Promise<PreviewResult> {
  const warnings: string[] = [];

  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkSmartypants, {})
    .use(remarkMath)
    .use(remarkRehype, { allowDangerousHtml: true, passThrough: [] })
    .use(rehypeShiki, warnings)
    .use(rehypeImageSize)
    .use(rehypeInternalLinks, linkLookup(ctx))
    .use(rehypeKatexLazy)
    .use(rehypeLocalImages, ctx.resolveAsset, warnings)
    .use(rehypeHeadingIds)
    .use(rehypeRaw)
    .use(rehypeRawImageWarnings, warnings)
    .use(rehypeDefang, warnings)
    .use(rehypeStringify, { allowDangerousHtml: true })
    .process(markdown);

  for (const message of file.messages) {
    const where = message.line ? ` (line ${message.line})` : '';
    const cause = message.cause instanceof Error ? `: ${message.cause.message}` : '';
    warnings.push(`${message.reason}${cause}${where}`);
  }

  return { html: String(file), warnings: [...new Set(warnings)] };
}
