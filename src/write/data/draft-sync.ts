/**
 * Has the upstream file changed since a draft was started?
 *
 * A draft remembers the text it was started from (`baseRaw`, plus `baseSha`
 * when the source knows it). Comparing that with what the source returns now
 * tells the UI whether "Review changes" still diffs against the real
 * original — and what to offer when it does not. Pure functions; no storage.
 */
import { applyPatch, structuredPatch } from 'diff';
import type { DraftRecord } from '../contracts';

export type DraftBaseState =
  /** New post: there is no upstream file. */
  | 'new'
  /** Upstream is still the text the draft started from. */
  | 'current'
  /** Upstream changed and now equals the draft: nothing left to save, the draft can be dropped. */
  | 'applied'
  /** Upstream changed to something else: the draft is based on an outdated file. */
  | 'diverged'
  /** The file no longer exists upstream (deleted or renamed). */
  | 'missing';

/** `upstream`: what `contentSource.load(draft.path)` returns now, or null when it rejects with PostNotFoundError. */
export function draftBaseState(
  draft: Pick<DraftRecord, 'isNew' | 'raw' | 'baseRaw' | 'baseSha'>,
  upstream: { raw: string; sha?: string } | null,
): DraftBaseState {
  if (draft.isNew || draft.baseRaw === null) return 'new';
  if (upstream === null) return 'missing';
  // Text is the truth; the sha is only a shortcut when both sides have one.
  if (draft.baseSha !== undefined && upstream.sha !== undefined && draft.baseSha === upstream.sha) return 'current';
  if (draft.baseRaw === upstream.raw) return 'current';
  return draft.raw === upstream.raw ? 'applied' : 'diverged';
}

/**
 * Carry a draft's edits over to a newer upstream text (three-way merge by
 * lines): the changes base → mine are re-applied on top of `theirs`.
 * Returns null when they touch the same lines (a real conflict) — the UI then
 * has to let the owner choose. Exact when only one side changed.
 */
export function mergeDraft(base: string, mine: string, theirs: string): string | null {
  if (mine === base) return theirs;
  if (theirs === base || theirs === mine) return mine;
  const patch = structuredPatch('base', 'mine', base, mine, undefined, undefined, { context: 3 });
  const merged = applyPatch(theirs, patch, { fuzzFactor: 0, autoConvertLineEndings: false });
  return merged === false ? null : merged;
}

/** The draft to store after adopting a newer upstream as its base (`raw` from `mergeDraft`, or the owner's choice). */
export function rebaseDraft(draft: DraftRecord, upstream: { raw: string; sha?: string }, raw: string, now = Date.now()): DraftRecord {
  const { baseSha: _old, ...rest } = draft;
  return { ...rest, raw, baseRaw: upstream.raw, ...(upstream.sha !== undefined ? { baseSha: upstream.sha } : {}), updatedAt: now };
}

/** What opening a post with kept changes comes to, given the source as it is now. */
export interface DraftResolution {
  /**
   * 'drop'     the source already says what the draft says: nothing is left to keep
   * 'current'  the source is still the draft's original: show the draft
   * 'merged'   the source changed elsewhere in the file: the edits were carried over onto it
   * 'conflict' the source changed in the same lines: the kept text is shown as it was
   */
  kind: 'drop' | 'current' | 'merged' | 'conflict';
  /** The text to open. */
  text: string;
  /**
   * The base to STORE with the draft. For a conflict this is still the draft's own (old)
   * original and sha — never the new upstream's — so the conflict is found again on every
   * later open, however much is typed in between, and a save cannot pass its sha check by
   * accident. For 'merged' it is the new upstream, which the carried-over edits now sit on.
   */
  base: { raw: string | null; sha?: string };
  /** Set for 'conflict': the upstream version the draft conflicts with. Stored as `DraftRecord.conflict`. */
  conflict?: { sha?: string };
}

/**
 * Decide what to open and what to keep when a post has a stored draft.
 *
 * Always judged from the draft's ORIGINAL base (which a conflicted draft keeps), so the answer
 * does not depend on how often the post was opened or edited since the source changed:
 * a conflict stays a conflict until the owner resolves it (`acceptConflict`) or the source
 * moves again — back to the draft's base (then there is no conflict any more), onto the
 * draft's text (then nothing is left to keep), or to something the edits can be carried onto.
 */
export function resolveDraft(
  draft: Pick<DraftRecord, 'isNew' | 'raw' | 'baseRaw' | 'baseSha' | 'conflict'> & Pick<Partial<DraftRecord>, 'assets'>,
  upstream: { raw: string; sha?: string },
): DraftResolution {
  const own = { raw: draft.baseRaw, ...(draft.baseSha !== undefined ? { sha: draft.baseSha } : {}) };
  // Images that are not committed yet are a reason to keep a draft whose text has nothing left to say.
  const settled: DraftResolution = draft.assets?.length
    ? { kind: 'current', text: upstream.raw, base: upstream }
    : { kind: 'drop', text: upstream.raw, base: upstream };
  if (draft.raw === upstream.raw) return settled;
  const state = draftBaseState(draft, upstream);
  if (state === 'new' || state === 'current') return { kind: 'current', text: draft.raw, base: state === 'new' ? own : upstream };
  if (state === 'applied') return settled;
  const merged = draft.baseRaw === null ? null : mergeDraft(draft.baseRaw, draft.raw, upstream.raw);
  if (merged !== null) return { kind: 'merged', text: merged, base: upstream };
  return { kind: 'conflict', text: draft.raw, base: own, conflict: upstream.sha !== undefined ? { sha: upstream.sha } : {} };
}

/**
 * What is left of a draft once a save has succeeded.
 *
 * `saved` is what was committed: the text sent (`SaveRequest.raw`) and the `SaveResult`. The
 * committed bytes become the draft's base. Returns `null` when nothing remains to keep — the
 * usual case: the caller deletes the draft. When the owner kept typing while the commit was under
 * way (`draft.raw` is no longer the text that was sent), or images are left that the commit did
 * not carry, the returned record is the draft to store instead: an existing post now (its id is
 * the committed path), based on the committed text and blob sha, holding only the images still
 * waiting. A conflict marker does not survive a save.
 */
export function draftAfterSave(
  draft: DraftRecord,
  saved: { raw: string; result: { path: string; sha: string; assets?: { path: string }[]; deleted?: boolean } },
  now = Date.now(),
): DraftRecord | null {
  if (saved.result.deleted) return null;
  const committed = new Set((saved.result.assets ?? []).map((a) => a.path.slice(a.path.lastIndexOf('/') + 1)));
  const assets = (draft.assets ?? []).filter((a) => !committed.has(a.name));
  if (draft.raw === saved.raw && assets.length === 0) return null;
  const { conflict: _conflict, assets: _assets, rev: _rev, baseSha: _baseSha, ...rest } = draft;
  const next: DraftRecord = { ...rest, id: saved.result.path, path: saved.result.path, isNew: false, baseRaw: saved.raw, baseSha: saved.result.sha, updatedAt: now };
  if (assets.length > 0) next.assets = assets;
  return next;
}
