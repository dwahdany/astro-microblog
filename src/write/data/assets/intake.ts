/**
 * Taking images in: from a paste, a drop or the file picker to `PendingImage`s ready to be kept
 * with the draft and committed with the post.
 *
 * `imagesFromPaste` and `imagesFromDrop` are lifted from Sveltia CMS —
 * https://github.com/sveltia/sveltia-cms (fork dwahdany/sveltia-cms) at commit 06d5552aa,
 * `src/lib/services/contents/fields/rich-text/images.js` (98-208: `getPastedImages`,
 * `getDroppedImages`, `getRemoteImageFileName`, `findImageInHTML`).
 * Copyright (c) 2026 Kohei Yoshino. MIT License: see src/write/licenses/sveltia-MIT.txt.
 * Changes: TypeScript; `@sveltia/utils` helpers inlined; editor-agnostic — the event is only READ
 * (Sveltia cleared the clipboard items and stopped propagation; here the caller calls
 * `preventDefault()` when images came back); any `image/*` file is passed on and judged by its
 * content later; naming is left to `intakeImages`.
 * `intakeImages` (sniff → strip/downscale → name → hash) is new code.
 */
import type { PendingImage } from '../../contracts';
import { rememberImageBytes } from '../draft-store';
import { gitBlobSha } from '../git-sha';
import { isAnimatedImage } from './animation';
import { imageRef, renameIfNeeded, sanitizeImageName } from './names';
import { isSvg, sniffRasterImageFormat, type RasterImageFormat } from './sniff';
import { browserImageEnv, transformImage, type ImageEnv, type TransformOptions } from './transform';

/** An image found in a paste or a drop. */
export interface ImageEntry {
  /** Image file to take in. Absent for a remote image that is linked rather than downloaded. */
  file?: File | Blob;
  /** Image URL. Used when there is no file. */
  src?: string;
  /** Alternative text found with the image. */
  alt?: string;
  /** A better name than the file's own (the last path segment of the page image it was copied from). */
  name?: string;
}

/** `accept` for a file input: the formats the site can show. */
export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/gif,image/avif';

/** Regular expression matching a base64-encoded image data URL, capturing its MIME type. */
const DATA_URL_REGEX = /^data:(?<type>image\/.+?);base64,.+/;

const isImageType = (type: string): boolean => /^image\//i.test(type);

