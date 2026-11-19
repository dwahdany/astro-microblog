// @vitest-environment jsdom
/**
 * frame.ts: writing a rendered post into the preview document — minimal DOM
 * updates, link hardening, scroll anchors. (Sandboxing itself is a browser
 * behaviour and is covered by tests/write/e2e/preview.spec.ts.)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  SLOT,
  anchorTop,
  applyContent,
  captureAnchor,
  detachAnchor,
  findBrokenImages,
  fractionAnchor,
  hardenLinks,
  isPreviewDocument,
  patchChildren,
  type FrameContent,
} from '../frame';

function frameDocument(): Document {
  const doc = document.implementation.createHTMLDocument('Preview');
  // A detached document's base is about:blank; the real frame has its page URL.
  const base = doc.createElement('base');
  base.href = 'https://blog.wahdany.eu/write/preview-frame/';
  doc.head.append(base);
  doc.body.innerHTML =
    `<main><article><header id="${SLOT.header}"></header><div id="${SLOT.lead}"></div>` +
    `<div id="${SLOT.body}" class="prose"></div><div id="${SLOT.after}"></div></article></main>`;
  return doc;
}

const content = (body: string, extra: Partial<FrameContent> = {}): FrameContent => ({
  title: 'Post',
  header: '<h1>Post</h1>',
  lead: '',
  body,
  after: '',
  wrapBody: null,
  ...extra,
});

let doc: Document;
beforeEach(() => {
  doc = frameDocument();
});

describe('isPreviewDocument', () => {
  it('recognises the frame page and nothing else', () => {
    expect(isPreviewDocument(doc)).toBe(true);
    expect(isPreviewDocument(document.implementation.createHTMLDocument('other'))).toBe(false);
    expect(isPreviewDocument(null)).toBe(false);
  });
});

describe('applyContent', () => {
  it('fills the four slots and sets the title', () => {
    applyContent(doc, content('<p>Body</p>', { lead: '<img src="/a.png" alt="">', after: '<p>After</p>' }));
    expect(doc.getElementById(SLOT.header)!.innerHTML).toBe('<h1>Post</h1>');
    expect(doc.getElementById(SLOT.lead)!.querySelector('img')).not.toBeNull();
    expect(doc.getElementById(SLOT.body)!.innerHTML).toBe('<p>Body</p>');
    expect(doc.getElementById(SLOT.after)!.innerHTML).toBe('<p>After</p>');
    expect(doc.title).toBe('Preview: Post');
  });

  it('wraps a quotation body in the site blockquote', () => {
    applyContent(doc, content('<p>Words</p>', { wrapBody: 'blockquote' }));
    const quote = doc.getElementById(SLOT.body)!.firstElementChild!;
    expect(quote.tagName).toBe('BLOCKQUOTE');
    expect(quote.className).toBe('border-l-4 border-terminal-accent-green pl-4 italic text-xl mb-6');
    expect(quote.innerHTML).toBe('<p>Words</p>');
  });

  it('changes nothing when the same content is applied again', () => {
    const next = content('<p>One</p><p>Two <a href="https://example.com">x</a></p>');
    expect(applyContent(doc, next)).toBeGreaterThan(0);
    const nodes = Array.from(doc.getElementById(SLOT.body)!.childNodes);
    expect(applyContent(doc, next)).toBe(0);
    expect(Array.from(doc.getElementById(SLOT.body)!.childNodes)).toEqual(nodes);
  });

  it('keeps untouched blocks as the same DOM nodes (images do not reload)', () => {
    applyContent(doc, content('<p>Intro</p><p><img src="/a.png"></p><p>Typing he</p><p>Outro</p>'));
    const body = doc.getElementById(SLOT.body)!;
    const [intro, picture, , outro] = Array.from(body.children);
    const image = picture.querySelector('img');

    const changed = applyContent(doc, content('<p>Intro</p><p><img src="/a.png"></p><p>Typing here</p><p>Outro</p>'));

    expect(body.children[0]).toBe(intro);
    expect(body.children[1]).toBe(picture);
    expect(body.querySelector('img')).toBe(image);
    expect(body.children[3]).toBe(outro);
    expect(body.children[2].textContent).toBe('Typing here');
    expect(changed).toBe(2); // one text node out, one in
  });

  it('handles insertion, removal and full replacement', () => {
    const body = doc.getElementById(SLOT.body)!;
    applyContent(doc, content('<p>A</p><p>C</p>'));
    const [a, c] = Array.from(body.children);
    applyContent(doc, content('<p>A</p><p>B</p><p>C</p>'));
    expect(body.innerHTML).toBe('<p>A</p><p>B</p><p>C</p>');
    expect(body.children[0]).toBe(a);
    expect(body.children[2]).toBe(c);
    applyContent(doc, content('<p>C</p>'));
    expect(body.innerHTML).toBe('<p>C</p>');
    applyContent(doc, content('<h2>New</h2><ul><li>x</li></ul>'));
    expect(body.innerHTML).toBe('<h2>New</h2><ul><li>x</li></ul>');
    applyContent(doc, content(''));
    expect(body.innerHTML).toBe('');
  });

  it('patches inside a changed list instead of replacing it', () => {
    const body = doc.getElementById(SLOT.body)!;
    applyContent(doc, content('<ul><li>one</li><li>two</li><li>three</li></ul>'));
    const list = body.firstElementChild!;
    const first = list.children[0];
    applyContent(doc, content('<ul><li>one</li><li>2</li><li>three</li></ul>'));
    expect(body.firstElementChild).toBe(list);
    expect(list.children[0]).toBe(first);
    expect(list.children[1].textContent).toBe('2');
  });

  it('does nothing to a document that is not the preview frame', () => {
    const other = document.implementation.createHTMLDocument('other');
    expect(applyContent(other, content('<p>x</p>'))).toBe(0);
    expect(other.body.innerHTML).toBe('');
  });
});

describe('patchChildren', () => {
  it('produces exactly the target for a range of edits', () => {
    const states = [
      '<p>a</p><p>b</p><p>c</p>',
      '<p>a</p><p>b!</p><p>c</p>',
      '<p>b!</p><p>c</p>',
      '<p>b!</p><p>c</p><p>d</p><p>e</p>',
      '<h2 id="x">b!</h2><p>c</p><p>d</p><p>e</p>',
      '<p>c</p><p>c</p><p>c</p>',
      '<p>c</p><p>c</p>',
      'text only',
      '<blockquote><p>q <em>deep <strong>deeper <code>x</code></strong></em></p></blockquote>',
      '<blockquote><p>q <em>deep <strong>deeper <code>y</code></strong></em></p></blockquote>',
      '',
    ];
    const host = doc.createElement('div');
    for (const state of states) {
      const template = doc.createElement('template');
      template.innerHTML = state;
      patchChildren(host, template.content);
      expect(host.innerHTML).toBe(state);
    }
  });
});

describe('hardenLinks', () => {
  function links(html: string): HTMLAnchorElement[] {
    const host = doc.createElement('div');
    host.innerHTML = html;
    hardenLinks(host, 'https://blog.wahdany.eu/write/preview-frame/');
    return Array.from(host.querySelectorAll('a'));
  }

  it('leaves in-page links (footnotes, headings) as plain same-document jumps', () => {
    const [ref, back] = links('<a href="#user-content-fn-1">1</a><a href="#user-content-fnref-1" target="_blank">↩</a>');
    expect(ref.getAttribute('href')).toBe('#user-content-fn-1');
    expect(ref.hasAttribute('target')).toBe(false);
    expect(back.hasAttribute('target')).toBe(false);
  });

  it('opens every other link in a new tab without an opener', () => {
    for (const link of links('<a href="https://example.com/x">a</a><a href="/2025/Oct/6/bubbles/">b</a><a href="mailto:a@b.c">c</a><a href="other/">d</a>')) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('disarms links with any other scheme', () => {
    for (const link of links(
      '<a href="javascript:alert(1)">a</a><a href=" JaVaScRiPt:alert(1)">b</a><a href="java&#9;script:alert(1)">c</a>' +
        '<a href="data:text/html,<script>alert(1)</script>">d</a><a href="vbscript:x">e</a><a href="blob:https://x/y">f</a><a href="file:///etc/passwd">g</a>',
    )) {
      expect(link.hasAttribute('href'), link.textContent ?? '').toBe(false);
      expect(link.hasAttribute('data-write-blocked')).toBe(true);
    }
  });

  it('is applied to everything written into the frame', () => {
    applyContent(doc, content('<p><a href="https://example.com">out</a> <a href="javascript:alert(1)">bad</a> <a href="#fn">in</a></p>', {
      header: '<a href="/2025/">2025</a>',
    }));
    const [out, bad, inPage] = Array.from(doc.getElementById(SLOT.body)!.querySelectorAll('a'));
    expect(out.target).toBe('_blank');
    expect(bad.hasAttribute('href')).toBe(false);
    expect(inPage.hasAttribute('target')).toBe(false);
    expect(doc.getElementById(SLOT.header)!.querySelector('a')!.target).toBe('_blank');
  });
});

describe('scroll anchors', () => {
  /** jsdom has no layout: give the blocks a fake one, 100px each, scrolled by `scrollTop`. */
  function layout(scrollTop: number, heights?: number[]) {
    const scroller = doc.scrollingElement ?? doc.documentElement;
    scroller.scrollTop = scrollTop;
    const blocks = Array.from(doc.getElementById(SLOT.body)!.children);
    let y = 200; // header above the body
    blocks.forEach((block, i) => {
      const height = heights?.[i] ?? 100;
      const top = y;
      block.getBoundingClientRect = () =>
        ({ top: top - scroller.scrollTop, bottom: top + height - scroller.scrollTop, height }) as DOMRect;
      y += height;
    });
  }

  beforeEach(() => {
    applyContent(doc, content('<p>0</p><p>1</p><p>2</p><p>3</p>'));
  });

  it('describes the position by block and offset', () => {
    layout(430);
    const anchor = captureAnchor(doc);
    expect(anchor.index).toBe(2);
    expect(anchor.offset).toBe(30);
    expect(anchor.node?.textContent).toBe('2');
  });

  it('falls back to pixels above the body', () => {
    layout(120);
    expect(captureAnchor(doc)).toEqual({ top: 120, index: -1, offset: 0 });
    expect(anchorTop(doc, { top: 120, index: -1, offset: 0 })).toBe(120);
  });

  it('follows its block when something above grows (an image finishing to load)', () => {
    layout(430);
    const anchor = captureAnchor(doc);
    layout(430, [100, 500, 100, 100]); // block 1 grew by 400px
    expect(anchorTop(doc, anchor)).toBe(830);
  });

  it('survives a frame reload by index', () => {
    layout(430);
    const remembered = detachAnchor(captureAnchor(doc));
    expect(remembered).toEqual({ top: 430, index: 2, offset: 30 });
    doc = frameDocument();
    applyContent(doc, content('<p>0</p><p>1</p><p>2</p><p>3</p>'));
    layout(0);
    expect(anchorTop(doc, remembered)).toBe(430);
  });

  it('uses the blocks inside the quotation wrapper', () => {
    applyContent(doc, content('<p>0</p><p>1</p>', { wrapBody: 'blockquote' }));
    const wrap = doc.getElementById(SLOT.body)!.firstElementChild!;
    const scroller = doc.scrollingElement ?? doc.documentElement;
    scroller.scrollTop = 250;
    Array.from(wrap.children).forEach((block, i) => {
      block.getBoundingClientRect = () => ({ top: 200 + i * 100 - 250, bottom: 300 + i * 100 - 250 }) as DOMRect;
    });
    expect(captureAnchor(doc).index).toBe(0);
    expect(captureAnchor(doc).offset).toBe(50);
  });
});

