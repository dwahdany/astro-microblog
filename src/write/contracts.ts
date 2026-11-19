/**
 * /write — shared contracts.
 *
 * Every area (data, editor, preview, ui, theme) compiles against the shapes in
 * this file and talks to the others only through them. Change a shape here
 * first, then the areas — never the other way round.
 *
 * Core principle the whole app is built on:
 *
 *   THE MARKDOWN TEXT IS THE ONLY SOURCE OF TRUTH.
 *
 * Nothing in this app may normalise, reformat or re-serialise text the user did
 * not edit. Opening a post and changing nothing must yield a byte-identical
 * file. Every shape below is designed so that guarantee is cheap to keep:
 * a post is carried around as exact text slices (`PostParts`) whose
 * concatenation is the file, never as a parsed tree that gets printed back.
 *
 * This file is almost entirely types. The few runtime values (constants,
 * `assemblePost`, the error classes) are dependency-free and safe to import
 * from anywhere, including tests in a plain node environment.
 */

import type { Component } from 'svelte';

/* ========================================================================== *
 * 1. Content model
 * ========================================================================== */

/** Directory names under src/content/ — also the Astro collection names. */
export const COLLECTIONS = [
  'entries',
  'notes',
  'blogmarks',
  'quotations',
  'photos',
  'portfolio',
  'series',
] as const;
export type CollectionKind = (typeof COLLECTIONS)[number];

/** Collections the app can create new posts in (v0). The rest are list + edit only. */
export const CREATABLE_COLLECTIONS = ['entries', 'notes', 'blogmarks', 'quotations'] as const;
export type CreatableCollection = (typeof CREATABLE_COLLECTIONS)[number];

export interface CollectionInfo {
  kind: CollectionKind;
  /** Plural, sentence case: "Entries". */
  label: string;
  /** Singular, sentence case: "Entry". */
  singular: string;
  creatable: boolean;
}

export const COLLECTION_INFO: Readonly<Record<CollectionKind, CollectionInfo>> = {
  entries: { kind: 'entries', label: 'Entries', singular: 'Entry', creatable: true },
  notes: { kind: 'notes', label: 'Notes', singular: 'Note', creatable: true },
  blogmarks: { kind: 'blogmarks', label: 'Blogmarks', singular: 'Blogmark', creatable: true },
  quotations: { kind: 'quotations', label: 'Quotations', singular: 'Quotation', creatable: true },
  photos: { kind: 'photos', label: 'Photos', singular: 'Photo', creatable: false },
  portfolio: { kind: 'portfolio', label: 'Portfolio', singular: 'Decision', creatable: false },
  series: { kind: 'series', label: 'Series', singular: 'Series', creatable: false },
};

/** Where content lives in the repo. Paths in this app are repo-relative, POSIX, no leading slash. */
export const CONTENT_ROOT = 'src/content';

/** The public GitHub repo the production source reads and, once signed in, commits to. */
export const REPO = { owner: 'dwahdany', name: 'astro-microblog', branch: 'main' } as const;

/**
 * The sign-in worker (the owner's fork of sveltia-cms-auth). It runs the GitHub
 * App's web flow in a popup (`/auth`) and exchanges refresh tokens (`/refresh`).
 * Messages from the popup are accepted from this origin only.
 */
export const AUTH_WORKER_ORIGIN = 'https://write-auth.dariush-5fc.workers.dev';

/** localStorage key holding the signed-in session (/write's own; `/admin` keeps `sveltia-cms.user`). */
export const AUTH_STORAGE_KEY = 'write:auth';

/** Public site origin, for links like "open published post". */
export const SITE_ORIGIN = 'https://blog.wahdany.eu';

/**
 * A post as it appears in the list. Everything here is derived from the file's
 * path and frontmatter by the data layer; the UI never parses YAML itself.
 */
export interface PostRef {
  /**
   * Stable key for routing, drafts and Svelte `{#each}` keys.
   * Existing post: its repo path. Unsaved new post: `new:<collection>:<uuid>`.
   */
  id: string;
  /** Repo-relative path, e.g. `src/content/entries/2026/curation-leaks.md`. */
  path: string;
  collection: CollectionKind;
  /** Frontmatter `slug`, or the filename stem when the key is missing. */
  slug: string;
  /**
   * Display title. Derivation (first non-empty wins):
   *   entries/portfolio/series: title
   *   notes: title → excerpt
   *   blogmarks: title → link_title
   *   quotations: source
   *   photos: title → alt
   * and finally the slug.
   */
  title: string;
  /** The `created` scalar exactly as written in the file (may be date-only), or null. */
  created: string | null;
  /** `created` as epoch ms for sorting; null when missing or unparseable. */
  createdMs: number | null;
  tags: string[];
  /** Frontmatter `is_draft === true`. */
  draft: boolean;
  /** Plain-text start of the body (≈160 chars, markdown syntax stripped) for list rows and search. */
  excerpt: string;
  /** True for a post that exists only as a local draft (not in the repo yet). */
  isNew: boolean;
  /** Git blob sha when the source knows it (GitHub source). Needed by save() later. */
  sha?: string;
}

/**
 * A post file cut into exact, contiguous text slices.
 *
 * INVARIANT: `bom + open + frontmatter + close + gap + body === raw`, byte for
 * byte (see `assemblePost`). Slices may be empty strings; none is ever trimmed
 * or re-encoded.
 *
 * Example for "---\nslug: a\n---\n\nHello\n":
 *   bom ''  open '---\n'  frontmatter 'slug: a\n'  close '---\n'  gap '\n'  body 'Hello\n'
 *
 * A file without frontmatter has open, frontmatter, close and gap all '' and
 * the whole text in `body`.
 */
export interface PostParts {
  /** '' or '﻿'. */
  bom: string;
  /** Opening fence line including its line break: '---\n' or '---\r\n'. */
  open: string;
  /** The YAML between the fences, including the line break before the closing fence. */
  frontmatter: string;
  /** Closing fence line including its line break (or no break at end of file). */
  close: string;
  /**
   * Blank line(s) between the closing fence and the first body character.
   * Kept out of `body` so the writing surface does not open on an empty line,
   * and so those bytes survive body edits untouched.
   */
  gap: string;
  /** The markdown the editor shows — everything after `gap`, including any trailing newline. */
  body: string;
}

/** Reassemble a file from its slices. The inverse of `FrontmatterApi.split`. */
export function assemblePost(parts: PostParts): string {
  return parts.bom + parts.open + parts.frontmatter + parts.close + parts.gap + parts.body;
}

/**
 * Line endings found in the file: all `\n`, all `\r\n`, all bare `\r` (old
 * Mac), or a mix. Whatever the answer, the editor keeps every existing line
 * break exactly as it is and only chooses one for lines that are ADDED (see
 * `EditorProps.lineSeparator`); nothing in the app converts line endings.
 */
