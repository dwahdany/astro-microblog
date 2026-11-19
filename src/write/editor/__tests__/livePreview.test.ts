import { describe, expect, it } from 'vitest';
import { EditorSelection, type EditorState } from '@codemirror/state';
import type { Decoration } from '@codemirror/view';
import { buildDecorations, livePreview, livePreviewConfig, parseImageAlt, setActiveFootnote, setFocused } from '../livePreview';
import { stateOf } from './helpers';

/** A state with the live preview installed; `focused` decides whether the caret reveals anything. */
function preview(marked: string, focused = true, resolve: (src: string) => string | null = (src) => `resolved:${src}`): EditorState {
  const state = stateOf(marked, [livePreviewConfig.of({ resolveAsset: resolve, onFootnote: () => {}, onImage: () => {} }), livePreview()]);
  return focused ? state.update({ effects: setFocused.of(true) }).state : state;
}

interface Seen {
  from: number;
  to: number;
  what: string;
}

function describeDeco(deco: Decoration): string {
  const spec = deco.spec as { widget?: object; class?: string; attributes?: Record<string, string>; block?: boolean };
  if (spec.widget) return `${spec.block ? 'block:' : 'widget:'}${spec.widget.constructor.name}`;
  if (spec.attributes?.class && !spec.class) return `line:${spec.attributes.class}${spec.attributes.style ? ` {${spec.attributes.style}}` : ''}`;
  if (spec.class) return `mark:${spec.class}${spec.attributes?.style ? ` {${spec.attributes.style}}` : ''}`;
  return 'hide';
}

function seen(state: EditorState): Seen[] {
  const out: Seen[] = [];
  const iter = buildDecorations(state).decorations.iter();
  for (; iter.value; iter.next()) out.push({ from: iter.from, to: iter.to, what: describeDeco(iter.value) });
  return out;
}

/** The text with hidden/replaced ranges removed and widgets shown as ⟨Name⟩ — roughly what is on screen. */
function rendered(state: EditorState): string {
  const text = state.sliceDoc();
  const cuts = seen(state).filter((d) => d.what === 'hide' || d.what.startsWith('widget:') || d.what.startsWith('block:'));
  let out = '';
  let pos = 0;
  for (const cut of cuts.sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (cut.from < pos) continue;
    out += text.slice(pos, cut.from);
    if (cut.what !== 'hide') out += `⟨${cut.what.replace(/^(widget|block):/, '').replace(/Widget$/, '')}⟩`;
    pos = cut.to;
  }
  return out + text.slice(pos);
}

const has = (state: EditorState, what: string | RegExp) =>
  seen(state).some((d) => (typeof what === 'string' ? d.what === what : what.test(d.what)));
const lineClasses = (state: EditorState, lineNumber: number) => {
  const from = state.doc.line(lineNumber).from;
  return seen(state).find((d) => d.from === from && d.what.startsWith('line:'))?.what ?? '';
};

describe('inline markup', () => {
  it('is hidden away from the caret', () => {
    expect(rendered(preview('|\n\nSome **bold**, *it*, ~~gone~~ and `code`.'))).toBe('\n\nSome bold, it, gone and code.');
  });

  it('is revealed for the construct the caret touches, and only that one', () => {
    expect(rendered(preview('Some **bo|ld**, *it* and `code`.'))).toBe('Some **bold**, it and code.');
    expect(rendered(preview('Some **bold**|, *it* and `code`.'))).toBe('Some **bold**, it and code.');
    expect(rendered(preview('Some **bold**, *it* and `co|de`.'))).toBe('Some bold, it and `code`.');
  });

  it('is revealed for everything a selection covers', () => {
    expect(rendered(preview('Some ⟦**bold**, *it*⟧ and `code`.'))).toBe('Some **bold**, *it* and code.');
  });

  it('reveals nothing while the editor is not focused', () => {
    expect(rendered(preview('Some **bo|ld** and `code`.', false))).toBe('Some bold and code.');
  });

  it('styles the content either way', () => {
    for (const state of [preview('|\n**b** *i* ~~s~~ `c`'), preview('**b|** *i* ~~s~~ `c`')]) {
      for (const cls of ['mark:cm-strong', 'mark:cm-em', 'mark:cm-strike', 'mark:cm-inline-code']) expect(has(state, cls)).toBe(true);
    }
  });

  it('leaves text inside code blocks alone', () => {
    const state = preview('|\n\n```\n**not bold** [^1] $x$\n```');
    expect(rendered(state)).toBe('\n\n⟨Fence⟩\n**not bold** [^1] $x$\n');
    expect(has(state, 'mark:cm-strong')).toBe(false);
  });
});

