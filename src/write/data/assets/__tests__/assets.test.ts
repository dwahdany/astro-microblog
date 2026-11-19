import { describe, expect, it } from 'vitest';
import type { PendingImage } from '../../../contracts';
import { gitBlobSha } from '../../git-sha';
import { isAnimatedImage } from '../animation';
import { intakeImages } from '../intake';
import {
  encodeFilePath,
  imageFolder,
  imagePath,
  imageRef,
  isImageReferenced,
  pendingAssetsFor,
  postStem,
  renameIfNeeded,
  rewriteImageRefs,
  sanitizeImageName,
  timestampName,
} from '../names';
import { createPendingImages } from '../pending';
import { isSvg, sniffRasterImageFormat } from '../sniff';
import { calculateResize, transformImage, type ImageEnv } from '../transform';
import * as img from './images';

const POST = 'src/content/notes/2026/my-note.md';
const NOW = Date.UTC(2026, 10, 19, 9, 30, 5);

/**
 * Stand-in for the browser's decoder and canvas. "Decoding" reads a size from the test; "encoding"
 * writes a NEW small file of the asked type — as a real canvas does, nothing of the source's bytes
 * (and so none of its EXIF) can be in it.
 */
function fakeEnv(options: { size?: [number, number]; cannotDecode?: boolean; cannotEncode?: string[]; transparent?: boolean } = {}) {
  const log: { decoded: number; canvases: [number, number][]; encodes: [string, number][]; closed: number } = { decoded: 0, canvases: [], encodes: [], closed: 0 };
  const signature: Record<string, Uint8Array> = { 'image/jpeg': img.jpeg().slice(0, 3), 'image/png': img.png(), 'image/webp': img.webp() };
  const env: ImageEnv = {
    async decode() {
      if (options.cannotDecode) throw new DOMException('The source image could not be decoded.', 'InvalidStateError');
      log.decoded += 1;
      const [width, height] = options.size ?? [4000, 3000];
      return { width, height, close: () => void (log.closed += 1) };
    },
    createCanvas(width, height) {
      log.canvases.push([width, height]);
      return {
        draw: () => {},
        hasTransparency: () => options.transparent === true,
        async encode(type, quality) {
          log.encodes.push([type, quality]);
          // A browser answers PNG for a type it cannot write.
          const real = options.cannotEncode?.includes(type) ? 'image/png' : type;
          return new Blob([signature[real] as BlobPart, new Uint8Array(40).fill(9)], { type: real });
        },
      };
    },
  };
  return { env, log };
}

describe('sniffing the real format', () => {
  it('reads the format from the content, whatever the name or declared type says', async () => {
    const cases: [Uint8Array, string | undefined][] = [
      [img.jpeg(), 'jpeg'],
      [img.png(), 'png'],
      [img.gif(), 'gif'],
      [img.webp(), 'webp'],
      [img.avif(), 'avif'],
      [img.heic(), 'heic'],
      [img.heicGeneric(), 'heic'],
      [img.text(), undefined],
      [img.svg(), undefined],
      [new Uint8Array([0xff, 0xd8]), undefined], // too short
      [new Uint8Array(0), undefined],
    ];
    for (const [bytes, expected] of cases) expect(await sniffRasterImageFormat(new Blob([bytes as BlobPart], { type: 'image/png' }))).toBe(expected);
  });

  it('recognises SVG markup (which is not taken in)', async () => {
    expect(await isSvg(new Blob([img.svg() as BlobPart]))).toBe(true);
    expect(await isSvg(new Blob(['  <svg viewBox="0 0 1 1"/>']))).toBe(true);
    expect(await isSvg(new Blob(['<html><svg/></html>']))).toBe(false);
    expect(await isSvg(new Blob([img.png() as BlobPart]))).toBe(false);
  });

  it('tells animations from stills', async () => {
    expect(await isAnimatedImage(new Blob([img.gif() as BlobPart]), 'gif')).toBe(false);
    expect(await isAnimatedImage(new Blob([img.animatedGif() as BlobPart]), 'gif')).toBe(true);
    expect(await isAnimatedImage(new Blob([img.png() as BlobPart]), 'png')).toBe(false);
    expect(await isAnimatedImage(new Blob([img.apng() as BlobPart]), 'png')).toBe(true);
    expect(await isAnimatedImage(new Blob([img.webp() as BlobPart]), 'webp')).toBe(false);
    expect(await isAnimatedImage(new Blob([img.animatedWebp() as BlobPart]), 'webp')).toBe(true);
    expect(await isAnimatedImage(new Blob([img.jpeg() as BlobPart]), 'jpeg')).toBe(false);
  });
});