export type Eol = 'lf' | 'crlf' | 'cr' | 'mixed';

/** A post opened for editing. */
export interface LoadedPost {
  ref: PostRef;
  /** The file exactly as the source returned it. Never mutated; diffs are made against this. */
  raw: string;
  /** `raw` cut into slices. `assemblePost(parts) === raw`. */
  parts: PostParts;
  eol: Eol;
}

/* ========================================================================== *
 * 2. Content source (implemented in data/; consumed by ui, editor and preview)
 * ========================================================================== */

/**
 * Resolves an image/link target as written in the markdown to a URL the
 * browser can load, or null when it cannot be resolved (render a placeholder).
 * Must be synchronous and cheap: the editor calls it while building decorations.
 */
export type AssetResolver = (src: string) => string | null;

export interface ListOptions {
  /** Bypass caches and re-read the source. */
  refresh?: boolean;
  signal?: AbortSignal;
}

/** Thrown by `save` while the source cannot write: nobody is signed in, or it is the working-tree source. */
export class ReadOnlyError extends Error {
  readonly code = 'READ_ONLY';
  constructor(message = 'Saving is not available yet. Copy or download the markdown instead.') {
    super(message);
    this.name = 'ReadOnlyError';
  }
}

/**
 * Thrown by `FrontmatterApi.patch` when a change cannot be applied without
 * risking the rest of the YAML. The original text is left untouched.
 */
export class FrontmatterPatchError extends Error {
  readonly code = 'FRONTMATTER_PATCH';
  constructor(
    message: string,
    /** 'syntax' the block does not parse · 'shape' not a plain `key: value` mapping · 'verify' the result failed its re-parse check */
    readonly reason: 'syntax' | 'shape' | 'verify',
    readonly key?: string,
  ) {
    super(message);
    this.name = 'FrontmatterPatchError';
  }
}

/** Thrown by `DraftStore` when a draft could not be written to (or read from) browser storage. */
export class DraftStoreError extends Error {
  readonly code = 'DRAFT_STORE';
  constructor(
    message: string,
    /** 'unavailable' no IndexedDB (private mode) · 'quota' storage is full · 'failed' anything else */
    readonly reason: 'unavailable' | 'quota' | 'failed',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DraftStoreError';
  }
}

/** Thrown by `load` when the path does not exist in the source. */
export class PostNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(readonly path: string) {
    super(`No post at ${path}`);
    this.name = 'PostNotFoundError';
  }
}

/** Why a content source could not answer from the network. */
export type UnavailableReason = 'offline' | 'rate-limited' | 'http';

/**
 * Thrown by `list`/`load` when the source could not be reached AND nothing is
 * cached to fall back on. (With a cached copy the source answers from it and
 * reports the situation through `ContentSource.status()` instead.) The
 * message is written to be shown to the owner as-is.
 */
export class SourceUnavailableError extends Error {
  readonly code = 'UNAVAILABLE';
  constructor(
    message: string,
    readonly reason: UnavailableReason,
    /** Epoch ms after which retrying makes sense (rate limit reset), when known. */
    readonly retryAt?: number,
    /** HTTP status, when there was a response. */
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SourceUnavailableError';
  }
}

/** How fresh a content source's answers are. */
export interface SourceStatus {
  /**
   * 'idle'  nothing has been listed yet
   * 'fresh' the list reflects the source as of `fetchedAt`
   * 'stale' the source could not be reached; answers come from the copy kept on this device
   */
  state: 'idle' | 'fresh' | 'stale';
  /** Why the kept copy is being used. Only with 'stale'. */
  reason?: UnavailableReason;
  /** Sentence for the UI. Only with 'stale'. */
  message?: string;
  /** Epoch ms the listing in use was fetched from the source. */
  fetchedAt?: number;
  /** Epoch ms after which a retry can succeed (rate limit reset). */
  retryAt?: number;
  /** GitHub API quota as of the last response (anonymous: 60 requests per hour per IP). */
  rateLimit?: { limit: number; remaining: number; resetAt: number };
}

/**
 * Thrown by `save` when the file in the repo is no longer the one the edit was
 * based on (`SaveRequest.baseSha` does not match), or when a NEW post's path is
 * already taken. Nothing was written. The UI keeps the draft, reloads the post
 * (which runs the usual "source changed" handling) and lets the owner decide.
 */
export class SaveConflictError extends Error {
  readonly code = 'SAVE_CONFLICT';
  constructor(
    readonly path: string,
    /**
     * 'changed' the file moved on upstream · 'exists' a new post's path (or a new image's) is taken ·
     * 'missing' the file to update or delete is gone · 'branch-moved' the file itself is fine, but the
     * branch kept moving while the commit was being made and the app gave up (it never forces): try again.
     */
    readonly reason: 'changed' | 'exists' | 'missing' | 'branch-moved',
    /** Blob sha the repo has now, when known. */
    readonly currentSha?: string,
    message = reason === 'exists'
      ? `There is already a file at ${path}. Change the slug and publish again.`
      : reason === 'missing'
        ? `${path} is no longer in the repository.`
        : reason === 'branch-moved'
          ? 'The repository kept changing while this was being published. Nothing was published — try again.'
          : `${path} changed in the repository after you started editing. Nothing was published.`,
  ) {
    super(message);
    this.name = 'SaveConflictError';
  }
}

/** Why a save that was not a conflict failed. */
export type SaveFailure =
  /** the token may not write (repo not in the App's installation, PAT without contents:write, branch protection) */
  | 'forbidden'
  /** the session ended (token revoked or expired beyond refresh); the owner has to sign in again */
  | 'signed-out'
  | 'offline'
  | 'rate-limited'
  /** a file is too large for GitHub to take */
  | 'too-large'
  /** the request is wrong before anything is sent (a path outside src/content, an empty file name …) */
  | 'invalid'
  | 'failed';

/**
 * Thrown by `save` when the commit could not be made for a reason other than a
 * conflict. The message can be shown as-is. `partial` is true when the save was
 * split into several commits and some image commits landed before the failure:
 * the post itself was NOT published; publishing again re-uses those images.
 */
export class SaveError extends Error {
  readonly code = 'SAVE_FAILED';
  constructor(
    message: string,
    readonly reason: SaveFailure,
    readonly details: { status?: number; partial?: boolean; retryAt?: number; cause?: unknown } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'SaveError';
  }
  get partial(): boolean {
    return this.details.partial === true;
  }
}

/** A binary file to commit alongside a post (pasted/uploaded image). Build with `pendingAssetsFor`. */
export interface PendingAsset {
  /** Repo-relative destination path, e.g. `src/content/notes/2026/my-slug/pic.png`. */
  path: string;
  data: Blob;
}