describe('links', () => {
  const link = '[text](https://example.com/a/long/path)';

  it('show only their text when untouched', () => {
    expect(rendered(preview(`|\n\nSee ${link} now.`))).toBe('\n\nSee text now.');
  });

  it('show brackets but keep the address folded while the text is edited', () => {
    expect(rendered(preview(`See [te|xt](https://example.com/a/long/path) now.`))).toBe('See [text]⟨UrlStub⟩ now.');
    expect(rendered(preview(`See ${link}| now.`))).toBe('See [text]⟨UrlStub⟩ now.');
  });

  it('show the address when the caret is inside the parentheses', () => {
    expect(rendered(preview('See [text](https://exa|mple.com) now.'))).toBe('See [text](https://example.com) now.');
    expect(rendered(preview('See [text](|https://example.com) now.'))).toBe('See [text](https://example.com) now.');
  });

  it('never fold an empty address (there is nothing to protect, and it must be typed into)', () => {
    expect(rendered(preview('See [text](|) now.'))).toBe('See [text]() now.');
    expect(rendered(preview('See [te|xt]() now.'))).toBe('See [text]() now.');
  });

  it('do not treat bracketed text as a link', () => {
    const state = preview('|\n\nHe said [sic] that.');
    expect(rendered(state)).toBe('\n\nHe said [sic] that.');
    expect(has(state, 'mark:cm-link')).toBe(false);
  });

  it('style autolinks and bare addresses', () => {
    const state = preview('|\n\n<https://a.example> and https://b.example');
    expect(rendered(state)).toBe('\n\nhttps://a.example and https://b.example');
    expect(seen(state).filter((d) => d.what === 'mark:cm-link')).toHaveLength(2);
  });
});

describe('headings, quotes and rules', () => {
  it('hide the # marks unless the caret is on them', () => {
    expect(rendered(preview('## Title\n\n|'))).toBe('Title\n\n');
    expect(rendered(preview('## Ti|tle'))).toBe('Title');
    expect(rendered(preview('##| Title'))).toBe('## Title');
    expect(rendered(preview('|## Title'))).toBe('## Title');
  });

  it('keep the marks of an empty heading visible', () => {
    expect(rendered(preview('## \n\n|'))).toBe('## \n\n');
  });

  it('size heading lines by level', () => {
    const state = preview('# One\n\n### Three\n\nSetext\n===\n\n|');
    expect(lineClasses(state, 1)).toContain('cm-h1');
    expect(lineClasses(state, 3)).toContain('cm-h3');
    expect(lineClasses(state, 5)).toContain('cm-h1');
    expect(lineClasses(state, 6)).toContain('cm-setext-rule');
  });

  it('hide quote marks and record the depth on every quoted line', () => {
    const state = preview('> one\n> two\n>\n> > deep\n\n|');
    expect(rendered(state)).toBe('one\ntwo\n\ndeep\n\n');
    expect(lineClasses(state, 1)).toContain('--cm-quote:1');
    expect(lineClasses(state, 3)).toContain('cm-quote-1');
    expect(lineClasses(state, 4)).toContain('--cm-quote:2');
  });

  it('show a quote mark only when the caret is at it', () => {
    expect(rendered(preview('> on|e'))).toBe('one');
    expect(rendered(preview('>| one'))).toBe('> one');
  });

  it('draw a rule, and show its source on that line only', () => {
    expect(rendered(preview('a\n\n---\n\n|'))).toBe('a\n\n⟨Rule⟩\n\n');
    expect(rendered(preview('a\n\n--|-\n\nb'))).toBe('a\n\n---\n\nb');
  });
});

