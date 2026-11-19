/**
 * Markdown-aware Enter and Backspace: continue list items and blockquotes on
 * a new line, and take one level of that markup away again.
 *
 * This is `insertNewlineContinueMarkup` and `deleteMarkupBackward` from
 * @codemirror/lang-markdown 6.5.2, ported to TypeScript. ONE deliberate
 * difference: the original renumbers the items below when Enter adds or
 * removes an item in a numbered list (`1. a / 2. b` becomes `1. a / 2. / 3. b`).
 * That rewrites lines the caret was never on, which this app does not do — the
 * new item gets the next number and the lines below stay exactly as written
 * (markdown numbers a list from its first item anyway, so it renders the same).
 * They live here instead of being imported because importing
 * anything from that package statically pulls @codemirror/lang-html (and with
 * it the CSS and JavaScript language packages) into the editor's main bundle;
 * those are loaded on demand for fenced code instead.
 *
 * Original: https://github.com/codemirror/lang-markdown
 *
 * MIT License
 *
 * Copyright (C) 2018-2021 by Marijn Haverbeke <marijn@haverbeke.berlin> and others
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import { indentUnit, syntaxTree } from '@codemirror/language';
import {
  EditorSelection,
  countColumn,
  type ChangeSpec,
  type EditorState,
  type Line,
  type SelectionRange,
  type StateCommand,
  type Text,
} from '@codemirror/state';
import type { KeyBinding } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';

/** Is the position in markdown (as opposed to a nested language inside a code block)? */
export type MarkdownProbe = (state: EditorState, pos: number, side?: -1 | 0 | 1) => boolean;

class Context {
  constructor(
    readonly node: SyntaxNode,
    readonly from: number,
    readonly to: number,
    readonly spaceBefore: string,
    readonly spaceAfter: string,
    readonly type: string,
    readonly item: SyntaxNode | null,
  ) {}

  blank(maxWidth: number | null, trailing = true): string {
    let result = this.spaceBefore + (this.node.name === 'Blockquote' ? '>' : '');
    if (maxWidth != null) {
      while (result.length < maxWidth) result += ' ';
      return result;
    }
    for (let i = this.to - this.from - result.length - this.spaceAfter.length; i > 0; i--) result += ' ';
    return result + (trailing ? this.spaceAfter : '');
  }

  marker(doc: Text, add: number): string {
    const number = this.node.name === 'OrderedList' ? String(+itemNumber(this.item!, doc)![2] + add) : '';
    return this.spaceBefore + number + this.type + this.spaceAfter;
  }
}

function getContext(node: SyntaxNode | null, doc: Text): Context[] {
  const nodes: SyntaxNode[] = [];
  const context: Context[] = [];
  for (let cur = node; cur; cur = cur.parent) {
    if (cur.name === 'FencedCode') return context;
    if (cur.name === 'ListItem' || cur.name === 'Blockquote') nodes.push(cur);
  }
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    let match: RegExpExecArray | null;
    const line = doc.lineAt(node.from);
    const startPos = node.from - line.from;
    if (node.name === 'Blockquote' && (match = /^ *>( ?)/.exec(line.text.slice(startPos)))) {
      context.push(new Context(node, startPos, startPos + match[0].length, '', match[1], '>', null));
    } else if (
      node.name === 'ListItem' &&
      node.parent!.name === 'OrderedList' &&
      (match = /^( *)\d+([.)])( *)/.exec(line.text.slice(startPos)))
    ) {
      let after = match[3];
      let len = match[0].length;
      if (after.length >= 4) {
        after = after.slice(0, after.length - 4);
        len -= 4;
      }
      context.push(new Context(node.parent!, startPos, startPos + len, match[1], after, match[2], node));
    } else if (
      node.name === 'ListItem' &&
      node.parent!.name === 'BulletList' &&
      (match = /^( *)([-+*])( {1,4}\[[ xX]\])?( +)/.exec(line.text.slice(startPos)))
    ) {
      let after = match[4];
      let len = match[0].length;
      if (after.length > 4) {
        after = after.slice(0, after.length - 4);
        len -= 4;
      }
      let type = match[2];
      if (match[3]) type += match[3].replace(/[xX]/, ' ');
      context.push(new Context(node.parent!, startPos, startPos + len, match[1], after, type, node));
    }
  }
  return context;
}