describe('names', () => {
  it('sanitises to [a-z0-9.-] and takes the extension from the real type', () => {
    const at = new Date(NOW);
    expect(sanitizeImageName('Façade Photo (1).JPEG', 'image/jpeg', at)).toBe('facade-photo-1.jpg');
    expect(sanitizeImageName('IMG_4032.HEIC', 'image/jpeg', at)).toBe('img-4032.jpg');
    expect(sanitizeImageName('Straße & Übergröße.png', 'image/png', at)).toBe('strasse-ubergrosse.png');
    expect(sanitizeImageName('my.holiday.photo.png', 'image/webp', at)).toBe('my-holiday-photo.webp');
    expect(sanitizeImageName('C:\\Users\\me\\Pictures\\cat.gif', 'image/gif', at)).toBe('cat.gif');
    expect(sanitizeImageName('../../etc/passwd', 'image/png', at)).toBe('passwd.png');
    expect(sanitizeImageName('a'.repeat(200) + '.png', 'image/png', at)).toBe('a'.repeat(80) + '.png');
    for (const name of ['写真.png', '🎉.png', 'image.png', 'IMAGE.PNG', 'image', '', undefined, '.png', 'Untitled.png', 'blob'])
      expect(sanitizeImageName(name, 'image/png', at), String(name)).toBe('20261119-093005.png');
    for (const name of ['Façade Photo (1).JPEG', '写真.png', '../x y.png', 'a%20b(1)!.png']) expect(sanitizeImageName(name, 'image/png', at)).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*\.png$/);
    expect(timestampName(at)).toBe('20261119-093005');
  });

  it('numbers a name that is taken, case-insensitively, above the highest number in use', () => {
    expect(renameIfNeeded('pic.png', [])).toBe('pic.png');
    expect(renameIfNeeded('pic.png', ['other.png'])).toBe('pic.png');
    expect(renameIfNeeded('pic.png', ['pic.png'])).toBe('pic-1.png');
    expect(renameIfNeeded('pic.png', ['PIC.PNG'])).toBe('pic-1.png');
    expect(renameIfNeeded('pic.png', ['pic.png', 'pic-1.png', 'pic-7.png'])).toBe('pic-8.png');
    expect(renameIfNeeded('pic.png', ['pic-3.png'])).toBe('pic.png'); // free: returned as is
    expect(renameIfNeeded('a.b.png', ['a.b.png'])).toBe('a.b-1.png');
    expect(renameIfNeeded('release-2.0', ['release-2.0'], { hasExtension: false })).toBe('release-2.0-1');
  });

  it('where images live and how they are written', () => {
    expect(postStem(POST)).toBe('my-note');
    expect(imageFolder(POST)).toBe('src/content/notes/2026/my-note');
    expect(imagePath(POST, 'pic.png')).toBe('src/content/notes/2026/my-note/pic.png');
    expect(imageRef(POST, 'pic.png')).toBe('my-note/pic.png'); // no ./ and no leading slash
    expect(imageFolder('src/content/series/ai-safety.md')).toBe('src/content/series/ai-safety');
    expect(encodeFilePath('a b/(c)!.png')).toBe('a%20b/%28c%29%21.png');
    expect(encodeFilePath('my-note/pic-1.png')).toBe('my-note/pic-1.png'); // a no-op for the names this app makes
  });

  it('pendingAssetsFor gives repo paths, and with the text leaves out images it no longer mentions', () => {
    const image = (name: string): PendingImage => ({ name, data: new Blob(['x']), type: 'image/png', size: 1, stripped: true, addedAt: 1 });
    const images = [image('a.png'), image('b.png')];
    expect(pendingAssetsFor(POST, images).map((a) => a.path)).toEqual(['src/content/notes/2026/my-note/a.png', 'src/content/notes/2026/my-note/b.png']);
    expect(pendingAssetsFor(POST, images, '![x](my-note/b.png)\n').map((a) => a.path)).toEqual(['src/content/notes/2026/my-note/b.png']);
    expect(pendingAssetsFor(POST, images, '---\ncard_image: my-note/a.png\n---\n').map((a) => a.path)).toEqual(['src/content/notes/2026/my-note/a.png']);
    expect(pendingAssetsFor(POST, undefined)).toEqual([]);
    expect(isImageReferenced('![x](my-note/a.png)', POST, 'a.png')).toBe(true);
    expect(isImageReferenced('![x](other/a.png)', POST, 'a.png')).toBe(false);
  });

  it('rewriteImageRefs moves references to the new folder and nothing else', () => {
    const to = 'src/content/notes/2026/renamed.md';
    const raw = [
      '---',
      'slug: my-note',
      'card_image: my-note/card.png',
      '---',
      '',
      'About my-note/ in prose and https://example.com/my-note/pic.png stay.',
      '![a](my-note/pic.png) ![b](./my-note/pic-1.png "title")',
      '<img src="my-note/pic.png"> <img src=\'my-note/pic.png\'>',
      '[link](my-note/doc.pdf)',
      'not-my-note/pic.png and my-notes/pic.png',
      '',
    ].join('\r\n');
    const out = rewriteImageRefs(raw, POST, to);
    expect(out).toBe(
      [
        '---',
        'slug: my-note',
        'card_image: renamed/card.png',
        '---',
        '',
        'About my-note/ in prose and https://example.com/my-note/pic.png stay.',
        '![a](renamed/pic.png) ![b](./renamed/pic-1.png "title")',
        '<img src="renamed/pic.png"> <img src=\'renamed/pic.png\'>',
        '[link](renamed/doc.pdf)',
        'not-my-note/pic.png and my-notes/pic.png',
        '',
      ].join('\r\n'),
    );
    // limited to known files
    expect(rewriteImageRefs('![a](my-note/pic.png) [l](my-note/doc.pdf)', POST, to, ['pic.png'])).toBe('![a](renamed/pic.png) [l](my-note/doc.pdf)');
    // nothing to do
    expect(rewriteImageRefs(raw, POST, POST)).toBe(raw);
    expect(rewriteImageRefs('no refs here', POST, to)).toBe('no refs here');
  });
});

