<!--
  One post open for writing: header (back, title, view, sheets), the editor
  (and/or preview), the formatting toolbar, and the status line.

  DATA FLOW — the part everything else hangs on:
    - the post is held as exact text slices (`parts`); `raw` is their concatenation
    - the editor only ever replaces `parts.body`; the title field and the
      properties sheet only go through frontmatter.patch(); nothing else can
      change the text
    - `raw === baseRaw` means byte-identical to the source, and then no draft is kept
    - every other state is autosaved to the draft store and restored on reload

  WHAT ELSE CAN HAPPEN TO A POST while it is open, and where it is handled:
    - the source changed since the draft was started   open() → resolveDraft (data): carried over,
      or a CONFLICT that stays flagged (`conflict`) through edits and reloads until it is resolved
    - another tab changed the same post                 draft events + the store's write counter
      (`rev`): this tab follows when it has nothing unstored, else asks (`superseded`)
    - it is published                                   publish(): the saved text becomes the base
    - it is deleted from the repo                       deletePost(): after the confirmation in Review

  IMAGES: a picture picked, pasted or dropped is taken in by the data layer (`intakeImages`:
  downscaled, metadata stripped, safely named) and becomes a `PendingImage` kept WITH THE DRAFT
  (`assets`). The text gets `![](<stem>/<name>)`; until the commit the editor and the preview show
  it from the bytes on this device (`pendingImages` → `blob:` URLs). Publish sends the images the
  text still refers to; one whose reference was removed is not sent, and is dropped from the draft
  the next time the post is opened (not sooner, so Undo can bring the reference back).

  WIRING POINTS to the other areas (all through the contracts):
    contentSource.load / .resolveAssetUrl / .list   ../data
    draftStore.get / .put / .delete                 ../data
    frontmatter.split / .parse / .patch / …         ../data
    <Editor>   EditorProps, EditorHandle            ../editor/Editor.svelte
    <Preview>  PreviewProps                         ../preview/Preview.svelte
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import ArrowLeft from '@lucide/svelte/icons/arrow-left';
  import CircleUser from '@lucide/svelte/icons/circle-user';
  import Columns2 from '@lucide/svelte/icons/columns-2';
  import Copy from '@lucide/svelte/icons/copy';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Eye from '@lucide/svelte/icons/eye';
  import FileDiff from '@lucide/svelte/icons/file-diff';
  import Palette from '@lucide/svelte/icons/palette';
  import PenLine from '@lucide/svelte/icons/pen-line';
  import SlidersHorizontal from '@lucide/svelte/icons/sliders-horizontal';
  import {
    COLLECTION_INFO,
    DraftConflictError,
    PostNotFoundError,
    SaveConflictError,
    type CollectionKind,
    type DraftRecord,
    type EditorHandle,
    type EditorNoteState,
    type EditorSelectionState,
    type FrontmatterPatch,
    type PendingImage,
    type PostParts,
    type PostRef,
    type PreviewContext,
    type SaveRequest,
    type SaveResult,
  } from '../contracts';
  import {
    IMAGE_ACCEPT,
    committedImageNames,
    composePost,
    finalBreakOf,
    contentSource,
    draftAfterSave,
    draftStore,
    frontmatter,
    hasImages,
    imageRef,
    imagesFromDrop,
    imagesFromPaste,
    intakeImages,
    isImageReferenced,
    newlineOf,
    pendingAssetsFor,
    pendingImages,
    resolveDraft,
    rewriteImageRefs,
    type ImageEntry,
  } from '../data';
  import Editor from '../editor/Editor.svelte';
  import Preview from '../preview/Preview.svelte';
  import AccountButton from './AccountButton.svelte';
  import Properties from './Properties.svelte';
  import Review, { type ReviewImage } from './Review.svelte';
  import Sheet from './Sheet.svelte';
  import Toolbar from './Toolbar.svelte';
  import BoundInput from './fields/BoundInput.svelte';
  import { KIND_ICON } from './kinds';
  import { relativeTime } from './lib/groups';
  import { copyText } from './lib/io';
  import { enterMovesOn } from './lib/keys';
  import { imageSpacing, summariseImages, type AddedImage } from './lib/images';
  import { blockersToList, explainSaveFailure, publishBlockers, saidOutsideReview, textLeftAfterPublish, type PublishOptions, type SaveProblem } from './lib/publish';
  import { autoSlug, isAutoSlug, slugSeedKey } from './lib/slug';
  import { countWords, readingMinutes, wordsLabel } from './lib/text';
  import { emptyValue } from './lib/values';
  import { account, canPublishHere } from './auth.svelte';
  import { look } from './look.svelte';
  import { handoff, listMemory, published, readViewMode, rememberViewMode, type Published, type ViewMode } from './memory.svelte';
  import { router } from './router.svelte';
  import { listHref, postHref, type PostSheet } from './routes';
  import { media } from './viewport.svelte';

  let { id, sheet }: { id: string; sheet: PostSheet | null } = $props();

  const isNew = $derived(id.startsWith('new:'));

  let status = $state<'loading' | 'ready' | 'missing' | 'failed'>('loading');
  let problem = $state('');
  let collection = $state<CollectionKind>('notes');
  let sourcePath = $state('');
  /** The source as it is now: what "changed" is measured against and what Review diffs with. Null for a new post. */
  let baseRaw = $state<string | null>(null);
  let baseSha = $state<string | undefined>();
  /**
   * The original the edits were really made on — what is stored with the draft and what a save
   * names as its base. The same as `baseRaw`/`baseSha` except while the draft is in conflict:
   * then it stays the OLD original, so the conflict is found again on every open and a save
   * cannot pass its sha check by accident.
   */
  let draftBase = $state.raw<{ raw: string | null; sha?: string }>({ raw: null });
  /** Set while the kept text conflicts with the source (the upstream version it conflicts with). */
  let conflict = $state.raw<{ sha?: string } | null>(null);
  let parts = $state.raw<PostParts>({ bom: '', open: '', frontmatter: '', close: '', gap: '', body: '' });
  /** The file's own line break, for the few breaks the app adds itself. */
  let fileBreak = $state<'\n' | '\r\n' | '\r'>('\n');
  /** Set when unsaved work from an earlier visit was picked up: when it was last changed. */
  let restoredFrom = $state<number | null>(null);
  /**
   * The source file changed (or went away) after the changes kept here were started:
   *   merged   they touch different lines, so the edits were carried over onto the new original
   *   missing  the file is no longer in the source; the kept text is all there is
   * (Changes to the SAME lines are a conflict: that is `conflict` below, which is not a notice to
   * wave away but a state that lasts until it is resolved.)
   */
  let upstream = $state<'merged' | 'missing' | null>(null);
  /** Why the last properties edit was refused (frontmatter the app will not rewrite). */
  let patchProblem = $state('');
  let keepFailed = $state(false);
  let keptAt = $state<number | null>(null);
  let persistedRaw = $state('');
  let initialSelection = $state<{ anchor: number; head: number } | undefined>();
  let initialScrollTop = $state<number | undefined>();
  /** Write counter of the stored draft as this tab last saw it (0: nothing stored). See DraftStore. */
  let rev = 0;
  /**
   * Another tab stored (or removed) changes to this post while this tab holds text of its own
   * that is not stored. Autosave stops until the owner picks a version.
   */
  let superseded = $state(false);
  /** This tab just replaced what it showed with what another tab had kept. */
  let followedTab = $state(false);
  /** The footnote open in the editor's note panel. */
  let note = $state<EditorNoteState | null>(null);
  /** Why a toolbar command did nothing, said once. */
  let notice = $state('');
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  /** Pictures are being taken in (decoded, downscaled): which one of how many. Null: none. */
  let takingImages = $state.raw<{ at: number; of: number } | null>(null);
  let canSave = $state(contentSource.canSave);
  /** The text a new post had when this screen opened it (to tell "nothing typed yet" from a draft in progress). */
  let startedRaw = $state('');
  /** How far through the text the editor was when the preview was opened. */
  let previewAt = $state<number | undefined>();
  /** Where the writing was the last time the preview was opened from it (0: the top, nothing to follow). */
  let writingWasAt = 0;

  /**
   * Images taken in for this post that are not in the repo yet. They are part of the draft
   * (`DraftRecord.assets`) and are committed with the post.
   */
  let assets = $state.raw<PendingImage[]>([]);
  /** The stored draft holds exactly `assets` (false: the next autosave has images to write or drop). */
  let assetsStored = true;
  /** Counts changes to what an image reference resolves to, so the editor and the preview look again. */
  let imageEpoch = $state(0);
  let fileInput = $state<HTMLInputElement | undefined>();
  /** The file is gone from the source and what is open is the kept copy: publishing creates it anew. */
  let gone = $state(false);
  /** This screen's last publish, to say how it went (and where the commit is). */
  let justPublished = $state.raw<Published | null>(null);
  /**
   * How the last publish or delete from this screen failed. Kept HERE, not in the Review sheet:
   * the sheet can be closed (or rebuilt, when a conflict makes the screen read the post again)
   * while the commit is still under way, and the failure must not go unsaid — a banner says it
   * on the writing screen, and Review says it again when it is reopened. Cleared by the next
   * attempt, by typing, and by signing in when signing in was the way forward.
   */
  let saveProblem = $state.raw<SaveProblem | null>(null);
  /** The Account sheet was opened from Review's "Sign in to publish": go back there once signed in. */
  let resumeReview = false;
  /** The "you were signed out" notice was read. */
  let endedSeen = $state(false);

  let editor = $state<EditorHandle | undefined>();
  let selection = $state<EditorSelectionState | undefined>();
  let wantedMode = $state<ViewMode>(readViewMode());
  let posts = $state.raw<readonly PostRef[]>(listMemory.posts ?? []);
  let copied = $state(false);
  let now = $state(Date.now());

  /** Side by side needs the room; on a narrower screen "split" falls back to writing. */
  const mode = $derived<ViewMode>(wantedMode === 'split' && !media.split ? 'write' : wantedMode);

  // The slices put back together — plus the line breaks the app itself owes a file (data/split.ts:
  // after a closing fence that ends the file once there is body text, at the end of a NEW post, and
  // at the end of a file whose original ended with one — text added under the last line would
  // otherwise leave the file without it).
  const raw = $derived(composePost(parts, { isNew, newline: fileBreak, finalBreak: finalBreakOf(baseRaw) }));
  const dirty = $derived(raw !== baseRaw);
  const parsed = $derived(frontmatter.parse(parts.frontmatter));
  const baseData = $derived(baseRaw === null ? null : frontmatter.parse(frontmatter.split(baseRaw).frontmatter).data);
  /** A new post's path follows its slug; an existing post keeps its path. */
  const path = $derived(
    isNew && typeof parsed.data.slug === 'string' && parsed.data.slug !== ''
      ? frontmatter.pathFor(collection, parsed.data.slug, String(parsed.data.created ?? ''))
      : sourcePath,
  );
  const ref = $derived(frontmatter.describe(path, raw, { id, isNew }));
  // A new function whenever what a reference resolves to may have changed (an image was added, the
  // post's address moved): that is what makes the editor and the preview resolve again.
  const resolveAsset = $derived.by(() => {
    void imageEpoch;
    return (src: string) => contentSource.resolveAssetUrl(path, src);
  });
  /** The pending images the text refers to: what a publish will carry. */
  const imagesToPublish = $derived(assets.filter((a) => isImageReferenced(raw, path, a.name)));
  const reviewImages = $derived<ReviewImage[]>(
    imagesToPublish.map((a) => ({
      name: a.name,
      size: a.size,
      originalSize: a.originalSize,
      width: a.width,
      height: a.height,
      stripped: a.stripped,
      url: (void imageEpoch, contentSource.resolveAssetUrl(path, imageRef(path, a.name))),
    })),
  );
  /**
   * An existing post whose slug was changed in this edit: the address its file could move to (same
   * folder, `<slug>.md`). Offered in Review, never done unasked. Null when there is nothing to
   * offer — the slug is unchanged or not a slug, or another post already lives there.
   */
  const moveTo = $derived.by(() => {
    if (isNew || gone || baseData === null || parsed.issues.length > 0) return null;
    const slug = parsed.data.slug;
    if (typeof slug !== 'string' || slug === '' || slug === baseData.slug || frontmatter.slugify(slug) !== slug) return null;
    const to = sourcePath.replace(/[^/]+\.md$/, `${slug}.md`);
    return to === sourcePath || posts.some((p) => p.path === to) ? null : to;
  });
  const signedOutNotice = $derived(account.state.status !== 'signed-in' && !endedSeen ? account.state.ended : undefined);
  const previewCtx = $derived<PreviewContext>({ path, collection, frontmatter: parsed.data, resolveAsset, posts });

  const words = $derived(countWords(parts.body));
  const minutes = $derived(readingMinutes(words));
  const issues = $derived(parsed.issues.length ? [] : frontmatter.validate(collection, parsed.data));
  /** Missing fields of a post nobody has typed in yet are not shouted about (a new blogmark opens on its properties). */
  const untouchedNew = $derived(isNew && baseRaw === null && raw === startedRaw);
  const issueCount = $derived(untouchedNew ? 0 : parsed.issues.length ? 1 : issues.length);
  const blockers = $derived(
    publishBlockers({ id, isNew, path, collection, parsed, issues, posts, conflict: conflict !== null, superseded, sourceLabel: contentSource.label }),
  );

  /** Tags already used on the blog, most used first, for the tag field. */
  const tagSuggestions = $derived.by(() => {
    const uses = new Map<string, number>();
    for (const p of posts) for (const tag of p.tags) uses.set(tag, (uses.get(tag) ?? 0) + 1);
    return [...uses].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
  });

  /** The frontmatter key the header's title field edits (a quotation is known by its source). */
  const titleKey = $derived(
    parsed.issues.length > 0
      ? null // frontmatter that does not parse is shown as text and never rewritten
      : collection === 'quotations'
        ? 'source'
        : frontmatter.fields(collection).some((f) => f.key === 'title')
          ? 'title'
          : null,
  );
  const titleValue = $derived(titleKey && typeof parsed.data[titleKey] === 'string' ? (parsed.data[titleKey] as string) : '');
  const titlePlaceholder = $derived.by(() => {
    if (collection === 'quotations') return 'Who said it?';
    if (collection === 'blogmarks') return typeof parsed.data.link_title === 'string' && parsed.data.link_title ? parsed.data.link_title : 'Title (optional)';
    return collection === 'notes' ? 'Title (optional)' : 'Title';
  });

  type KeepState = 'clean' | 'keeping' | 'kept' | 'failed';
  const keepState = $derived<KeepState>(
    keepFailed && dirty ? 'failed' : !dirty ? 'clean' : raw === persistedRaw ? 'kept' : superseded ? 'failed' : 'keeping',
  );
  const keepShort = $derived(
    { clean: 'No changes', keeping: 'Keeping', kept: isNew ? 'New draft' : 'Edited', failed: 'Not kept' }[keepState],
  );
  const keepLong = $derived(
    {
      clean: 'No changes',
      keeping: 'Keeping your changes',
      kept: `${isNew ? 'Not published' : 'Edited'}, kept on this device${keptAt ? ` ${relativeTime(keptAt, now)}` : ''}`,
      failed: 'Changes are not being kept on this device',
    }[keepState],
  );

  let timer: ReturnType<typeof setTimeout> | undefined;

  /** Open the post, then settle its images: register what the text refers to, drop what it does not. */
  async function open() {
    await openPost();
    if (status !== 'ready') return;
    const referred = assets.filter((a) => isImageReferenced(raw, path, a.name));
    if (referred.length !== assets.length) {
      assets = referred;
      assetsStored = false;
    }
    showImages();
  }

  /** Tell the data layer which images this post holds, so their references resolve to the bytes on this device. */
  function showImages() {
    pendingImages.sync(id, path, assets);
    imageEpoch += 1;
  }

  async function openPost() {
    try {
      const draft = await draftStore.get(id).catch(() => undefined);
      rev = draft?.rev ?? 0;
      assets = draft?.assets ?? [];
      assetsStored = true;
      gone = false;
      if (published.last && !published.last.deleted && published.last.path === id) {
        justPublished = published.last;
        published.last = null;
      }
      superseded = false;
      upstream = null;
      restoredFrom = null;
      conflict = null;
      initialSelection = undefined;
      initialScrollTop = undefined;
      previewAt = undefined;
      writingWasAt = 0;
      if (id.startsWith('new:')) {
        const fresh = handoff.get(id);
        const text = draft?.raw ?? fresh?.raw;
        if (text === undefined) {
          status = 'missing';
          return;
        }
        collection = draft?.collection ?? fresh!.ref.collection;
        sourcePath = draft?.path ?? fresh!.ref.path;
        baseRaw = null;
        draftBase = { raw: null };
        parts = frontmatter.split(text);
        fileBreak = newlineOf(text);
        // "Untouched" only for a post created a moment ago (it arrives through the hand-off).
        startedRaw = fresh ? composePost(parts, { isNew: true, newline: fileBreak }) : '';
        initialSelection = draft?.selection;
        initialScrollTop = draft?.scrollTop;
        keptAt = draft?.updatedAt ?? null;
        // Nothing stored means this browser refused the draft when it was created.
        keepFailed = draft === undefined;
      } else {
        let loaded;
        try {
          loaded = await contentSource.load(id);
        } catch (err) {
          // The file is gone from the source, but work on it is kept here: open that rather than lose it.
          if (!(err instanceof PostNotFoundError) || !draft) throw err;
          collection = draft.collection;
          sourcePath = draft.path;
          baseRaw = draft.baseRaw;
          baseSha = draft.baseSha;
          draftBase = { raw: draft.baseRaw, sha: draft.baseSha };
          // Nothing is left upstream to be in conflict with.
          conflict = null;
          parts = frontmatter.split(draft.raw);
          fileBreak = newlineOf(draft.raw);
          initialSelection = draft.selection;
          initialScrollTop = draft.scrollTop;
          keptAt = draft.updatedAt;
          upstream = 'missing';
          gone = true;
          persistedRaw = draft.raw;
          status = 'ready';
          return;
        }
        collection = loaded.ref.collection;
        sourcePath = loaded.ref.path;
        baseRaw = loaded.raw;
        baseSha = loaded.ref.sha;
        draftBase = { raw: loaded.raw, sha: loaded.ref.sha };
        parts = loaded.parts;
        fileBreak = newlineOf(loaded.raw);
        let stored = loaded.raw;
        if (draft) {
          // Judged from the draft's own original, however often it was opened or edited since.
          const found = resolveDraft(draft, { raw: loaded.raw, sha: loaded.ref.sha });
          if (found.kind === 'drop') {
            // What was kept here is what the source has now: nothing is left to keep.
            await draftStore.delete(id).catch(() => {});
            rev = 0;
            assets = [];
          } else {
            stored = draft.raw;
            parts = frontmatter.split(found.text);
            draftBase = found.base;
            conflict = found.conflict ?? null;
            // A merge is stored (on the new original) by the first autosave. A conflict keeps the
            // draft's OLD original as its base, so it is found — and announced — on every open
            // until the owner resolves it (keepMine / discard).
            upstream = found.kind === 'merged' ? 'merged' : null;
            const sameText = found.text === draft.raw;
            initialSelection = sameText ? draft.selection : undefined;
            initialScrollTop = sameText ? draft.scrollTop : undefined;
            restoredFrom = draft.updatedAt;
            keptAt = draft.updatedAt;
          }
        }
        persistedRaw = stored;
        status = 'ready';
        return;
      }
      persistedRaw = draft ? draft.raw : '';
      status = 'ready';
    } catch (err) {
      if (err instanceof PostNotFoundError) status = 'missing';
      else {
        problem = err instanceof Error ? err.message : String(err);
        status = 'failed';
      }
    }
  }

  /**
   * Where the writing is, to come back to after a reload. Taken from what the editor last
   * REPORTED, not asked of it on the spot: the last write happens while this screen is being torn
   * down, when the editor may already be gone (and would answer "at the very top").
   */
  let lastScrollTop: number | undefined;
  let leaving = false;
  function position(): Pick<DraftRecord, 'selection' | 'scrollTop'> {
    if (!leaving && editor) lastScrollTop = editor.getScrollTop();
    return {
      selection: selection ? { anchor: selection.anchor, head: selection.head } : undefined,
      scrollTop: lastScrollTop,
    };
  }

  /** The draft record for the text as it is now. */
  function record(text: string): DraftRecord {
    return {
      id,
      path,
      collection,
      isNew,
      raw: text,
      baseRaw: draftBase.raw,
      baseSha: draftBase.sha,
      updatedAt: Date.now(),
      ...position(),
      ...(conflict ? { conflict } : {}),
      ...(assets.length > 0 ? { assets } : {}),
      rev,
    };
  }

  /** One store write at a time: two checked writes in flight would trip over each other's counter. */
  let saving: Promise<void> = Promise.resolve();

  /**
   * Keep the text on this device (or drop the draft when the text is the original again).
   * Checked against the store's write counter, so a tab that has fallen behind another one is
   * told (`superseded`) instead of overwriting it. `force` writes even when nothing changed
   * (after the owner chose this tab's version).
   */
  function persist(force = false): Promise<void> {
    clearTimeout(timer);
    saving = saving.then(async () => {
      if (status !== 'ready' || superseded) return;
      const text = raw;
      if (text === persistedRaw && !keepFailed && !force && assetsStored) return;
      try {
        if (!isNew && text === baseRaw) {
          // The original again: nothing refers to a pending image any more, so nothing is kept.
          // (`assets` stays in memory: Redo may bring a reference back, and then it is stored again.)
          await draftStore.delete(id, { expectedRev: rev });
          rev = 0;
          conflict = null;
          draftBase = { raw: baseRaw, sha: baseSha };
          assetsStored = assets.length === 0;
        } else {
          const held = assets;
          rev = await draftStore.put(record(text), { expectedRev: rev });
          if (assets === held) assetsStored = true;
          keptAt = Date.now();
        }
        persistedRaw = text;
        keepFailed = false;
        handoff.delete(id);
      } catch (err) {
        if (err instanceof DraftConflictError) superseded = true;
        else keepFailed = true;
      }
    });
    return saving;
  }

  /**
   * The page is going away (tab closed, app switched): issue the write NOW, in this turn — the
   * store starts its request before returning, so the last keystrokes are on their way before the
   * page is. Unchecked (a checked write needs a read first, which may never come back).
   */
  function flush() {
    clearTimeout(timer);
    if (status !== 'ready' || superseded) return;
    const text = raw;
    if (text === persistedRaw && !keepFailed && assetsStored) return;
    if (!isNew && text === baseRaw) {
      void persist();
      return;
    }
    const held = assets;
    draftStore.put(record(text)).then(
      (stored) => {
        rev = Math.max(rev, stored);
        if (raw === text) persistedRaw = text;
        if (assets === held) assetsStored = true;
        keptAt = Date.now();
        keepFailed = false;
        handoff.delete(id);
      },
      () => {
        keepFailed = true;
      },
    );
  }

  /** Another tab stored or removed changes to this post. */
  function onOtherTab() {
    if (status !== 'ready') return;
    clearTimeout(timer);
    if (raw === persistedRaw && !keepFailed) {
      // Nothing here that is not stored: show what the other tab kept (when this tab is looked at).
      if (document.visibilityState === 'hidden') staleFromTab = true;
      else void follow();
    } else superseded = true;
  }
  let staleFromTab = false;

  /** Replace what this tab shows with what is stored now. */
  async function follow() {
    staleFromTab = false;
    superseded = false;
    editor = undefined;
    status = 'loading';
    await open();
    followedTab = (status as string) === 'ready';
  }

  /** The owner chose THIS tab's text over the other tab's: store it over whatever is there. */
  async function keepThisTab() {
    rev = (await draftStore.get(id).catch(() => undefined))?.rev ?? 0;
    superseded = false;
    await persist(true);
  }

  /** The owner keeps their text although the source changed in the same lines: it now stands against the new original. */
  async function keepMine() {
    saveProblem = null;
    draftBase = { raw: baseRaw, sha: baseSha };
    conflict = null;
    upstream = null;
    restoredFrom = null;
    await persist(true);
  }

  /** A save found the post changed or gone in the repo: read it again, which runs the usual "changed since you started" handling. */
  async function afterConflict(err: unknown, kind: 'publish' | 'delete') {
    if (!(err instanceof SaveConflictError) || (err.reason !== 'changed' && err.reason !== 'missing')) return;
    // Reading the post again rebuilds the screen, Review included: it is handed what went wrong.
    saveProblem = explainSaveFailure(err, kind);
    await follow();
    followedTab = false;
  }

  /**
   * Publish (when the source can save): ONE commit holding the text, with the base it was really
   * made on, and the pending images the text refers to. `options.move` also moves the file to the
   * address its changed slug gives it (image references in the text follow).
   *
   * On success this text IS the original: the draft goes (or keeps only what the commit did not
   * carry), a new or moved post goes to its real address, the list is refreshed. When the branch
   * moved meanwhile the data layer looks again and commits on top, unless this very post changed —
   * that is a conflict, and then nothing is lost: the post is re-read. Throws what `save` throws.
   */
  async function publish(options: PublishOptions = {}): Promise<Published> {
    saveProblem = null;
    await persist();
    const sent = raw;
    const from = path;
    const to = options.move && moveTo ? moveTo : from;
    const moving = !isNew && to !== from;
    const text = moving ? rewriteImageRefs(sent, from, to, [...committedImageNames(from), ...assets.map((a) => a.name)]) : sent;
    const files = pendingAssetsFor(to, assets, text);
    // A post that is gone from the repo is created anew; everything else names the blob it was based on.
    const request: SaveRequest = { path: to, raw: text, baseSha: isNew || gone ? undefined : draftBase.sha };
    if (moving) request.previousPath = from;
    if (files.length > 0) request.assets = files;
    if (options.message) request.message = options.message;
    let result: SaveResult;
    try {
      result = await contentSource.save(request);
    } catch (err) {
      saveProblem = explainSaveFailure(err, 'publish');
      await afterConflict(err, 'publish');
      throw err;
    }
    clearTimeout(timer);
    await saving;
    // What is left to keep: nothing, unless the text moved on while the commit was under way or
    // images remain that it did not carry. Text typed during a MOVE still names the old image
    // folder: it gets the rewrite the committed text got.
    const names = moving ? [...committedImageNames(from), ...assets.map((a) => a.name)] : [];
    const leftText = textLeftAfterPublish(raw, sent, text, (newer) => (moving ? rewriteImageRefs(newer, from, to, names) : newer));
    const left = draftAfterSave(record(leftText), { raw: text, result });
    if (left === null || left.id !== id) await draftStore.delete(id).catch(() => {});
    const leftRev = left ? await draftStore.put(left).catch(() => 0) : 0;
    handoff.delete(id);
    listMemory.posts = null;
    void contentSource
      .list()
      .then((list) => {
        posts = list;
        listMemory.posts = list;
      })
      .catch(() => {});
    const done: Published = { path: result.path, commitUrl: result.commitUrl, commits: result.commits, moved: result.path !== id, at: Date.now() };
    if (result.path !== id) {
      status = 'loading'; // stops the unmount flush from writing the draft back
      published.last = done;
      router.go(postHref(result.path), { replace: true });
    } else {
      baseRaw = text;
      baseSha = result.sha;
      draftBase = { raw: text, sha: result.sha };
      rev = leftRev;
      persistedRaw = left ? left.raw : text;
      assets = left?.assets ?? [];
      assetsStored = true;
      conflict = null;
      upstream = null;
      gone = false;
      restoredFrom = null;
      keepFailed = false;
      justPublished = done;
    }
    return done;
  }

  /**
   * Delete the post from the repo — one commit, after the confirmation in Review. Its image folder
   * goes with it. The blob the post was opened at is named, so a post that changed meanwhile is
   * not deleted unseen (it is re-read instead, like any conflict).
   */
  async function deletePost(options: PublishOptions = {}): Promise<Published> {
    saveProblem = null;
    clearTimeout(timer);
    await saving;
    const request: SaveRequest = { path: sourcePath, raw: '', delete: true, baseSha: draftBase.sha };
    if (options.message) request.message = options.message;
    let result: SaveResult;
    try {
      result = await contentSource.save(request);
    } catch (err) {
      saveProblem = explainSaveFailure(err, 'delete');
      await afterConflict(err, 'delete');
      throw err;
    }
    clearTimeout(timer);
    await saving;
    await draftStore.delete(id).catch(() => {});
    handoff.delete(id);
    rev = 0;
    listMemory.posts = null;
    status = 'loading'; // stops the unmount flush from writing the draft back
    const done: Published = { path: sourcePath, commitUrl: result.commitUrl, deleted: true, at: Date.now() };
    published.last = done;
    router.go(listHref(), { replace: true });
    return done;
  }

  /* ------------------------------------------------------------------ images */

  /**
   * Take pictures in (file picker, paste, drop) and put them in the text at the caret. One at a
   * time, so each gets a name the folder does not have yet. While they are being decoded and
   * downscaled (seconds, for a camera photo on a phone) a banner says so; afterwards one notice
   * says what was added and what was refused.
   *
   * `ownParagraph` (the Image button): each picture becomes a paragraph of its own, wherever the
   * caret happens to be — on a phone it is often still where the last sentence ended, or was
   * never placed at all. A paste or a drop goes exactly where it was aimed (`Look: ![](…)`); only
   * further pictures of the same batch are set apart from the one before.
   */
  async function takeImages(entries: readonly ImageEntry[], options: { ownParagraph?: boolean } = {}) {
    if (status !== 'ready' || !editor) return;
    const refused: string[] = [];
    const taken: AddedImage[] = [];
    const files = entries.filter((e) => e.file).length;
    let nth = 0;
    try {
      for (const entry of entries) {
        const handle = editor;
        if (!handle) break;
        if (!entry.file) {
          // A picture dragged from another page comes as its address: link it, nothing to store.
          if (entry.src) handle.exec('image', { src: entry.src, alt: entry.alt });
          continue;
        }
        nth += 1;
        takingImages = { at: nth, of: files };
        const names = [...committedImageNames(path), ...assets.map((a) => a.name)];
        const { images, inserts, rejected } = await intakeImages([entry], { postPath: path, taken: names });
        for (const r of rejected) refused.push(r.message);
        if (images.length === 0 || status !== 'ready') continue;
        const before = assets;
        const added = images.map((image) => ({ ...image, originalSize: entry.file!.size }));
        assets = [...assets, ...added];
        assetsStored = false;
        showImages(); // before the text mentions them, so the editor finds them at once
        const ok = inserts.every((insert) => placeImage(insert, { before: options.ownParagraph || taken.length > 0, after: options.ownParagraph === true }));
        if (!ok) {
          assets = before;
          showImages();
          refused.push('The picture was not added: put the caret in the text of the post first.');
          continue;
        }
        taken.push(...added);
      }
    } finally {
      takingImages = null;
    }
    const { message, sticky } = summariseImages(taken, refused);
    if (message) onNotice(message, { sticky });
  }

  /**
   * Put one image reference at the caret. `apart.before` / `apart.after`: add the line breaks that
   * side needs (`imageSpacing`), so the picture is not glued to the text there.
   */
  function placeImage(insert: { src: string; alt?: string }, apart: { before: boolean; after: boolean }): boolean {
    const handle = editor;
    if (!handle) return false;
    const caret = () => {
      const { anchor, head } = handle.getSelection();
      return anchor === head ? head : null; // a selection is left to the editor's own rules
    };
    const at = caret();
    const lead = apart.before && at !== null ? imageSpacing(handle.getDoc(), at).before : 0;
    if (lead) handle.insertText(fileBreak.repeat(lead));
    if (handle.exec('image', insert) !== true) return false;
    const after = caret();
    const trail = apart.after && after !== null ? imageSpacing(handle.getDoc(), after).after : 0;
    if (trail) handle.insertText(fileBreak.repeat(trail));
    return true;
  }

  function pickImage() {
    fileInput?.click();
  }

  function onPicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = ''; // the same file can be picked again
    if (files.length > 0) void takeImages(files.map((file) => ({ file })), { ownParagraph: true });
  }

  /** A paste or drop that carries picture files is taken in here, before the editor sees it. */
  function onPasteImages(event: ClipboardEvent) {
    if (status !== 'ready' || !hasImages(event)) return;
    event.preventDefault();
    event.stopPropagation();
    void imagesFromPaste(event).then(takeImages);
  }

  function onDropImages(event: DragEvent) {
    if (status !== 'ready' || !hasImages(event)) return;
    event.preventDefault();
    event.stopPropagation();
    void imagesFromDrop(event).then(takeImages);
  }

  function onDragOverImages(event: DragEvent) {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  }

  // The images follow the post: whenever its address or its set of images changes, say so to the
  // data layer (a new post's address follows its slug).
  $effect(() => {
    void path;
    void assets;
    if (status !== 'ready') return;
    untrack(showImages);
  });

  /** "Sign in to publish": the Account sheet, and back to Review as soon as that worked. */
  function signInFromReview() {
    resumeReview = true;
    router.openSheet('account');
  }

  $effect(() => {
    if (sheet !== 'account') resumeReview = false;
    else if (resumeReview && canSave) {
      resumeReview = false;
      untrack(() => router.openSheet('review'));
    }
  });

  /**
   * A NEW draft whose address already holds exactly this text was published already: the page
   * went away (a phone killing the tab mid-upload) before the draft could be dropped. Nothing is
   * left to publish, and "Change the slug" would be wrong advice — it would publish a duplicate.
   * Drop the draft and open the post.
   */
  async function settlePublishedDraft() {
    if (!isNew || status !== 'ready') return;
    const twin = posts.find((p) => p.path === path && p.id !== id);
    if (!twin) return;
    const text = raw;
    let there;
    try {
      there = await contentSource.load(twin.path);
    } catch {
      return;
    }
    if (status !== 'ready' || raw !== text || there.raw !== text) return;
    // Its pictures have to be there too: one still waiting means that publish did not finish.
    const committed = new Set(committedImageNames(twin.path));
    if (imagesToPublish.some((a) => !committed.has(a.name))) return;
    clearTimeout(timer);
    await saving;
    await draftStore.delete(id).catch(() => {});
    handoff.delete(id);
    rev = 0;
    status = 'loading'; // stops the unmount flush from writing the draft back
    router.go(postHref(twin.path), { replace: true });
  }

  $effect(() => {
    void posts;
    void path;
    if (isNew && status === 'ready') untrack(() => void settlePublishedDraft());
  });

  /** A draft is a few kB; the wait only spares a write per keystroke. */
  const AUTOSAVE_MS = 250;

  // Autosave: any change to the text, shortly after it stops changing.
  $effect(() => {
    void raw;
    if (status !== 'ready') return;
    clearTimeout(timer);
    timer = setTimeout(() => void persist(), AUTOSAVE_MS);
  });

  function onBody(body: string) {
    if (body !== parts.body) {
      parts = { ...parts, body };
      restoredFrom = null;
      followedTab = false;
      justPublished = null;
      saveProblem = null;
    }
  }

  /** Say something once. It goes away by itself, unless it is `sticky`: then it stays until dismissed. */
  function onNotice(message: string, options: { sticky?: boolean } = {}) {
    notice = message;
    clearTimeout(noticeTimer);
    if (!options.sticky) noticeTimer = setTimeout(() => (notice = ''), 7000);
  }

  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  /** Every frontmatter edit in the app ends here. */
  function patch(changes: FrontmatterPatch) {
    let all = changes;
    // A new post's slug follows its title until the slug is edited by hand.
    const seedKey = slugSeedKey(collection);
    if (isNew && seedKey in changes && !('slug' in changes)) {
      const next = autoSlug(str(changes[seedKey]), frontmatter.slugify);
      if (next !== '' && isAutoSlug(str(parsed.data.slug), str(parsed.data[seedKey]), frontmatter.slugify)) {
        all = { ...changes, slug: next };
      }
    }
    try {
      const before = path;
      parts = frontmatter.patch(parts, all, collection);
      patchProblem = '';
      justPublished = null;
      // A new post's address follows its slug, and its images follow the post: the references in
      // the text are rewritten to the new folder name.
      if (isNew && assets.length > 0 && path !== before) {
        const body = rewriteImageRefs(
          parts.body,
          before,
          path,
          assets.map((a) => a.name),
        );
        if (body !== parts.body) {
          parts = { ...parts, body };
          editor?.setDoc(body, { keepHistory: true });
        }
      }
    } catch (err) {
      // patch() refuses rather than risk the rest of the YAML (see FrontmatterPatchError); the text is untouched.
      patchProblem = err instanceof Error ? err.message : String(err);
    }
  }

  function onTitle(value: string) {
    if (titleKey) patch({ [titleKey]: value === '' ? emptyValue(baseData, titleKey) : value });
  }

  async function discard() {
    clearTimeout(timer);
    await saving;
    await draftStore.delete(id).catch(() => {});
    rev = 0;
    superseded = false;
    conflict = null;
    draftBase = { raw: baseRaw, sha: baseSha };
    assets = [];
    assetsStored = true;
    handoff.delete(id);
    if (isNew || baseRaw === null) {
      status = 'loading'; // stops the unmount flush from writing the draft back
      router.go(listHref(), { replace: true });
      return;
    }
    parts = frontmatter.split(baseRaw);
    persistedRaw = baseRaw;
    restoredFrom = null;
    upstream = null;
    patchProblem = '';
    keepFailed = false;
    editor?.setDoc(parts.body);
    router.closeSheet();
  }

  function setMode(next: ViewMode) {
    // Open the preview where the writing is, not at the top of the post.
    // But only when the writing has moved since the preview was last open: coming straight back
    // to it (or opening it with the text still at the top) returns to where it was being read.
    if (next !== 'write' && mode === 'write') {
      const at = editor?.getScrollFraction() ?? 0;
      previewAt = at === writingWasAt ? undefined : at;
      writingWasAt = at;
    }
    wantedMode = next;
    rememberViewMode(next);
  }

  async function quickCopy() {
    copied = await copyText(raw);
    setTimeout(() => (copied = false), 2000);
  }

  /** Leaving is always safe when the draft is stored. When it is not, show the ways out first. */
  let warnedOnce = false;
  function onBack(event: MouseEvent) {
    if (keepState !== 'failed' || warnedOnce) return;
    event.preventDefault();
    warnedOnce = true;
    router.openSheet('review');
  }

  function onKeydown(event: KeyboardEvent) {
    // ⌘S / Ctrl+S: there is no Save, but the habit should land somewhere useful.
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void persist();
    }
  }

  onMount(() => {
    const stopDrafts = draftStore.subscribe((event) => {
      if (event.id === id && event.origin === 'remote') onOtherTab();
    });
    const stopAuth = contentSource.onAuthChange(() => {
      canSave = contentSource.canSave;
      // Signed in again: what was in the way of the last publish is not any more.
      if (canSave && saveProblem?.signIn) saveProblem = null;
    });
    void open();
    if (posts.length === 0) {
      void contentSource
        .list()
        .then((list) => (posts = list))
        .catch(() => {});
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
      else if (staleFromTab) onOtherTab();
    };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      flush();
      if (keepState === 'failed') event.preventDefault();
    };
    const clock = setInterval(() => (now = Date.now()), 30_000);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      leaving = true;
      stopDrafts();
      stopAuth();
      pendingImages.clear(id);
      clearInterval(clock);
      clearTimeout(noticeTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', beforeUnload);
      flush();
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

<header class="top" class:tucked={!media.wide && note?.cover === true}>
  <a class="w-icon back" href={listHref()} aria-label="Back to all posts" title="All posts" data-action="back" onclick={onBack}>
    <ArrowLeft size={22} aria-hidden="true" />
  </a>

  <!-- A label, so the whole block (title and the line under it) is the tap target for the title field. -->
  <label class="what">
    {#if status !== 'ready'}
      <span class="title static">{status === 'loading' ? 'Opening' : 'Post'}</span>
    {:else if titleKey}
      <BoundInput
        class="title"
        type="text"
        aria-label={titleKey === 'source' ? 'Source' : 'Title'}
        placeholder={titlePlaceholder}
        autocomplete="off"
        autocapitalize="sentences"
        enterkeyhint="done"
        data-title-input
        value={titleValue}
        onInput={onTitle}
        onkeydown={(e) => enterMovesOn(e, () => editor?.focus())}
      />
    {:else}
      <span class="title static">{ref.title}</span>
    {/if}
    {#if status === 'ready'}
      {@const Icon = KIND_ICON[collection]}
      <span class="state" data-write-state={dirty ? 'edited' : 'clean'} data-keep-state={keepState}>
        <Icon size={13} aria-hidden="true" />
        <span class="kind">{COLLECTION_INFO[collection].singular}</span>
        <span class="words" class:yields={keepState !== 'clean'}>{wordsLabel(words)}</span>
        <span class="keep {keepState}" role="status">{media.wide ? keepLong : keepShort}</span>
      </span>
    {/if}
  </label>

  {#if media.wide}
    <div class="modes" role="group" aria-label="View">
      <button type="button" aria-pressed={mode === 'write'} data-mode="write" onclick={() => setMode('write')}>
        <PenLine size={16} aria-hidden="true" />Write
      </button>
      {#if media.split}
        <button type="button" aria-pressed={mode === 'split'} data-mode="split" onclick={() => setMode('split')}>
          <Columns2 size={16} aria-hidden="true" />Side by side
        </button>
      {/if}
      <button type="button" aria-pressed={mode === 'preview'} data-mode="preview" onclick={() => setMode('preview')}>
        <Eye size={16} aria-hidden="true" />Preview
      </button>
    </div>
    <AccountButton />
    <button type="button" class="w-icon" data-open="look" aria-label="Change the look" title="Look" onclick={() => router.openSheet('look')}>
      <Palette size={20} aria-hidden="true" />
    </button>
    <button type="button" class="w-btn is-quiet props" data-open="properties" disabled={status !== 'ready'} onclick={() => router.openSheet('properties')}>
      <SlidersHorizontal size={18} aria-hidden="true" />Properties{#if issueCount}<span class="badge" aria-label="{issueCount} to fix">{issueCount}</span>{/if}
    </button>
    <button type="button" class="w-btn is-primary" data-open="review" disabled={status !== 'ready'} onclick={() => router.openSheet('review')}>
      Review changes
    </button>
  {:else}
    <button
      type="button"
      class="w-icon"
      aria-label={mode === 'preview' ? 'Back to writing' : 'Preview'}
      title={mode === 'preview' ? 'Back to writing' : 'Preview'}
      aria-pressed={mode === 'preview'}
      data-mode={mode === 'preview' ? 'write' : 'preview'}
      disabled={status !== 'ready'}
      onclick={() => setMode(mode === 'preview' ? 'write' : 'preview')}
    >
      {#if mode === 'preview'}<PenLine size={20} aria-hidden="true" />{:else}<Eye size={20} aria-hidden="true" />{/if}
    </button>
    <button type="button" class="w-icon has-badge" data-open="properties" aria-label="Properties{issueCount ? `, ${issueCount} to fix` : ''}" title="Properties" disabled={status !== 'ready'} onclick={() => router.openSheet('properties')}>
      <SlidersHorizontal size={20} aria-hidden="true" />{#if issueCount}<span class="pip" aria-hidden="true"></span>{/if}
    </button>
    <button type="button" class="w-icon has-badge" data-open="more" aria-label="Review changes and more" title="More" disabled={status !== 'ready'} onclick={() => router.openSheet('more')}>
      <Ellipsis size={20} aria-hidden="true" />{#if dirty && !isNew}<span class="pip accent" aria-hidden="true"></span>{/if}
    </button>
  {/if}
</header>

{#if status === 'ready' && media.wide && mode !== 'preview'}
  <Toolbar {editor} {selection} {note} placement="top" onPickImage={pickImage} />
{/if}

<main class="stage" data-view={mode}>
  {#if status === 'loading'}
    <div class="state-screen" role="status">
      <span class="bone" style:width="62%"></span><span class="bone" style:width="88%"></span><span class="bone" style:width="74%"></span>
      <span class="w-sr">Opening the post</span>
    </div>
  {:else if status === 'missing'}
    <div class="state-screen" role="alert">
      <h2>{isNew ? 'This draft is no longer on this device' : 'This post was not found'}</h2>
      <p>
        {isNew
          ? 'It was deleted, or it was started in another browser. Drafts stay in the browser they were written in.'
          : `${id} is not in ${contentSource.label}.`}
      </p>
      <a class="w-btn" href={listHref()}>All posts</a>
    </div>
  {:else if status === 'failed'}
    <div class="state-screen" role="alert">
      <h2>The post did not open</h2>
      <p>{problem}</p>
      <div class="pair">
        <button type="button" class="w-btn is-primary" onclick={() => ((status = 'loading'), void open())}>Try again</button>
        <a class="w-btn" href={listHref()}>All posts</a>
      </div>
    </div>
  {:else}
    {#if superseded}
      <p class="banner bad" role="alert" data-banner="other-tab">
        <span>This post was changed in another tab. This tab has changes of its own that are not kept yet.</span>
        <span class="choices">
          <button type="button" data-action="follow-tab" onclick={follow}>Show that version</button>
          <button type="button" data-action="keep-tab" onclick={keepThisTab}>Keep this one</button>
        </span>
      </p>
    {:else if keepState === 'failed'}
      <p class="banner bad" role="alert" data-banner="not-kept">
        <span>This browser is not storing your changes. Copy or download before closing the tab.</span>
        <button type="button" onclick={() => router.openSheet('review')}>Copy or download</button>
      </p>
    {:else if saidOutsideReview(saveProblem, sheet)}
      <!-- A publish or delete failed while Review was not open to say so (it was closed mid-commit). -->
      <p class="banner bad" role="alert" data-banner="publish-failed" data-publish-failed={saveProblem?.reason}>
        <span>{saveProblem?.message}</span>
        <span class="choices">
          {#if saveProblem?.signIn && canPublishHere}
            <button type="button" data-open="account" onclick={signInFromReview}>Sign in</button>
          {:else}
            <button type="button" data-open="review" onclick={() => router.openSheet('review')}>Review</button>
          {/if}
          <button type="button" data-action="dismiss-publish-failed" onclick={() => (saveProblem = null)}>OK</button>
        </span>
      </p>
    {:else if takingImages}
      <p class="banner" role="status" data-banner="taking-images">
        <span>{takingImages.of > 1 ? `Adding picture ${takingImages.at} of ${takingImages.of}` : 'Adding the picture'}. Large photos take a moment.</span>
      </p>
    {:else if patchProblem}
      <p class="banner bad" role="alert" data-banner="patch-refused">
        <span>That change was not made. {patchProblem}</span>
        <button type="button" onclick={() => (patchProblem = '')}>OK</button>
      </p>
    {:else if notice}
      <p class="banner" role="status" data-banner="notice">
        <span>{notice}</span>
        <button type="button" onclick={() => (notice = '')}>OK</button>
      </p>
    {:else if justPublished && sheet !== 'review'}
      <p class="banner good" role="status" data-banner="published">
        <span>
          Published{justPublished.moved ? ` as ${justPublished.path}` : ''}.
          {#if justPublished.commitUrl}<a href={justPublished.commitUrl} target="_blank" rel="noopener noreferrer" data-commit-link>View the commit</a>{/if}
        </span>
        <button type="button" onclick={() => (justPublished = null)}>OK</button>
      </p>
    {:else if signedOutNotice && canPublishHere}
      <!-- The session ended (expired, revoked). Nothing is lost: the draft is on this device. -->
      <p class="banner" role="status" data-banner="signed-out">
        <span>{signedOutNotice.message} Your changes are kept on this device.</span>
        <span class="choices">
          <button type="button" data-open="account" onclick={() => router.openSheet('account')}>Sign in</button>
          <button type="button" onclick={() => (endedSeen = true)}>Later</button>
        </span>
      </p>
    {:else if conflict !== null}
      <!-- Stays until it is resolved: typing does not make it go away, and neither does a reload. -->
      <p class="banner bad" role="alert" data-banner="upstream-conflict">
        <span>
          This post changed in {contentSource.label} since you started, in the same lines you changed. What you see is your
          version; Review shows how it differs from the post as it is now.
        </span>
        <span class="choices">
          <button type="button" data-action="keep-mine" onclick={keepMine}>Keep mine</button>
          <button type="button" data-action="review-conflict" onclick={() => router.openSheet('review')}>Review</button>
        </span>
      </p>
    {:else if upstream !== null}
      <p class="banner" class:bad={upstream === 'missing'} role="status" data-banner="upstream-{upstream}">
        <span>
          {#if upstream === 'merged'}
            This post changed in {contentSource.label} since you started. Your changes were carried over onto the new version.
          {:else}
            This post is no longer in {contentSource.label}. What you see is the copy kept on this device.
          {/if}
        </span>
        <button type="button" onclick={() => (upstream = null)}>OK</button>
      </p>
    {:else if followedTab}
      <p class="banner" role="status" data-banner="followed-tab">
        <span>Updated to the changes made in another tab.</span>
        <button type="button" onclick={() => (followedTab = false)}>OK</button>
      </p>
    {:else if restoredFrom !== null}
      <p class="banner" role="status" data-banner="restored">
        <span>Picked up your changes from {relativeTime(restoredFrom, now)}. They are only on this device.</span>
        <button type="button" onclick={() => (restoredFrom = null)}>OK</button>
      </p>
    {/if}

    <div class="panes">
      <!-- Pictures pasted or dropped on the writing are taken in before the editor sees the event. -->
      <div
        class="pane editor"
        hidden={mode === 'preview'}
        data-write-pane="editor"
        role="presentation"
        onpastecapture={onPasteImages}
        ondropcapture={onDropImages}
        ondragovercapture={onDragOverImages}
      >
        <div class="page">
          <!-- WIRING POINT: the editor (../editor). Uncontrolled: it reads `doc` on mount and when `docKey` changes. -->
          <Editor
            doc={parts.body}
            docKey={id}
            onChange={onBody}
            onReady={(handle) => (editor = handle)}
            onSelectionChange={(s) => (selection = s)}
            onNoteChange={(n) => (note = n)}
            {onNotice}
            {resolveAsset}
            theme={look.theme}
            lineSeparator={fileBreak}
            placeholder={collection === 'quotations' ? 'The quote' : collection === 'blogmarks' ? 'What makes this link worth keeping?' : 'Start writing'}
            {initialSelection}
            {initialScrollTop}
            insets={{ top: 8, bottom: 24 }}
          />
        </div>
      </div>
      {#if mode !== 'write'}
        <div class="pane preview" data-write-pane="preview">
          <!-- WIRING POINT: the site-faithful preview (../preview). -->
          <Preview markdown={parts.body} ctx={previewCtx} startAt={previewAt} />
        </div>
      {/if}
    </div>
  {/if}
</main>

{#if status === 'ready'}
  {#if media.wide}
    <footer class="status" data-write-status>
      <span>{COLLECTION_INFO[collection].singular}</span>
      <span class="path">{path}</span>
      <span class="grow"></span>
      <span>{wordsLabel(words)}</span>
      {#if minutes}<span>{minutes} min read</span>{/if}
      {#if ref.draft}<span>Draft</span>{/if}
      <span>{keepLong}</span>
    </footer>
  {:else if mode === 'write'}
    <Toolbar {editor} {selection} {note} placement="bottom" onPickImage={pickImage} />
  {/if}
{/if}

{#if status === 'ready'}
  <!-- The Image button's picker: one or more pictures from this device (the camera roll, on a phone). -->
  <input class="picker" type="file" accept={IMAGE_ACCEPT} multiple hidden tabindex="-1" aria-hidden="true" data-image-picker bind:this={fileInput} onchange={onPicked} />
{/if}

{#if status === 'ready'}
  {#if sheet === 'properties'}
    <Sheet title="Properties" name="properties" onClose={() => router.closeSheet()}>
      <Properties {parts} {collection} {path} {isNew} {baseData} {tagSuggestions} {posts} postId={id} problem={patchProblem} onPatch={patch} />
    </Sheet>
  {:else if sheet === 'review'}
    <Review
      {path}
      {baseRaw}
      {raw}
      {isNew}
      {collection}
      creating={isNew || gone}
      {canSave}
      canSignIn={!canSave && canPublishHere}
      blockers={blockersToList(blockers, contentSource.label)}
      conflict={conflict !== null}
      keepFailed={keepState === 'failed' && !superseded}
      images={reviewImages}
      {moveTo}
      committedImages={committedImageNames(sourcePath).length}
      removable={!isNew && !gone && baseRaw !== null}
      published={justPublished}
      carried={saveProblem}
      onPublish={publish}
      onDelete={deletePost}
      onSignIn={signInFromReview}
      onKeepMine={keepMine}
      onDiscard={discard}
      onClose={() => router.closeSheet()}
    />
  {:else if sheet === 'more'}
    <Sheet title={ref.title} name="more" onClose={() => router.closeSheet()}>
      <ul class="menu">
        <li>
          <button type="button" data-open="review" onclick={() => router.openSheet('review')}>
            <FileDiff size={20} aria-hidden="true" />
            <span class="name">Review changes</span>
            <span class="hint">
              {dirty
                ? isNew
                  ? 'A new post, not published yet'
                  : `See what you changed, then ${canSave ? 'publish' : 'copy or download'}`
                : 'Nothing changed. Copy or download the file'}
            </span>
          </button>
        </li>
        <li>
          <button type="button" data-action="quick-copy" onclick={quickCopy}>
            <Copy size={20} aria-hidden="true" />
            <span class="name">{copied ? 'Copied' : 'Copy markdown'}</span>
            <span class="hint">The whole file, frontmatter included</span>
          </button>
        </li>
        <li>
          <button type="button" data-open="look" onclick={() => router.openSheet('look')}>
            <Palette size={20} aria-hidden="true" />
            <span class="name">Look</span>
            <span class="hint">Galley, Console or Riso</span>
          </button>
        </li>
        <li>
          <button type="button" data-open="account" onclick={() => router.openSheet('account')}>
            <CircleUser size={20} aria-hidden="true" />
            <span class="name">Account</span>
            <span class="hint">
              {account.state.status === 'signed-in'
                ? `Signed in as ${account.state.user?.login ?? 'you'}`
                : canPublishHere
                  ? 'Sign in to publish from here'
                  : 'Not signed in'}
            </span>
          </button>
        </li>
      </ul>
      <p class="fine">{wordsLabel(words)}{minutes ? `, about ${minutes} min to read` : ''}. {keepLong}.</p>
    </Sheet>
  {/if}
{/if}

<style>
  /* ---------------------------------------------------------------- header */
  .top {
    flex: none;
    display: flex;
    align-items: center;
    gap: 2px;
    min-height: 56px;
    padding: env(safe-area-inset-top) calc(var(--w-space-1) + env(safe-area-inset-right)) 0
      calc(var(--w-space-1) + env(safe-area-inset-left));
    border-bottom: var(--w-border) solid var(--w-line);
    background: var(--w-bg);
  }
  .what {
    flex: 1;
    min-width: 0;
    display: grid;
    gap: 1px;
    padding: 6px 0;
  }
  .what :global(.title) {
    display: block;
    width: 100%;
    min-width: 0;
    height: 26px;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: var(--w-radius-xs);
    background: transparent;
    color: var(--w-ink);
    font-family: var(--w-font-display);
    /* An editable field: never below 16px, or iOS zooms on focus. */
    font-size: max(1rem, var(--w-text-lg));
    font-weight: var(--w-display-weight);
    font-stretch: var(--w-display-stretch);
    letter-spacing: var(--w-display-tracking);
    line-height: 26px;
    text-overflow: ellipsis;
  }
  .what :global(.title::placeholder) {
    color: var(--w-ink-3);
    opacity: 1;
  }
  .what :global(input.title:focus-visible) {
    outline: 2px solid var(--w-focus);
    outline-offset: 2px;
  }
  .title.static {
    overflow: hidden;
    white-space: nowrap;
  }
  .state {
    display: flex;
    align-items: center;
    gap: var(--w-space-2);
    min-width: 0;
    overflow: hidden;
    color: var(--w-ink-2);
    font-size: var(--w-text-xs);
    line-height: 16px;
    white-space: nowrap;
    text-transform: var(--wx-case);
    font-variant-numeric: tabular-nums;
  }
  .state :global(svg) {
    flex: none;
    color: var(--wx-kind-ink);
  }
  .state .kind {
    margin-left: -4px;
  }
  .state .kind {
    flex: none;
  }
  /* The kept/edited state is the one thing here that must always be readable in full: the word
     count gives way first (it is in the More sheet too). */
  .keep {
    flex: none;
    font-weight: var(--w-ui-strong-weight);
  }
  .state .words {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  @media (max-width: 479px) {
    .state .words.yields {
      display: none;
    }
  }
  /* A phone on its side with the keyboard up and a footnote open: every pixel goes to the note. */
  .top.tucked {
    display: none;
  }
  .keep.kept,
  .keep.keeping {
    color: var(--w-accent-text);
  }
  .keep.clean {
    font-weight: var(--w-ui-weight);
  }
  .keep.failed {
    color: var(--w-danger);
  }
  .has-badge {
    position: relative;
  }
  .pip {
    position: absolute;
    top: 9px;
    right: 9px;
    width: 8px;
    height: 8px;
    border-radius: var(--w-radius-pill);
    background: var(--w-danger);
    box-shadow: 0 0 0 2px var(--w-bg);
  }
  .pip.accent {
    background: var(--w-accent);
  }
  .badge {
    display: inline-grid;
    place-items: center;
    min-width: 20px;
    height: 20px;
    padding: 0 5px;
    border-radius: var(--w-radius-pill);
    background: var(--w-danger);
    color: var(--w-surface);
    font-size: var(--w-text-xs);
    font-variant-numeric: tabular-nums;
  }

  /* Write | Side by side | Preview */
  .modes {
    flex: none;
    display: inline-flex;
    margin: 0 var(--w-space-3);
    padding: 2px;
    border: var(--w-border) solid var(--w-line);
    border-radius: var(--w-radius-sm);
    background: var(--w-surface-2);
  }
  .modes button {
    display: inline-flex;
    align-items: center;
    gap: var(--w-space-2);
    min-height: 36px;
    padding: 0 var(--w-space-3);
    border: 0;
    border-radius: calc(var(--w-radius-sm) - 1px);
    background: transparent;
    color: var(--w-ink-2);
    font: inherit;
    font-size: var(--w-text-sm);
    text-transform: var(--wx-case);
    white-space: nowrap;
    cursor: pointer;
  }
  .modes button[aria-pressed='true'] {
    background: var(--w-surface);
    color: var(--w-ink);
    font-weight: var(--w-ui-strong-weight);
    box-shadow: var(--w-shadow-1);
  }
  .props {
    padding: 0 var(--w-space-3);
  }

  /* ----------------------------------------------------------------- stage */
  .stage {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }
  .panes {
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-auto-flow: column;
    grid-auto-columns: minmax(0, 1fr);
  }
  .pane {
    min-width: 0;
    min-height: 0;
  }
  .pane[hidden],
  .pane.editor[hidden] {
    display: none;
  }
  /* The writing sheet: full-bleed on a phone; on a wide screen each theme
     decides whether it is a page on a desk (--wx-page-*). */
  .pane.editor {
    display: flex;
    background: var(--wx-page-bg);
  }
  .page {
    flex: 1;
    min-width: 0;
    min-height: 0;
    font-size: var(--w-prose-size);
  }
  .pane.preview {
    background: var(--w-bg);
  }
  .stage[data-view='split'] .pane.preview {
    border-left: var(--w-border) solid var(--w-line);
  }

  .banner {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--w-space-3);
    margin: 0;
    padding: var(--w-space-1) var(--w-space-2) var(--w-space-1) var(--w-gutter);
    background: var(--w-accent-soft);
    color: var(--w-ink);
    font-size: var(--w-text-sm);
    line-height: 1.35;
  }
  .banner.bad {
    background: var(--w-del-bg);
    color: var(--w-del-ink);
  }
  .banner.good {
    background: var(--w-add-bg);
    color: var(--w-add-ink);
  }
  .banner a {
    /* A 44px tap target without loosening the lines around it: the padding is taken back by the margin. */
    display: inline-flex;
    align-items: center;
    padding-block: 13px;
    margin-block: -13px;
    color: inherit;
    font-weight: var(--w-ui-strong-weight);
    text-underline-offset: 3px;
    white-space: nowrap;
  }
  .banner > span:first-child {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  /* A banner with two ways out: on a phone the buttons go under the sentence instead of squeezing it. */
  .banner:has(.choices) {
    flex-wrap: wrap;
    row-gap: 0;
  }
  .banner:has(.choices) > span:first-child {
    flex: 1 1 16rem;
    padding: var(--w-space-2) 0;
  }
  .banner .choices {
    flex: none;
    display: flex;
    margin-left: auto;
  }
  .banner button {
    flex: none;
    min-height: var(--w-tap);
    padding: 0 var(--w-space-3);
    border: 0;
    border-radius: var(--w-radius-sm);
    background: transparent;
    color: inherit;
    font: inherit;
    font-weight: var(--w-ui-strong-weight);
    text-decoration: underline;
    text-underline-offset: 3px;
    cursor: pointer;
  }

  .state-screen {
    display: grid;
    justify-items: start;
    gap: var(--w-space-3);
    width: 100%;
    max-width: 40rem;
    margin: 0 auto;
    padding: var(--w-space-7) var(--w-gutter);
  }
  .state-screen h2 {
    margin: 0;
    font-family: var(--w-font-display);
    font-size: var(--w-text-xl);
    font-weight: var(--w-display-weight);
    font-stretch: var(--w-display-stretch);
    letter-spacing: var(--w-display-tracking);
    line-height: 1.15;
  }
  .state-screen p {
    margin: 0;
    color: var(--w-ink-2);
    overflow-wrap: anywhere;
  }
  .bone {
    display: block;
    height: 1em;
    border-radius: var(--w-radius-xs);
    background: var(--w-surface-2);
  }
  .pair {
    display: flex;
    flex-wrap: wrap;
    gap: var(--w-space-2);
  }

  /* ----------------------------------------------------------- status line */
  .status {
    flex: none;
    display: flex;
    align-items: center;
    gap: var(--w-space-5);
    min-height: 28px;
    padding: 0 var(--w-space-4);
    border-top: var(--w-border) solid var(--w-line);
    background: var(--wx-status-bg);
    color: var(--wx-status-ink);
    font-size: var(--w-text-xs);
    font-variant-numeric: tabular-nums;
    text-transform: var(--wx-case);
    white-space: nowrap;
    overflow: hidden;
  }
  .status .path {
    overflow: hidden;
    text-overflow: ellipsis;
    font-family: var(--w-font-mono);
    text-transform: none;
  }
  .status .grow {
    flex: 1;
  }

  /* ------------------------------------------------------------- more menu */
  .menu {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--w-space-2);
  }
  .menu button {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr);
    grid-template-areas: 'icon name' 'icon hint';
    align-items: center;
    column-gap: var(--w-space-3);
    width: 100%;
    min-height: 60px;
    padding: var(--w-space-2) var(--w-space-3);
    border: var(--w-border) solid var(--w-line);
    border-radius: var(--w-radius-md);
    background: transparent;
    color: var(--w-ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
    touch-action: manipulation;
  }
  .menu button :global(svg) {
    grid-area: icon;
    color: var(--w-accent-text);
  }
  .menu .name {
    grid-area: name;
    font-weight: var(--w-ui-strong-weight);
    text-transform: var(--wx-case);
  }
  .menu .hint {
    grid-area: hint;
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
  }
  .fine {
    margin: var(--w-space-4) 0 0;
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
  }

  /* ------------------------------------------------------------ wide screen */
  /* Desktop layout: wide AND tall enough (see viewport.svelte.ts); a phone on its side keeps the phone layout. */
  :global(html[data-write-wide]) .top {
    gap: var(--w-space-2);
    padding: 0 var(--w-space-4) 0 var(--w-space-2);
  }
  :global(html[data-write-wide]) .what {
    padding-left: var(--w-space-2);
  }
  :global(html[data-write-wide]) .stage:not([data-view='split']) .pane.editor,
  :global(html[data-write-wide]) .stage[data-view='split'] .pane.editor {
    background: transparent;
  }
  :global(html[data-write-wide]) .page {
    background: var(--wx-page-bg);
  }
  /* A page on the desk — only when the page is narrower than the pane. */
  :global(html[data-write-wide]) .stage:not([data-view='split']) .page {
    flex: none;
    width: min(100% - 2 * var(--w-gutter), calc(var(--w-prose-measure) + 5 * var(--w-gutter)));
    margin: var(--wx-page-margin) auto 0;
    border: var(--wx-page-outline) solid var(--wx-page-line);
    border-bottom: 0;
    border-radius: var(--wx-page-radius) var(--wx-page-radius) 0 0;
    box-shadow: var(--wx-page-shadow);
    overflow: hidden;
  }
</style>
