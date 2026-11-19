import { describe, expect, it } from 'vitest';
import {
  exitEmptyListItem,
  indentList,
  insertImage,
  insertRule,
  outdentList,
  parsePrefix,
  selectionState,
  setHeading,
  toggleCodeBlock,
  toggleInline,
  toggleLink,
  toggleList,
  toggleMathBlock,
  toggleQuote,
} from '../commands';
import { run, runTimes, stateOf } from './helpers';

const bold = (s: Parameters<typeof toggleInline>[0]) => toggleInline(s, 'bold');
const italic = (s: Parameters<typeof toggleInline>[0]) => toggleInline(s, 'italic');
const strike = (s: Parameters<typeof toggleInline>[0]) => toggleInline(s, 'strike');
const code = (s: Parameters<typeof toggleInline>[0]) => toggleInline(s, 'code');
const math = (s: Parameters<typeof toggleInline>[0]) => toggleInline(s, 'math');

describe('inline toggles', () => {
  it('wraps a selection and keeps it selected', () => {
    expect(run('a ⟦word⟧ b', bold)).toBe('a **⟦word⟧** b');
    expect(run('a ⟦word⟧ b', italic)).toBe('a *⟦word⟧* b');
    expect(run('a ⟦word⟧ b', strike)).toBe('a ~~⟦word⟧~~ b');
    expect(run('a ⟦word⟧ b', code)).toBe('a `⟦word⟧` b');
    expect(run('a ⟦x^2⟧ b', math)).toBe('a $⟦x^2⟧$ b');
  });

  it('leaves spaces at the selection edges outside the marks', () => {
    expect(run('a⟦ word ⟧b', bold)).toBe('a **⟦word⟧** b');
  });

  it('toggles off when the selection is inside the construct', () => {
    expect(run('a **⟦word⟧** b', bold)).toBe('a ⟦word⟧ b');
    expect(run('a ⟦**word**⟧ b', bold)).toBe('a ⟦word⟧ b');
    expect(run('a **wo⟦r⟧d** b', bold)).toBe('a wo⟦r⟧d b');
    expect(run('a ~~⟦word⟧~~ b', strike)).toBe('a ⟦word⟧ b');
  });

  it('is its own inverse on a selection', () => {
    for (const cmd of [bold, italic, strike, code, math]) {
      expect(runTimes('some ⟦plain words⟧ here', cmd, 2)).toBe('some ⟦plain words⟧ here');
    }
  });

  it('with a caret in a word, wraps the word', () => {
    expect(run('a wo|rd b', bold)).toBe('a **wo|rd** b');
  });

  it('with a caret in the middle of the construct, removes it', () => {
    expect(run('a **wo|rd** b', bold)).toBe('a wo|rd b');
    expect(run('a *wo|rd* b', italic)).toBe('a wo|rd b');
    expect(run('a `wo|rd` b', code)).toBe('a wo|rd b');
  });

  it('with a caret on nothing, opens an empty pair; pressing again removes it', () => {
    expect(run('a | b', bold)).toBe('a **|** b');
    expect(run('a **|** b', bold)).toBe('a | b');
    expect(run('a | b', italic)).toBe('a *|* b');
    expect(run('a *|* b', italic)).toBe('a | b');
    expect(run('a | b', code)).toBe('a `|` b');
    expect(run('a `|` b', code)).toBe('a | b');
  });

  it('typing then pressing the button again steps out of the construct', () => {
    expect(run('a **bold|** b', bold)).toBe('a **bold**| b');
    expect(run('a *it|* b', italic)).toBe('a *it*| b');
  });

  it('italic inside an empty bold pair nests instead of eating it', () => {
    expect(run('**|**', italic)).toBe('***|***');
    expect(run('***|***', italic)).toBe('**|**');
  });

  it('bold inside italic text nests', () => {
    expect(run('*an ⟦important⟧ thing*', bold)).toBe('*an **⟦important⟧** thing*');
  });

  it('wraps each line of a multi-line selection inside its list marker', () => {
    expect(run('⟦- one\n- two⟧', bold)).toBe('- **⟦one**\n- **two⟧**');
    expect(run('⟦para one\n\npara two⟧', italic)).toBe('*⟦para one*\n\n*para two⟧*');
  });

  it('does nothing to code block lines', () => {
    expect(run('```\n⟦code⟧\n```', bold)).toBeNull();
  });
});