describe('downscale and re-encode', () => {
  it('calculateResize fits inside the box and never enlarges', () => {
    expect(calculateResize({ width: 4000, height: 3000 }, { width: 2000, height: 2000 })).toEqual({ scale: 0.5, width: 2000, height: 1500 });
    expect(calculateResize({ width: 3000, height: 4000 }, { width: 2000, height: 2000 })).toEqual({ scale: 0.5, width: 1500, height: 2000 });
    expect(calculateResize({ width: 800, height: 600 }, { width: 2000, height: 2000 })).toEqual({ scale: 1, width: 800, height: 600 });
    expect(calculateResize({ width: 2000, height: 2000 }, { width: 2000, height: 2000 })).toEqual({ scale: 1, width: 2000, height: 2000 });
  });

  it('scales a large photo down to the longest side and writes a new JPEG at the given quality', async () => {
    const { env, log } = fakeEnv({ size: [4032, 3024] });
    const out = await transformImage(new Blob([img.jpeg() as BlobPart]), 'jpeg', {}, env);
    expect(out).toMatchObject({ type: 'image/jpeg', width: 2000, height: 1500, resized: true });
    expect(log.canvases).toEqual([[2000, 1500]]);
    expect(log.encodes).toEqual([['image/jpeg', 0.85]]);
    expect(log.closed).toBe(1);
    const custom = await transformImage(new Blob([img.jpeg() as BlobPart]), 'jpeg', { maxDimension: 1000, quality: 60 }, fakeEnv({ size: [4000, 2000] }).env);
    expect(custom).toMatchObject({ width: 1000, height: 500 });
  });

  it('keeps the type where the browser can write it; PNG stays PNG, a still GIF becomes PNG, AVIF becomes WebP', async () => {
    const run = (format: Parameters<typeof transformImage>[1], opts = {}) => transformImage(new Blob([img.png() as BlobPart]), format, {}, fakeEnv({ size: [100, 100], ...opts }).env);
    expect((await run('png')).type).toBe('image/png');
    expect((await run('webp')).type).toBe('image/webp');
    expect((await run('gif')).type).toBe('image/png');
    expect((await run('avif')).type).toBe('image/webp');
    expect((await run('heic')).type).toBe('image/jpeg');
    expect((await run('png')).resized).toBe(false);
  });

  it('a browser that cannot write WebP gets JPEG — or PNG when the picture has transparency', async () => {
    const opaque = fakeEnv({ size: [100, 100], cannotEncode: ['image/webp'] });
    expect((await transformImage(new Blob([img.webp() as BlobPart]), 'webp', {}, opaque.env)).type).toBe('image/jpeg');
    expect(opaque.log.encodes.map(([t]) => t)).toEqual(['image/webp', 'image/jpeg']);
    const seeThrough = fakeEnv({ size: [100, 100], cannotEncode: ['image/webp'], transparent: true });
    expect((await transformImage(new Blob([img.webp() as BlobPart]), 'webp', {}, seeThrough.env)).type).toBe('image/png');
  });

  it('rejects when the picture cannot be decoded', async () => {
    await expect(transformImage(new Blob([img.heic() as BlobPart]), 'heic', {}, fakeEnv({ cannotDecode: true }).env)).rejects.toThrow();
  });
});

