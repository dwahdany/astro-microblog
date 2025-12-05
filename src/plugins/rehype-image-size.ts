import { visit } from 'unist-util-visit';
import type { Root, Element } from 'hast';

const sizeClasses: Record<string, string> = {
  small: 'img-small',
  medium: 'img-medium',
  full: 'img-full',
};

// Syntax: ![alt text|size](image.png)
// Examples: ![|small](image.png), ![A diagram|medium](image.png)
const SIZE_PATTERN = /\|(\w+)$/;

export function rehypeImageSize() {
  return (tree: Root) => {
    visit(tree, 'element', (node: Element) => {
      if (node.tagName !== 'img') return;

      const alt = node.properties?.alt;
      if (typeof alt !== 'string') return;

      const match = alt.match(SIZE_PATTERN);
      if (!match) return;

      const size = match[1];
      if (!sizeClasses[size]) return;

      // Remove size suffix from alt text
      node.properties.alt = alt.replace(SIZE_PATTERN, '').trim();

      // Add size class
      const existingClass = node.properties.className;
      const classes: string[] = Array.isArray(existingClass)
        ? [...existingClass]
        : typeof existingClass === 'string'
          ? [existingClass]
          : [];

      classes.push(sizeClasses[size]);
      node.properties.className = classes;
    });
  };
}