/**
 * An image taken in from a paste, a drop or the file picker that is not in the
 * repo yet. It lives with the draft (`DraftRecord.assets`) until the post is
 * published; the commit carries it along.
 *
 * Where it goes: `<directory of the post>/<file stem of the post>/<name>`, i.e.
 * `src/content/<collection>/<year>/<stem>/<name>`, written in the markdown as
 * `<stem>/<name>` (no `./`, no leading slash). The stem is the post's file name
 * without `.md`; for every post this app creates it equals the slug. The image
 * stores only its `name`, so it follows the post when the slug of a new post
 * changes.
 */
export interface PendingImage {
  /** File name inside the post's image folder. Always `[a-z0-9.-]`, unique in the folder (case-insensitive). */
  name: string;
  /** The bytes that will be committed. */
  data: Blob;
  /** MIME type of `data`, from its content (not from the name it arrived with). */
  type: string;
  /** Byte size of `data`. */
  size: number;
  /** Byte size of the file as it arrived, before any downscale or re-encode (for the UI: "3.4 MB → 410 kB"). */
  originalSize?: number;
  /** Git blob id of `data`: identifies the bytes in storage and tells a commit the file is already there. */
  sha?: string;
  /** Pixel size of `data`, when it could be decoded. */
  width?: number;
  height?: number;
  /** The name the file arrived with (for the UI; not used in paths). */
  originalName?: string;
  /** Alt text found with the image (the `alt` of a copied `<img>`), to prefill `![alt](…)`. */
  alt?: string;
  /**
   * True when the image was decoded and re-encoded, which drops EXIF, GPS and every other embedded
   * metadata. False when the original bytes are kept (the original-quality switch, or an animation):
   * the UI should then say that location data may be published with the file.
   */
  stripped: boolean;
  /** Epoch ms it was taken in. */
  addedAt: number;
}

/**
 * The save interface.
 *
 * One save is ONE commit holding the post and its new images (GraphQL
 * `createCommitOnBranch`, guarded by `expectedHeadOid`; when GitHub refuses
 * that mutation for the token, the Git Data API: blobs → tree → commit → ref
 * update without force). Only a save whose images exceed what one request can
 * carry is split: images first, the post last, so a post is never live without
 * its images. The branch is never forced.
 *
 * Kinds of save, all through `ContentSource.save`:
 *   create   `baseSha` undefined, `path` new                → conflict 'exists' when the path is taken
 *   update   `baseSha` = the blob the edit was made on       → conflict 'changed' / 'missing'
 *   rename   as update, plus `previousPath` (old address)    → the post moves, and the image folder
 *            `<old dir>/<old stem>/` moves to `<dir>/<stem>/` in the same commit. The caller has
 *            already rewritten the image references in `raw` (`rewriteImageRefs`).
 *   delete   `delete: true`, `baseSha` = the blob that is deleted; `raw` is ignored. The post's
 *            image folder goes with it unless `keepImages`.
 *
 * The working-tree source reports `canSave = false` and rejects with
 * `ReadOnlyError`; so does the GitHub source while nobody is signed in.
 *
 * What the UI already does around it (ui/Workspace.svelte, ui/Review.svelte,
 * the decisions in ui/lib/publish.ts):
 *  - Publish shows when `canSave` is true and re-evaluates on `onAuthChange`;
 *  - it is blocked while the frontmatter has problems (`FrontmatterApi.validate`,
 *    YAML that does not parse), while a NEW post's path collides with a listed
 *    post, and while a draft is in conflict with the source (`DraftRecord.conflict`);
 *  - on success the draft is deleted, the saved text and `SaveResult.sha` become
 *    the new base, a new post's route moves to its real path and the list is refreshed;
 *  - on `SaveConflictError` nothing is lost: the post is re-read from the source
 *    and the usual "changed since you started" handling takes over.
 */
export interface SaveRequest {
  /** Repo-relative path to write. */
  path: string;
  /** Full file text to write, exactly as it should land in the repo. */
  raw: string;
  /** Blob sha the edit was based on; undefined when creating a new file. Used for conflict detection. */
  baseSha?: string;
  /** When set and different from `path`, the save is a rename/move. */
  previousPath?: string;
  /**
   * Commit message; the source supplies Sveltia's wording when omitted:
   * `Create|Update|Delete <Singular> “<year>/<slug>”`, plus ` +N` for N further files.
   */
  message?: string;
  /** New images to commit with the post (`pendingAssetsFor(path, draft.assets)`). */
  assets?: PendingAsset[];
  /** Remove the post at `path` instead of writing it. `raw` is ignored (pass ''). */
  delete?: boolean;
  /** With `delete`: leave the post's image folder in the repo. */
  keepImages?: boolean;
  signal?: AbortSignal;
}

export interface SaveResult {
  path: string;
  /** New blob sha of the saved file ('' for a delete). */
  sha: string;
  /** The (last) commit made. */
  commitSha?: string;
  commitUrl?: string;
  /** True for a delete. */
  deleted?: boolean;
  /** How many commits the save took (1 unless large images forced a split). */
  commits?: number;
  /** Every file the save wrote besides the post, with its new blob sha. */
  assets?: { path: string; sha?: string }[];
  /** Every path the save removed (the old address of a rename, a deleted post, moved or deleted images). */
  removed?: string[];
  /** Which API made the commit: 'graphql' (createCommitOnBranch) or 'rest' (Git Data fallback). */
  via?: 'graphql' | 'rest';
}

export interface ContentSource {
  /** 'local' = working tree via Vite in dev; 'github' = public repo over HTTPS. */
  readonly kind: 'local' | 'github';
  /** Human label for the UI, e.g. "Working tree" or "dwahdany/astro-microblog@main". */
  readonly label: string;
  /**
   * True when `save` can commit: the GitHub source with someone signed in who may push. The UI
   * shows Publish only when true; otherwise Review / Copy / Download.
   * May change during a session (sign-in, sign-out): read it again after `onAuthChange` fires.
   */
  readonly canSave: boolean;

  /**
   * Every post across all collections, newest first (createdMs desc, nulls
   * last). Excludes files the site's loaders ignore (portfolio `_*.md`).
   * Implementations cache; pass `refresh` to re-read. Rejects with
   * `SourceUnavailableError` only when the source is unreachable and nothing
   * is cached; otherwise it answers from the cache and `status()` turns 'stale'.
   */
  list(opts?: ListOptions): Promise<PostRef[]>;

  /** Load one post by repo path. Rejects with `PostNotFoundError` if absent. */
  load(path: string, opts?: { signal?: AbortSignal }): Promise<LoadedPost>;

  /**
   * Resolve an asset reference written in a post to a loadable URL.
   *   - absolute URLs (`https:`, `data:`, `blob:`, protocol-relative) → returned unchanged
   *   - `/x.png` (site-absolute, i.e. public/) → dev: unchanged; github: SITE_ORIGIN + src
   *   - `my-slug/pic.png` or `./my-slug/pic.png` → relative to the DIRECTORY of `postPath`
   * An image that is not in the repo yet (a draft's `PendingImage`, registered with
   * `pendingImages.sync`) or that this session has just committed resolves to a `blob:` URL.
   * Returns null for anything that cannot be resolved (e.g. escaping the repo).
   */
  resolveAssetUrl(postPath: string, src: string): string | null;