function itemNumber(item: SyntaxNode, doc: Text): RegExpExecArray | null {
  return /^(\s*)(\d+)(?=[.)])/.exec(doc.sliceString(item.from, item.from + 10));
}

function normalizeIndent(content: string, state: EditorState): string {
  const blank = /^[ \t]*/.exec(content)![0].length;
  if (!blank || state.facet(indentUnit) !== '\t') return content;
  const col = countColumn(content, 4, blank);
  let space = '';
  for (let i = col; i > 0; ) {
    if (i >= 4) {
      space += '\t';
      i -= 4;
    } else {
      space += ' ';
      i--;
    }
  }
  return space + content.slice(blank);
}

function isMark(node: SyntaxNode): boolean {
  return node.name === 'QuoteMark' || node.name === 'ListMark';
}

function nonTightList(node: SyntaxNode, doc: Text): boolean {
  if (node.name !== 'OrderedList' && node.name !== 'BulletList') return false;
  const first = node.firstChild!;
  const second = node.getChild('ListItem', 'ListItem');
  if (!second) return false;
  const line1 = doc.lineAt(first.to);
  const line2 = doc.lineAt(second.from);
  const empty = /^[\s>]*$/.test(line1.text);
  return line1.number + (empty ? 0 : 1) < line2.number;
}

function blankLine(context: Context[], state: EditorState, line: Line): string {
  let insert = '';
  for (let i = 0, e = context.length - 2; i <= e; i++) {
    insert += context[i].blank(i < e ? countColumn(line.text, 4, context[i + 1].from) - insert.length : null, i < e);
  }
  return normalizeIndent(insert, state);
}

function contextNodeForDelete(tree: Tree, pos: number): SyntaxNode {
  let node = tree.resolveInner(pos, -1);
  let scan = pos;
  if (isMark(node)) {
    scan = node.from;
    node = node.parent!;
  }
  for (let prev: SyntaxNode | null; (prev = node.childBefore(scan)); ) {
    if (isMark(prev)) {
      scan = prev.from;
    } else if (prev.name === 'OrderedList' || prev.name === 'BulletList') {
      node = prev.lastChild!;
      scan = node.to;
    } else {
      break;
    }
  }
  return node;
}

type RangeResult = { range: SelectionRange; changes?: ChangeSpec };

/**
 * Enter: create a new line carrying the blockquote/list markup of the current
 * one. Directly after the markup of an empty item, removes that markup instead.
 * Returns false outside markdown or when there is nothing to continue, so a
 * plain newline binding must follow it.
 */
export function insertNewlineContinueMarkup(isMarkdown: MarkdownProbe): StateCommand {
  return ({ state, dispatch }) => {
    const tree = syntaxTree(state);
    const { doc } = state;
    let dont: RangeResult | null = null;
    const changes = state.changeByRange((range): RangeResult => {
      if (!range.empty || (!isMarkdown(state, range.from, -1) && !isMarkdown(state, range.from, 1))) return (dont = { range });
      const pos = range.from;
      const line = doc.lineAt(pos);
      const context = getContext(tree.resolveInner(pos, -1), doc);
      while (context.length && context[context.length - 1].from > pos - line.from) context.pop();
      if (!context.length) return (dont = { range });
      const inner = context[context.length - 1];
      if (inner.to - inner.spaceAfter.length > pos - line.from) return (dont = { range });
      const emptyLine = pos >= inner.to - inner.spaceAfter.length && !/\S/.test(line.text.slice(inner.to));
      // Empty line in list
      if (inner.item && emptyLine) {
        if (inner.item.from < line.from && !/^[\s>]*$/.test(line.text.slice(0, inner.to))) return (dont = { range });
        const first = inner.node.firstChild!;
        const second = inner.node.getChild('ListItem', 'ListItem');
        // Not second item or blank line before: delete a level of markup
        if (first.to >= pos || (second && second.to < pos) || (line.from > 0 && !/[^\s>]/.test(doc.lineAt(line.from - 1).text))) {
          const next = context.length > 1 ? context[context.length - 2] : null;
          let delTo: number;
          let insert = '';
          if (next && next.item) {
            // Re-add marker for the list at the next level
            delTo = line.from + next.from;
            insert = next.marker(doc, 1);
          } else {
            delTo = line.from + (next ? next.to : 0);
          }
          const changes: ChangeSpec[] = [{ from: delTo, to: pos, insert }];
          return { range: EditorSelection.cursor(delTo + insert.length), changes };
        }
        // Move second item down, making tight two-item list non-tight
        const insert = blankLine(context, state, line);
        return { range: EditorSelection.cursor(pos + insert.length + 1), changes: { from: line.from, insert: insert + state.lineBreak } };
      }
      if (inner.node.name === 'Blockquote' && emptyLine && line.from) {
        const prevLine = doc.lineAt(line.from - 1);
        const quoted = />\s*$/.exec(prevLine.text);
        // Two aligned empty quoted lines in a row
        if (quoted && quoted.index === inner.from) {
          const changes = state.changes([
            { from: prevLine.from + quoted.index, to: prevLine.to },
            { from: line.from + inner.from, to: line.to },
          ]);
          return { range: range.map(changes), changes };
        }
      }
      const changes: ChangeSpec[] = [];
      const continued = inner.item && inner.item.from < line.from;
      let insert = '';
      // If not dedented
      if (!continued || /^[\s\d.)\-+*>]*/.exec(line.text)![0].length >= inner.to) {
        for (let i = 0, e = context.length - 1; i <= e; i++) {
          insert +=
            i === e && !continued
              ? context[i].marker(doc, 1)
              : context[i].blank(i < e ? countColumn(line.text, 4, context[i + 1].from) - insert.length : null);
        }
      }
      let from = pos;
      while (from > line.from && /\s/.test(line.text.charAt(from - line.from - 1))) from--;
      insert = normalizeIndent(insert, state);
      if (nonTightList(inner.node, state.doc)) insert = blankLine(context, state, line) + state.lineBreak + insert;
      changes.push({ from, to: pos, insert: state.lineBreak + insert });
      return { range: EditorSelection.cursor(from + insert.length + 1), changes };
    });
    if (dont) return false;
    dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'input' }));
    return true;
  };
}

