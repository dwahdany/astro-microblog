import { describe, expect, it } from 'vitest';
import { history, undo } from '@codemirror/commands';
import { EditorState, type Extension, type TransactionSpec } from '@codemirror/state';
import { decodeAlt, encodeAlt, imageAt, imagesOnLine, imageView, removeImage, setImageAlt, setImageSize, splitImageText, type ImageSize } from '../images';
import { parseImageAlt } from '../livePreview';
import { lineBreaks, docText } from '../lineBreaks';
import { footnoteIndex } from '../footnotes';
import { writeMarkdown } from '../markdown';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import { visit } from 'unist-util-visit';

/** A state for exactly this text (the shared helper reads `|` as a caret, and image text is full of pipes). */
const stateOf = (doc: string, extra: Extension = []): EditorState =>
  EditorState.create({ doc, extensions: [writeMarkdown(), footnoteIndex, history(), extra] });

/** The state for `text`, and the image at (or around) the first `![`. */
function open(text: string, at = text.indexOf('![')) {
  const state = stateOf(text);
  const info = imageAt(state, at);
  if (!info) throw new Error(`no image at ${at} in ${JSON.stringify(text)}`);
  return { state, info };
}
const apply = (state: EditorState, spec: TransactionSpec | null): string => {
  if (!spec) throw new Error('no change');
  return state.update(spec).state.sliceDoc();
};
const size = (text: string, to: ImageSize, at?: number): string | null => {
  const { state, info } = open(text, at);
  const spec = setImageSize(state, info, to);
  return spec ? apply(state, spec) : null;
};
const alt = (text: string, typed: string, at?: number): string | 'refused' | 'unchanged' => {
  const { state, info } = open(text, at);
  const result = setImageAlt(state, info, typed);
  return 'spec' in result ? apply(state, result.spec) : 'refused' in result ? 'refused' : 'unchanged';
};
/** What the panel shows for the first image of `text`. */
const shown = (text: string) => {
  const { info } = open(text);
  const view = imageView(info);
  return { alt: view.alt, size: view.size };
};

describe('the bracket text of an image', () => {
  it('is alt text plus an optional size suffix', () => {
    expect(splitImageText('A cat')).toEqual({ alt: 'A cat', suffix: '', size: '' });
    expect(splitImageText('A cat|small')).toEqual({ alt: 'A cat', suffix: '|small', size: 'small' });
    expect(splitImageText('|full')).toEqual({ alt: '', suffix: '|full', size: 'full' });
    expect(splitImageText('a|b|medium')).toEqual({ alt: 'a|b', suffix: '|medium', size: 'medium' });
  });

  it('leaves an unknown suffix as alt text', () => {
    expect(splitImageText('A cat|large')).toEqual({ alt: 'A cat|large', suffix: '', size: '' });
    expect(splitImageText('A cat|small ')).toEqual({ alt: 'A cat|small ', suffix: '', size: '' });
    expect(splitImageText('A cat|Small')).toEqual({ alt: 'A cat|Small', suffix: '', size: '' });
  });

  it('takes the backslash that escapes the pipe (a table needs it) as part of the suffix', () => {
    expect(splitImageText('a\\|small')).toEqual({ alt: 'a', suffix: '\\|small', size: 'small' });
    // An escaped backslash before the pipe is alt text.
    expect(splitImageText('a\\\\|small')).toEqual({ alt: 'a\\\\', suffix: '|small', size: 'small' });
  });

  it('parseImageAlt keeps reading what the site reads', () => {
    expect(parseImageAlt('A diagram|medium')).toEqual({ alt: 'A diagram', size: 'medium' });
    expect(parseImageAlt('A diagram |medium')).toEqual({ alt: 'A diagram', size: 'medium' });
    expect(parseImageAlt('|small')).toEqual({ alt: '', size: 'small' });
    expect(parseImageAlt('A diagram|large')).toEqual({ alt: 'A diagram|large', size: '' });
    expect(parseImageAlt(' padded ')).toEqual({ alt: ' padded ', size: '' });
  });
});

