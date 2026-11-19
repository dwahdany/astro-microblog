/**
 * Data layer entry point — the ONLY module other areas import from here.
 *
 * The three contract exports (`contentSource`, `draftStore`, `frontmatter`)
 * are what src/write/contracts.ts promises. Everything below them is extra:
 * helpers the contract does not name yet, kept here so the UI never reaches
 * into this directory's files. See ./README.md.
 */
import { REPO, type AuthApi, type ContentSource, type DraftStore, type FrontmatterApi } from '../contracts';
import { createPendingImages, type PendingImages } from './assets/pending';
import { MANIFEST_URL } from './manifest';
import { createDraftStore } from './draft-store';
import { frontmatter as frontmatterImpl } from './frontmatter';
import { createGithubSource, type GithubSource } from './github-source';
import { createSession } from './github/session';
import { createLocalSource } from './local-source';

/* ------------------------------------------------------------- the contract */

export const frontmatter: FrontmatterApi = frontmatterImpl;

const drafts = createDraftStore();
export const draftStore: DraftStore = drafts;

/**
 * Sign-in. One session per browser profile, shared by every tab (localStorage). It exists with
 * either content source, but only the GitHub source turns it into `canSave`.
 */
const session = createSession({ repo: REPO });
export const auth: AuthApi = session;

/**
 * `blob:` URLs for images that have no address yet: a draft's pending images
 * (`pendingImages.sync(draft.id, draft.path, draft.assets)`) and images this session committed.
 * `contentSource.resolveAssetUrl` consults it first, in both sources.
 */
export const pendingImages: PendingImages = createPendingImages();

/**
 * In dev, `?source=github` (remembered for the tab in sessionStorage; `?source=local` undoes it)
 * swaps the working tree for the GitHub source, so sign-in and publishing can be exercised on
 * localhost — with a pasted token, since the auth worker refuses the popup there.
 */
function devWantsGithub(): boolean {
  try {
    const KEY = 'write:source';
    const asked = new URLSearchParams(globalThis.location?.search ?? '').get('source');
    if (asked === 'github' || asked === 'local') globalThis.sessionStorage?.setItem(KEY, asked);
    return globalThis.sessionStorage?.getItem(KEY) === 'github';
  } catch {
    return false;
  }
}

const githubSource = (): GithubSource => createGithubSource(REPO, frontmatter, { manifestUrl: MANIFEST_URL, auth: session, images: pendingImages });

/**
 * Dev reads the working tree (offline, reflects uncommitted files); production
 * reads the public GitHub repo. The `import.meta.env.DEV` ternary must stay a
 * literal so the bundler drops ./local-files (and with it every post's text)
 * from the production build.
 */
const source: ContentSource & Partial<Pick<GithubSource, 'imageNames' | 'onSaveProgress'>> = import.meta.env.DEV
  ? devWantsGithub()
    ? githubSource()
    : createLocalSource(() => import('./local-files').then((m) => m.files), frontmatter, { images: pendingImages })
  : githubSource();
export const contentSource: ContentSource = source;

// A session left by an earlier visit is checked with GitHub once, in the background: a token that
// was revoked meanwhile is dropped (and `auth.onChange` says so) before the owner tries to publish.
if (session.state().status === 'signed-in') void session.verify().catch(() => {});

/* ------------------------------------------------- beyond the contract (v0) */

/** 'indexeddb' when drafts survive a reload, 'memory' when this browser cannot store them. */
export const draftPersistence = () => drafts.persistence();
export type { DraftPersistence } from './draft-store';

/** "Review changes": line diff of the original against the current text. */
export { reviewDiff, inlineDiff } from './diff';
export type { DiffHunk, DiffLine, InlineSegment, ReviewDiff, ReviewDiffOptions } from './diff';

/** Did the upstream file change since a draft was started, and can the edits be carried over? */
export { draftBaseState, mergeDraft, rebaseDraft, resolveDraft } from './draft-sync';
export type { DraftBaseState, DraftResolution } from './draft-sync';

/** The file text of a post being edited (adds the two line breaks the app is responsible for), and the file's own line break. */
export { composePost, finalBreakOf, newlineOf } from './split';

/** Field tables beyond `frontmatter.fields`: defaults, write order, what "empty" means per key. */
export { emptyValueFor, fieldDef, fieldDefs, scaffoldKeys, writeOrder } from './fields';
export type { FieldDef } from './fields';

/** Timestamps in the formats the files use. */
export { formatLike, parseTimestamp, sveltiaTimestamp } from './dates';

/** Repo path an asset reference points at (where a pasted image has to be committed). */
export { assetRepoPath } from './paths';

/** Git blob id of a text — what `PostRef.sha` / `SaveRequest.baseSha` hold. */
export { gitBlobSha } from './git-sha';

/* --------------------------------------------- sign-in, publish, images (v1) */

/**
 * File names already in the post's image folder in the repo (empty for the working-tree source and
 * before the first `list()`). With the draft's own pending names this is the `taken` list for
 * `intakeImages`, and the `names` for `rewriteImageRefs`.
 */
export const committedImageNames = (postPath: string): string[] => source.imageNames?.(postPath) ?? [];

/** Progress of a save that had to be split into several commits: `(done, total)`. Returns unsubscribe. */
export const onSaveProgress = (listener: (done: number, total: number) => void): (() => void) => source.onSaveProgress?.(listener) ?? (() => {});

/** Image intake: paste / drop / file picker → `PendingImage`s (type sniffing, EXIF-stripping re-encode, safe unique names). */
export { IMAGE_ACCEPT, hasImages, imagesFromDrop, imagesFromPaste, intakeImages } from './assets/intake';
export type { ImageEntry, IntakeOptions, IntakeRejection, IntakeRejectionReason, IntakeResult } from './assets/intake';

/** Where a post's images live and how they are written in the text. */
export { imageFolder, imagePath, imageRef, isImageReferenced, pendingAssetsFor, rewriteImageRefs } from './assets/names';
export type { PendingImages } from './assets/pending';

/** What remains of a draft after a successful save (null: delete it). */
export { draftAfterSave } from './draft-sync';

/** The default commit message for a save, as it will read in the history. */
export { commitMessage } from './github/commit';
