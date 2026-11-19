/**
 * Regression tests for the editor findings of the pre-release review. Each
 * block names the finding it pins down. State level only (no DOM): the
 * browser-level counterparts are in tests/write/editor-harness/editor.spec.ts.
 */
import { describe, expect, it } from 'vitest';
import { EditorSelection, type EditorState, type Transaction } from '@codemirror/state';
import type { Decoration } from '@codemirror/view';
import { unified } from 'unified';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { visit } from 'unist-util-visit';
import { insertRule, pureCommands, selectionState, toggleInline, toggleLink } from '../commands';
import {
  appendDefinitionSafely,
  footnoteInsertPos,
  getFootnotes,
  hasDefinitionLine,
  insertFootnote,
  isValidFootnoteLabel,
  renameFootnote,
} from '../footnotes';
import { buildDecorations, livePreview, livePreviewConfig, setFocused } from '../livePreview';
import { isMarkdownAt } from '../markdown';
import { insertNewlineContinueMarkup } from '../markdownKeys';
import { ImageWidget } from '../widgets';
import { run, show, stateOf } from './helpers';

/** What the SITE's parser (remark-gfm) makes of a text: its footnote references and definitions. */
function siteFootnotes(markdown: string): { refs: string[]; defs: string[] } {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const refs: string[] = [];
  const defs: string[] = [];
  visit(tree, (node) => {
    if (node.type === 'footnoteReference') refs.push((node as { label?: string }).label ?? '');
    if (node.type === 'footnoteDefinition') defs.push((node as { label?: string }).label ?? '');
  });
  return { refs, defs };
}

const editorFootnotes = (markdown: string) => {
  const index = getFootnotes(stateOf(markdown));
  return { refs: index.refs.map((r) => r.label), defs: index.defs.map((d) => d.label) };
};

const footnote = (marked: string): string | null => {
  const state = stateOf(marked);
  const made = insertFootnote(state);
  return made ? show(state.update(made.spec).state) : null;
};

describe('Footnote button when the document ends in an unclosed code fence (a new `[^n]:` line per keystroke)', () => {
  const body = 'Some text here.|\n\n```js\nlet a = 1;\n';

  it('closes the open block first, so the note is a note — here and on the site', () => {
    const after = footnote(body)!;
    expect(after).toBe('Some text here.[^1]|\n\n```js\nlet a = 1;\n```\n\n[^1]: \n');
    const text = after.replace('|', '');
    expect(editorFootnotes(text)).toEqual({ refs: ['1'], defs: ['1'] });
    expect(siteFootnotes(text.replace('[^1]: \n', '[^1]: hello\n'))).toEqual({ refs: ['1'], defs: ['1'] });
  });

  it('typing the note after that edits ONE definition (the reviewer’s "hello")', () => {
    let state = stateOf(body);
    state = state.update(insertFootnote(state)!.spec).state;
    for (const ch of 'hello') {
      // What the note panel does on a keystroke when the note has a definition: insert at its end.
      const def = getFootnotes(state).byKey.get('1')!.defs[0];
      expect(def, `before typing ${ch}`).toBeDefined();
      state = state.update({ changes: { from: def.to, insert: ch } }).state;
    }
    expect(state.sliceDoc()).toBe('Some text here.[^1]\n\n```js\nlet a = 1;\n```\n\n[^1]: hello\n');
    expect(state.sliceDoc().match(/\[\^1\]:/g)).toHaveLength(1);
  });

  it('the same for an unclosed display-math block and a tilde fence', () => {
    expect(footnote('Text|\n\n$$\nx^2\n')).toBe('Text[^1]|\n\n$$\nx^2\n$$\n\n[^1]: \n');
    expect(footnote('Text|\n\n~~~~\ncode\n')).toBe('Text[^1]|\n\n~~~~\ncode\n~~~~\n\n[^1]: \n');
  });

  it('a note typed for a reference that has none goes through the same check', () => {
    const state = stateOf('See[^7].\n\n```\nopen\n');
    const changes = appendDefinitionSafely(state, '7', 'h')!;
    const next = state.update({ changes }).state;
    expect(next.sliceDoc()).toBe('See[^7].\n\n```\nopen\n```\n\n[^7]: h\n');
    expect(getFootnotes(next).byKey.get('7')!.defs).toHaveLength(1);
  });

  it('never appends when it would not be read as a note, and sees a `[^n]:` line that is only text', () => {
    // The definition line exists but sits inside a (closed) code block: it is text, not a note.
    const stuck = stateOf('A[^1]\n\n```\n[^1]: h\n```\n');
    expect(getFootnotes(stuck).byKey.get('1')!.defs).toHaveLength(0);
    expect(hasDefinitionLine(stuck, '1')).toBe(true);
    expect(hasDefinitionLine(stateOf('A[^1]\n'), '1')).toBe(false);
    // An unclosed HTML comment at the end swallows everything after it: refuse rather than write into it.
    const comment = stateOf('Text|\n\n<!-- never closed\n');
    expect(insertFootnote(comment)).toBeNull();
    expect(appendDefinitionSafely(stateOf('A[^1]\n\n<!-- never closed\n'), '1', 'x')).toBeNull();
  });

  it('ordinary documents are appended to exactly as before', () => {
    expect(footnote('Text|\n')).toBe('Text[^1]|\n\n[^1]: \n');
    expect(footnote('Text|[^1]\n\n[^1]: one\n')).toBe('Text[^2]|[^1]\n\n[^1]: one\n[^2]: \n');
    expect(footnote('```js\ncode\n```\n\nText|\n')).toBe('```js\ncode\n```\n\nText[^1]|\n\n[^1]: \n');
  });
});