  /**
   * Commit a create / update / rename / delete (see `SaveRequest`). Rejects with
   *   `ReadOnlyError`      when `canSave` is false;
   *   `SaveConflictError`  when the file moved on, a new path is taken, or the branch kept moving
   *                        (nothing was written; the branch is never forced);
   *   `SaveError`          for everything else (no permission, offline, rate limit …).
   * After it resolves, the next `list()` / `load()` reflect the save WITHOUT a refetch: the
   * committed text is in the source's cache under its new blob sha.
   */
  save(req: SaveRequest): Promise<SaveResult>;

  /**
   * Called whenever `canSave` (or who is signed in) changes. Returns unsubscribe.
   * The working-tree source never calls the listener.
   */
  onAuthChange(listener: () => void): () => void;

  /** Whether answers are live or a kept copy (the working-tree source is always 'fresh' once listed). */
  status(): SourceStatus;
  /** Called whenever `status()` changes. Returns unsubscribe. */
  onStatus(listener: (status: SourceStatus) => void): () => void;
}

/* ========================================================================== *
 * 2b. Sign-in (implemented in data/github; consumed by ui through `auth`)
 * ========================================================================== */

/**
 * 'app'   the GitHub App's web flow in a popup, through the auth worker. The token lasts 8 hours and
 *         comes with a refresh token; the data layer refreshes it by itself.
 * 'token' a personal access token pasted by the owner (fine-grained, Contents read/write on the
 *         repo). The only way to sign in on localhost, where the worker refuses the popup.
 */
export type AuthMethod = 'app' | 'token';

export interface AuthUser {
  login: string;
  name?: string;
  avatarUrl?: string;
  id?: number;
}

export interface AuthState {
  /**
   * 'signed-out'  no session
   * 'signing-in'  a popup is open, or a pasted token is being checked
   * 'signed-in'   a session is stored. It was valid when it was last checked; `verified` says
   *               whether that check has happened in THIS page load yet.
   */
  status: 'signed-out' | 'signing-in' | 'signed-in';
  user?: AuthUser;
  method?: AuthMethod;
  /** The session was confirmed with GitHub (`GET /user`) since the page loaded. */
  verified?: boolean;
  /** Epoch ms the access token expires ('app' sessions; refreshed before then). */
  expiresAt?: number;
  /** Why the last session ended, when it was not the owner signing out: shown once, next to "Sign in". */
  ended?: { reason: 'expired' | 'revoked'; message: string };
}

/** Why sign-in did not happen. */
export type AuthFailure =
  /** the owner cancelled, or the popup was closed without an answer (it may have shown a refusal) */
  | 'cancelled'
  /** the browser did not open the popup (blocked, or an installed web app without window.open) */
  | 'popup-blocked'
  /**
   * The worker POSTED that it refuses this site. The owner's forked worker never does: it shows
   * that refusal only inside its own window, and the app sees a closed window ('cancelled', with a
   * hint to use a token). Kept for a worker that posts `UNSUPPORTED_DOMAIN`.
   */
  | 'unsupported-domain'
  /** the worker or GitHub reported an error during the flow */
  | 'rejected'
  /** GitHub does not accept the token (401) */
  | 'invalid-token'
  /** the token is valid but may not push to the repo */
  | 'no-push'
  /** the repo is not visible to the token (not selected for a fine-grained token, or the App is not installed on it) */
  | 'no-access'
  | 'offline'
  | 'rate-limited'
  | 'failed';

/** Thrown by `AuthApi.signInWithGithub` / `signInWithToken`. The message can be shown as-is. */
export class AuthError extends Error {
  readonly code = 'AUTH';
  constructor(
    message: string,
    readonly reason: AuthFailure,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AuthError';
  }
}

export interface AuthApi {
  /** The current state. Cheap and synchronous; the stored session is read when the module loads. */
  state(): AuthState;
  /** Called on every change of `state()`, including changes made in another tab. Returns unsubscribe. */
  onChange(listener: (state: AuthState) => void): () => void;
  /**
   * False where the popup is known not to work: on localhost (the worker's allow-list is https
   * sites) and without a window. Offer only the token field there. True does NOT promise the
   * worker allows this host — that is only known in the popup, see `AuthFailure` 'cancelled'.
   */
  readonly popupSupported: boolean;
  /**
   * Sign in with the GitHub App. MUST be called directly from a tap/click handler: the popup is
   * opened synchronously, before anything is awaited, or the browser blocks it. Resolves with the
   * signed-in state; rejects with `AuthError`.
   */
  signInWithGithub(): Promise<AuthState>;
  /** Close the popup and give up a `signInWithGithub` that is waiting (it rejects with reason 'cancelled'). */
  cancelSignIn(): void;
  /**
   * Sign in with a pasted personal access token. Checks it with GitHub (who it belongs to, and that
   * it may push to the repo) before anything is stored. Rejects with `AuthError`.
   */
  signInWithToken(token: string): Promise<AuthState>;
  /**
   * Forget the session on this device (all tabs). The token itself is not revoked at GitHub: an App
   * token simply expires within 8 hours; a pasted token stays valid until the owner deletes it.
   */
  signOut(): void;
  /** Re-check the stored session with GitHub now (also done once, lazily, after page load). */
  verify(): Promise<AuthState>;
  /** Where the owner creates a fine-grained token for this repo (prefilled where GitHub allows). */
  readonly tokenHelpUrl: string;
}

/* ========================================================================== *
 * 3. Frontmatter (implemented in data/; consumed by ui)
 * ========================================================================== */

/** Values the properties sheet can read and write. */
export type FrontmatterValue =
  | string
  | number
  | boolean
  | null
  | FrontmatterValue[]
  | { [key: string]: FrontmatterValue };

export interface FrontmatterIssue {
  message: string;
  /** 1-based line within the frontmatter slice, when known. */
  line?: number;
  /** Top-level key the issue belongs to, when known. */
  key?: string;
}

export interface ParsedFrontmatter {
  /**
   * Plain JS view of the YAML (YAML 1.2 core schema). Timestamps are NOT
   * converted: `created: 2026-04-22T12:00:00+00:00` is the string as written.
   * Empty object when there is no frontmatter or it does not parse.
   */
  data: Record<string, unknown>;
  /** Top-level keys in document order. */
  keys: string[];
  /** YAML syntax errors. When non-empty the sheet should show the raw YAML instead of fields. */
  issues: FrontmatterIssue[];
}

/**
 * `undefined` removes the key; any other value sets it. A change whose value
 * deep-equals the current parsed value is ignored.
 */