const decodeSafely = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** The file name at the end of a remote image's URL, decoded; undefined when there is none. */
const remoteImageName = (url: string): string | undefined => {
  try {
    const name = decodeSafely(new URL(url).pathname.split('/').pop() ?? '');
    return /\.[a-z0-9]{2,5}$/i.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
};

/** Parse the given HTML and find the first image in it. */
const findImageInHTML = (html: string): HTMLImageElement | null => new DOMParser().parseFromString(html, 'text/html').querySelector('img');

/**
 * Get the images in a paste. A remote image copied within the browser comes with both the file and
 * HTML holding an `<img>`, so the file name and alternative text are scraped from the HTML. Images
 * pasted as local files are used as they are.
 *
 * Call it synchronously inside the `paste` handler (the clipboard is only readable then), and call
 * `event.preventDefault()` when it MAY return images — i.e. when `hasImages(event)` is true —
 * because the answer itself arrives after the handler has returned.
 * @returns Images. Empty if nothing pasted is an image.
 */
export async function imagesFromPaste(event: ClipboardEvent): Promise<ImageEntry[]> {
  const { clipboardData } = event;
  const pastedItems = clipboardData?.items;

  if (!pastedItems) {
    return [];
  }

  const items = [...pastedItems];
  const fileIndex = items.findIndex(({ kind, type }) => kind === 'file' && isImageType(type));
  const htmlIndex = items.findIndex(({ kind, type }) => kind === 'string' && type === 'text/html');

  if (fileIndex > -1 && htmlIndex > -1) {
    const file = items[fileIndex].getAsFile();

    if (!file) {
      return [];
    }

    const img = await new Promise<HTMLImageElement | null>((resolve) => {
      items[htmlIndex].getAsString((str) => {
        try {
          resolve(findImageInHTML(str));
        } catch {
          resolve(null);
        }
      });
    });

    const entry: ImageEntry = { file };

    if (img) {
      if (img.alt) entry.alt = img.alt;
      const src = img.getAttribute('src') ?? '';
      if (/^https?:/.test(src)) entry.name = remoteImageName(src);
    }

    return [entry];
  }

  return [...clipboardData.files].filter(({ type }) => isImageType(type)).map((file) => ({ file }));
}

/** Does the paste or drop carry an image file? Synchronous: decides whether to `preventDefault()`. */
export function hasImages(event: ClipboardEvent | DragEvent): boolean {
  const transfer = 'clipboardData' in event ? event.clipboardData : (event as DragEvent).dataTransfer;
  if (!transfer) return false;
  if ([...(transfer.files ?? [])].some(({ type }) => isImageType(type))) return true;
  return [...(transfer.items ?? [])].some(({ kind, type }) => kind === 'file' && isImageType(type));
}

/**
 * Get the images in a drop. Local files are used as they are. A remote image dragged from another
 * page comes as HTML holding an `<img>` rather than a file, so its `src` and `alt` are used to link
 * it instead; the image is only downloaded when the `src` is a data URL, because fetching it from
 * another site would most likely fail due to its CORS policy.
 *
 * Call it synchronously inside the `drop` handler.
 * @returns Images. Empty if nothing dropped is an image, or the dropped data URL couldn't be read.
 */
export async function imagesFromDrop(event: DragEvent): Promise<ImageEntry[]> {
  const { dataTransfer } = event;
  const droppedFiles = dataTransfer?.files;

  if (droppedFiles?.length) {
    return [...droppedFiles].filter(({ type }) => isImageType(type)).map((file) => ({ file }));
  }

  const html = dataTransfer?.getData('text/html');
  let img: HTMLImageElement | null = null;
  try {
    img = html ? findImageInHTML(html) : null;
  } catch {
    img = null;
  }

  if (!img) {
    return [];
  }

  const src = img.getAttribute('src') ?? '';
  const alt = img.alt;
  const type = src.match(DATA_URL_REGEX)?.groups?.type ?? '';

  if (isImageType(type)) {
    try {
      const file = await (await fetch(src)).blob();
      return [{ file, alt }];
    } catch {
      return [];
    }
  }

  return src ? [{ src, alt }] : [];
}

/* ---------------------------------------------------------- new: pipeline */

export interface IntakeOptions {
  /** Current target path of the post the images are for (`DraftRecord.path`). */
  postPath: string;
  /** Names already used in the post's image folder — committed files and the draft's pending images. */
  taken?: Iterable<string>;
  /**
   * Keep the file exactly as it is: no downscale, no re-encode — and therefore EXIF, GPS and other
   * metadata STAY in it and are published with it. Off by default. The result says so
   * (`PendingImage.stripped === false`).
   */
  originalQuality?: boolean;
  /** Longest side after downscaling, px. Default 2000. */
  maxDimension?: number;
  /** Quality for lossy formats, 0–100. Default 85. */
  quality?: number;
  /** Largest file accepted after processing. Default 25 MB. */
  maxBytes?: number;
  now?: () => number;
  /** Browser image APIs. Defaults to the real ones; null = none (every image then needs `originalQuality`). */
  env?: ImageEnv | null;
}

export type IntakeRejectionReason =
  /** the content is not a picture format the site can show */
  | 'not-an-image'
  /** a picture, but one this app does not take (SVG, or HEIC where the browser cannot convert it) */
  | 'unsupported'
  /** the file could not be read */
  | 'unreadable'
  | 'too-large'
  /** it could not be re-encoded, so its metadata cannot be removed; offer the original-quality switch */
  | 'cannot-strip';

export interface IntakeRejection {
  /** The name the file arrived with. */
  name: string;
  reason: IntakeRejectionReason;
  /** A sentence for the owner. */
  message: string;
}

export interface IntakeResult {
  /** Images taken in, in the order given: add them to `DraftRecord.assets`. */
  images: PendingImage[];
  /** What to insert in the text, in the order given: `src` for `exec('image', { src, alt })`. Includes linked remote images. */
  inserts: { src: string; alt?: string }[];
  rejected: IntakeRejection[];
}

export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;

const TYPE_FOR_FORMAT: Readonly<Record<RasterImageFormat, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  heic: 'image/heic',
};

const nameOf = (entry: ImageEntry): string => entry.name ?? ((entry.file as File | undefined)?.name || 'image');