describe('Footnote button inside link text, inline code, math, addresses and code blocks', () => {
  it('goes right after a link, code span, inline math or image the caret is in', () => {
    expect(footnote('See [the docs|](https://example.com/docs)')).toBe('See [the docs](https://example.com/docs)[^1]|\n\n[^1]: ');
    expect(footnote('See [the docs](http|://x.y) now')).toBe('See [the docs](http://x.y)[^1]| now\n\n[^1]: ');
    expect(footnote('on `code|` here')).toBe('on `code`[^1]| here\n\n[^1]: ');
    expect(footnote('so $x|+y$ holds')).toBe('so $x+y$[^1]| holds\n\n[^1]: ');
    expect(footnote('![alt|](pic.png) text')).toBe('![alt](pic.png)[^1]| text\n\n[^1]: ');
  });

  it('what it inserts is a footnote to the site’s parser too', () => {
    for (const marked of ['See [the docs|](https://example.com/docs)', 'on `code|` here', 'so $x|+y$ holds', '**bold|** text', '> quote|']) {
      const text = footnote(marked)!.replace('|', '').replace(/\[\^1\]: $/, '[^1]: note');
      expect(siteFootnotes(text), marked).toEqual({ refs: ['1'], defs: ['1'] });
      expect(editorFootnotes(text), marked).toEqual({ refs: ['1'], defs: ['1'] });
    }
  });

  it('does not apply inside a code block, display math or raw HTML', () => {
    expect(footnote('```js\nlet a = 1;|\n```\n\nText\n')).toBeNull();
    expect(footnote('    indented| code\n\nText\n')).toBeNull();
    expect(footnote('$$\nx|^2\n$$\n')).toBeNull();
    expect(footnote('<div>\nraw| html\n</div>\n')).toBeNull();
    expect(pureCommands.footnote(stateOf('```\ncode|\n```\n'))).toBeNull();
    expect(footnoteInsertPos(stateOf('plain text'), 5)).toBe(5);
  });

  it('the toolbar is told when the caret is in literal text', () => {
    expect(selectionState(stateOf('```js\nlet a = 1;|\n```\n')).literal).toBe(true);
    expect(selectionState(stateOf('$$\nx|^2\n$$\n')).literal).toBe(true);
    expect(selectionState(stateOf('plain| text')).literal).toBe(false);
    expect(selectionState(stateOf('`inline|` code')).literal).toBe(false);
  });
});

