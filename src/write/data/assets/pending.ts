/**
 * `blob:` URLs for images that have no address yet.
 *
 * A draft's `PendingImage`s are not in the repo, and an image this session has just committed is
 * not on raw.githubusercontent.com for up to five minutes (its CDN lags). Both are shown from the
 * bytes on this device: `ContentSource.resolveAssetUrl` asks this registry first.
 *
 * New code (no upstream).
 */
import type { PendingImage } from '../../contracts';
import { imagePath } from './names';

export interface PendingImages {
  /**
   * Tell the registry which images the open draft holds, and where its post lives now. Call it
   * when a draft is opened, when an image is added or removed, and when the post's path changes
   * (the slug of a new post). Replaces what was registered for `draftId`; URLs of images that are
   * gone are revoked. `undefined` or `[]` clears the draft's images.
   */
  sync(draftId: string, postPath: string, images: readonly PendingImage[] | undefined): void;
  /** An image committed in this session: keep showing it from memory at its repo path. */
  keep(repoPath: string, data: Blob): void;
  /** The `blob:` URL for a repo path, or null when the registry does not hold it. */
  url(repoPath: string): string | null;
  /** Names registered for a draft (to de-duplicate a new image's name against). */
  names(draftId: string): string[];
  /** Forget a draft's images (or everything), revoking the URLs. */
  clear(draftId?: string): void;
}

export interface PendingImagesOptions {
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
}

interface Entry {
  name: string;
  path: string;
  data: Blob;
  url: string;
}

export function createPendingImages(options: PendingImagesOptions = {}): PendingImages {
  const create = options.createObjectURL ?? ((blob: Blob) => (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : ''));
  const revoke = options.revokeObjectURL ?? ((url: string) => void (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function' && URL.revokeObjectURL(url)));
  const drafts = new Map<string, Entry[]>();
  const committed = new Map<string, string>();

  const drop = (entries: Entry[]) => entries.forEach((e) => e.url && revoke(e.url));

  return {
    sync(draftId, postPath, images) {
      const before = drafts.get(draftId) ?? [];
      const next: Entry[] = (images ?? []).map((image) => {
        // Same bytes as before (same object, or same content after a reload): keep its URL, so an <img> does not flicker.
        const same = before.find((e) => e.data === image.data || (e.name === image.name && e.data.size === image.data.size && e.data.type === image.data.type));
        return { name: image.name, path: imagePath(postPath, image.name), data: image.data, url: same ? same.url : create(image.data) };
      });
      const kept = new Set(next.map((e) => e.url));
      drop(before.filter((e) => !kept.has(e.url)));
      if (next.length > 0) drafts.set(draftId, next);
      else drafts.delete(draftId);
    },

    keep(repoPath, data) {
      const old = committed.get(repoPath);
      if (old) revoke(old);
      const url = create(data);
      if (url) committed.set(repoPath, url);
    },

    url(repoPath) {
      for (const entries of drafts.values()) {
        const hit = entries.find((e) => e.path === repoPath);
        if (hit?.url) return hit.url;
      }
      return committed.get(repoPath) ?? null;
    },

    names: (draftId) => (drafts.get(draftId) ?? []).map((e) => e.name),

    clear(draftId) {
      if (draftId !== undefined) {
        drop(drafts.get(draftId) ?? []);
        drafts.delete(draftId);
        return;
      }
      drafts.forEach(drop);
      drafts.clear();
      committed.forEach((url) => revoke(url));
      committed.clear();
    },
  };
}