describe('lists', () => {
  it('draw bullets and checkboxes in place of their markers', () => {
    expect(rendered(preview('- one\n- [ ] todo\n- [x] done\n1. num\n\n|'))).toBe('⟨Bullet⟩ one\n ⟨Checkbox⟩ todo\n ⟨Checkbox⟩ done\n1. num\n\n');
  });

  it('show the raw marker only when the caret is on it', () => {
    expect(rendered(preview('- on|e'))).toBe('⟨Bullet⟩ one');
    expect(rendered(preview('- |one'))).toBe('⟨Bullet⟩ one');
    expect(rendered(preview('-| one'))).toBe('- one');
    expect(rendered(preview('- [|x] done'))).toBe(' [x] done');
  });

  it('hang wrapped text by the width of the prefix, per nesting level', () => {
    const state = preview('- a\n  - b\n\n10. c\n\n- [ ] t\n\n|');
    expect(lineClasses(state, 1)).toContain('--cm-hang:2');
    expect(lineClasses(state, 2)).toContain('--cm-hang:4');
    expect(lineClasses(state, 4)).toContain('--cm-hang:4');
    expect(lineClasses(state, 6)).toContain('--cm-hang:4'); // gap + checkbox + gap, without the hidden dash
  });

  it('indent continuation lines of an item with it', () => {
    const state = preview('- first\n  second line\n\n  third para\n\n|');
    expect(lineClasses(state, 2)).toContain('--cm-hang:2');
    expect(lineClasses(state, 4)).toContain('--cm-hang:2');
  });

  it('count only what shows after hidden quote marks', () => {
    const state = preview('> - item\n\n|');
    expect(lineClasses(state, 1)).toContain('--cm-hang:2');
    expect(lineClasses(state, 1)).toContain('--cm-quote:1');
  });

  it('mark finished tasks', () => {
    expect(lineClasses(preview('- [x] done\n\n|'), 1)).toContain('cm-task-done');
    expect(lineClasses(preview('- [ ] open\n\n|'), 1)).not.toContain('cm-task-done');
  });
});

describe('code and math', () => {
  it('keep fence lines as lines but hide their text until the caret is in the block', () => {
    const doc = '```js\nlet a\n```\n\n';
    expect(rendered(preview(doc + '|'))).toBe('⟨Fence⟩\nlet a\n\n\n');
    expect(rendered(preview('```js\nle|t a\n```'))).toBe('```js\nlet a\n```');
    const state = preview(doc + '|');
    expect(lineClasses(state, 1)).toContain('cm-code-open');
    expect(lineClasses(state, 2)).toContain('cm-code');
    expect(lineClasses(state, 3)).toContain('cm-code-close');
  });

  it('typeset inline math, and show its source under the caret', () => {
    expect(rendered(preview('|\n\nLet $x^2$ be.'))).toBe('\n\nLet ⟨InlineMath⟩ be.');
    expect(rendered(preview('Let $x|^2$ be.'))).toBe('Let $x^2$ be.');
    expect(has(preview('Let $x|^2$ be.'), 'mark:cm-math-src')).toBe(true);
  });

  it('replace a display block when away, and show source plus preview when inside', () => {
    const away = preview('a\n\n$$\nx = y\n$$\n\n|');
    expect(rendered(away)).toBe('a\n\n⟨BlockMath⟩\n\n');
    const inside = preview('a\n\n$$\nx |= y\n$$\n\nb');
    expect(rendered(inside)).toBe('a\n\n$$\nx = y\n$$⟨BlockMath⟩\n\nb');
    expect(lineClasses(inside, 3)).toContain('cm-math-open');
    expect(lineClasses(inside, 5)).toContain('cm-math-close');
  });

  it('does not replace an empty or indented display block', () => {
    expect(rendered(preview('$$\n$$\n\n|'))).toBe('$$\n$$\n\n');
    expect(rendered(preview('- item\n\n  $$\n  x\n  $$\n\n|'))).toContain('$$\n  x\n  $$⟨BlockMath⟩');
  });
});