describe('link', () => {
  it('wraps the selection and puts the caret in the address', () => {
    expect(run('see ⟦this page⟧ now', toggleLink)).toBe('see [this page](|) now');
  });

  it('turns a selected address into the target', () => {
    expect(run('see ⟦https://example.com/a⟧ now', toggleLink)).toBe('see [|](https://example.com/a) now');
  });

  it('wraps the word under the caret', () => {
    expect(run('see th|is now', toggleLink)).toBe('see [this](|) now');
  });

  it('inserts an empty link with the caret in the text', () => {
    expect(run('see | now', toggleLink)).toBe('see [|]() now');
  });

  it('steps text → address → out while a link is being written', () => {
    expect(run('see [text|]() now', toggleLink)).toBe('see [text](|) now');
    expect(run('see [text](https://x.y|) now', toggleLink)).toBe('see [text](https://x.y)| now');
  });

  it('unlinks when inside a finished link', () => {
    expect(run('see [te|xt](https://x.y) now', toggleLink)).toBe('see ⟦text⟧ now');
    expect(run('see [⟦text⟧](https://x.y) now', toggleLink)).toBe('see ⟦text⟧ now');
  });

  it('inserts a given url, using the selection as text', () => {
    expect(run('see ⟦this⟧ now', (s) => toggleLink(s, { url: 'https://x.y' }))).toBe('see [this](https://x.y)| now');
    expect(run('see | now', (s) => toggleLink(s, { url: 'https://x.y' }))).toBe('see [https://x.y](https://x.y)| now');
    expect(run('see | now', (s) => toggleLink(s, { url: 'https://x.y', text: 'X' }))).toBe('see [X](https://x.y)| now');
  });
});

describe('image', () => {
  it('inserts an empty image with the caret in the address', () => {
    expect(run('|', insertImage)).toBe('![](|)');
  });

  it('inserts a given source with alt and the site size suffix', () => {
    expect(run('|', (s) => insertImage(s, { src: 'post/pic.png', alt: 'A cat', size: 'small' }))).toBe('![A cat|small](post/pic.png)|');
    expect(run('|', (s) => insertImage(s, { src: 'post/pic.png' }))).toBe('![](post/pic.png)|');
  });

  it('protects sources with spaces', () => {
    expect(run('|', (s) => insertImage(s, { src: 'my pic.png' }))).toBe('![](<my pic.png>)|');
  });
});

describe('heading', () => {
  const cycle = (s: Parameters<typeof setHeading>[0]) => setHeading(s);

  it('cycles paragraph → h2 → h3 → paragraph', () => {
    expect(run('Tit|le', cycle)).toBe('## Tit|le');
    expect(run('## Tit|le', cycle)).toBe('### Tit|le');
    expect(run('### Tit|le', cycle)).toBe('Tit|le');
    expect(runTimes('Tit|le', cycle, 3)).toBe('Tit|le');
  });

  it('starts a heading on an empty line with the caret after the mark', () => {
    expect(run('a\n\n|', cycle)).toBe('a\n\n## |');
  });

  it('sets, changes and clears an explicit level', () => {
    expect(run('Tit|le', (s) => setHeading(s, { level: 1 }))).toBe('# Tit|le');
    expect(run('# Tit|le', (s) => setHeading(s, { level: 4 }))).toBe('#### Tit|le');
    expect(run('#### Tit|le', (s) => setHeading(s, { level: 4 }))).toBe('Tit|le');
    expect(run('#### Tit|le', (s) => setHeading(s, { level: 0 }))).toBe('Tit|le');
  });

  it('keeps list and quote prefixes in front', () => {
    expect(run('> quo|te', cycle)).toBe('> ## quo|te');
    expect(run('- it|em', cycle)).toBe('- ## it|em');
  });

  it('converts an underlined heading instead of stacking syntax', () => {
    expect(run('Tit|le\n=====\n\ntext', cycle)).toBe('## Tit|le\n\ntext');
    expect(run('Tit|le\n-----\n\ntext', cycle)).toBe('### Tit|le\n\ntext');
  });

  it('does not touch code', () => {
    expect(run('```\nco|de\n```', cycle)).toBeNull();
  });

  it('leaves every other line byte-identical', () => {
    const before = 'One  \n\n* odd   list\n\nTit|le\n\n1) x\n';
    expect(run(before, cycle)).toBe('One  \n\n* odd   list\n\n## Tit|le\n\n1) x\n');
  });
});

