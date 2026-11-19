import { describe, expect, it } from 'vitest';
import { assemblePost, type PostParts } from '../../contracts';
import { composePost, eol, finalBreakOf, newlineOf, split } from '../split';
import { allFiles, posts } from './content';

const BOM = '﻿';

describe('split → assemble is byte-identical', () => {
  it('for every markdown file under src/content', () => {
    let bytes = 0;
    for (const [path, raw] of allFiles) {
      const parts = split(raw);
      expect(assemblePost(parts), path).toBe(raw);
      // The slices are contiguous cuts of the input, in order.
      expect(parts.bom + parts.open + parts.frontmatter + parts.close + parts.gap + parts.body, path).toBe(raw);
      bytes += new TextEncoder().encode(raw).length;
    }
    expect(allFiles.length).toBeGreaterThan(50);
    console.info(
      `[data] byte-identity: ${allFiles.length}/${allFiles.length} files under src/content round-trip (${bytes} bytes); ` +
        `${posts.length} are published posts, ${allFiles.length - posts.length} ignored by the site`,
    );
  });

  it('every published post has a `---` block, and its body starts at the first non-blank line', () => {
    for (const [path, raw] of posts) {
      const parts = split(raw);
      expect(parts.open, path).toBe('---\n');
      expect(parts.close, path).toBe('---\n');
      expect(parts.frontmatter.endsWith('\n'), path).toBe(true);
      expect(/^[ \t]*\r?\n/.test(parts.body), path).toBe(false);
      expect(/^(?:[ \t]*\n)*$/.test(parts.gap), path).toBe(true);
    }
  });

  it('for every real file converted to CRLF, given a BOM, or stripped of its final newline', () => {
    for (const [path, raw] of allFiles) {
      const crlf = raw.replace(/\n/g, '\r\n');
      const variants = [crlf, BOM + raw, BOM + crlf, raw.replace(/\n+$/, ''), raw + '\n\n', raw.replace(/\n/g, '\r')];
      for (const v of variants) expect(assemblePost(split(v)), path).toBe(v);
      // Same slicing regardless of line ending: converting back gives the LF slices.
      const a = split(raw);
      const b = split(crlf);
      for (const k of Object.keys(a) as (keyof PostParts)[]) expect(b[k].replace(/\r\n/g, '\n'), `${path} ${k}`).toBe(a[k]);
    }
  });

  const cases: [string, string, Partial<PostParts>][] = [
    ['empty file', '', { body: '' }],
    ['no frontmatter', 'just text\n', { open: '', body: 'just text\n' }],
    ['lone fence', '---\n', { open: '', body: '---\n' }],
    ['lone fence, no newline', '---', { open: '', body: '---' }],
    ['unterminated frontmatter', '---\nslug: a\n', { open: '', frontmatter: '', body: '---\nslug: a\n' }],
    ['empty frontmatter', '---\n---\n', { open: '---\n', frontmatter: '', close: '---\n', body: '' }],
    ['no newline after closing fence', '---\nslug: a\n---', { frontmatter: 'slug: a\n', close: '---', gap: '', body: '' }],
    ['empty body', '---\nslug: a\n---\n', { close: '---\n', gap: '', body: '' }],
    ['empty body, blank lines only', '---\nslug: a\n---\n\n\n', { gap: '\n\n', body: '' }],
    ['body without trailing newline', '---\nslug: a\n---\n\nBody', { gap: '\n', body: 'Body' }],
    ['no blank line before body', '---\nslug: a\n---\nBody\n', { gap: '', body: 'Body\n' }],
    ['CRLF', '---\r\nslug: a\r\n---\r\n\r\nBody\r\n', { open: '---\r\n', frontmatter: 'slug: a\r\n', close: '---\r\n', gap: '\r\n', body: 'Body\r\n' }],
    ['CRLF, no final newline', '---\r\nslug: a\r\n---\r\nBody', { close: '---\r\n', gap: '', body: 'Body' }],
    ['mixed line endings', '---\nslug: a\r\ntitle: b\n---\r\n\nBody\r\n', { frontmatter: 'slug: a\r\ntitle: b\n', close: '---\r\n', gap: '\n', body: 'Body\r\n' }],
    ['old Mac CR', '---\rslug: a\r---\r\rBody\r', { open: '---\r', frontmatter: 'slug: a\r', close: '---\r', gap: '\r', body: 'Body\r' }],
    ['BOM', BOM + '---\nslug: a\n---\nBody', { bom: BOM, open: '---\n', body: 'Body' }],
    ['BOM without frontmatter', BOM + 'Body', { bom: BOM, open: '', body: 'Body' }],
    ['BOM only', BOM, { bom: BOM, body: '' }],
    ['thematic break in body', '---\nslug: a\n---\n\n\n\nBody\n\n---\n\nmore\n', { gap: '\n\n\n', body: 'Body\n\n---\n\nmore\n' }],
    ['whitespace on fence and gap lines', '---\nslug: a\n--- \n \n\t\nBody', { close: '--- \n', gap: ' \n\t\n', body: 'Body' }],
    ['trailing spaces on opening fence', '---  \nslug: a\n---\nB', { open: '---  \n', body: 'B' }],
    ['four dashes are not a fence', '----\nslug: a\n---\n', { open: '', body: '----\nslug: a\n---\n' }],
    ['fence must start the file', '\n---\nslug: a\n---\n', { open: '', body: '\n---\nslug: a\n---\n' }],
    ['indented --- inside YAML is not the closing fence', '---\ntext: |\n  ---\n  x\n---\nB\n', { frontmatter: 'text: |\n  ---\n  x\n', body: 'B\n' }],
    ['--- followed by text is not a fence', '---\na: 1\n--- x\n---\nB', { frontmatter: 'a: 1\n--- x\n', body: 'B' }],
    ['body is only whitespace', '---\na: 1\n---\n   ', { gap: '', body: '   ' }],
    ['astral characters and NUL', '---\ntitle: 😀\n---\n\n\u0000𝒳\n', { frontmatter: 'title: 😀\n', body: '\u0000𝒳\n' }],
  ];

  it.each(cases)('%s', (_name, raw, expected) => {
    const parts = split(raw);
    expect(assemblePost(parts)).toBe(raw);
    expect(parts).toMatchObject(expected);
  });

  it('for arbitrary strings (seeded fuzz over fence-ish fragments)', () => {
    const atoms = ['---', '--- ', '\n', '\r\n', '\r', BOM, 'a: 1', ' ', '\t', 'Body', '...', '----', '#', ''];
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let i = 0; i < 5000; i++) {
      const n = 1 + Math.floor(rand() * 9);
      let s = '';
      for (let j = 0; j < n; j++) s += atoms[Math.floor(rand() * atoms.length)];
      const parts = split(s);
      expect(assemblePost(parts)).toBe(s);
      // A block is either fully there or not at all.
      expect(parts.open === '').toBe(parts.close === '');
      if (parts.open === '') expect(parts.frontmatter + parts.gap).toBe('');
    }
  });
});