describe('findBrokenImages', () => {
  it('reports images that completed with no pixels, and clears the mark when they recover', () => {
    applyContent(doc, content('<p><img src="/ok.png"><img src="/broken.png"><img src="/pending.png"></p>'));
    const [ok, broken, pending] = Array.from(doc.images);
    const fake = (img: HTMLImageElement, complete: boolean, naturalWidth: number) => {
      Object.defineProperty(img, 'complete', { value: complete, configurable: true });
      Object.defineProperty(img, 'naturalWidth', { value: naturalWidth, configurable: true });
    };
    fake(ok, true, 640);
    fake(broken, true, 0);
    fake(pending, false, 0);
    expect(findBrokenImages(doc)).toEqual(['/broken.png']);
    expect(broken.hasAttribute('data-write-broken')).toBe(true);
    expect(ok.hasAttribute('data-write-broken')).toBe(false);
    fake(broken, true, 10);
    expect(findBrokenImages(doc)).toEqual([]);
    expect(broken.hasAttribute('data-write-broken')).toBe(false);
  });
});

/** Review finding: the preview always opened at the top, not where the writing was. */
describe('fractionAnchor: open the preview near where the editor was', () => {
  const body =
    '<p>' + 'a'.repeat(100) + '</p><p>' + 'b'.repeat(100) + '</p><p><img src="x.png" alt=""></p><p>' + 'c'.repeat(100) + '</p><p>' + 'd'.repeat(100) + '</p>';
  const painted = () => {
    const doc = frameDocument();
    applyContent(doc, content(body));
    return doc;
  };
  const blockOf = (doc: Document, fraction: number) => fractionAnchor(doc, fraction).node?.textContent?.[0] ?? '(top)';

  it('the very start stays at the top of the page (title included)', () => {
    const doc = painted();
    expect(fractionAnchor(doc, 0)).toEqual({ top: 0, index: -1, offset: 0 });
    expect(fractionAnchor(doc, Number.NaN)).toEqual({ top: 0, index: -1, offset: 0 });
  });

  it('picks the block that far through the TEXT, so an image does not count as a paragraph', () => {
    const doc = painted();
    expect(blockOf(doc, 0.1)).toBe('a');
    expect(blockOf(doc, 0.3)).toBe('b');
    expect(blockOf(doc, 0.6)).toBe('c');
    expect(blockOf(doc, 0.9)).toBe('d');
    expect(blockOf(doc, 1)).toBe('d');
    expect(blockOf(doc, 7)).toBe('d');
  });

  it('an empty body has nowhere to go but the top', () => {
    const doc = frameDocument();
    applyContent(doc, content(''));
    expect(fractionAnchor(doc, 0.5).index).toBe(-1);
  });
});