describe('lists', () => {
  const bullet = (s: Parameters<typeof toggleList>[0]) => toggleList(s, 'bullet');
  const ordered = (s: Parameters<typeof toggleList>[0]) => toggleList(s, 'ordered');
  const task = (s: Parameters<typeof toggleList>[0]) => toggleList(s, 'task');

  it('toggles a bullet on and off', () => {
    expect(run('it|em', bullet)).toBe('- it|em');
    expect(run('- it|em', bullet)).toBe('it|em');
    expect(run('|', bullet)).toBe('- |');
  });

  it('numbers the selected lines', () => {
    expect(run('⟦a\nb\nc⟧', ordered)).toBe('1. ⟦a\n2. b\n3. c⟧');
    expect(run('1. ⟦a\n2. b⟧', ordered)).toBe('⟦a\nb⟧');
  });

  it('continues the numbering and bullet style of the list above', () => {
    expect(run('3. a\nb|', ordered)).toBe('3. a\n4. b|');
    expect(run('1) a\nb|', ordered)).toBe('1) a\n2) b|');
    expect(run('* a\nb|', bullet)).toBe('* a\n* b|');
  });

  it('converts between kinds', () => {
    expect(run('- it|em', ordered)).toBe('1. it|em');
    expect(run('1. it|em', bullet)).toBe('- it|em');
    expect(run('- it|em', task)).toBe('- [ ] it|em');
    expect(run('- [x] it|em', bullet)).toBe('- it|em');
    expect(run('- [ ] it|em', task)).toBe('it|em');
    expect(run('* it|em', task)).toBe('* [ ] it|em');
  });

  it('works inside a quote and skips blank lines', () => {
    expect(run('> it|em', bullet)).toBe('> - it|em');
    expect(run('⟦a\n\nb⟧', bullet)).toBe('- ⟦a\n\n- b⟧');
  });

  it('indents an item under the one above and takes its children along', () => {
    expect(run('- a\n- b|\n  - c', indentList)).toBe('- a\n  - b|\n    - c');
    expect(run('1. a\n2. b|', indentList)).toBe('1. a\n   2. b|');
  });

  it('cannot indent the first item or outdent a top-level one', () => {
    expect(run('- a|\n- b', indentList)).toBeNull();
    expect(run('- a\n- b|', outdentList)).toBeNull();
    expect(run('plain|', indentList)).toBeNull();
  });

  it('outdents back to the parent level', () => {
    expect(run('- a\n  - b|\n    - c', outdentList)).toBe('- a\n- b|\n  - c');
    expect(run('1. a\n   - b|', outdentList)).toBe('1. a\n- b|');
  });

  it('indent then outdent restores the text', () => {
    const before = '- a\n- b|\n  continued\n\n  - c\n- d';
    const state = stateOf(before);
    const indented = state.update(indentList(state)!).state;
    const back = indented.update(outdentList(indented)!).state;
    expect(back.sliceDoc()).toBe(state.sliceDoc());
  });
});

describe('Enter on an empty list item', () => {
  it('ends a top-level list with a blank line, so what follows is not a lazy continuation', () => {
    expect(run('- one\n- two\n- |', exitEmptyListItem)).toBe('- one\n- two\n\n|');
    expect(run('- one\n- |', exitEmptyListItem)).toBe('- one\n\n|');
    expect(run('1. a\n2. |', exitEmptyListItem)).toBe('1. a\n\n|');
    expect(run('- [ ] a\n- [ ] |', exitEmptyListItem)).toBe('- [ ] a\n\n|');
    expect(run('- one\n\n- |', exitEmptyListItem)).toBe('- one\n\n|');
  });

  it('leaves everything else to the regular handling', () => {
    expect(run('- one\n- two|', exitEmptyListItem)).toBeNull();
    expect(run('- one\n  - |', exitEmptyListItem)).toBeNull();
    expect(run('- |\n- two', exitEmptyListItem)).toBeNull();
    expect(run('1. a\n2. |\n3. c', exitEmptyListItem)).toBeNull();
    expect(run('> - a\n> - |', exitEmptyListItem)).toBeNull();
    expect(run('```\n- |\n```', exitEmptyListItem)).toBeNull();
  });
});

describe('quote', () => {
  it('toggles on a line and across a selection', () => {
    expect(run('wo|rds', toggleQuote)).toBe('> wo|rds');
    expect(run('> wo|rds', toggleQuote)).toBe('wo|rds');
    expect(run('⟦a\n\nb⟧', toggleQuote)).toBe('> ⟦a\n>\n> b⟧');
    expect(run('> ⟦a\n>\n> b⟧', toggleQuote)).toBe('⟦a\n\nb⟧');
  });

  it('removes one level at a time', () => {
    expect(run('> > de|ep', toggleQuote)).toBe('> de|ep');
  });

  it('starts a quote on an empty line', () => {
    expect(run('|', toggleQuote)).toBe('> |');
  });
});

