/**
 * The markdown dialect the writing surface understands.
 *
 * CommonMark + GFM (tables, task lists, strikethrough, autolinks) from
 * @lezer/markdown, plus four constructs the site's pipeline renders
 * (remark-gfm footnotes, remark-math) that lezer does not ship:
 *
 *   FootnoteReference    [^label]                       inline
 *   FootnoteDefinition   [^label]: text                 block (composite)
 *                            indented continuation      (4 columns, blank lines allowed)
 *   InlineMath           $…$  or  $$…$$ inside a line   inline
 *   BlockMath            $$ on its own line … $$        block
 *
 * This is a PARSER only: it produces a syntax tree over the unchanged text.
 * Nothing here can alter the document.
 *
 * Deliberately built on @lezer/markdown directly, without @codemirror/lang-markdown: importing
 * anything from that package statically drags @codemirror/lang-html (and the CSS and JavaScript
 * language packages behind it) into the main bundle. Here they load on demand, for fenced code.
 * The two commands worth having from it are ported in ./markdownKeys.ts.
 */
import {
  Language,
  LanguageDescription,
  LanguageSupport,
  ParseContext,
  defineLanguageFacet,
  ensureSyntaxTree,
  indentNodeProp,
  languageDataProp,
  syntaxTree,
} from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import type { Tree } from '@lezer/common';
import {
  GFM,
  parseCode,
  parser as commonmark,
  type BlockContext,
  type Element,
  type Line,
  type MarkdownConfig,
  type MarkdownParser,
} from '@lezer/markdown';
import { tags as t } from '@lezer/highlight';

/**
 * A label this editor will WRITE (rename): no whitespace, no square brackets, no backslash, and
 * short enough for the site's parser (micromark reads at most 999 characters as a label).
 */
export const FOOTNOTE_LABEL = /^[^\s[\]\\]{1,999}$/;
const MAX_LABEL = 999;
const BACKSLASH = 92;

const DOLLAR = 36;
const BRACKET_OPEN = 91;
const BRACKET_CLOSE = 93;
const CARET = 94;

function isSpace(ch: number): boolean {
  return ch === 32 || ch === 9 || ch === 10 || ch === 13;
}

/**
 * Where the label that starts at `from` (just after `[^`) ends: the index of its closing `]`, or -1
 * when this is not a label. Read the way the site's parser (micromark's GFM footnotes) reads it, so
 * the editor never draws a footnote the site would print as text: a backslash before `[`, `]` or
 * `\` escapes it (so `[^a\]` has no closing bracket), whitespace and bare brackets end it, and it
 * is at most 999 characters long.
 */
export function footnoteLabelEnd(char: (index: number) => number, from: number, limit: number): number {
  let end = from;
  for (; end < limit; end++) {
    const ch = char(end);
    if (ch === BRACKET_CLOSE) break;
    if (ch === BRACKET_OPEN || isSpace(ch)) return -1;
    if (ch === BACKSLASH) {
      const next = end + 1 < limit ? char(end + 1) : -1;
      if (next === BRACKET_OPEN || next === BRACKET_CLOSE || next === BACKSLASH) end++;
    }
  }
  if (end >= limit || end === from || end - from > MAX_LABEL) return -1;
  return end;
}

/** `[^label]:` at the line's position: the length of that mark and of its label, or null. */
function footnoteDefStart(line: Line): { mark: number; label: number } | null {
  if (line.next !== BRACKET_OPEN || line.indent >= line.baseIndent + 4) return null;
  const text = line.text;
  const at = line.pos;
  if (text.charCodeAt(at + 1) !== CARET) return null;
  const end = footnoteLabelEnd((i) => text.charCodeAt(i), at + 2, text.length);
  if (end < 0 || text.charCodeAt(end + 1) !== 58 /* : */) return null;
  return { mark: end + 2 - at, label: end - (at + 2) };
}

/** Number of `$` in an opening/closing display-math fence at the line's position, or -1. */
function mathFence(line: Line): number {
  if (line.next !== DOLLAR || line.indent >= line.baseIndent + 4) return -1;
  let pos = line.pos;
  while (pos < line.text.length && line.text.charCodeAt(pos) === DOLLAR) pos++;
  const size = pos - line.pos;
  if (size < 2) return -1;
  // Like a backtick fence: the rest of the opening line may not contain the fence character
  // (`$$x$$` on one line is inline math, exactly as remark-math reads it).
  for (let i = pos; i < line.text.length; i++) if (line.text.charCodeAt(i) === DOLLAR) return -1;
  return size;
}

export const footnoteExtension: MarkdownConfig = {
  defineNodes: [
    { name: 'FootnoteReference', style: t.link },
    {
      name: 'FootnoteDefinition',
      block: true,
      composite(_cx: BlockContext, line: Line) {
        // A blank line keeps the definition open (it only extends it if indented content follows).
        if (line.next < 0) return true;
        if (line.indent < line.baseIndent + 4) return false;
        line.moveBaseColumn(line.baseIndent + 4);
        return true;
      },
    },
    { name: 'FootnoteDefinitionMark', style: t.processingInstruction },
    { name: 'FootnoteLabel', style: t.labelName },
  ],
  parseBlock: [
    {
      name: 'FootnoteDefinition',
      // Must win over LinkReference: `[^1]: text` is also a valid link reference definition.
      before: 'LinkReference',
      parse(cx, line) {
        const m = footnoteDefStart(line);
        if (!m) return false;
        const from = cx.lineStart + line.pos;
        cx.startComposite('FootnoteDefinition', line.pos, 0);
        cx.addElement(
          cx.elt('FootnoteDefinitionMark', from, from + m.mark, [cx.elt('FootnoteLabel', from + 2, from + 2 + m.label)]),
        );
        line.moveBase(line.pos + m.mark);
        return null;
      },
      // `[^2]: …` directly under `[^1]: …` starts a new definition instead of continuing the paragraph.
      endLeaf(_cx, line) {
        return footnoteDefStart(line) !== null;
      },
    },
  ],
  parseInline: [
    {
      name: 'FootnoteReference',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== BRACKET_OPEN || cx.char(pos + 1) !== CARET) return -1;
        const end = footnoteLabelEnd((i) => cx.char(i), pos + 2, cx.end);
        if (end < 0) return -1;
        return cx.addElement(cx.elt('FootnoteReference', pos, end + 1, [cx.elt('FootnoteLabel', pos + 2, end)]));
      },
    },
  ],
};

