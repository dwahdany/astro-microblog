/**
 * Test helper: every markdown file under src/content exactly as on disk
 * (Vite `?raw`, asserted against readFileSync in tests/write/foundation.test.ts).
 */
import { isPostPath } from '../paths';

const files = import.meta.glob<string>('/src/content/**/*.md', { query: '?raw', import: 'default', eager: true });

/** [repo path, raw text] for ALL markdown files, including ones the site ignores (portfolio/_README.md). */
export const allFiles: readonly (readonly [string, string])[] = Object.entries(files)
  .map(([key, raw]) => [key.slice(1), raw] as const)
  .sort(([a], [b]) => (a < b ? -1 : 1));

/** Only files the site publishes. */
export const posts = allFiles.filter(([path]) => isPostPath(path));

/**
 * The line ranges top-level keys own, found WITHOUT a YAML parser (so the
 * patch tests do not check the implementation against itself): a key starts
 * at a line beginning with `name:` in column 0 and owns everything up to the
 * next such line. Good for every file in this repo (asserted in patch.test.ts).
 */
export function keyBlocks(frontmatter: string): { key: string; start: number; end: number }[] {
  const lines = frontmatter.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const starts: { key: string; start: number }[] = [];
  lines.forEach((line, i) => {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s|$)/.exec(line);
    if (m) starts.push({ key: m[1], start: i });
  });
  return starts.map((s, i) => ({ ...s, end: i + 1 < starts.length ? starts[i + 1].start : lines.length }));
}

/** Indices (in `before`) of lines that differ, after trimming the common prefix and suffix. */
export function changedRegion(before: string, after: string): { start: number; endBefore: number; endAfter: number } {
  const a = before.split('\n');
  const b = after.split('\n');
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return { start, endBefore: endA, endAfter: endB };
}
