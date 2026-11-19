/**
 * Downscaling and re-encoding an image in the browser — which is also what removes EXIF, GPS and
 * every other embedded metadata: the image is decoded to pixels and a NEW file is encoded from
 * them, so nothing of the original container survives.
 *
 * `calculateResize` is lifted from Sveltia CMS — https://github.com/sveltia/sveltia-cms
 * (fork dwahdany/sveltia-cms) at commit 06d5552aa, `src/lib/services/utils/media/image/resize.js`;
 * the decode → canvas → encode sequence and the "does the browser encode this type" check follow
 * `transform.js:169-218` and `encode.js`.
 * Copyright (c) 2026 Kohei Yoshino. MIT License: see src/write/licenses/sveltia-MIT.txt.
 * Changes: TypeScript; the browser APIs sit behind an injectable `ImageEnv` (tests); no UNPKG
 * `loadModule`, no jSquash, HEIC decoder or SVGO — a type the browser cannot encode (WebP on older
 * Safari) falls back to JPEG, or PNG when the picture has transparency; the output type follows the
 * source type instead of a configured format; the EXIF orientation is applied while decoding.
 */
import type { RasterImageFormat } from './sniff';

/** Calculate the size of the resized canvas: scale down to fit inside the target, never up. */
export const calculateResize = (
  { width: originalWidth, height: originalHeight }: { width: number; height: number },
  {
    width: targetWidth = originalWidth,
    height: targetHeight = originalHeight,
    fit = 'scale-down',
  }: { width?: number; height?: number; fit?: 'scale-down' | 'contain' } = {},
): { scale: number; width: number; height: number } => {
  const original = { scale: 1, width: originalWidth, height: originalHeight };

  if (originalWidth === targetWidth && originalHeight === targetHeight) {
    return original;
  }

  const isSmaller = originalWidth <= targetWidth && originalHeight <= targetHeight;
  let scale = 1;
  let newWidth = 0;
  let newHeight = 0;

  if (fit === 'scale-down') {
    if (isSmaller) {
      return original;
    }

    fit = 'contain';
  }

  if (fit === 'contain') {
    scale = Math.min(targetWidth / originalWidth, targetHeight / originalHeight);
    newWidth = originalWidth * scale;
    newHeight = originalHeight * scale;
  }

  return { scale, width: newWidth, height: newHeight };
};

/** A decoded picture that can be drawn on a canvas. */
export interface DecodedImage {
  width: number;
  height: number;
  close?(): void;
}

export interface CanvasLike {
  /** Draw the whole picture scaled to the canvas. */
  draw(image: DecodedImage): void;
  /** Encode. Resolves with a blob whose `type` says what was REALLY produced (a browser answers PNG for a type it cannot encode). */
  encode(type: string, quality: number): Promise<Blob>;
  /** Whether any pixel is not fully opaque. */
  hasTransparency(): boolean;
}

/** The browser APIs the transform needs. */
export interface ImageEnv {
  /** Decode with the EXIF orientation applied. Rejects for a format the browser cannot decode. */
  decode(blob: Blob): Promise<DecodedImage>;
  createCanvas(width: number, height: number): CanvasLike;
}

/** The real thing: `createImageBitmap` and `OffscreenCanvas` (or a `<canvas>` where that is missing). Null outside a browser. */
export function browserImageEnv(): ImageEnv | null {
  const g = globalThis as unknown as {
    createImageBitmap?: (blob: Blob, options?: { imageOrientation?: string }) => Promise<ImageBitmap>;
    OffscreenCanvas?: new (w: number, h: number) => OffscreenCanvas;
    document?: Document;
  };
  if (typeof g.createImageBitmap !== 'function') return null;
  if (typeof g.OffscreenCanvas !== 'function' && !g.document) return null;

  return {
    // 'from-image' turns the pixels the way the EXIF orientation says, so dropping the tag is safe.
    decode: (blob) => (g.createImageBitmap as NonNullable<typeof g.createImageBitmap>)(blob, { imageOrientation: 'from-image' }),
    createCanvas(width, height) {
      const canvas: OffscreenCanvas | HTMLCanvasElement =
        typeof g.OffscreenCanvas === 'function' ? new g.OffscreenCanvas(width, height) : Object.assign((g.document as Document).createElement('canvas'), { width, height });
      const context = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
      if (!context) throw new Error('No 2D canvas in this browser');
      return {
        draw: (image) => context.drawImage(image as unknown as CanvasImageSource, 0, 0, width, height),
        encode: (type, quality) =>
          'convertToBlob' in canvas
            ? canvas.convertToBlob({ type, quality })
            : new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Encoding failed'))), type, quality)),
        hasTransparency() {
          const { data } = context.getImageData(0, 0, width, height);
          // Every fourth byte is the alpha channel of a pixel
          for (let index = 3; index < data.length; index += 4) if (data[index] < 255) return true;
          return false;
        },
      };
    },
  };
}

export interface TransformOptions {
  /** Longest side of the result in pixels; a smaller picture is not enlarged. Default 2000. */
  maxDimension?: number;
  /** Quality for lossy formats, 0–100. Default 85. */
  quality?: number;
}

export interface TransformResult {
  blob: Blob;
  /** MIME type of `blob`. */
  type: string;
  width: number;
  height: number;
  /** The picture was made smaller. */
  resized: boolean;
}

export const DEFAULT_MAX_DIMENSION = 2000;
export const DEFAULT_QUALITY = 85;

/** The type a re-encoded picture gets: its own where the browser can write it, otherwise the nearest it can. */
const PREFERRED_TYPE: Readonly<Record<RasterImageFormat, string>> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  // Canvas cannot write AVIF or HEIC; a static GIF is a palette image, PNG keeps it exact.
  avif: 'image/webp',
  heic: 'image/jpeg',
  gif: 'image/png',
};

/**
 * Decode, scale down to `maxDimension`, encode anew. The result carries no metadata of the source.
 * @throws When the browser cannot decode the picture or encode the result.
 */
export async function transformImage(blob: Blob, format: RasterImageFormat, options: TransformOptions, env: ImageEnv): Promise<TransformResult> {
  const max = options.maxDimension ?? DEFAULT_MAX_DIMENSION;
  const quality = Math.min(100, Math.max(1, options.quality ?? DEFAULT_QUALITY)) / 100;
  const image = await env.decode(blob);

  try {
    if (!(image.width > 0 && image.height > 0)) throw new Error('The picture has no size');
    const size = calculateResize({ width: image.width, height: image.height }, { width: max, height: max });
    const width = Math.max(1, Math.round(size.width));
    const height = Math.max(1, Math.round(size.height));
    const canvas = env.createCanvas(width, height);
    canvas.draw(image);

    let type = PREFERRED_TYPE[format];
    let out = await canvas.encode(type, quality);
    if (out.type !== type) {
      // The browser cannot write that type. JPEG has no transparency, which would come out black.
      type = canvas.hasTransparency() ? 'image/png' : 'image/jpeg';
      out = await canvas.encode(type, quality);
      if (out.type !== type) throw new Error(`This browser cannot write ${type}`);
    }
    if (out.size === 0) throw new Error('Encoding produced an empty file');

    return { blob: out, type, width, height, resized: size.scale !== 1 };
  } finally {
    // An `ImageBitmap` holds the decoded pixels until it's closed
    image.close?.();
  }
}