export const mathExtension: MarkdownConfig = {
  defineNodes: [
    { name: 'InlineMath' },
    { name: 'InlineMathMark', style: t.processingInstruction },
    { name: 'BlockMath', block: true },
    { name: 'BlockMathMark', style: t.processingInstruction },
  ],
  parseBlock: [
    {
      name: 'BlockMath',
      before: 'FencedCode',
      parse(cx, line) {
        const size = mathFence(line);
        if (size < 0) return false;
        const from = cx.lineStart + line.pos;
        const children: Element[] = [cx.elt('BlockMathMark', from, from + size)];
        // `depth` on Line is internal API, used the same way by lezer's own FencedCode parser:
        // stop when an enclosing blockquote/list item ends.
        const depthOf = (l: Line) => (l as unknown as { depth: number }).depth;
        while (cx.nextLine() && depthOf(line) >= cx.depth) {
          let i = line.pos;
          if (line.indent - line.baseIndent < 4) {
            while (i < line.text.length && line.text.charCodeAt(i) === DOLLAR) i++;
          }
          for (const marker of line.markers) children.push(marker);
          if (i - line.pos >= size && line.skipSpace(i) === line.text.length) {
            children.push(cx.elt('BlockMathMark', cx.lineStart + line.pos, cx.lineStart + i));
            cx.nextLine();
            break;
          }
        }
        cx.addElement(cx.elt('BlockMath', from, cx.prevLineEnd(), children));
        return true;
      },
      endLeaf(_cx, line) {
        return mathFence(line) >= 0;
      },
    },
  ],
  parseInline: [
    {
      name: 'InlineMath',
      before: 'InlineCode',
      // Same shape as a code span: a run of N dollars closes at the next run of exactly N.
      parse(cx, next, start) {
        if (next !== DOLLAR || (start > cx.offset && cx.char(start - 1) === DOLLAR)) return -1;
        let pos = start + 1;
        while (pos < cx.end && cx.char(pos) === DOLLAR) pos++;
        const size = pos - start;
        let run = 0;
        for (; pos < cx.end; pos++) {
          if (cx.char(pos) === DOLLAR) {
            run++;
            if (run === size && cx.char(pos + 1) !== DOLLAR) {
              return cx.addElement(
                cx.elt('InlineMath', start, pos + 1, [
                  cx.elt('InlineMathMark', start, start + size),
                  cx.elt('InlineMathMark', pos + 1 - size, pos + 1),
                ]),
              );
            }
          } else {
            run = 0;
          }
        }
        return -1;
      },
    },
  ],
};

/** GFM + footnotes + math. Order matters only between our own extensions and the built-ins they name. */
export const writeExtensions = [GFM, footnoteExtension, mathExtension];

const markdownData = defineLanguageFacet({ commentTokens: { block: { open: '<!--', close: '-->' } } });

/** The bare parser (no nested code languages) — what unit tests and pure helpers use. */
export const writeParser: MarkdownParser = commonmark.configure([
  writeExtensions,
  // No automatic indentation rules: a new line keeps the indentation of the one above.
  { props: [languageDataProp.add({ Document: markdownData }), indentNodeProp.add({ Document: () => null })] },
]);

const plainLanguage = new Language(markdownData, writeParser, [], 'markdown');

/**
 * True where the text is markdown itself rather than a language nested in a code block.
 * (Every Language built here shares one data facet, which is what this looks at.)
 */
export function isMarkdownAt(state: EditorState, pos: number, side: -1 | 0 | 1 = 0): boolean {
  return plainLanguage.isActiveAt(state, pos, side);
}

export interface WriteMarkdownOptions {
  /** Languages offered for fenced code blocks; each one loads on first use. */
  codeLanguages?: readonly LanguageDescription[];
}

/** The CodeMirror language for the writing surface. */
export function writeMarkdown(options: WriteMarkdownOptions = {}): LanguageSupport {
  const { codeLanguages } = options;
  let parser = writeParser;
  if (codeLanguages?.length) {
    parser = parser.configure(
      parseCode({
        codeParser(info) {
          const name = /\S*/.exec(info)?.[0] ?? '';
          if (!name) return null;
          const found = LanguageDescription.matchLanguageName(codeLanguages, name, true);
          if (!found) return null;
          return found.support ? found.support.language.parser : ParseContext.getSkippingParser(found.load());
        },
      }),
    );
  }
  return new LanguageSupport(parser === writeParser ? plainLanguage : new Language(markdownData, parser, [], 'markdown'));
}

/**
 * The syntax tree for the whole document. CodeMirror parses lazily (viewport
 * first, the rest in the background); posts are small, so finishing the parse
 * on demand is cheap and keeps commands and decorations correct everywhere.
 */
export function fullTree(state: EditorState): Tree {
  return ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
}
