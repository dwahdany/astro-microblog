/**
 * renderMarkdown: the body HTML must be what the published site emits.
 * Expected strings marked "site" were taken from a real `astro build` of this
 * repo (dist/client/…); tools/compare-site.ts checks all posts the same way.
 */
import { describe, expect, it } from 'vitest';
import type { PostRef, PreviewContext } from '../../contracts';
import { renderMarkdown as lazyRenderMarkdown } from '../index';
import { targetFromFile } from '../link-targets';
import { isScriptUrl } from '../plugins';
import { renderMarkdown, type PreviewRenderContext } from '../render';

function context(extra: Partial<PreviewRenderContext> = {}): PreviewRenderContext {
  return {
    path: 'src/content/notes/2026/example.md',
    collection: 'notes',
    frontmatter: {},
    resolveAsset: (src) => `/assets/${src.replace(/^\.\//, '')}`,
    ...extra,
  };
}

async function html(markdown: string, extra?: Partial<PreviewRenderContext>): Promise<string> {
  return (await renderMarkdown(markdown, context(extra))).html;
}

describe('markdown basics (Astro defaults)', () => {
  it('renders GFM: tables, strikethrough, task lists, autolinks', async () => {
    const out = await html(
      ['| a | b |', '| - | - |', '| 1 | 2 |', '', '~~gone~~', '', '- [x] done', '- [ ] todo', '', 'https://example.com'].join('\n'),
    );
    expect(out).toContain('<table>');
    expect(out).toContain('<del>gone</del>');
    expect(out).toContain('<input type="checkbox" checked disabled>');
    expect(out).toContain('<a href="https://example.com">https://example.com</a>');
  });

  it('applies smartypants like the site: curly quotes, dashes, ellipsis', async () => {
    const out = await html(`"I'll be there" -- she said... 'really'`);
    expect(out).toBe('<p>“I’ll be there” — she said… ‘really’</p>');
  });

  it('does not touch quotes inside code', async () => {
    const out = await html('Use `"quoted"` here');
    expect(out).toContain('<code>"quoted"</code>');
  });

  it('gives headings github-slugger ids, numbering duplicates', async () => {
    const out = await html(['## Turning goals into actions, or, why', '## Goals', '## Goals', '### `code` & more'].join('\n\n'));
    expect(out).toContain('<h2 id="turning-goals-into-actions-or-why">');
    expect(out).toContain('<h2 id="goals">Goals</h2>');
    expect(out).toContain('<h2 id="goals-1">Goals</h2>');
    expect(out).toContain('<h3 id="code--more">');
  });

  it('is deterministic: the same input renders the same output twice', async () => {
    const source = '## A\n\n## A\n\nText[^1]\n\n[^1]: note';
    expect(await html(source)).toBe(await html(source));
  });

  it('renders an empty document to an empty string', async () => {
    expect(await renderMarkdown('', context())).toEqual({ html: '', warnings: [] });
  });
});