export type FrontmatterPatch = Record<string, FrontmatterValue | undefined>;

export type FieldKind =
  | 'string' // single line
  | 'text' // multi-line
  | 'slug' // single line, validated against SLUG_PATTERN
  | 'url'
  | 'datetime' // ISO timestamp, written as YYYY-MM-DDTHH:mm:ss+00:00
  | 'date' // YYYY-MM-DD
  | 'boolean'
  | 'tags' // string[]
  | 'number'
  | 'select' // one of `options`
  | 'image' // path relative to the post's directory
  | 'yaml'; // structured value (gallery, exif, legs): shown read-only / as raw YAML in v0

export interface FieldSpec {
  /** Top-level frontmatter key. */
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  /**
   * 'core' = title, slug, created, tags, is_draft (in that order);
   * 'collection' = the collection's own fields;
   * 'advanced' = rarely touched (card_image, excerpt, exif …), collapsed by default.
   * The sheet leads with the core fields, except for blogmarks and quotations,
   * which start from their link / source and therefore lead with their own fields.
   */
  group: 'core' | 'collection' | 'advanced';
  /**
   * What an empty field looks like in a file Sveltia wrote (`''`, `[]`, `false`):
   * the value a scaffold writes and the one to patch when the field is cleared.
   * Absent for keys Sveltia does not write.
   */
  default?: FrontmatterValue;
  hint?: string;
  placeholder?: string;
  options?: readonly string[];
}

/** Sveltia's slug rule from public/admin/config.yml. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The five core keys, in display order (`title` is absent for quotations). */
export const CORE_FIELD_KEYS = ['title', 'slug', 'created', 'tags', 'is_draft'] as const;

export interface ScaffoldInit {
  /** Defaults to the current time. */
  now?: Date;
  /** Initial field values (e.g. a title typed in the "new post" sheet, or a blogmark URL). */
  values?: FrontmatterPatch;
  /** Initial body text. Defaults to ''. */
  body?: string;
}

export interface FrontmatterApi {
  /**
   * Cut a file into slices. Total: never throws, accepts any string, and
   * `assemblePost(split(raw)) === raw` for every input.
   */
  split(raw: string): PostParts;

  /** Detect the file's line endings. */
  eol(raw: string): Eol;

  /** Parse the `frontmatter` slice. Never throws; syntax errors come back in `issues`. */
  parse(frontmatter: string): ParsedFrontmatter;

  /**
   * Apply key changes and return new slices.
   *
   * GUARANTEES
   *  - No effective change → returns the SAME `parts` object (`===`).
   *  - Lines belonging to untouched keys stay byte-identical: order, quoting
   *    style, comments, blank lines, flow-vs-block lists, indentation.
   *  - Only `frontmatter` changes, except when the file had no frontmatter and
   *    a key is added: then `open`/`close` (and `gap`, if a body exists) are
   *    created using the file's line ending.
   *  - A changed scalar keeps its existing quoting style when the new value
   *    allows it; a changed list keeps its existing flow/block style.
   *  - New keys are inserted where Sveltia would write them — the field order
   *    of public/admin/config.yml for the collection (after the nearest
   *    preceding known key) — otherwise appended.
   *
   * THROWS `FrontmatterPatchError` rather than emit anything it cannot prove
   * safe: when the YAML does not parse, when it is not a plain block mapping
   * (flow mapping, explicit keys, a referenced anchor on the edited value), or
   * when the spliced result fails its own re-parse check. There is no reprint
   * fallback; `parts` is untouched. Callers show the message and leave the
   * text alone (the properties sheet shows raw YAML when `parse().issues` is
   * non-empty and never calls `patch` then).
   */
  patch(parts: PostParts, changes: FrontmatterPatch, collection?: CollectionKind): PostParts;

  /** Field definitions for the properties sheet, in display order (core first). */
  fields(collection: CollectionKind): readonly FieldSpec[];

  /** Problems that should block "ready to publish" (missing required key, bad slug, bad URL …). */
  validate(collection: CollectionKind, data: Record<string, unknown>): FrontmatterIssue[];

  /**
   * A new post with the frontmatter Sveltia would write for this collection
   * (same keys, order, quoting and empty-value conventions — see
   * public/admin/config.yml and recent files under src/content/).
   * The returned post is `isNew`, `is_draft: true` (Sveltia's own default is
   * false; deliberate, because this tool is meant to commit to `main`), with
   * id `new:<collection>:<uuid>` and `created` = now in UTC, seconds zeroed.
   */
  scaffold(collection: CreatableCollection, init?: ScaffoldInit): LoadedPost;

  /**
   * Repo path for a NEW post: `src/content/<collection>/<year>/<slug>.md`
   * (Sveltia's `{{year}}/{{slug}}`), year taken from `created` in UTC.
   * (Sveltia itself uses the UTC year of the first save. For a post written here
   * `created` IS that moment, so the two agree; they differ only when the owner
   * back-dates `created` before first publishing, and then the folder follows
   * the date the post shows — deliberate, and it only ever applies to new posts.)
   * Series live flat: `src/content/series/<slug>.md`.
   * Never use it to recompute the path of an existing post: a post stays in
   * the folder it was created in even when `created` says another year
   * (one real post does), so existing posts keep `PostRef.path`.
   */
  pathFor(collection: CollectionKind, slug: string, created: string | Date): string;

  /** ASCII, lowercase, hyphenated — matches SLUG_PATTERN. '' when nothing usable remains. */
  slugify(text: string): string;

  /** Build the list entry for a post from its path and text (used by sources and for live drafts). */
  describe(path: string, raw: string, extra?: { id?: string; isNew?: boolean; sha?: string }): PostRef;
}

/* ========================================================================== *
 * 4. Draft store (implemented in data/; consumed by ui)
 * ========================================================================== */

/**
 * One locally autosaved post. Stores the full text, not slices: the text is
 * the truth and slices are re-derived with `FrontmatterApi.split`.
 */
export interface DraftRecord {
  /** `PostRef.id`. */
  id: string;
  /** Current target path (for a new post this follows the slug). */
  path: string;
  collection: CollectionKind;
  isNew: boolean;
  /** Current full file text. */
  raw: string;
  /** The source text the edit started from; null for a new post. Diff base and conflict check. */
  baseRaw: string | null;
  baseSha?: string;
  /** Epoch ms of the last local change. */
  updatedAt: number;
  /** Caret/selection as editor positions in the body, to restore after reload. */
  selection?: { anchor: number; head: number };
  /** Scroll position of the writing surface, restored with the caret. */
  scrollTop?: number;
  /**
   * Set while the draft is IN CONFLICT with the source: the file changed upstream
   * in the same lines after the draft was started, so the edits could not be
   * carried over. `baseRaw`/`baseSha` then still name the OLD original (the one
   * the edits were really made on); this names the upstream version that was
   * found. It stays — through edits and reloads — until the owner resolves the
   * conflict (keeps their text against the new original, or discards). While
   * it is set the UI warns and Publish is blocked, because a save "based on" the
   * new sha would silently revert the upstream change.
   */
  conflict?: { sha?: string };
  /**
   * Images taken in for this post that are not in the repo yet. They are kept
   * with the draft in IndexedDB (the bytes in a store of their own, written
   * once, not with every keystroke) and committed with the post. Absent or
   * empty when there are none. A draft with images is kept even when
   * `raw === baseRaw`.
   */
  assets?: PendingImage[];
  /**
   * Write counter, managed by the store: 1 on first `put`, +1 on every later one.
   * Pass back the `rev` you last read or wrote; the store refuses the write when
   * the stored record has moved on (another tab wrote it).
   */
  rev?: number;
}