describe('Footnote labels the site does not read as footnotes', () => {
  it('renaming refuses a backslash and an over-long label', () => {
    const state = stateOf('A[^1] B[^2] C[^1]\n\n[^1]: one\n[^2]: two\n');
    expect(renameFootnote(state, '1', 'a\\')).toEqual({ error: 'invalid' });
    expect(renameFootnote(state, '1', 'a\\]b')).toEqual({ error: 'invalid' });
    expect(renameFootnote(state, '1', 'x'.repeat(1000))).toEqual({ error: 'invalid' });
    expect(isValidFootnoteLabel('x'.repeat(999))).toBe(true);
    expect(isValidFootnoteLabel('note-1')).toBe(true);
    expect('spec' in renameFootnote(state, '1', 'note')).toBe(true);
  });

  it('the editor and the site agree on what is a footnote, escapes and long labels included', () => {
    const cases = [
      'a[^a\\]\n\n[^a\\]: one\n',
      'a[^a\\]b]\n\n[^a\\]b]: one\n',
      'a[^a\\\\]\n\n[^a\\\\]: one\n',
      'a[^a\\b]\n\n[^a\\b]: one\n',
      'a[^1]\n\n[^1]: one\n',
      'a\\[^1]\n\n[^1]: one\n',
      `a[^${'x'.repeat(999)}]\n\n[^${'x'.repeat(999)}]: one\n`,
      `a[^${'x'.repeat(1000)}]\n\n[^${'x'.repeat(1000)}]: one\n`,
      'a[^ b]\n\n[^ b]: one\n',
      'a[^b c]\n',
      'a[^]\n',
    ];
    for (const text of cases) {
      const site = siteFootnotes(text);
      const here = editorFootnotes(text);
      expect(here.refs.length, JSON.stringify(text.slice(0, 40))).toBe(site.refs.length);
      expect(here.defs.length, JSON.stringify(text.slice(0, 40))).toBe(site.defs.length);
    }
  });
});

describe('Math and Link buttons on text that only looks like their construct', () => {
  const math = (s: EditorState) => toggleInline(s, 'math');

  it('a caret between two prices does not strip the dollar signs', () => {
    expect(run('Price is $5 a|nd $6 today.', math)).toBeNull();
    expect(run('From $10 to| $20 or more', math)).toBeNull();
  });

  it('real math still toggles, and a selection always says what is meant', () => {
    expect(run('so $x|+y$ holds', math)).toBe('so x|+y holds');
    expect(run('so $\\alpha| \\beta$ holds', math)).toBe('so \\alpha| \\beta holds');
    expect(run('Price is $⟦5 and ⟧$6 today.', math)).toBe('Price is ⟦5 and ⟧6 today.');
    expect(run('a ⟦x^2⟧ b', math)).toBe('a $⟦x^2⟧$ b');
  });

  it('Link with the caret in a bare address uses the whole address', () => {
    expect(run('See the docs at https://exa|mple.com/a_b_(c) now.', toggleLink)).toBe('See the docs at [|](<https://example.com/a_b_(c)>) now.');
    expect(run('See https://exa|mple.com/page.', toggleLink)).toBe('See [|](https://example.com/page).');
    expect(run('See <http://au|to.link> there', toggleLink)).toBe('See [|](http://auto.link) there');
    // A word is still a word.
    expect(run('See the do|cs now', toggleLink)).toBe('See the [docs](|) now');
  });

  it('the result is a link to the same address on the site', () => {
    const out = run('See https://exa|mple.com/page.', toggleLink)!.replace('|', 'here');
    const tree = unified().use(remarkParse).use(remarkGfm).parse(out);
    const urls: string[] = [];
    visit(tree, 'link', (node) => void urls.push((node as { url: string }).url));
    expect(urls).toEqual(['https://example.com/page']);
  });

  it('Divider does not write `---` into a code block, display math or raw HTML', () => {
    expect(run('```\ncode|\n```\n', insertRule)).toBeNull();
    expect(run('$$\nx|\n$$\n', insertRule)).toBeNull();
    expect(run('Text|\n', insertRule)).toBe('Text\n\n---\n|');
  });
});

describe('Enter in a numbered list', () => {
  const enter = (marked: string): string => {
    const state = stateOf(marked);
    let next: Transaction | undefined;
    const done = insertNewlineContinueMarkup(isMarkdownAt)({ state, dispatch: (tr) => (next = tr) });
    expect(done).toBe(true);
    return show(next!.state);
  };

  it('numbers the new item and leaves the lines below exactly as written', () => {
    expect(enter('1. a|\n2. b\n3. c\n')).toBe('1. a\n2. |\n2. b\n3. c\n');
    expect(enter('5. a|\n6. b\n9. c\n')).toBe('5. a\n6. |\n6. b\n9. c\n');
    expect(enter('1. a\n2. b|\n')).toBe('1. a\n2. b\n3. |\n');
    expect(enter('1. a|\n1. b\n1. c\n')).toBe('1. a\n2. |\n1. b\n1. c\n');
  });

  it('only the caret’s line and the new one differ from the original', () => {
    const before = '1. a|\n2. b\n3. c\n4. d\n';
    const after = enter(before).replace('|', '').split('\n');
    const original = before.replace('|', '').split('\n');
    expect(after.filter((line) => !original.includes(line))).toEqual(['2. ']);
    expect(original.every((line) => after.includes(line))).toBe(true);
  });

  it('the site renders the same list either way (markdown numbers from the first item)', () => {
    const tree = unified().use(remarkParse).use(remarkGfm).parse('1. a\n2. new\n2. b\n3. c\n');
    const lists: number[] = [];
    visit(tree, 'list', (node) => void lists.push((node as { children: unknown[] }).children.length));
    expect(lists).toEqual([4]);
  });
});

