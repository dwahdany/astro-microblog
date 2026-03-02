import { visit } from 'unist-util-visit';
import type { Root, Element, ElementContent } from 'hast';
import * as fs from 'fs';
import * as path from 'path';
import matter from 'gray-matter';

// URL pattern: blog.wahdany.eu/{year}/{month}/{day}/{slug}/
const INTERNAL_LINK_PATTERN = /^https?:\/\/blog\.wahdany\.eu\/(\d{4})\/([A-Za-z]{3})\/(\d{1,2})\/([^/]+)\/?$/;

// Content directories to search
const CONTENT_DIRS = ['entries', 'blogmarks', 'notes', 'quotations'];

interface PostMeta {
  slug: string;
  title?: string;
  excerpt?: string;
  type: string;
  url: string;
  date: Date;
  linkTitle?: string; // for blogmarks
}

// Cache for post metadata to avoid repeated file reads
// Cache is cleared on each build, but persists during dev hot reloads
const postCache = new Map<string, PostMeta | null>();

function findPostBySlug(slug: string, contentRoot: string): PostMeta | null {
  // Skip cache in development to avoid stale data during hot reloads
  const isDev = process.env.NODE_ENV !== 'production';
  if (!isDev && postCache.has(slug)) {
    return postCache.get(slug)!;
  }

  for (const dir of CONTENT_DIRS) {
    const dirPath = path.join(contentRoot, dir);
    if (!fs.existsSync(dirPath)) continue;

    const files = findMarkdownFiles(dirPath);
    for (const file of files) {
      try {
        const content = fs.readFileSync(file, 'utf-8');
        const { data } = matter(content);

        if (data.slug === slug) {
          const { data: frontmatter, content: mdContent } = matter(content);
          const date = new Date(frontmatter.created);
          const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          const url = `/${date.getFullYear()}/${months[date.getMonth()]}/${date.getDate()}/${slug}/`;

          // Determine title based on content type
          let title = frontmatter.title;
          if (dir === 'blogmarks') {
            title = frontmatter.title || frontmatter.link_title;
          } else if (dir === 'quotations') {
            title = `Quote from ${frontmatter.source}`;
          }

          // For posts without title, extract first sentence from content
          let excerpt = frontmatter.excerpt;
          const hasTitle = title && typeof title === 'string' && title.trim().length > 0;
          if (!hasTitle && !excerpt && mdContent) {
            // Strip markdown links and images, get plain text
            const plainText = mdContent
              .replace(/!\[.*?\]\(.*?\)/g, '') // Remove images
              .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Replace links with text
              .replace(/[#*_`~]/g, '') // Remove markdown formatting
              .trim();
            // Get first sentence or first 120 chars
            const firstSentence = plainText.match(/^[^.!?]+[.!?]/);
            excerpt = firstSentence
              ? firstSentence[0].trim()
              : plainText.slice(0, 120) + (plainText.length > 120 ? '...' : '');
          }

          const meta: PostMeta = {
            slug,
            title: hasTitle ? title : undefined,
            excerpt,
            type: dir.slice(0, -1), // entries -> entry, etc.
            url,
            date,
            linkTitle: dir === 'blogmarks' ? frontmatter.link_title : undefined,
          };

          postCache.set(slug, meta);
          return meta;
        }
      } catch (e) {
        // Skip files that can't be read/parsed
      }
    }
  }

  postCache.set(slug, null);
  return null;
}

function findMarkdownFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(currentDir: string) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.md')) {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

function createPreviewCard(meta: PostMeta, originalUrl: string): Element {
  // Type icons matching the blog's style
  const typeIcons: Record<string, string> = {
    entry: '▸',
    blogmark: '@',
    note: '○',
    quotation: '"',
  };

  const typeColors: Record<string, string> = {
    entry: 'preview-icon-entry',
    blogmark: 'preview-icon-blogmark',
    note: 'preview-icon-note',
    quotation: 'preview-icon-quote',
  };

  // Format date
  const dateStr = meta.date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  // Build the card content
  const contentChildren: ElementContent[] = [];

  // Title or excerpt as main text
  if (meta.title) {
    contentChildren.push({
      type: 'element',
      tagName: 'span',
      properties: { className: 'preview-title' },
      children: [{ type: 'text', value: meta.title }],
    });
  }
  if (meta.excerpt) {
    contentChildren.push({
      type: 'element',
      tagName: 'span',
      properties: { className: meta.title ? 'preview-excerpt' : 'preview-title' },
      children: [{ type: 'text', value: meta.excerpt }],
    });
  }

  // Date footer
  contentChildren.push({
    type: 'element',
    tagName: 'span',
    properties: { className: 'preview-date' },
    children: [{ type: 'text', value: dateStr }],
  });

  return {
    type: 'element',
    tagName: 'div',
    properties: { className: 'internal-link-preview' },
    children: [
      {
        type: 'element',
        tagName: 'a',
        properties: { href: meta.url },
        children: [
          // Icon
          {
            type: 'element',
            tagName: 'span',
            properties: { className: `preview-icon ${typeColors[meta.type] || ''}` },
            children: [{ type: 'text', value: typeIcons[meta.type] || '→' }],
          },
          // Content wrapper
          {
            type: 'element',
            tagName: 'span',
            properties: { className: 'preview-content' },
            children: contentChildren,
          },
        ],
      },
    ],
  };
}

function findInternalLinks(node: Element): { url: string; slug: string }[] {
  const links: { url: string; slug: string }[] = [];

  visit(node, 'element', (child: Element) => {
    if (child.tagName === 'a' && child.properties?.href) {
      const href = String(child.properties.href);
      const match = href.match(INTERNAL_LINK_PATTERN);
      if (match) {
        links.push({ url: href, slug: match[4] });
      }
    }
  });

  return links;
}

export function rehypeInternalLinkPreview() {
  // Get the content root directory
  const contentRoot = path.join(process.cwd(), 'src', 'content');

  return (tree: Root) => {
    const nodesToInsert: { index: number; parent: Element; card: Element }[] = [];

    visit(tree, 'element', (node: Element, index, parent) => {
      // Only process paragraphs
      if (node.tagName !== 'p') return;
      if (index === undefined || !parent) return;

      const links = findInternalLinks(node);
      if (links.length === 0) return;

      // For each internal link, create a preview card
      for (const link of links) {
        const meta = findPostBySlug(link.slug, contentRoot);
        if (meta) {
          const card = createPreviewCard(meta, link.url);
          nodesToInsert.push({ index: index as number, parent: parent as Element, card });
        }
      }
    });

    // Insert cards after their paragraphs (in reverse order to maintain indices)
    for (const { index, parent, card } of nodesToInsert.reverse()) {
      if (parent.children) {
        parent.children.splice(index + 1, 0, card);
      }
    }
  };
}