describe('eol', () => {
  it.each([
    ['', 'lf'],
    ['a', 'lf'],
    ['a\nb\n', 'lf'],
    ['a\r\nb\r\n', 'crlf'],
    ['a\r\nb\n', 'mixed'],
    ['a\rb\r\n', 'mixed'],
    // Bare CR (old Mac) is its own answer, not "lf" (review finding).
    ['a\rb\r', 'cr'],
    ['a\rb\nc\r', 'mixed'],
  ] as const)('%j → %s', (raw, expected) => expect(eol(raw)).toBe(expected));

  it('every content file uses LF today (other line endings are covered with constructed files)', () => {
    for (const [path, raw] of allFiles) expect(eol(raw), path).toBe('lf');
  });

  it('newlineOf: the file’s own break; in a mixed file the one it uses most', () => {
    expect(newlineOf('a\r\nb\r\n')).toBe('\r\n');
    expect(newlineOf('a\r\nb\n')).toBe('\n');
    expect(newlineOf('a\r\nb\r\nc\n')).toBe('\r\n');
    expect(newlineOf('a\rb\r')).toBe('\r');
    expect(newlineOf('')).toBe('\n');
  });
});

describe('composePost: the text of a post being edited', () => {
  it('is assemblePost for every real file, new or not', () => {
    for (const [path, raw] of allFiles) {
      expect(composePost(split(raw), { isNew: false, newline: '\n' }), path).toBe(raw);
      expect(composePost(split(raw), { isNew: true, newline: '\n' }), path).toBe(raw);
      // …and as the writing screen calls it: with the break the file itself ends with.
      expect(composePost(split(raw), { isNew: false, newline: newlineOf(raw), finalBreak: finalBreakOf(raw) }), path).toBe(raw);
    }
  });

  // Review finding: a file ending at its closing `---`; typing body text produced `---X`.
  it('a file that ends at the closing fence gets the fence’s line break once there is body text', () => {
    const raw = '---\nslug: disksurvey\nis_draft: false\n---';
    const parts = split(raw);
    expect(parts.close).toBe('---');
    expect(composePost(parts, { isNew: false, newline: '\n' })).toBe(raw);
    const typed = composePost({ ...parts, body: 'X' }, { isNew: false, newline: '\n' });
    expect(typed).toBe(raw + '\nX');
    // The frontmatter is still frontmatter, and the body is what was typed.
    expect(split(typed).frontmatter).toBe(parts.frontmatter);
    expect(split(typed).body).toBe('X');
    // With the body empty again the file is the original, byte for byte.
    expect(composePost({ ...parts, body: '' }, { isNew: false, newline: '\n' })).toBe(raw);
    // It uses the file's own break.
    const crlf = split('---\r\nslug: a\r\n---');
    expect(composePost({ ...crlf, body: 'X' }, { isNew: false, newline: '\r\n' })).toBe('---\r\nslug: a\r\n---\r\nX');
  });

  it('finalBreakOf: the line break a text ends with', () => {
    expect(finalBreakOf('a\n')).toBe('\n');
    expect(finalBreakOf('a\r\n')).toBe('\r\n');
    expect(finalBreakOf('a\r')).toBe('\r');
    expect(finalBreakOf('a')).toBe('');
    expect(finalBreakOf('a\n ')).toBe('');
    expect(finalBreakOf('')).toBe('');
    expect(finalBreakOf(null)).toBe('');
  });

  // The final verifier's finding: text added under the last line (the caret sits after the final
  // line break there) left the file without one.
  it('a file that ended with a line break keeps ending with one, whatever is added at the end', () => {
    const raw = '---\nslug: a\n---\n\nFirst.\n';
    const parts = split(raw);
    const compose = (body: string, original = raw) => composePost({ ...parts, body }, { isNew: false, newline: newlineOf(original), finalBreak: finalBreakOf(original) });
    expect(compose('First.\n')).toBe(raw);
    expect(compose('First.\nTyped under it')).toBe('---\nslug: a\n---\n\nFirst.\nTyped under it\n');
    expect(compose('First.\n\n![](a/pic.png)')).toBe('---\nslug: a\n---\n\nFirst.\n\n![](a/pic.png)\n');
    expect(compose('First.[^1]\n\n[^1]: Note')).toBe('---\nslug: a\n---\n\nFirst.[^1]\n\n[^1]: Note\n');
    // The final break deleted in the editor: the file is the original again.
    expect(compose('First.')).toBe(raw);
    // Never doubled, and a body emptied out needs none (the file ends with its fence's break).
    expect(compose('First.\n\n')).toBe('---\nslug: a\n---\n\nFirst.\n\n');
    expect(compose('')).toBe('---\nslug: a\n---\n\n');
    // The break is the one the original ended with, also when the file mixes them.
    const crlf = '---\r\nslug: a\r\n---\r\n\r\nFirst.\r\n';
    expect(composePost({ ...split(crlf), body: 'First.\r\nMore' }, { isNew: false, newline: '\r\n', finalBreak: finalBreakOf(crlf) })).toBe(crlf + 'More\r\n');
    const mixed = 'One\r\nTwo\r\nThree\n';
    expect(composePost({ ...split(mixed), body: mixed + 'Four' }, { isNew: false, newline: newlineOf(mixed), finalBreak: finalBreakOf(mixed) })).toBe(mixed + 'Four\n');
  });

  it('a file that did NOT end with a line break is never given one; what the writer types stays', () => {
    const raw = '---\nslug: a\n---\n\nFirst.';
    const parts = split(raw);
    const compose = (body: string) => composePost({ ...parts, body }, { isNew: false, newline: '\n', finalBreak: finalBreakOf(raw) });
    expect(compose('First.')).toBe(raw);
    expect(compose('First. More')).toBe(raw + ' More');
    expect(compose('First.\n')).toBe(raw + '\n');
    // A file without frontmatter, emptied: still empty.
    expect(composePost({ ...split('Text\n'), body: '' }, { isNew: false, newline: '\n', finalBreak: '\n' })).toBe('');
  });

  it('a NEW post gets a final line break; an existing file only when its original had one', () => {
    const parts = split('---\nslug: a\n---\n\nText');
    expect(composePost(parts, { isNew: true, newline: '\n' })).toBe('---\nslug: a\n---\n\nText\n');
    expect(composePost(parts, { isNew: false, newline: '\n' })).toBe('---\nslug: a\n---\n\nText');
    expect(composePost({ ...parts, body: '' }, { isNew: true, newline: '\n' })).toBe('---\nslug: a\n---\n\n');
  });
});