/** What the list needs to badge a row without loading every draft's text. */
export type DraftSummary = Pick<DraftRecord, 'id' | 'path' | 'collection' | 'isNew' | 'updatedAt'> & {
  /** `raw !== baseRaw`, or images are waiting to be committed (always true for new posts). */
  dirty: boolean;
  /** How many images wait with the draft (absent when none). */
  images?: number;
};

/** `origin` tells a listener whether this tab made the change or another one did. */
export type DraftEvent = { type: 'put' | 'delete'; id: string; origin: 'local' | 'remote' };

/**
 * Thrown by `DraftStore.put` / `.delete` when the stored draft is not the one
 * the caller last saw (`expectedRev`): another tab wrote it in between. Nothing
 * was written. `current` is what is stored now (undefined when it was deleted).
 */
export class DraftConflictError extends Error {
  readonly code = 'DRAFT_CONFLICT';
  constructor(
    readonly id: string,
    readonly current: DraftRecord | undefined,
  ) {
    super('This post was changed in another tab.');
    this.name = 'DraftConflictError';
  }
}

export interface DraftWriteOptions {
  /**
   * The `rev` of the record this write is based on: what `get` returned or the
   * last `put` resolved with; `0` when the caller believes nothing is stored.
   * When given and the stored record's `rev` differs, the write is refused with
   * `DraftConflictError`. Omit to write unconditionally.
   */
  expectedRev?: number;
}

export interface DraftStore {
  get(id: string): Promise<DraftRecord | undefined>;
  /**
   * Upsert; resolves with the stored record's new `rev`. Rejects with
   * `DraftStoreError` on quota / private-mode failures so the UI can warn (never
   * fails silently), and with `DraftConflictError` when `expectedRev` is stale.
   * The write starts synchronously when storage is already open, so it can be
   * issued from `pagehide`.
   */
  put(record: DraftRecord, options?: DraftWriteOptions): Promise<number>;
  /** Rejects with `DraftConflictError` when `expectedRev` is stale. */
  delete(id: string, options?: DraftWriteOptions): Promise<void>;
  /** All drafts, most recently changed first. */
  list(): Promise<DraftSummary[]>;
  /** Changes made in this tab and (where the browser allows) other tabs. Returns unsubscribe. */
  subscribe(listener: (event: DraftEvent) => void): () => void;
}

/* ========================================================================== *
 * 5. Editor (implemented in editor/; consumed by ui)
 * ========================================================================== */

/** Toolbar commands. Each toggles when the caret/selection is already inside that construct. */
export interface EditorCommandArgs {
  bold: void;
  italic: void;
  strike: void;
  code: void;
  /**
   * No args: wrap the selection as `[text](|)` and put the caret in the URL;
   * pressed again while a link is being written it steps on (text → address →
   * out), and on a finished link it unlinks. `{ url, text }` inserts directly.
   */
  link: { url?: string; text?: string } | void;
  /** No level: cycle paragraph → h2 → h3 → paragraph. Level 0 clears the heading. */
  heading: { level?: 0 | 1 | 2 | 3 | 4 | 5 | 6 } | void;
  bulletList: void;
  orderedList: void;
  taskList: void;
  quote: void;
  codeBlock: { lang?: string } | void;
  /**
   * Insert `[^n]` at the caret, where n is the next unused number, append
   * `[^n]: ` as a definition at the end of the document (after a blank line,
   * or directly under the definitions already there), and open that note for
   * editing in place. Existing labels are never renumbered. Note that the
   * site numbers notes by order of first reference, not by label.
   *
   * With the caret inside a link, image, code span or inline math the
   * reference goes right after that construct. Inside a code block, display
   * math or raw HTML the command does not apply (returns false, with a notice).
   * When the document ends in a code or math block that was never closed, the
   * block is closed first — otherwise the new note would be part of it.
   */
  footnote: void;
  /**
   * No args: insert `![](|)`. `size` uses the site's `![alt|small](src)` convention. With `src` the
   * image panel (size, alt text, remove) opens for the new image; the text keeps the keyboard.
   */
  image: { src: string; alt?: string; size?: 'small' | 'medium' | 'full' } | void;
  /** Inline `$…$`. */
  math: void;
  /** Display `$$…$$` on its own lines. */
  mathBlock: void;
  rule: void;
  indent: void;
  outdent: void;
  undo: void;
  redo: void;
}
export type EditorCommandId = keyof EditorCommandArgs;

/** For toolbar pressed-states. Emitted on every selection or document change. */
export interface EditorSelectionState {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  code: boolean;
  link: boolean;
  /** 0 = not a heading. */
  heading: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  list: 'bullet' | 'ordered' | 'task' | null;
  quote: boolean;
  codeBlock: boolean;
  /**
   * The caret is in literal text (a code block, display math, raw HTML), where
   * markdown markup means nothing: Footnote and Divider do not apply there.
   */
  literal: boolean;
  /** Selection is collapsed (a caret). */
  empty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Offsets into the document, for draft restore. */
  anchor: number;
  head: number;
}

/** Commands that also work on the text of a footnote while it is being edited in the note panel. */
export const NOTE_COMMANDS = ['bold', 'italic', 'strike', 'code', 'math', 'link', 'undo', 'redo'] as const satisfies readonly EditorCommandId[];

/** The footnote open in the note panel, reported through `EditorProps.onNoteChange`. */
export interface EditorNoteState {
  label: string;
  /**
   * The note's text field has the keyboard: toolbar commands then act on the
   * note, and only `NOTE_COMMANDS` apply.
   */
  editing: boolean;
  /**
   * The panel covers the whole writing surface (a very short viewport: a phone
   * on its side with the keyboard up). The shell may fold its header away.
   */
  cover: boolean;
}

export interface EditorChangeInfo {
  /** True when the change came from the user (typing, command, paste) rather than `setDoc`. */
  userEvent: boolean;
}