describe('footnotes', () => {
  it('emits the site footnote markup with working jump and back links', async () => {
    const out = await html('Claim.[^1] Again.[^note]\n\n[^1]: First.\n[^note]: Second.');
    // reference → definition
    expect(out).toContain(
      '<sup><a href="#user-content-fn-1" id="user-content-fnref-1" data-footnote-ref="" aria-describedby="footnote-label">1</a></sup>',
    );
    expect(out).toContain('href="#user-content-fn-note" id="user-content-fnref-note"');
    // the section, as on the site
    expect(out).toContain('<section data-footnotes="" class="footnotes"><h2 class="sr-only" id="footnote-label">Footnotes</h2>');
    expect(out).toContain('<li id="user-content-fn-1">');
    // definition → back to the reference
    expect(out).toContain(
      '<a href="#user-content-fnref-1" data-footnote-backref="" aria-label="Back to reference 1" class="data-footnote-backref">↩</a>',
    );
  });

  it('every footnote href points at an id that exists in the output', async () => {
    const out = await html('A[^a] B[^b] A again[^a]\n\n[^a]: one\n[^b]: two');
    const ids = new Set([...out.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const targets = [...out.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(targets.length).toBeGreaterThanOrEqual(5);
    for (const target of targets) expect(ids.has(target), `#${target}`).toBe(true);
  });
});

describe('math', () => {
  it('renders inline and display math with KaTeX', async () => {
    const out = await html('Inline $\\mathcal{T}$ here.\n\n$$\na^2 + b^2 = c^2\n$$');
    // site (curation-leaks): inline math is a bare span.katex with MathML + HTML
    expect(out).toContain(
      '<span class="katex"><span class="katex-mathml"><math xmlns="http://www.w3.org/1998/Math/MathML"><semantics><mrow><mi mathvariant="script">T</mi></mrow><annotation encoding="application/x-tex">\\mathcal{T}</annotation></semantics></math></span>',
    );
    expect(out).toContain('<span class="katex-display">');
    expect(out).not.toContain('language-math');
  });

  it('reports invalid math instead of failing', async () => {
    const result = await renderMarkdown('$\\frac{1}{$', context());
    expect(result.html).toContain('katex-error');
    expect(result.warnings.join('\n')).toMatch(/KaTeX|math/i);
  });

  it('leaves a lone dollar amount alone', async () => {
    expect(await html('It costs $5.')).toBe('<p>It costs $5.</p>');
  });
});

describe('images', () => {
  it('resolves relative images through the resolver, like Astro: lazy, async, empty alt dropped', async () => {
    const out = await html('![](simple-ideas/2025-02-image.png)');
    expect(out).toBe('<p><img src="/assets/simple-ideas/2025-02-image.png" loading="lazy" decoding="async"></p>');
  });

  it('turns the |size suffix into the site class and removes it from the alt', async () => {
    const out = await html('![Voting scheme|medium](./curation-leaks/voting.png)');
    expect(out).toContain('alt="Voting scheme"');
    expect(out).toContain('class="img-medium"');
    expect(out).toContain('src="/assets/curation-leaks/voting.png"');
    expect(await html('![x|small](a.png)')).toContain('class="img-small"');
    expect(await html('![x|full](a.png)')).toContain('class="img-full"');
  });

  it('keeps an unknown size suffix in the alt, as the site does (|large is not a size)', async () => {
    const out = await html('![Pipeline|large](a.png)');
    expect(out).toContain('alt="Pipeline|large"');
    expect(out).not.toContain('class=');
  });

  it('leaves remote images untouched', async () => {
    const seen: string[] = [];
    const out = await html('![logo](https://example.com/a.png)', {
      resolveAsset: (src) => {
        seen.push(src);
        return src;
      },
    });
    expect(out).toBe('<p><img src="https://example.com/a.png" alt="logo"></p>');
    expect(seen).toEqual([]);
  });

  it('passes the decoded path to the resolver and resolves reference-style images', async () => {
    const seen: string[] = [];
    await html('![a](my%20pics/one.png)\n\n![b][ref]\n\n[ref]: two.png', {
      resolveAsset: (src) => {
        seen.push(src);
        return `/r/${src}`;
      },
    });
    expect(seen).toEqual(['my pics/one.png', 'two.png']);
  });

  it('warns about an image the resolver cannot find and marks it', async () => {
    const result = await renderMarkdown('![x](../../../etc/passwd.png)', context({ resolveAsset: () => null }));
    expect(result.warnings).toEqual(['Image not found: ../../../etc/passwd.png']);
    expect(result.html).toContain('data-write-missing');
  });

  it('does not resolve a raw <img> (the site does not either) and says so', async () => {
    const result = await renderMarkdown('<img src="pics/a.png" alt="x">', context());
    expect(result.html).toContain('<img src="pics/a.png" alt="x">');
    expect(result.warnings.join('\n')).toContain('raw HTML with a relative path');
  });
});

describe('code blocks', () => {
  it('highlights with Astro’s Shiki setup (github-dark, astro-code)', async () => {
    const out = await html('```bash\nclaudia () {\n        local dir=$(mktemp -d /tmp/claudia.XXXXXX)\n}\n```');
    // site (notes/2026/claudia)
    expect(out).toContain(
      '<pre class="astro-code github-dark" style="background-color:#24292e;color:#e1e4e8; overflow-x: auto;" tabindex="0" data-language="bash"><code><span class="line"><span style="color:#B392F0">claudia</span><span style="color:#E1E4E8"> () {</span></span>',
    );
    expect(out).toContain('<span style="color:#F97583">        local</span>');
  });

  it('wraps a block without a language as plaintext, like the site', async () => {
    const out = await html('```\nplain "text"\n```');
    expect(out).toBe(
      '<pre class="astro-code github-dark" style="background-color:#24292e;color:#e1e4e8; overflow-x: auto;" tabindex="0" data-language="plaintext"><code><span class="line"><span>plain "text"</span></span></code></pre>',
    );
  });

  it('falls back to plain text for an unknown language and warns', async () => {
    const result = await renderMarkdown('```notalanguage\nx\n```', context());
    expect(result.html).toContain('data-language="plaintext"');
    expect(result.warnings.join('\n')).toContain('"notalanguage"');
  });

  it('highlights code inside raw HTML containers (details)', async () => {
    const out = await html('<details><summary>Profile</summary>\n\n```plain\ncat file\n```\n\n</details>');
    expect(out).toContain('<details><summary>Profile</summary>');
    expect(out).toContain('data-language="plain"');
  });
});

describe('raw HTML and scripts', () => {
  it('passes harmless raw HTML through', async () => {
    const out = await html('<details open><summary>More</summary>\n\nHidden **text**\n\n</details>\n\nA <kbd>⌘</kbd> key and <span style="color:red">red</span>.');
    expect(out).toContain('<details open><summary>More</summary>');
    expect(out).toContain('<strong>text</strong>');
    expect(out).toContain('<kbd>⌘</kbd>');
    expect(out).toContain('<span style="color:red">red</span>');
  });

  it('removes scripts, handlers and script URLs, and reports it', async () => {
    const result = await renderMarkdown(
      [
        '<script>window.top.pwned = 1</script>',
        '',
        '<img src="https://example.com/x.png" onerror="alert(1)">',
        '',
        '<a href="javascript:alert(1)">raw link</a> and [md link](javascript:alert(2))',
        '',
        '<a href=" jav&#x09;ascript:alert(3)">sneaky</a>',
        '',
        '<base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example/">',
        '',
        '<iframe srcdoc="<script>alert(4)</script>" src="https://www.youtube.com/embed/x"></iframe>',
        '',
        '<svg><a xlink:href="javascript:alert(5)"><text>x</text></a></svg>',
      ].join('\n'),
      context(),
    );
    expect(result.html).not.toMatch(/<script/i);
    expect(result.html).not.toMatch(/onerror/i);
    expect(result.html).not.toMatch(/javascript:/i);
    expect(result.html).not.toMatch(/ascript:/i);
    expect(result.html).not.toMatch(/<base|<meta/i);
    expect(result.html).not.toMatch(/srcdoc/i);
    expect(result.html).toContain('<iframe src="https://www.youtube.com/embed/x"></iframe>');
    expect(result.html).toContain('raw link</a>');
    const warnings = result.warnings.join('\n');
    expect(warnings).toContain('<script>');
    expect(warnings).toContain('Inline scripts');
    expect(warnings).toContain('Embedded frames');
  });

  it('recognises script URLs however they are disguised', () => {
    for (const url of ['javascript:x', 'JaVaScRiPt:x', ' java\tscript:x', 'java\nscript:x', 'vbscript:x', 'data:text/html,<script>']) {
      expect(isScriptUrl(url), url).toBe(true);
    }
    for (const url of ['https://example.com', '/a', '#fn-1', 'mailto:a@b.c', 'data:image/png;base64,AAAA', 'my-javascript:notes.png']) {
      expect(isScriptUrl(url), url).toBe(false);
    }
  });
});

describe('internal link cards', () => {
  const bubbles = targetFromFile(
    'entries',
    { slug: 'bubbles', title: 'Bubbles', created: '2025-10-06T08:00:00+00:00', excerpt: 'About bubbles.' },
    'Body',
  )!;

  it('adds a "Previously" card after a paragraph linking to a post', async () => {
    const out = await html('See [this](https://blog.wahdany.eu/2025/Oct/6/bubbles/) for more.\n\nNext paragraph.', {
      linkTargets: [bubbles],
    });
    // `preview-entrie` is not a typo here: the site's plugin derives the type
    // with `'entries'.slice(0, -1)`, so that is the class the published page
    // carries (and why entry cards never get their green border). The preview
    // shows what the site shows.
    expect(out).toBe(
      '<p>See <a href="https://blog.wahdany.eu/2025/Oct/6/bubbles/">this</a> for more.</p>' +
        '<div class="internal-link-preview preview-entrie"><a href="/2025/Oct/6/bubbles/">' +
        '<span class="preview-label">↩ Previously · post · Oct 6, 2025</span>' +
        '<span class="preview-title">Bubbles</span>' +
        '<span class="preview-excerpt">About bubbles.</span></a></div>\n' +
        '<p>Next paragraph.</p>',
    );
  });

  it('adds no card for unknown posts, external links or non-permalink URLs', async () => {
    const out = await html(
      '[a](https://blog.wahdany.eu/2025/Oct/6/unknown/) [b](https://example.com/2025/Oct/6/bubbles/) [c](https://blog.wahdany.eu/bubbles/)',
      { linkTargets: [bubbles] },
    );
    expect(out).not.toContain('internal-link-preview');
  });

  it('falls back to the post list when no exact targets are given', async () => {
    const post: PostRef = {
      id: 'src/content/notes/2026/headless-claude.md',
      path: 'src/content/notes/2026/headless-claude.md',
      collection: 'notes',
      slug: 'headless-claude',
      title: 'Headless Claude',
      created: '2026-01-08T10:00:00+00:00',
      createdMs: Date.parse('2026-01-08T10:00:00+00:00'),
      tags: [],
      draft: false,
      excerpt: 'Running it without a terminal.',
      isNew: false,
    };
    const out = await html('<https://blog.wahdany.eu/2026/Jan/8/headless-claude/>', { posts: [post] });
    expect(out).toContain('<div class="internal-link-preview preview-note"><a href="/2026/Jan/8/headless-claude/">');
    expect(out).toContain('↩ Previously · note · Jan 8, 2026');
    expect(out).toContain('<span class="preview-title">Headless Claude</span>');
  });
});

describe('public entry', () => {
  it('index.ts renders through the lazily loaded pipeline with a plain PreviewContext', async () => {
    const ctx: PreviewContext = context();
    const result = await lazyRenderMarkdown('# Hello *you*', ctx);
    expect(result).toEqual({ html: '<h1 id="hello-you">Hello <em>you</em></h1>', warnings: [] });
  });
});