describe('fenced blocks', () => {
  it('opens an empty code block on an empty line', () => {
    expect(run('a\n\n|', toggleCodeBlock)).toBe('a\n\n```\n|\n```');
    expect(run('|', (s) => toggleCodeBlock(s, { lang: 'js' }))).toBe('```js\n|\n```');
  });

  it('wraps the selected lines and unwraps them again', () => {
    expect(run('⟦let a\nlet b⟧', toggleCodeBlock)).toBe('```\n⟦let a\nlet b⟧\n```');
    expect(run('```\n⟦let a\nlet b⟧\n```', toggleCodeBlock)).toBe('⟦let a\nlet b⟧');
    expect(run('before\n```js\nco|de\n```\nafter', toggleCodeBlock)).toBe('before\nco|de\nafter');
  });

  it('removes an empty block entirely', () => {
    expect(run('a\n```\n|```\nb', toggleCodeBlock)).toBe('a\n|\nb');
  });

  it('uses a longer fence when the text contains one', () => {
    expect(run('⟦say ``` here⟧', toggleCodeBlock)).toBe('````\n⟦say ``` here⟧\n````');
  });

  it('does the same for display math', () => {
    expect(run('|', toggleMathBlock)).toBe('$$\n|\n$$');
    expect(run('⟦a = b⟧', toggleMathBlock)).toBe('$$\n⟦a = b⟧\n$$');
    expect(run('$$\na |= b\n$$', toggleMathBlock)).toBe('a |= b');
  });
});

describe('rule', () => {
  it('goes on its own line, separated from text above so it cannot become a heading underline', () => {
    expect(run('text|', insertRule)).toBe('text\n\n---\n|');
    expect(run('text\n|', insertRule)).toBe('text\n\n---\n|');
    expect(run('text\n\n|', insertRule)).toBe('text\n\n---\n|');
    expect(run('te|xt\nmore', insertRule)).toBe('text\n\n---\n|more');
  });
});

describe('parsePrefix', () => {
  it('separates quote, indent, marker, task and heading', () => {
    expect(parsePrefix('> - [x] ## T')).toEqual({ quote: '> ', indent: '', marker: '-', markerGap: ' ', task: '[x] ', heading: '## ' });
    expect(parsePrefix('   12) text').marker).toBe('12)');
    expect(parsePrefix('**bold** start').marker).toBe('');
    expect(parsePrefix('#hashtag').heading).toBe('');
    expect(parsePrefix('1.5 litres').marker).toBe('');
  });
});

describe('selection state', () => {
  it('reports the inline constructs around the caret', () => {
    const s = selectionState(stateOf('a **bo|ld** and *it* and `c`'));
    expect(s).toMatchObject({ bold: true, italic: false, code: false, strike: false, link: false, empty: true });
    expect(selectionState(stateOf('a ***bo|th***')).italic).toBe(true);
    expect(selectionState(stateOf('a ***bo|th***')).bold).toBe(true);
    expect(selectionState(stateOf('[te|xt](u)')).link).toBe(true);
    expect(selectionState(stateOf('~~go|ne~~')).strike).toBe(true);
    expect(selectionState(stateOf('`co|de`')).code).toBe(true);
  });

  it('is not pressed just outside the construct', () => {
    expect(selectionState(stateOf('**bold**| after')).bold).toBe(false);
    expect(selectionState(stateOf('|**bold** after')).bold).toBe(false);
  });

  it('reports block context', () => {
    expect(selectionState(stateOf('### He|ad')).heading).toBe(3);
    expect(selectionState(stateOf('He|ad\n===')).heading).toBe(1);
    expect(selectionState(stateOf('- it|em')).list).toBe('bullet');
    expect(selectionState(stateOf('2. it|em')).list).toBe('ordered');
    expect(selectionState(stateOf('- [ ] it|em')).list).toBe('task');
    expect(selectionState(stateOf('- item\n  more|')).list).toBe('bullet');
    expect(selectionState(stateOf('> quo|te')).quote).toBe(true);
    expect(selectionState(stateOf('> quote\nlazy|')).quote).toBe(true);
    expect(selectionState(stateOf('```\n- co|de\n```'))).toMatchObject({ codeBlock: true, list: null, heading: 0 });
    expect(selectionState(stateOf('plain|'))).toMatchObject({ heading: 0, list: null, quote: false, codeBlock: false });
  });

  it('carries the selection offsets', () => {
    expect(selectionState(stateOf('ab⟦cd⟧ef'))).toMatchObject({ anchor: 2, head: 4, empty: false, canUndo: false, canRedo: false });
  });
});