/** Imperative handle the editor hands to its parent via `onReady`. */
export interface EditorHandle {
  /** Run a toolbar command. Returns false when it did not apply. Must not blur the editor. */
  exec<K extends EditorCommandId>(
    id: K,
    ...args: EditorCommandArgs[K] extends void ? [] : [args?: EditorCommandArgs[K]]
  ): boolean;
  focus(): void;
  /** The exact document text, every line break as it is in the file. */
  getDoc(): string;
  /** Replace the whole document (e.g. "Discard changes"). Emits onChange with `userEvent: false`. */
  setDoc(text: string, opts?: { keepHistory?: boolean }): void;
  /** Insert text at the selection, replacing it. */
  insertText(text: string): void;
  getSelection(): { anchor: number; head: number };
  setSelection(sel: { anchor: number; head?: number }, opts?: { scrollIntoView?: boolean }): void;
  getScrollTop(): number;
  setScrollTop(px: number): void;
  /**
   * How far the top of the visible text is through the document, 0–1 (by
   * document position, not pixels). Used to open the preview where the
   * writing was.
   */
  getScrollFraction(): number;
}

/**
 * Props of `src/write/editor/Editor.svelte` (default export, Svelte 5).
 *
 * The editor is UNCONTROLLED: `doc` is read when the component mounts and
 * again whenever `docKey` changes. Later changes to `doc` alone are ignored —
 * the parent must not echo `onChange` text back in to drive the editor.
 *
 * Layout: the component fills its parent's box (height: 100%) and owns its
 * scroller. It centres the text column at `--w-prose-measure` with
 * `--w-gutter` side padding and leaves generous space below the last line.
 *
 * Byte-identity rules the editor must keep:
 *  - `getDoc()` right after mount returns exactly `doc`.
 *  - `onChange` fires only for real document changes (never on mount, focus,
 *    selection or decoration updates).
 *  - Rendering is done with decorations/widgets only; the document text is
 *    never rewritten by the live preview.
 */
export interface EditorProps {
  doc: string;
  /** Identity of the document being edited (use `PostRef.id`). Changing it resets state and history. */
  docKey: string;
  onChange: (doc: string, info: EditorChangeInfo) => void;
  onReady?: (handle: EditorHandle) => void;
  onSelectionChange?: (state: EditorSelectionState) => void;
  /** Resolves image sources for inline image rendering. Already bound to the open post. */
  resolveAsset: AssetResolver;
  /**
   * Current theme id. Styling comes from the `--w-*` CSS variables, so this is
   * only a signal to re-measure after fonts/metrics change.
   */
  theme: ThemeId;
  /**
   * The line break for lines the user ADDS. Line breaks already in `doc` are
   * kept exactly as they are, whatever their kind — a file with mixed endings
   * round-trips, edited or not — and new lines use the kind `doc` uses most.
   * This prop only decides for a `doc` that has no line break of its own to go
   * by (pass the file's). Defaults to '\n'.
   */
  lineSeparator?: '\n' | '\r\n' | '\r';
  readOnly?: boolean;
  placeholder?: string;
  /** Restore caret after reload. Applied on mount / docKey change only. */
  initialSelection?: { anchor: number; head: number };
  /** Restore the scroll position after reload. Applied on mount / docKey change only. */
  initialScrollTop?: number;
  /** The note panel opened, closed, or its text field gained or lost the keyboard. */
  onNoteChange?: (note: EditorNoteState | null) => void;
  /** A command could not do what was asked; a sentence to show the writer (e.g. Footnote inside a code block). */
  onNotice?: (message: string) => void;
  /**
   * Pixels at the top/bottom of the editor's scroller covered by app chrome
   * (sticky header, formatting toolbar, on-screen keyboard). The editor keeps
   * the caret out of these bands when scrolling it into view.
   */
  insets?: { top?: number; bottom?: number };
  /** Called when the user activates a link (tap on rendered link / ⌘-click). Default: open in a new tab. */
  onOpenLink?: (url: string) => void;
}

export type EditorComponent = Component<EditorProps>;

/* ========================================================================== *
 * 6. Preview (implemented in preview/; consumed by ui)
 * ========================================================================== */

export interface PreviewContext {
  /** Repo path of the post (for resolving relative assets and for the frame title). */
  path: string;
  collection: CollectionKind;
  /** Parsed frontmatter (`ParsedFrontmatter.data`) — title, created, tags, link_url, source … */
  frontmatter: Record<string, unknown>;
  resolveAsset: AssetResolver;
  /**
   * The post list, so the browser port of rehype-internal-link-preview can
   * build "Previously" cards for links to blog.wahdany.eu/<y>/<Mon>/<d>/<slug>/.
   */
  posts?: readonly PostRef[];
}

export interface PreviewResult {
  /** Body HTML as the site would render it (inside its `.prose` container). */
  html: string;
  /** Non-fatal problems worth surfacing (unresolved image, invalid math …). */
  warnings: string[];
}

/**
 * `renderMarkdown` exported from `src/write/preview/index.ts`.
 * Mirrors astro.config.mjs as far as a browser can: GFM + smartypants (Astro
 * defaults), remark-math, rehype-image-size, internal-link previews,
 * rehype-katex, raw HTML passthrough, heading ids, Shiki highlighting.
 * Pure with respect to its inputs; safe to call repeatedly (debounced by the UI).
 */
export type RenderMarkdown = (markdown: string, ctx: PreviewContext) => Promise<PreviewResult>;

/**
 * Props of `src/write/preview/Preview.svelte` (default export, Svelte 5).
 * Shows the post like the published page — site CSS, post header for the
 * collection, then the rendered body. The site's stylesheet must not leak
 * into the app (hence the frame route src/pages/write/preview-frame.astro).
 */
export interface PreviewProps {
  /** The body markdown (`PostParts.body`). */
  markdown: string;
  ctx: PreviewContext;
  /**
   * Rendering finished (or failed); lets the UI show a busy state / warnings.
   * May be called more than once per render (again when a broken image is
   * detected). Without it the preview shows warnings in its own strip; a
   * parent that passes it takes over showing them.
   */
  onRendered?: (result: PreviewResult) => void;
  /**
   * Where to open on first paint: how far through the body's text, 0–1
   * (`EditorHandle.getScrollFraction()`), so the preview shows the part that
   * was being written. Read once per mount. Without it the preview reopens
   * where it was last read.
   */
  startAt?: number;
}

export type PreviewComponent = Component<PreviewProps>;

/* ========================================================================== *
 * 7. Theme (src/write/theme/**; everyone consumes the tokens)
 * ========================================================================== */

export const THEME_IDS = ['galley', 'console', 'riso'] as const;
export type ThemeId = (typeof THEME_IDS)[number];

/** `<html data-write-theme="galley">` selects a token set. */
export const THEME_ATTRIBUTE = 'data-write-theme';
/** localStorage key remembering the choice. */
export const THEME_STORAGE_KEY = 'write:theme';