describe('Typing an image address (one request per keystroke)', () => {
  const widgets = (state: EditorState): ImageWidget[] => {
    const out: ImageWidget[] = [];
    for (const iter = buildDecorations(state).decorations.iter(); iter.value; iter.next()) {
      const widget = (iter.value as Decoration).spec.widget as unknown;
      if (widget instanceof ImageWidget) out.push(widget);
    }
    return out;
  };
  const preview = (marked: string, focused = true): EditorState => {
    const state = stateOf(marked, [livePreviewConfig.of({ resolveAsset: (src) => `resolved:${src}`, onFootnote: () => {}, onImage: () => {} }), livePreview()]);
    return focused ? state.update({ effects: setFocused.of(true) }).state : state;
  };

  it('nothing is resolved for loading while the caret is in the address', () => {
    for (const typed of ['h', 'ht', 'https://e', 'https://example.com/img/pho', 'my-slug/scr']) {
      const [widget] = widgets(preview(`![](${typed}|)`));
      expect(widget.url, typed).toBeNull();
      expect(widget.typing, typed).toBe(true);
    }
    expect(widgets(preview('![](|)'))[0]).toMatchObject({ url: null, typing: true });
  });

  it('the picture is resolved once the caret leaves the address, or the editor loses focus', () => {
    expect(widgets(preview('![](my-slug/pic.png)\n\nnext| line'))[0]).toMatchObject({ url: 'resolved:my-slug/pic.png', typing: false });
    expect(widgets(preview('![alt|](my-slug/pic.png)'))[0]).toMatchObject({ url: 'resolved:my-slug/pic.png', typing: false });
    expect(widgets(preview('![](my-slug/pic.png|)', false))[0]).toMatchObject({ url: 'resolved:my-slug/pic.png', typing: false });
  });

  it('typing the address character by character never yields a loadable widget until the caret moves away', () => {
    let state = preview('![](|)');
    const loads: string[] = [];
    for (const ch of 'https://example.com/img/photo.png') {
      const at = state.selection.main.head;
      state = state.update({ changes: { from: at, insert: ch }, selection: EditorSelection.cursor(at + 1) }).state;
      for (const w of widgets(state)) if (w.url) loads.push(w.url);
    }
    expect(loads).toEqual([]);
    state = state.update({ selection: EditorSelection.cursor(0) }).state;
    expect(widgets(state).map((w) => w.url)).toEqual(['resolved:https://example.com/img/photo.png']);
  });
});

describe('Spellcheck and autocorrect are off for text that is not prose', () => {
  const attrs = (marked: string): Record<string, string>[] => {
    const state = stateOf(marked, [livePreviewConfig.of({ resolveAsset: (src) => src, onFootnote: () => {}, onImage: () => {} }), livePreview()]).update({
      effects: setFocused.of(true),
    }).state;
    const out: Record<string, string>[] = [];
    for (const iter = buildDecorations(state).decorations.iter(); iter.value; iter.next()) {
      const spec = (iter.value as Decoration).spec as { class?: string; attributes?: Record<string, string> };
      if (spec.attributes?.spellcheck) out.push({ class: spec.class ?? spec.attributes.class, ...spec.attributes });
    }
    return out;
  };

  it('code spans, addresses being edited, code blocks and display math', () => {
    expect(attrs('a `code` b|')).toEqual([expect.objectContaining({ class: 'cm-inline-code', spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' })]);
    expect(attrs('[text](https://x.y/|)').map((a) => a.class)).toContain('cm-url');
    const block = attrs('```js\nlet a = 1;\n```\n\ntext|');
    expect(block).toHaveLength(3);
    expect(block.every((a) => a.spellcheck === 'false' && a.autocorrect === 'off')).toBe(true);
    expect(attrs('$$\nx^2|\n$$\n').length).toBe(3);
  });

  it('prose carries no such attribute', () => {
    expect(attrs('Just **prose** with a [link](https://x.y) and a list:\n\n- one|\n')).toEqual([]);
  });
});