/**
 * Turn files into `PendingImage`s:
 *   1. the format is read from the CONTENT (a renamed HEIC or a text file called `.png` is caught);
 *   2. unless `originalQuality`, the picture is decoded, scaled down to `maxDimension` and encoded
 *      anew, which removes EXIF/GPS. An animation is kept as it is (re-encoding would keep only
 *      its first frame) and marked `stripped: false`;
 *   3. the name is narrowed to `[a-z0-9.-]`, given the extension of the real type, and numbered
 *      when the folder already has it (`pic.jpg` → `pic-1.jpg`), also within the batch;
 *   4. the git blob id of the final bytes is recorded.
 * Never throws for a bad file: it is reported in `rejected` and the others still come through.
 */
export async function intakeImages(input: readonly (File | Blob | ImageEntry)[], options: IntakeOptions): Promise<IntakeResult> {
  const env = options.env === undefined ? browserImageEnv() : options.env;
  const now = options.now ?? Date.now;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const taken = [...(options.taken ?? [])];
  const transformOptions: TransformOptions = { maxDimension: options.maxDimension, quality: options.quality };
  const result: IntakeResult = { images: [], inserts: [], rejected: [] };

  for (const item of input) {
    const entry: ImageEntry = item instanceof Blob ? { file: item } : item;
    const original = nameOf(entry);
    const reject = (reason: IntakeRejectionReason, message: string) => void result.rejected.push({ name: original, reason, message });

    if (!entry.file) {
      // A remote image: nothing to take in, it is linked where it is.
      if (entry.src) result.inserts.push(entry.alt ? { src: entry.src, alt: entry.alt } : { src: entry.src });
      continue;
    }

    const file = entry.file;
    const format = await sniffRasterImageFormat(file);
    if (!format) {
      if (await isSvg(file)) reject('unsupported', `${original} is an SVG file. SVG images cannot be added here.`);
      else if (file.size === 0) reject('unreadable', `${original} is empty or could not be read.`);
      else reject('not-an-image', `${original} is not a JPEG, PNG, WebP, GIF or AVIF image.`);
      continue;
    }

    const animated = await isAnimatedImage(file, format);
    let data: Blob = file;
    let type = TYPE_FOR_FORMAT[format];
    let width: number | undefined;
    let height: number | undefined;
    let stripped = false;

    if (options.originalQuality || animated) {
      if (format === 'heic') {
        reject('unsupported', `${original} is a HEIC photo, which the site cannot show as it is. Add it without “original quality” in Safari, or convert it to JPEG first.`);
        continue;
      }
      // Kept byte for byte. Its pixel size is nice to have, nothing more.
      if (env) {
        try {
          const decoded = await env.decode(file);
          ({ width, height } = decoded);
          decoded.close?.();
        } catch {
          /* unknown size */
        }
      }
      if (data.type !== type) data = data.slice(0, data.size, type);
    } else {
      if (!env) {
        reject('cannot-strip', `${original} cannot be re-encoded in this browser, so the details stored inside it (which can include where it was taken) cannot be removed. Add it with “original quality” to keep it as it is.`);
        continue;
      }
      try {
        const out = await transformImage(file, format, transformOptions, env);
        ({ blob: data, type, width, height } = out);
        stripped = true;
      } catch {
        if (format === 'heic') reject('unsupported', `${original} is a HEIC photo, which this browser cannot convert. Convert it to JPEG first.`);
        else
          reject('cannot-strip', `${original} could not be re-encoded, so the details stored inside it (which can include where it was taken) cannot be removed. Add it with “original quality” to keep it as it is.`);
        continue;
      }
    }

    if (data.size > maxBytes) {
      reject('too-large', `${original} is ${(data.size / 1024 / 1024).toFixed(1)} MB; the limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`);
      continue;
    }

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await data.arrayBuffer());
    } catch {
      reject('unreadable', `${original} could not be read.`);
      continue;
    }

    // The draft store keeps bytes, not Blobs: hand them over now, so storing the draft need not wait.
    rememberImageBytes(data, bytes);

    const at = now();
    const name = renameIfNeeded(sanitizeImageName(original, type, new Date(at)), taken);
    taken.push(name);

    const image: PendingImage = { name, data, type, size: data.size, stripped, addedAt: at };
    const sha = await gitBlobSha(bytes);
    if (sha) image.sha = sha;
    if (width && height) {
      image.width = width;
      image.height = height;
    }
    if (original && original !== 'image') image.originalName = original;
    if (entry.alt) image.alt = entry.alt;

    result.images.push(image);
    const src = imageRef(options.postPath, name);
    result.inserts.push(entry.alt ? { src, alt: entry.alt } : { src });
  }

  return result;
}
