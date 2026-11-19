import { describe, expect, it } from 'vitest';
import { writeParser } from '../markdown';

/** Compact s-expression of the tree: `Name(children)`; leaves show their text. */
function shape(doc: string): string {
  const tree = writeParser.parse(doc);
  const out: string[] = [];
  tree.iterate({
    enter(node) {
      if (node.name === 'Document') return;
      out.push(node.name + '(');
      if (!node.node.firstChild) out.push(JSON.stringify(doc.slice(node.from, node.to)));
    },
    leave(node) {
      if (node.name === 'Document') return;
      out.push(')');
    },
  });
  return out.join('');
}

function nodes(doc: string, name: string): string[] {
  const found: string[] = [];
  writeParser.parse(doc).iterate({
    enter(node) {
      if (node.name === name) found.push(doc.slice(node.from, node.to));
    },
  });
  return found;
}

describe('footnote references', () => {
  it('parses [^label] as a reference with its label', () => {
    expect(shape('A claim[^1] here.')).toBe('Paragraph(FootnoteReference(FootnoteLabel("1")))');
    expect(nodes('x[^note-a] y[^2]', 'FootnoteLabel')).toEqual(['note-a', '2']);
  });

  it('does not treat it as a link, even when followed by parentheses', () => {
    const s = shape('a[^1](b)');
    expect(s).toContain('FootnoteReference');
    expect(s).not.toContain('Link(');
  });

  it('rejects empty labels, labels with spaces and unclosed brackets', () => {
    expect(nodes('a [^] b', 'FootnoteReference')).toEqual([]);
    expect(nodes('a [^two words] b', 'FootnoteReference')).toEqual([]);
    expect(nodes('a [^open b', 'FootnoteReference')).toEqual([]);
  });

  it('is not parsed inside code', () => {
    expect(nodes('`[^1]`', 'FootnoteReference')).toEqual([]);
    expect(nodes('```\n[^1]\n```', 'FootnoteReference')).toEqual([]);
  });

  it('leaves ordinary links alone', () => {
    expect(shape('[text](url)')).toContain('Link(');
    expect(nodes('[text](url) and [^1]', 'FootnoteReference')).toEqual(['[^1]']);
  });
});

describe('footnote definitions', () => {
  it('parses a one-line definition with inline content', () => {
    expect(shape('[^1]: A *note*.')).toBe(
      'FootnoteDefinition(FootnoteDefinitionMark(FootnoteLabel("1"))Paragraph(Emphasis(EmphasisMark("*")EmphasisMark("*"))))',
    );
  });

  it('is not a link reference definition', () => {
    expect(nodes('[^1]: https://example.com', 'LinkReference')).toEqual([]);
    expect(nodes('[ref]: https://example.com', 'LinkReference')).toHaveLength(1);
  });

  it('keeps consecutive definitions separate (the owner writes them on adjacent lines)', () => {
    const doc = '[^1]: one\n[^2]: two\n[^3]: three';
    expect(nodes(doc, 'FootnoteDefinition')).toEqual(['[^1]: one', '[^2]: two', '[^3]: three']);
  });

  it('includes indented continuation, across blank lines', () => {
    const doc = 'Text.\n\n[^1]: first\n    second\n\n    third para\n\nOutside.';
    expect(nodes(doc, 'FootnoteDefinition')).toEqual(['[^1]: first\n    second\n\n    third para']);
    expect(nodes(doc, 'Paragraph')).toEqual(['Text.', 'first\n    second', 'third para', 'Outside.']);
  });

  it('ends at a blank line followed by unindented text', () => {
    const doc = '[^1]: note\n\nNot part of it.';
    expect(nodes(doc, 'FootnoteDefinition')).toEqual(['[^1]: note']);
  });

  it('allows a lazy continuation line, like any paragraph', () => {
    expect(nodes('[^1]: note\ncontinues', 'FootnoteDefinition')).toEqual(['[^1]: note\ncontinues']);
  });

  it('interrupts a paragraph', () => {
    const doc = 'Paragraph\n[^1]: note';
    expect(nodes(doc, 'Paragraph')).toEqual(['Paragraph', 'note']);
  });

  it('holds block content such as lists and code', () => {
    const doc = '[^1]: intro\n\n    - a\n    - b\n\n    ```js\n    x\n    ```';
    const s = shape(doc);
    expect(s).toContain('BulletList(');
    expect(s).toContain('FencedCode(');
    expect(nodes(doc, 'FootnoteDefinition')).toHaveLength(1);
  });

  it('is not recognised when indented as code', () => {
    expect(nodes('    [^1]: note', 'FootnoteDefinition')).toEqual([]);
  });

  it('can hold references to other notes', () => {
    expect(nodes('[^1]: see[^2]', 'FootnoteReference')).toEqual(['[^2]']);
  });
});