describe('finding images', () => {
  it('finds the image at its start, inside it and at its end — and nothing elsewhere', () => {
    const text = 'Before ![a cat|small](pics/cat.png) after';
    const state = stateOf(text);
    const from = text.indexOf('![');
    const to = text.indexOf(')') + 1;
    for (const pos of [from, from + 3, to]) {
      expect(imageAt(state, pos)).toMatchObject({ from, to, rawAlt: 'a cat', suffix: '|small', size: 'small', src: 'pics/cat.png' });
    }
    expect(imageAt(state, 2)).toBeNull();
    expect(imageAt(state, to + 2)).toBeNull();
  });

  it('reads the address without its angle brackets, and a reference image without one', () => {
    expect(open('![a](<my pics/cat 1.png>)').info.src).toBe('my pics/cat 1.png');
    expect(open('![a][ref]\n\n[ref]: x.png').info).toMatchObject({ rawAlt: 'a', src: '' });
  });

  it('lists the images of a line in order', () => {
    const text = 'x ![one](1.png) y ![two|full](2.png)\n\n![three](3.png)';
    const state = stateOf(text);
    expect(imagesOnLine(state, 3).map((i) => i.src)).toEqual(['1.png', '2.png']);
    expect(imagesOnLine(state, text.length).map((i) => i.src)).toEqual(['3.png']);
    expect(imagesOnLine(state, text.indexOf('\n') + 1)).toEqual([]);
  });

  it('names the image by its file', () => {
    expect(imageView(open('![a](curation-leaks/hero.png)').info).name).toBe('hero.png');
    expect(imageView(open('![a](https://example.com/p/x.jpg?w=2#top)').info).name).toBe('x.jpg');
    expect(imageView(open('![a][ref]').info).name).toBe('image');
  });
});

describe('size: only the suffix changes', () => {
  it('adds, changes and removes the suffix', () => {
    expect(size('![A cat](c.png)', 'small')).toBe('![A cat|small](c.png)');
    expect(size('![A cat|small](c.png)', 'full')).toBe('![A cat|full](c.png)');
    expect(size('![A cat|full](c.png)', '')).toBe('![A cat](c.png)');
    expect(size('![](c.png)', 'medium')).toBe('![|medium](c.png)');
    expect(size('![|medium](c.png)', '')).toBe('![](c.png)');
  });

  it('does nothing when the size is already that', () => {
    expect(size('![A cat|small](c.png)', 'small')).toBeNull();
    expect(size('![A cat](c.png)', '')).toBeNull();
  });

  it('leaves every other byte alone: the alt text as written, the address, the title, the rest of the text', () => {
    const before = 'One *two*\n\n> - [![ A  \\[cat\\] _x_ |small](<my pics/c 1.png> "T")](https://e.com) tail  \n\nEnd\n';
    const after = size(before, 'full');
    expect(after).toBe(before.replace('|small]', '|full]'));
    expect(size(before, '')).toBe(before.replace('|small]', ']'));
  });

  it('an unknown suffix is alt text: shown as Default, and a real size goes after it', () => {
    expect(shown('![A cat|large](c.png)')).toEqual({ alt: 'A cat|large', size: '' });
    expect(size('![A cat|large](c.png)', 'small')).toBe('![A cat|large|small](c.png)');
    expect(shown('![A cat|large|small](c.png)')).toEqual({ alt: 'A cat|large', size: 'small' });
    expect(size('![A cat|large|small](c.png)', '')).toBe('![A cat|large](c.png)');
  });

  it('works on a reference image and on the second image of a line', () => {
    expect(size('![a][ref]\n\n[ref]: x.png', 'small')).toBe('![a|small][ref]\n\n[ref]: x.png');
    const text = '![one](1.png) and ![two](2.png)';
    expect(size(text, 'medium', text.lastIndexOf('!['))).toBe('![one](1.png) and ![two|medium](2.png)');
  });

  it('in a table the pipe is written escaped, and read back', () => {
    const table = '| a | b |\n| - | - |\n| ![cat](c.png) | x |\n';
    const sized = size(table, 'small');
    expect(sized).toBe('| a | b |\n| - | - |\n| ![cat\\|small](c.png) | x |\n');
    expect(shown(sized!)).toEqual({ alt: 'cat', size: 'small' });
    expect(size(sized!, 'full')).toBe('| a | b |\n| - | - |\n| ![cat\\|full](c.png) | x |\n');
    expect(size(sized!, '')).toBe(table);
  });

  it('each size change is one undo step, and undo restores the bytes', () => {
    const text = 'A\n\n![A cat](c.png)\n\nB\n';
    let state = stateOf(text);
    for (const to of ['small', 'full'] as const) state = state.update(setImageSize(state, imageAt(state, 3)!, to)!).state;
    expect(state.sliceDoc()).toBe('A\n\n![A cat|full](c.png)\n\nB\n');
    const step = (s: EditorState): EditorState => {
      let next = s;
      undo({ state: s, dispatch: (tr) => (next = tr.state) });
      return next;
    };
    state = step(state);
    expect(state.sliceDoc()).toBe('A\n\n![A cat|small](c.png)\n\nB\n');
    state = step(state);
    expect(state.sliceDoc()).toBe(text);
  });
});