describe('intake', () => {
  const base = { postPath: POST, now: () => NOW };

  it('by default re-encodes: the result has none of the original bytes (EXIF/GPS gone), a safe name and its blob id', async () => {
    const { env } = fakeEnv({ size: [4032, 3024] });
    const original = img.jpeg(5000);
    expect(new TextDecoder('latin1').decode(original)).toContain('GPS');
    const result = await intakeImages([img.fileOf(original, 'IMG 4032 (Berlin).JPG', 'image/jpeg')], { ...base, env });

    expect(result.rejected).toEqual([]);
    expect(result.images).toHaveLength(1);
    const image = result.images[0];
    expect(image).toMatchObject({ name: 'img-4032-berlin.jpg', type: 'image/jpeg', stripped: true, width: 2000, height: 1500, originalName: 'IMG 4032 (Berlin).JPG', addedAt: NOW });
    const out = new Uint8Array(await image.data.arrayBuffer());
    expect(new TextDecoder('latin1').decode(out)).not.toContain('GPS');
    expect(new TextDecoder('latin1').decode(out)).not.toContain('Exif');
    expect(image.size).toBe(out.byteLength);
    expect(image.sha).toBe(await gitBlobSha(out));
    expect(image.data.type).toBe('image/jpeg');
    expect(result.inserts).toEqual([{ src: 'my-note/img-4032-berlin.jpg' }]);
  });

  it('the original-quality switch keeps the file byte for byte — and says the metadata is still in it', async () => {
    const { env, log } = fakeEnv({ size: [4032, 3024] });
    const original = img.jpeg(5000);
    const result = await intakeImages([img.fileOf(original, 'photo.jpg', 'image/jpeg')], { ...base, env, originalQuality: true });
    const image = result.images[0];
    expect(new Uint8Array(await image.data.arrayBuffer())).toEqual(original);
    expect(image).toMatchObject({ name: 'photo.jpg', stripped: false, type: 'image/jpeg', width: 4032, height: 3024, size: original.byteLength });
    expect(image.sha).toBe(await gitBlobSha(original));
    expect(log.encodes).toEqual([]);
  });

  it('judges by content: a PNG named .jpg gets .png; text named .png and SVG are rejected', async () => {
    const { env } = fakeEnv({ size: [10, 10] });
    const result = await intakeImages(
      [img.fileOf(img.png(), 'shot.jpg', 'image/jpeg'), img.fileOf(img.text(), 'notes.png', 'image/png'), img.fileOf(img.svg(), 'logo.svg', 'image/svg+xml'), img.fileOf(new Uint8Array(0), 'empty.png', 'image/png')],
      { ...base, env },
    );
    expect(result.images.map((i) => [i.name, i.type])).toEqual([['shot.png', 'image/png']]);
    expect(result.rejected.map((r) => [r.name, r.reason])).toEqual([
      ['notes.png', 'not-an-image'],
      ['logo.svg', 'unsupported'],
      ['empty.png', 'unreadable'],
    ]);
    expect(result.rejected.every((r) => r.message.length > 10)).toBe(true);
  });

  it('de-duplicates names against the folder, the draft, and within the batch', async () => {
    const { env } = fakeEnv({ size: [10, 10] });
    const result = await intakeImages(
      [img.fileOf(img.png(), 'Pic.png'), img.fileOf(img.png(), 'pic.PNG'), img.fileOf(img.png(), 'image.png'), img.fileOf(img.png(), 'image.png'), new Blob([img.png() as BlobPart])],
      { ...base, env, taken: ['pic.png', 'pic-1.png', 'unrelated.jpg'] },
    );
    expect(result.images.map((i) => i.name)).toEqual(['pic-2.png', 'pic-3.png', '20261119-093005.png', '20261119-093005-1.png', '20261119-093005-2.png']);
    expect(new Set(result.images.map((i) => i.name.toLowerCase())).size).toBe(5);
    expect(result.inserts.map((i) => i.src)).toEqual(result.images.map((i) => `my-note/${i.name}`));
  });

  it('keeps an animation as it is (re-encoding would freeze it) and marks it not stripped', async () => {
    const { env, log } = fakeEnv({ size: [10, 10] });
    const bytes = img.animatedGif();
    const result = await intakeImages([img.fileOf(bytes, 'party.gif', 'image/gif')], { ...base, env });
    expect(result.images[0]).toMatchObject({ name: 'party.gif', type: 'image/gif', stripped: false });
    expect(new Uint8Array(await result.images[0].data.arrayBuffer())).toEqual(bytes);
    expect(log.encodes).toEqual([]);
  });

  it('never keeps original bytes silently: when the picture cannot be re-encoded it is rejected, pointing at the switch', async () => {
    const jpg = img.fileOf(img.jpeg(), 'photo.jpg', 'image/jpeg');
    const broken = await intakeImages([jpg], { ...base, env: fakeEnv({ cannotDecode: true }).env });
    expect(broken.images).toEqual([]);
    expect(broken.rejected[0]).toMatchObject({ reason: 'cannot-strip' });
    expect(broken.rejected[0].message).toContain('original quality');
    // no image APIs at all (node, an old browser)
    const none = await intakeImages([jpg], { ...base, env: null });
    expect(none.rejected[0].reason).toBe('cannot-strip');
    // …and with the switch the same file goes in
    const kept = await intakeImages([jpg], { ...base, env: null, originalQuality: true });
    expect(kept.images[0]).toMatchObject({ name: 'photo.jpg', stripped: false });
    expect(kept.images[0].width).toBeUndefined();
  });

  it('HEIC: converted where the browser can decode it, otherwise rejected (never committed as HEIC)', async () => {
    const heic = img.fileOf(img.heic(), 'IMG_0001.HEIC', 'image/heic');
    const safari = await intakeImages([heic], { ...base, env: fakeEnv({ size: [4000, 3000] }).env });
    expect(safari.images[0]).toMatchObject({ name: 'img-0001.jpg', type: 'image/jpeg', stripped: true });
    const chrome = await intakeImages([heic], { ...base, env: fakeEnv({ cannotDecode: true }).env });
    expect(chrome.rejected[0]).toMatchObject({ reason: 'unsupported' });
    const original = await intakeImages([heic], { ...base, env: fakeEnv().env, originalQuality: true });
    expect(original.rejected[0]).toMatchObject({ reason: 'unsupported' });
    // a HEIC renamed to .jpg is still recognised
    const renamed = await intakeImages([img.fileOf(img.heic(), 'photo.jpg', 'image/jpeg')], { ...base, env: fakeEnv({ cannotDecode: true }).env });
    expect(renamed.rejected[0].reason).toBe('unsupported');
  });

  it('rejects a file over the size limit', async () => {
    const result = await intakeImages([img.fileOf(img.jpeg(4000), 'big.jpg')], { ...base, env: null, originalQuality: true, maxBytes: 1000 });
    expect(result.rejected[0]).toMatchObject({ name: 'big.jpg', reason: 'too-large' });
  });

  it('a remote image without a file is linked, not taken in; alt text and a scraped name carry over', async () => {
    const { env } = fakeEnv({ size: [10, 10] });
    const result = await intakeImages(
      [
        { src: 'https://example.com/a.png', alt: 'An example' },
        { file: img.fileOf(img.png(), 'image.png', 'image/png'), alt: 'A diagram', name: 'system diagram.jpg' },
      ],
      { ...base, env },
    );
    expect(result.images.map((i) => [i.name, i.alt])).toEqual([['system-diagram.png', 'A diagram']]);
    expect(result.inserts).toEqual([
      { src: 'https://example.com/a.png', alt: 'An example' },
      { src: 'my-note/system-diagram.png', alt: 'A diagram' },
    ]);
  });
});

