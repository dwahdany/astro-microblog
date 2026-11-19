/**
 * Preview — public entry.
 *
 * `renderMarkdown(markdown, ctx)` returns the body HTML the published site
 * would produce. The pipeline itself lives in ./render.ts and is loaded on
 * first use, so importing this module costs nothing: unified, remark, rehype,
 * parse5 (and later Shiki / KaTeX, each only when a post needs it) stay out of
 * the app's initial bundle.
 *
 * Read ./render.ts for what is mirrored and the known differences.
 */
import type { RenderMarkdown } from '../contracts';

export type { PreviewRenderContext } from './render';
export type { LinkTarget } from './link-targets';

export const renderMarkdown: RenderMarkdown = async (markdown, ctx) => {
  const { renderMarkdown: render } = await import('./render');
  return render(markdown, ctx);
};