/** The alt text the SITE's parser reads for the first image of `text` (remark, as the build uses), or null when it reads no image. */
function siteAlt(text: string): string | null {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(text);
  let found: string | null = null;
  visit(tree, (node) => {
    if (found === null && (node.type === 'image' || node.type === 'imageReference')) found = (node as { alt?: string | null }).alt ?? '';
  });
  return found;
}

describe('alt text: only its own characters change', () => {
  it('replaces just the characters that differ', () => {
    const { state, info } = open('x ![A cat|small](c.png) y');
    const result = setImageAlt(state, info, 'A black cat');
    if (!('spec' in result)) throw new Error('refused');
    expect(result.spec.changes).toEqual({ from: 6, to: 6, insert: 'black ' });
    expect(apply(state, result.spec)).toBe('x ![A black cat|small](c.png) y');
  });

  it('writes, clears and reports no change', () => {
    expect(alt('![](c.png)', 'A cat')).toBe('![A cat](c.png)');
    expect(alt('![A cat|full](c.png)', '')).toBe('![|full](c.png)');
    expect(alt('![A cat](c.png)', 'A cat')).toBe('unchanged');
  });

  it('escapes brackets, so the alt text cannot end early', () => {
    expect(alt('![](c.png)', 'Figure [1]')).toBe('![Figure \\[1\\]](c.png)');
    expect(alt('![](c.png)', 'a ] b')).toBe('![a \\] b](c.png)');
    expect(alt('![](c.png)', '](evil.png) ![')).toBe('![\\](evil.png) !\\[](c.png)');
    expect(shown('![Figure \\[1\\]](c.png)').alt).toBe('Figure [1]');
  });

  it('a backslash at the end is doubled (it would escape the closing bracket)', () => {
    expect(alt('![](c.png)', 'C:\\')).toBe('![C:\\\\](c.png)');
    expect(alt('![|small](c.png)', 'a\\')).toBe('![a\\\\|small](c.png)');
    // …and shown as the one backslash it is.
    expect(shown('![a\\\\|small](c.png)')).toEqual({ alt: 'a\\', size: 'small' });
  });

  it('typed key by key, a path with backslashes is shown as typed all the way (review finding)', () => {
    for (const typed of ['C:\\dir', 'a\\]b', 'a\\', 'a\\\\b', '\\[x]', 'x\\|small']) {
      let state = stateOf('Before ![|small](c.png) after\n');
      for (let n = 1; n <= typed.length; n++) {
        const result = setImageAlt(state, imageAt(state, 7)!, typed.slice(0, n));
        expect('refused' in result, `${typed} at ${n}`).toBe(false);
        if ('spec' in result) state = state.update(result.spec).state;
        // What the field is synced to after each key is what was typed so far.
        expect(imageView(imageAt(state, 7)!).alt, `${typed} at ${n}`).toBe(typed.slice(0, n));
      }
      expect(imageAt(state, 7)!.size).toBe('small');
      // The site reads the backslashes that were typed (its own size suffix aside).
      expect(siteAlt(state.sliceDoc()), typed).toBe(`${typed}|small`);
    }
    expect(alt('![](c.png)', 'C:\\dir')).toBe('![C:\\dir](c.png)');
  });

  it('keeps escapes the writer typed, and backslashes that escape nothing', () => {
    expect(encodeAlt('a \\* b')).toBe('a \\* b');
    expect(encodeAlt('C:\\dir')).toBe('C:\\dir');
    // A backslash typed before a bracket (or another backslash) is a backslash: both are written escaped.
    expect(encodeAlt('\\[x\\]')).toBe('\\\\\\[x\\\\\\]');
    expect(encodeAlt('\\\\[x]')).toBe('\\\\\\\\\\[x\\]');
    expect(decodeAlt('\\\\\\[x\\\\\\]')).toBe('\\[x\\]');
  });

  it('an edit leaves the rest of the alt text as it is written (review finding)', () => {
    // Brackets that were never escaped, a link and an image inside the alt text: one key at the end touches none of them.
    for (const [before, alt0] of [
      ['![a [b] c](x.png)', 'a [b] c'],
      ['![a `]` b](x.png)', 'a ] b'],
      ['![a [l](u) b](x.png)', 'a l b'],
      ['![a ![in](y.png) b](x.png)', 'a in b'],
      ['![a \\* `x\\` \\[k\\] b](x.png)', 'a * x\\ [k] b'],
    ] as const) {
      expect(siteAlt(before), before).toBe(alt0);
      const { state, info } = open(before);
      const result = setImageAlt(state, info, imageView(info).alt + 'Z');
      if (!('spec' in result)) throw new Error(`refused: ${before}`);
      expect(result.spec.changes, before).toEqual({ from: info.textTo, to: info.textTo, insert: 'Z' });
      const after = apply(state, result.spec);
      expect(after).toBe(before.replace('](x.png)', 'Z](x.png)'));
      expect(siteAlt(after), before).toBe(alt0 + 'Z');
      // Typing what is shown changes nothing — no first-keystroke rewrite.
      expect(setImageAlt(state, info, imageView(info).alt)).toEqual({ unchanged: true });
    }
    // An edit in the middle rewrites the middle only.
    expect(alt('![a [b] c [d] e](x.png)', 'a [b] c! [d] e')).toBe('![a [b] c! [d] e](x.png)');
    // Taking one bracket of a pair away leaves a lone one: that one is then written escaped, or the image would end early.
    expect(alt('![a [b] c](x.png)', 'a b] c')).toBe('![a b\\] c](x.png)');
    expect(siteAlt('![a b\\] c](x.png)')).toBe('a b] c');
  });

  it('a code span is written as typed: a bracket inside it gets no backslash (review finding)', () => {
    expect(alt('![](c.png)', 'a `]` b')).toBe('![a `]` b](c.png)');
    expect(siteAlt('![a `]` b](c.png)')).toBe('a ] b');
    expect(alt('![](c.png)', '``a ` [b]`` c')).toBe('![``a ` [b]`` c](c.png)');
    // Typed key by key: the bracket is escaped until the code span closes around it, then it is not.
    let state = stateOf('![|small](c.png)\n');
    for (const typed of ['`', '`]', '`]`']) {
      const result = setImageAlt(state, imageAt(state, 0)!, typed);
      if ('spec' in result) state = state.update(result.spec).state;
      expect(imageView(imageAt(state, 0)!).alt).toBe(typed);
    }
    expect(state.sliceDoc()).toBe('![`]`|small](c.png)\n');
    expect(siteAlt(state.sliceDoc())).toBe(']|small');
    // A backtick that opens nothing is a backtick; brackets after it are escaped.
    expect(alt('![](c.png)', 'a ` [b]')).toBe('![a ` \\[b\\]](c.png)');
    // In a table the pipe is escaped even in code, and shown without the backslash.
    const table = '| a |\n| - |\n| ![](c.png) |\n';
    const written = alt(table, '`x | y`');
    expect(written).toBe('| a |\n| - |\n| ![`x \\| y`](c.png) |\n');
    expect(shown(written as string).alt).toBe('`x | y`');
  });

  it('what the site reads is what was typed, for text typed into a fresh image', () => {
    for (const typed of ['Figure [1]', '] [ |', 'x](y)', '![nested](img.png)', '[link](e.com)', 'C:\\', 'C:\\dir\\file', 'a\\]b', '\\\\', '`]`', 'a ` ] b', '[[]]', '[^1]']) {
      const written = alt('Before ![old](pics/c.png) after\n\n[^1]: note\n', typed);
      expect(written, typed).not.toBe('refused');
      expect(siteAlt(written), typed).toBe(typed.replace(/`/g, typed === '`]`' ? '' : '`'));
    }
  });

  it('turns line breaks into a space', () => {
    expect(encodeAlt('one\ntwo')).toBe('one two');
    expect(encodeAlt('one \r\n\r\n  two\rthree')).toBe('one two three');
    expect(alt('![](c.png)', 'one\ntwo')).toBe('![one two](c.png)');
  });

  it('a pipe is alt text, except an ending that is a size', () => {
    expect(alt('![](c.png)', 'a | b')).toBe('![a | b](c.png)');
    expect(shown('![a | b](c.png)')).toEqual({ alt: 'a | b', size: '' });
    // `|small` at the end is the size, here as on the site: it cannot be written as plain alt text.
    expect(alt('![](c.png)', 'a|small')).toBe('![a|small](c.png)');
    expect(shown('![a|small](c.png)')).toEqual({ alt: 'a', size: 'small' });
    // With a size already set, the same characters are alt text.
    expect(alt('![|full](c.png)', 'a|small')).toBe('![a|small|full](c.png)');
    expect(shown('![a|small|full](c.png)')).toEqual({ alt: 'a|small', size: 'full' });
  });

  it('in a table a pipe is escaped, and shown without the backslash', () => {
    const table = '| a |\n| - |\n| ![](c.png) |\n';
    const written = alt(table, 'x | y [z]');
    expect(written).toBe('| a |\n| - |\n| ![x \\| y \\[z\\]](c.png) |\n');
    expect(shown(written as string).alt).toBe('x | y [z]');
  });

  it('round trip: whatever is typed is read back as typed, by the parser, with the rest untouched', () => {
    const typed = [
      'A cat',
      'Figure [1]',
      ']',
      '[',
      '[[]]',
      '] [ |',
      'a | b',
      '|',
      'x](y)',
      '![nested](img.png)',
      '[link](https://e.com)',
      '*emphasis* and `code` and $math$',
      'quote "double" and \'single\'',
      'tab\there',
      'unicode — “quotes” 🐈',
      'ends with pipe |',
      'a|large',
      '<b>html</b> & entities &amp;',
      '^1',
      '[^1]',
      'a\nb',
      ' padded ',
    ];
    for (const wrapper of [(i: string) => `Before ${i} after\n`, (i: string) => `> - ${i}\n`, (i: string) => `[${i}](https://e.com) tail\n`]) {
      for (const suffix of ['', '|small']) {
        for (const text of typed) {
          const before = wrapper(`![old${suffix}](pics/c.png)`);
          const { state, info } = open(before);
          const result = setImageAlt(state, info, text);
          if ('refused' in result) continue; // refusing is safe; what is accepted must round-trip
          const after = 'spec' in result ? state.update(result.spec).state : state;
          const read = imageAt(after, info.from);
          const label = `${JSON.stringify(text)} in ${JSON.stringify(before)}`;
          expect(read, label).not.toBeNull();
          // The same image, the same address and size, and nothing outside its brackets changed.
          expect(read!.src, label).toBe('pics/c.png');
          expect(read!.size, label).toBe(suffix ? 'small' : '');
          expect(after.sliceDoc(0, read!.textFrom), label).toBe(before.slice(0, info.textFrom));
          expect(after.sliceDoc(read!.textTo), label).toBe(before.slice(info.textTo));
          // Read back as typed (line breaks are the one thing that is rewritten: to a space).
          expect(imageView(read!).alt, label).toBe(text.replace(/\n/g, ' '));
          // And typing the same again changes nothing.
          expect(setImageAlt(after, read!, imageView(read!).alt), label).toEqual({ unchanged: true });
        }
      }
    }
  });

  it('none of the awkward inputs is refused in ordinary text', () => {
    for (const text of [']', '[', '] [ |', 'x](y)', '![nested](img.png)', 'a\nb', '[^1]', 'C:\\']) {
      expect(alt('Before ![old](c.png) after', text), JSON.stringify(text)).not.toBe('refused');
    }
  });

  it('decode and encode agree with each other', () => {
    for (const raw of ['plain', 'a \\[b\\] c', 'a\\\\', 'x \\* y', '\\\\\\[', 'C:\\dir\\file']) {
      expect(encodeAlt(decodeAlt(raw)), raw).toBe(raw);
    }
  });

  it('alt text that runs over several lines is not edited here, but its size can be set', () => {
    const text = '![one\ntwo](c.png)';
    expect(imageView(open(text).info)).toMatchObject({ alt: 'one two', altEditable: false });
    expect(alt(text, 'changed')).toBe('refused');
    expect(size(text, 'small')).toBe('![one\ntwo|small](c.png)');
  });

  it('a run of keystrokes is one undo step; a size change in between is its own', () => {
    let state = EditorState.create({ doc: '![](c.png)\n', extensions: [writeMarkdown(), history({ newGroupDelay: 10_000 })] });
    const type = (text: string) => {
      const result = setImageAlt(state, imageAt(state, 0)!, text);
      if ('spec' in result) state = state.update(result.spec).state;
    };
    const step = () => undo({ state, dispatch: (tr) => (state = tr.state) });
    type('A');
    type('A ');
    type('A c');
    expect(state.sliceDoc()).toBe('![A c](c.png)\n');
    step();
    expect(state.sliceDoc()).toBe('![](c.png)\n');
  });
});

describe('a collapsed or shortcut reference image: the bracket text is its label (review finding)', () => {
  const cases = ['![old][] x\n\n[old]: pics/c.png\n', '![old] x\n\n[old]: pics/c.png\n', '![old|small] x\n\n[old|small]: pics/c.png\n', '![nodef] x\n'];
  for (const text of cases) {
    it(`size and alt text are refused, nothing is written: ${JSON.stringify(text.split('\n')[0])}`, () => {
      const { info } = open(text);
      expect(info.isLabel).toBe(true);
      expect(imageView(info)).toMatchObject({ altEditable: false, sizeEditable: false });
      for (const to of ['', 'small', 'medium', 'full'] as const) expect(size(text, to)).toBeNull();
      for (const typed of ['oldX', 'A cat', '', 'ol']) expect(alt(text, typed)).toBe('refused');
    });
  }

  it('a full reference keeps both: its label is not the bracket text', () => {
    const text = '![old][pic] x\n\n[pic]: pics/c.png\n';
    expect(open(text).info.isLabel).toBe(false);
    expect(imageView(open(text).info)).toMatchObject({ altEditable: true, sizeEditable: true });
    expect(alt(text, 'A cat')).toBe(text.replace('![old]', '![A cat]'));
    expect(size(text, 'small')).toBe(text.replace('![old]', '![old|small]'));
    expect(siteAlt(text.replace('![old]', '![A cat]'))).toBe('A cat');
    expect(open('![a](c.png)').info.isLabel).toBe(false);
  });

  it('can still be removed', () => {
    const { state, info } = open('A\n\n![old][]\n\n[old]: pics/c.png\n');
    expect(apply(state, removeImage(state, info))).toBe('A\n\n[old]: pics/c.png\n');
  });
});

describe('images inside links, lists and blockquotes', () => {
  const cases = [
    ['a link', '[![a cat](c.png)](https://e.com)'],
    ['a list', '- one\n- ![a cat](c.png) text\n'],
    ['a nested list', '1. one\n   - ![a cat](c.png)\n'],
    ['a blockquote', '> quoted ![a cat](c.png)\n> more\n'],
    ['a quote in a list', '- > ![a cat](c.png)\n'],
    ['a heading', '## ![a cat](c.png) title\n'],
  ] as const;
  for (const [where, text] of cases) {
    it(`size and alt text in ${where}`, () => {
      expect(size(text, 'medium')).toBe(text.replace('a cat]', 'a cat|medium]'));
      expect(alt(text, 'a [black] cat')).toBe(text.replace('a cat]', 'a \\[black\\] cat]'));
    });
  }
});

describe('removing an image', () => {
  const remove = (text: string, at?: number): string => {
    const { state, info } = open(text, at);
    return apply(state, removeImage(state, info));
  };

  it('inside a sentence: the image goes, the sentence stays', () => {
    expect(remove('Look ![a](c.png) here')).toBe('Look  here');
    expect(remove('> - ![a](c.png) text\n')).toBe('> -  text\n');
  });

  it('on a line of its own: the line goes, with one of the blank lines around it', () => {
    expect(remove('A\n\n![a](c.png)\n\nB\n')).toBe('A\n\nB\n');
    expect(remove('A\n![a](c.png)\nB\n')).toBe('A\nB\n');
    expect(remove('A\n\n![a](c.png)\nB\n')).toBe('A\n\nB\n');
    expect(remove('A\n![a](c.png)\n\nB\n')).toBe('A\n\nB\n');
    expect(remove('![a](c.png)\n\nB\n')).toBe('B\n');
  });

  it('at the end: a file that ended with a line break still does, one that did not still does not', () => {
    expect(remove('A\n\n![a](c.png)\n')).toBe('A\n');
    expect(remove('A\n\n![a](c.png)')).toBe('A');
    expect(remove('A\n![a](c.png)')).toBe('A');
    expect(remove('![a](c.png)')).toBe('');
  });

  it('a link that holds only the image goes with it; a link with more keeps the rest', () => {
    expect(remove('See [![a](c.png)](https://e.com) now')).toBe('See  now');
    expect(remove('A\n\n[![a](c.png)](https://e.com)\n\nB\n')).toBe('A\n\nB\n');
    expect(remove('See [![a](c.png) text](https://e.com) now')).toBe('See [ text](https://e.com) now');
  });

  it('emphasis or a strikethrough around the image alone goes with it (review finding)', () => {
    // `~~~~` at the start of a line would open a code block, `****` alone on a line is a rule.
    expect(remove('~~![old](pics/c.png)~~ x\n')).toBe(' x\n');
    expect(remove('a **![old](pics/c.png)** d\n')).toBe('a  d\n');
    expect(remove('a *![old](pics/c.png)* d\n')).toBe('a  d\n');
    expect(remove('a _![old](pics/c.png)_ d\n')).toBe('a  d\n');
    expect(remove('A\n\n**![old](pics/c.png)**\n\nB\n')).toBe('A\n\nB\n');
    // Wrappers inside wrappers, with a link among them.
    expect(remove('a **[![old](pics/c.png)](https://e.com)** d\n')).toBe('a  d\n');
    expect(remove('a ~~*[![old](pics/c.png)](https://e.com)*~~ d\n')).toBe('a  d\n');
    // Emphasis that holds more keeps the rest.
    expect(remove('a **![old](pics/c.png) bold** d\n')).toBe('a ** bold** d\n');
    expect(remove('a **b [![old](pics/c.png)](https://e.com)** d\n')).toBe('a **b ** d\n');
  });

  it('only the image that was meant', () => {
    const text = '![one](1.png) ![two](2.png)';
    expect(remove(text, text.lastIndexOf('!['))).toBe('![one](1.png) ');
  });

  it('is one undo step', () => {
    const text = 'A\n\n![a](c.png)\n\nB\n';
    let state = stateOf(text);
    state = state.update(removeImage(state, imageAt(state, 3)!)).state;
    undo({ state, dispatch: (tr) => (state = tr.state) });
    expect(state.sliceDoc()).toBe(text);
  });

  it('keeps the other line breaks of a CRLF file as they are', () => {
    const text = 'A\r\n\r\n![a](c.png)\r\n\r\nB\r\n';
    let state = stateOf(text.replace(/\r\n/g, '\n'), lineBreaks(text));
    state = state.update(removeImage(state, imageAt(state, 3)!)).state;
    expect(docText(state)).toBe('A\r\n\r\nB\r\n');
    state = stateOf(text.replace(/\r\n/g, '\n'), lineBreaks(text));
    state = state.update(setImageSize(state, imageAt(state, 3)!, 'small')!).state;
    expect(docText(state)).toBe(text.replace('![a]', '![a|small]'));
  });
});