describe('inline math', () => {
  it('parses $…$', () => {
    expect(shape('Let $x^2$ be.')).toBe('Paragraph(InlineMath(InlineMathMark("$")InlineMathMark("$")))');
  });

  it('does not parse markdown inside math', () => {
    expect(nodes('$a_1 * b_2 * c$', 'Emphasis')).toEqual([]);
    expect(nodes('$a_1 * b_2 * c$', 'InlineMath')).toEqual(['$a_1 * b_2 * c$']);
  });

  it('parses $$…$$ within a line as inline math with two-dollar marks', () => {
    const doc = '$$\\text{score}(f) = \\alpha$$';
    expect(nodes(doc, 'InlineMath')).toEqual([doc]);
    expect(nodes(doc, 'InlineMathMark')).toEqual(['$$', '$$']);
    expect(nodes(doc, 'BlockMath')).toEqual([]);
  });

  it('needs a closing run of the same length', () => {
    expect(nodes('costs $5 only', 'InlineMath')).toEqual([]);
    expect(nodes('$$a$ b', 'InlineMath')).toEqual([]);
  });

  it('respects backslash escapes outside math and code spans', () => {
    expect(nodes('\\$5 and \\$6', 'InlineMath')).toEqual([]);
    expect(nodes('`$x$`', 'InlineMath')).toEqual([]);
  });

  it('finds every span in a real sentence from the blog', () => {
    const doc = 'for large $|\\mathcal T|$ of around $50,000$. At $\\varepsilon = 10$ on CIFAR-10';
    expect(nodes(doc, 'InlineMath')).toEqual(['$|\\mathcal T|$', '$50,000$', '$\\varepsilon = 10$']);
  });
});

describe('block math', () => {
  it('parses a fenced $$ block', () => {
    const doc = 'Before\n\n$$\na = b\n$$\n\nAfter';
    expect(nodes(doc, 'BlockMath')).toEqual(['$$\na = b\n$$']);
    expect(nodes(doc, 'BlockMathMark')).toEqual(['$$', '$$']);
  });

  it('does not parse markdown inside', () => {
    const doc = '$$\n# not a heading\n*x*\n$$';
    expect(shape(doc)).toBe('BlockMath(BlockMathMark("$$")BlockMathMark("$$"))');
  });

  it('runs to the end of the document when unclosed', () => {
    const doc = '$$\na = b\nmore';
    expect(nodes(doc, 'BlockMath')).toEqual([doc]);
    expect(nodes(doc, 'BlockMathMark')).toEqual(['$$']);
  });

  it('interrupts a paragraph and is followed by one', () => {
    const doc = 'Text\n$$\nx\n$$\nMore';
    expect(nodes(doc, 'Paragraph')).toEqual(['Text', 'More']);
  });

  it('stays inside its blockquote', () => {
    const doc = '> $$\n> x\n> $$\n\nAfter';
    expect(nodes(doc, 'BlockMath')).toEqual(['$$\n> x\n> $$']);
    expect(nodes(doc, 'Paragraph')).toEqual(['After']);
  });

  it('ends with its list item', () => {
    const doc = '- $$\n  x\nOutside';
    const blocks = nodes(doc, 'BlockMath');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).not.toContain('Outside');
  });
});

describe('GFM still works alongside', () => {
  it('parses strikethrough, tasks, tables and autolinks', () => {
    expect(nodes('~~gone~~', 'Strikethrough')).toHaveLength(1);
    expect(nodes('- [ ] todo\n- [x] done', 'TaskMarker')).toEqual(['[ ]', '[x]']);
    expect(nodes('| a | b |\n| - | - |\n| 1 | 2 |', 'Table')).toHaveLength(1);
    expect(nodes('see https://example.com now', 'URL')).toEqual(['https://example.com']);
  });

  it('does not add sub/superscript or emoji syntax the site does not render', () => {
    expect(shape('H~2~O and x^2^ and :smile:')).toBe('Paragraph("H~2~O and x^2^ and :smile:")');
  });
});