/**
 * Backspace directly after list or blockquote markup: delete one level of it.
 * A list marker is first replaced by spaces (so the item can be continued), a
 * second press deletes those. Returns false anywhere else.
 */
export function deleteMarkupBackward(isMarkdown: MarkdownProbe): StateCommand {
  return ({ state, dispatch }) => {
    const tree = syntaxTree(state);
    let dont: RangeResult | null = null;
    const changes = state.changeByRange((range): RangeResult => {
      const pos = range.from;
      const { doc } = state;
      if (range.empty && isMarkdown(state, range.from)) {
        const line = doc.lineAt(pos);
        const context = getContext(contextNodeForDelete(tree, pos), doc);
        if (context.length) {
          const inner = context[context.length - 1];
          const spaceEnd = inner.to - inner.spaceAfter.length + (inner.spaceAfter ? 1 : 0);
          // Delete extra trailing space after markup
          if (pos - line.from > spaceEnd && !/\S/.test(line.text.slice(spaceEnd, pos - line.from))) {
            return { range: EditorSelection.cursor(line.from + spaceEnd), changes: { from: line.from + spaceEnd, to: pos } };
          }
          if (
            pos - line.from === spaceEnd &&
            // Only apply this if we're on the line that has the construct's syntax, or there's only
            // indentation in the target range
            ((inner.item && line.from <= inner.item.from) || /^[\s>]*$/.test(line.text.slice(0, inner.to)))
          ) {
            const start = line.from + inner.from;
            // Replace a list item marker with blank space
            if (inner.item && inner.node.from < inner.item.from && /\S/.test(line.text.slice(inner.from, inner.to))) {
              let insert = inner.blank(countColumn(line.text, 4, inner.to) - countColumn(line.text, 4, inner.from));
              if (start === line.from) insert = normalizeIndent(insert, state);
              return { range: EditorSelection.cursor(start + insert.length), changes: { from: start, to: line.from + inner.to, insert } };
            }
            // Delete one level of indentation
            if (start < pos) return { range: EditorSelection.cursor(start), changes: { from: start, to: pos } };
          }
        }
      }
      return (dont = { range });
    });
    if (dont) return false;
    dispatch(state.update(changes, { scrollIntoView: true, userEvent: 'delete' }));
    return true;
  };
}

/** Enter and Backspace bindings; give them a higher precedence than the default keymap. */
export function markdownKeymap(isMarkdown: MarkdownProbe): KeyBinding[] {
  return [
    { key: 'Enter', run: insertNewlineContinueMarkup(isMarkdown) },
    { key: 'Backspace', run: deleteMarkupBackward(isMarkdown) },
  ];
}
