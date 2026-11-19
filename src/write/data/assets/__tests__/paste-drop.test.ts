// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { hasImages, imagesFromDrop, imagesFromPaste } from '../intake';
import * as img from './images';

const fileItem = (file: File) => ({ kind: 'file', type: file.type, getAsFile: () => file, getAsString: () => {} });
const stringItem = (type: string, value: string) => ({ kind: 'string', type, getAsFile: () => null, getAsString: (cb: (s: string) => void) => cb(value) });

const pasteEvent = (items: object[], files: File[] = []) => ({ clipboardData: { items, files } }) as unknown as ClipboardEvent;
const dropEvent = (files: File[], html = '') => ({ dataTransfer: { files, items: [], getData: (t: string) => (t === 'text/html' ? html : '') } }) as unknown as DragEvent;

describe('imagesFromPaste', () => {
  it('an image copied from a web page: the file, plus alt text and a name scraped from the HTML', async () => {
    const file = img.fileOf(img.png(), 'image.png', 'image/png');
    const html = '<meta charset="utf-8"><img src="https://example.com/media/My%20Diagram.jpg?w=800" alt="A diagram of the system">';
    const event = pasteEvent([stringItem('text/html', html), fileItem(file)], [file]);
    expect(hasImages(event)).toBe(true);
    const images = await imagesFromPaste(event);
    expect(images).toHaveLength(1);
    expect(images[0].file).toBe(file);
    expect(images[0].alt).toBe('A diagram of the system');
    expect(images[0].name).toBe('My Diagram.jpg');
  });

  it('a screenshot or local files: used as they are', async () => {
    const a = img.fileOf(img.png(), 'image.png', 'image/png');
    const b = img.fileOf(img.jpeg(), 'IMG_1.jpg', 'image/jpeg');
    const text = new File(['x'], 'notes.txt', { type: 'text/plain' });
    const images = await imagesFromPaste(pasteEvent([fileItem(a), fileItem(b), fileItem(text)], [a, b, text]));
    expect(images.map((i) => i.file)).toEqual([a, b]);
  });

  it('plain text or HTML without an image file is not an image paste', async () => {
    const event = pasteEvent([stringItem('text/plain', 'hello'), stringItem('text/html', '<p>hello <img src="https://example.com/a.png"></p>')]);
    expect(hasImages(event)).toBe(false);
    expect(await imagesFromPaste(event)).toEqual([]);
    expect(await imagesFromPaste({ clipboardData: null } as unknown as ClipboardEvent)).toEqual([]);
  });

  it('HTML that holds a script does not run it and yields no name from a data: URL', async () => {
    const file = img.fileOf(img.png(), 'image.png', 'image/png');
    (globalThis as { pwned?: boolean }).pwned = false;
    const html = '<img src="data:image/png;base64,AAAA" alt="x" onerror="globalThis.pwned = true"><script>globalThis.pwned = true</script>';
    const images = await imagesFromPaste(pasteEvent([stringItem('text/html', html), fileItem(file)], [file]));
    expect(images[0].name).toBeUndefined();
    expect((globalThis as { pwned?: boolean }).pwned).toBe(false);
  });

  it('does not touch the event (the caller decides about preventDefault)', async () => {
    const file = img.fileOf(img.png(), 'image.png', 'image/png');
    let cleared = false;
    const items = Object.assign([stringItem('text/html', '<img src="https://e.com/a.png">'), fileItem(file)], { clear: () => (cleared = true) });
    let stopped = false;
    const event = { clipboardData: { items, files: [file] }, stopPropagation: () => (stopped = true), preventDefault: () => (stopped = true) } as unknown as ClipboardEvent;
    await imagesFromPaste(event);
    expect(cleared).toBe(false);
    expect(stopped).toBe(false);
  });
});

describe('imagesFromDrop', () => {
  it('dropped files: images only', async () => {
    const a = img.fileOf(img.png(), 'a.png', 'image/png');
    const pdf = new File(['%PDF'], 'doc.pdf', { type: 'application/pdf' });
    const event = dropEvent([a, pdf]);
    expect(hasImages(event)).toBe(true);
    expect((await imagesFromDrop(event)).map((i) => i.file)).toEqual([a]);
  });

  it('an image dragged from another page is linked by its URL, with its alt text', async () => {
    const images = await imagesFromDrop(dropEvent([], '<a href="/x"><img src="https://example.com/pic.jpg" alt="Pic"></a>'));
    expect(images).toEqual([{ src: 'https://example.com/pic.jpg', alt: 'Pic' }]);
  });

  it('nothing usable dropped', async () => {
    expect(await imagesFromDrop(dropEvent([], '<p>text</p>'))).toEqual([]);
    expect(await imagesFromDrop(dropEvent([]))).toEqual([]);
    expect(await imagesFromDrop({ dataTransfer: null } as unknown as DragEvent)).toEqual([]);
  });
});