describe('pending image URLs', () => {
  const image = (name: string, data = new Blob([name])): PendingImage => ({ name, data, type: 'image/png', size: data.size, stripped: true, addedAt: 1 });
  function registry() {
    const made: string[] = [];
    const revoked: string[] = [];
    let n = 0;
    return { images: createPendingImages({ createObjectURL: () => (made.push(`blob:x/${++n}`), `blob:x/${n}`), revokeObjectURL: (u) => void revoked.push(u) }), made, revoked };
  }

  it('resolves a draft’s images by repo path, follows the post when its path changes, and revokes what is dropped', () => {
    const { images, revoked } = registry();
    const a = image('a.png');
    const b = image('b.png');
    images.sync('new:notes:1', 'src/content/notes/2026/untitled.md', [a, b]);
    expect(images.url('src/content/notes/2026/untitled/a.png')).toBe('blob:x/1');
    expect(images.url('src/content/notes/2026/untitled/b.png')).toBe('blob:x/2');
    expect(images.url('src/content/notes/2026/untitled/c.png')).toBeNull();
    expect(images.names('new:notes:1')).toEqual(['a.png', 'b.png']);

    // the slug changed: same blobs, same URLs, new paths
    images.sync('new:notes:1', 'src/content/notes/2026/my-note.md', [a, b]);
    expect(images.url('src/content/notes/2026/my-note/a.png')).toBe('blob:x/1');
    expect(images.url('src/content/notes/2026/untitled/a.png')).toBeNull();
    expect(revoked).toEqual([]);

    // one removed
    images.sync('new:notes:1', 'src/content/notes/2026/my-note.md', [b]);
    expect(revoked).toEqual(['blob:x/1']);
    expect(images.url('src/content/notes/2026/my-note/a.png')).toBeNull();

    images.sync('new:notes:1', 'src/content/notes/2026/my-note.md', undefined);
    expect(revoked).toEqual(['blob:x/1', 'blob:x/2']);
    expect(images.names('new:notes:1')).toEqual([]);
  });

  it('keeps committed images for the session, and two drafts apart', () => {
    const { images, revoked } = registry();
    images.sync('d1', 'src/content/notes/2026/one.md', [image('p.png')]);
    images.sync('d2', 'src/content/notes/2026/two.md', [image('p.png')]);
    images.keep('src/content/notes/2026/one/p.png', new Blob(['committed']));
    expect(images.url('src/content/notes/2026/one/p.png')).toBe('blob:x/1'); // the draft's own wins while it exists
    images.clear('d1');
    expect(images.url('src/content/notes/2026/one/p.png')).toBe('blob:x/3'); // then the committed bytes
    expect(images.url('src/content/notes/2026/two/p.png')).toBe('blob:x/2');
    images.clear();
    expect(images.url('src/content/notes/2026/two/p.png')).toBeNull();
    expect(revoked.sort()).toEqual(['blob:x/1', 'blob:x/2', 'blob:x/3']);
  });
});
