/** Minimal image files for tests: correct signatures and structure, no real pixels. */

const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const pad = (bytes: number[], length = 64) => new Uint8Array([...bytes, ...new Array(Math.max(0, length - bytes.length)).fill(0)]);

/** A JPEG start: SOI, then an APP1 "Exif" segment (where a camera keeps GPS). */
export const jpeg = (extra = 0) => pad([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x20, ...ascii('Exif\0\0'), ...ascii('GPS: 52.52N 13.40E')], 64 + extra);

const pngChunk = (type: string, data: number[]) => [...u32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
const PNG_SIG = [0x89, ...ascii('PNG'), 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = pngChunk('IHDR', [...u32(1), ...u32(1), 8, 6, 0, 0, 0]);
export const png = () => new Uint8Array([...PNG_SIG, ...IHDR, ...pngChunk('IDAT', [1, 2, 3]), ...pngChunk('IEND', [])]);
export const apng = () => new Uint8Array([...PNG_SIG, ...IHDR, ...pngChunk('acTL', [...u32(2), ...u32(0)]), ...pngChunk('IDAT', [1, 2, 3]), ...pngChunk('IEND', [])]);

const gifFrame = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, /* lzw min */ 2, /* block */ 1, 0x44, 0];
const GIF_HEAD = [...ascii('GIF89a'), 1, 0, 1, 0, 0, 0, 0];
export const gif = () => pad([...GIF_HEAD, ...gifFrame, 0x3b], 32);
export const animatedGif = () => pad([...GIF_HEAD, ...gifFrame, ...gifFrame, 0x3b], 48);

export const webp = () => pad([...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8 '), 0, 0, 0, 0]);
export const animatedWebp = () => pad([...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8X'), 10, 0, 0, 0, 0x02, 0, 0, 0]);

const ftyp = (major: string, ...compatible: string[]) => {
  const body = [...ascii('ftyp'), ...ascii(major), 0, 0, 0, 0, ...compatible.flatMap(ascii)];
  return pad([...u32(body.length + 4), ...body]);
};
export const avif = () => ftyp('avif', 'mif1', 'miaf');
export const heic = () => ftyp('heic', 'mif1');
/** Some Android phones: generic major brand, `heic` only among the compatible ones. */
export const heicGeneric = () => ftyp('mif1', 'heic');

export const svg = () => new TextEncoder().encode('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
export const text = () => new TextEncoder().encode('just some text, long enough to be sniffed properly');

export const fileOf = (bytes: Uint8Array, name: string, type = '') => new File([bytes as BlobPart], name, { type });