describe('images', () => {
  it('fold the source into a caption and draw the image below its line', () => {
    const state = preview('|\n\n![A cat|small](cats/one.png)\n\nafter');
    expect(rendered(state)).toBe('\n\n⟨ImageChip⟩⟨Image⟩\n\nafter');
    const widget = buildDecorations(state).decorations.iter();
    let image: { url: string | null; alt: string; size: string } | undefined;
    for (; widget.value; widget.next()) {
      const w = (widget.value.spec as { widget?: { constructor: { name: string } } }).widget;
      if (w?.constructor.name === 'ImageWidget') image = w as unknown as typeof image;
    }
    expect(image).toMatchObject({ url: 'resolved:cats/one.png', alt: 'A cat', size: 'small' });
  });

  it('show the source (address folded) under the caret, with the image still there', () => {
    expect(rendered(preview('![A c|at](cats/one.png)'))).toBe('![A cat]⟨UrlStub⟩⟨Image⟩');
    expect(rendered(preview('![A cat](cats/on|e.png)'))).toBe('![A cat](cats/one.png)⟨Image⟩');
  });

  it('pass an unresolvable source through as null', () => {
    const state = preview('|\n\n![x](../../etc/passwd)', true, () => null);
    expect(rendered(state)).toBe('\n\n⟨ImageChip⟩⟨Image⟩');
  });

  it('parses the alt|size convention like the site plugin', () => {
    expect(parseImageAlt('A cat|small')).toEqual({ alt: 'A cat', size: 'small' });
    expect(parseImageAlt('|medium')).toEqual({ alt: '', size: 'medium' });
    expect(parseImageAlt('A | B')).toEqual({ alt: 'A | B', size: '' });
    expect(parseImageAlt('pipe|unknown')).toEqual({ alt: 'pipe|unknown', size: '' });
  });
});

describe('footnotes', () => {
  const doc = 'A claim[^1] and[^x].\n\n[^1]: The note.\n[^y]: Unused.';

  const widgets = (state: EditorState, name: string) => {
    const found: { label: string; orphan: boolean; active: boolean }[] = [];
    const iter = buildDecorations(state).decorations.iter();
    for (; iter.value; iter.next()) {
      const w = (iter.value.spec as { widget?: { constructor: { name: string } } }).widget;
      if (w?.constructor.name === name) found.push(w as unknown as (typeof found)[number]);
    }
    return found;
  };

  it('references are always chips, even under the caret, and are atomic', () => {
    const state = preview('A claim[^1]| and[^x].\n\n[^1]: The note.\n[^y]: Unused.');
    expect(rendered(state)).toBe('A claim⟨FootnoteRef⟩ and⟨FootnoteRef⟩.\n\n⟨FootnoteDef⟩ The note.\n⟨FootnoteDef⟩ Unused.');
    const atomic: [number, number][] = [];
    const iter = buildDecorations(state).atomic.iter();
    for (; iter.value; iter.next()) atomic.push([iter.from, iter.to]);
    expect(atomic).toEqual([
      [7, 11],
      [15, 19],
    ]);
  });

  it('flag references without a note and notes without a reference', () => {
    const state = preview('|' + doc);
    expect(widgets(state, 'FootnoteRefWidget').map((w) => [w.label, w.orphan])).toEqual([
      ['1', false],
      ['x', true],
    ]);
    expect(widgets(state, 'FootnoteDefWidget').map((w) => [w.label, w.orphan])).toEqual([
      ['1', false],
      ['y', true],
    ]);
  });

  it('highlight the chips of the note that is open', () => {
    const state = preview('|' + doc).update({ effects: setActiveFootnote.of('1') }).state;
    expect(widgets(state, 'FootnoteRefWidget').map((w) => w.active)).toEqual([true, false]);
    expect(widgets(state, 'FootnoteDefWidget').map((w) => w.active)).toEqual([true, false]);
  });

  it('show the raw definition label when the caret is on it', () => {
    const at = doc.indexOf('[^1]:') + 2;
    const state = preview(doc).update({ selection: EditorSelection.cursor(at) }).state;
    expect(rendered(state)).toContain('\n[^1]: The note.\n⟨FootnoteDef⟩ Unused.');
  });

  it('rule off the first note after body text, not the ones that follow', () => {
    const state = preview('|' + doc);
    expect(lineClasses(state, 3)).toContain('cm-fn-section');
    expect(lineClasses(state, 4)).toContain('cm-fn-def');
    expect(lineClasses(state, 4)).not.toContain('cm-fn-section');
  });
});

describe('the decorations never touch the text', () => {
  it('building them for any selection leaves the document as it was', () => {
    const doc = '# T\n\nSome **b** [l](u) `c` $m$ ![i](s)[^1]\n\n- a\n> q\n\n```\nx\n```\n\n$$\ny\n$$\n\n---\n\n[^1]: n\n';
    let state = preview(doc);
    for (let pos = 0; pos <= doc.length; pos++) {
      state = state.update({ selection: EditorSelection.cursor(pos) }).state;
      buildDecorations(state);
    }
    state = state.update({ selection: EditorSelection.range(0, doc.length) }).state;
    buildDecorations(state);
    expect(state.sliceDoc()).toBe(doc);
  });
});