/**
 * Galley and Riso each have a light and a dark set; Console is dark only.
 * `<html data-write-scheme="light|dark">` selects which, following the OS
 * unless the owner pins one. Any element carrying both attributes renders in
 * that look (the Look sheet's specimens rely on this).
 */
export type Scheme = 'light' | 'dark';
/** 'auto' follows the OS; the other two pin a scheme (where the theme has it). */
export type SchemePref = 'auto' | Scheme;
export const SCHEME_ATTRIBUTE = 'data-write-scheme';
/** localStorage key remembering the scheme preference. */
export const SCHEME_STORAGE_KEY = 'write:scheme';

export interface ThemeInfo {
  id: ThemeId;
  label: string;
  /** One line telling the owner what this direction is. */
  description: string;
  /** The theme's primary scheme (the one shown when the OS does not prefer dark, or the only one). */
  scheme: Scheme;
  /** Value for <meta name="theme-color"> in the primary scheme (the app canvas colour). */
  themeColor: string;
}

/**
 * Every custom property a theme must define. Components (editor included) use
 * ONLY these — no literal colours, font names, radii or durations — so that
 * switching the attribute restyles the whole app.
 *
 * Definitions and the three token sets live in src/write/theme/*.css; the
 * meaning of each token is documented at the top of tokens.css.
 *
 * The theme files also define `--wx-*` properties (page-on-a-desk, wordmark,
 * status line, letter case …). Those are private to the app shell in
 * src/write/ui: the editor and the preview must not use them.
 */
export const THEME_TOKENS = [
  // colour — surfaces
  '--w-bg',
  '--w-surface',
  '--w-surface-2',
  '--w-scrim',
  // colour — text
  '--w-ink',
  '--w-ink-2',
  '--w-ink-3',
  // colour — lines
  '--w-line',
  '--w-line-strong',
  // colour — accent
  '--w-accent',
  '--w-accent-ink',
  '--w-accent-soft',
  '--w-accent-text',
  // colour — states
  '--w-selection',
  '--w-mark',
  '--w-focus',
  '--w-ok',
  '--w-warn',
  '--w-danger',
  '--w-add-bg',
  '--w-add-ink',
  '--w-del-bg',
  '--w-del-ink',
  // colour — markdown in the editor
  '--w-syn-mark',
  '--w-syn-heading',
  '--w-syn-link',
  '--w-syn-code',
  '--w-syn-code-bg',
  '--w-syn-quote',
  '--w-syn-quote-bar',
  '--w-syn-footnote',
  '--w-syn-math',
  // colour — code tokens inside fenced blocks
  '--w-code-keyword',
  '--w-code-string',
  '--w-code-number',
  '--w-code-comment',
  '--w-code-fn',
  // type — families
  '--w-font-prose',
  '--w-font-display',
  '--w-font-ui',
  '--w-font-mono',
  // type — prose (the writing surface)
  '--w-prose-size',
  '--w-prose-leading',
  '--w-prose-measure',
  '--w-prose-gap',
  '--w-prose-weight',
  '--w-prose-strong-weight',
  // type — headings inside the writing surface (em, relative to prose size)
  '--w-h1',
  '--w-h2',
  '--w-h3',
  '--w-h4',
  '--w-heading-weight',
  '--w-heading-leading',
  '--w-heading-tracking',
  '--w-heading-stretch',
  // type — app chrome
  '--w-text-xs',
  '--w-text-sm',
  '--w-text-md',
  '--w-text-lg',
  '--w-text-xl',
  '--w-text-2xl',
  '--w-ui-weight',
  '--w-ui-strong-weight',
  '--w-ui-tracking',
  '--w-display-weight',
  '--w-display-tracking',
  '--w-display-stretch',
  // shape
  '--w-radius-xs',
  '--w-radius-sm',
  '--w-radius-md',
  '--w-radius-lg',
  '--w-radius-pill',
  '--w-border',
  // elevation
  '--w-shadow-1',
  '--w-shadow-2',
  // space (shared scale, themes may not override)
  '--w-space-1',
  '--w-space-2',
  '--w-space-3',
  '--w-space-4',
  '--w-space-5',
  '--w-space-6',
  '--w-space-7',
  '--w-space-8',
  '--w-gutter',
  '--w-tap',
  '--w-toolbar-h',
  // motion
  '--w-ease',
  '--w-ease-out',
  '--w-dur-1',
  '--w-dur-2',
  '--w-dur-3',
] as const;
export type ThemeToken = (typeof THEME_TOKENS)[number];

/**
 * Layout variables written on <html> at runtime by the UI's viewport helper
 * (visualViewport). Not part of a theme; present from first paint with safe
 * fallbacks in tokens.css.
 *   --w-vv-height  visible height in px (shrinks when the keyboard opens)
 *   --w-vv-offset  visualViewport.offsetTop in px (iOS scrolls the layout viewport)
 *   --w-kb-inset   px of the layout viewport covered by the on-screen keyboard
 */
export const VIEWPORT_VARS = ['--w-vv-height', '--w-vv-offset', '--w-kb-inset'] as const;

/* ========================================================================== *
 * 8. Module map — the fixed import surface between areas
 * ========================================================================== *
 *
 *   src/write/data/index.ts        export const contentSource: ContentSource
 *                                  export const draftStore: DraftStore
 *                                  export const frontmatter: FrontmatterApi
 *                                  export const auth: AuthApi            (sign-in; drives contentSource.canSave)
 *                                  export const pendingImages            (blob: URLs for images not committed yet)
 *                                  image intake: intakeImages, imagesFromPaste, imagesFromDrop, imageRef,
 *                                  pendingAssetsFor, rewriteImageRefs, draftAfterSave … (see its README)
 *                                  plus helpers the UI uses: reviewDiff / inlineDiff (Review),
 *                                  resolveDraft / mergeDraft (draft against a changed source),
 *                                  composePost / finalBreakOf / newlineOf (the text of the post being edited),
 *                                  fieldDefs, emptyValueFor, formatLike, gitBlobSha … (see its README)
 *   src/write/editor/Editor.svelte default export: EditorComponent
 *   src/write/preview/index.ts     export const renderMarkdown: RenderMarkdown
 *   src/write/preview/Preview.svelte default export: PreviewComponent
 *   src/write/theme/index.ts       export const THEMES: readonly ThemeInfo[]
 *                                  export function getTheme(): ThemeId
 *                                  export function setTheme(id: ThemeId): void
 *                                  export function getSchemePref() / setSchemePref(pref: SchemePref)
 *                                  export const THEME_BOOT_SCRIPT (inline, applies both before first paint)
 *   src/write/theme/index.css      fonts + tokens + the three themes and their dark sets (imported by the page)
 *   src/write/ui/App.svelte        default export: the app root mounted by src/pages/write/index.astro
 *
 * Areas import each other ONLY through these paths. Anything else inside an
 * area directory is private to that area.
 */
