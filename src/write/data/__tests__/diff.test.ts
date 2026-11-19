import { describe, expect, it } from 'vitest';
import { inlineDiff, linesOf, reviewDiff, type DiffHunk } from '../diff';
import { draftBaseState, mergeDraft, rebaseDraft, resolveDraft } from '../draft-sync';
import { frontmatter } from '../frontmatter';
import { posts } from './content';

/** `-old` / `+new` / ` ctx` lines, like a unified diff body. */
const show = (hunks: DiffHunk[]) =>
  hunks.map((h) => h.lines.map((l) => ({ context: ' ', add: '+', del: '-' })[l.kind] + l.text).join('\n'));

/** Rebuild both sides from a full-context diff: proves the diff describes the texts exactly. */
function rebuild(base: string, current: string) {
  const d = reviewDiff(base, current, { context: Number.MAX_SAFE_INTEGER });
  const lines = d.hunks.flatMap((h) => h.lines);
  return {
    before: lines.filter((l) => l.kind !== 'add').map((l) => l.text + l.eol).join(''),
    after: lines.filter((l) => l.kind !== 'del').map((l) => l.text + l.eol).join(''),
  };
}

describe('reviewDiff', () => {
  it('identical texts: unchanged, no hunks — for every real post', () => {
    for (const [path, raw] of posts) {
      const d = reviewDiff(raw, raw);
      expect(d.changed, path).toBe(false);
      expect(d.hunks, path).toEqual([]);
      expect(d.added + d.removed, path).toBe(0);
    }
  });

  it('a one-line body edit', () => {
    const base = '---\nslug: a\n---\n\none\ntwo\nthree\nfour\nfive\nsix\n';
    const d = reviewDiff(base, base.replace('four', 'FOUR'));
    expect(d).toMatchObject({ changed: true, isNew: false, added: 1, removed: 1, frontmatterChanged: false, bodyChanged: true });
    expect(show(d.hunks)).toEqual([' two\n three\n-four\n+FOUR\n five\n six']);
    expect(d.hunks[0]).toMatchObject({ oldStart: 6, oldLines: 5, newStart: 6, newLines: 5 });
    const [, , del, add] = d.hunks[0].lines;
    expect(del).toMatchObject({ kind: 'del', oldLine: 8, eol: '\n' });
    expect(add).toMatchObject({ kind: 'add', newLine: 8 });
    expect(del.newLine).toBeUndefined();
  });

  it('a frontmatter-only edit is told apart from a body edit', () => {
    const base = '---\nslug: a\ntitle: T\n---\n\nBody\n';
    expect(reviewDiff(base, base.replace('title: T', 'title: U'))).toMatchObject({ frontmatterChanged: true, bodyChanged: false });
    expect(reviewDiff(base, base + 'more\n')).toMatchObject({ frontmatterChanged: false, bodyChanged: true });
  });

  it('distant changes become separate hunks; context is configurable', () => {
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const base = lines.join('\n') + '\n';
    const current = base.replace('line 3\n', 'line three\n').replace('line 25\n', '');
    const d = reviewDiff(base, current);
    expect(d.hunks.length).toBe(2);
    expect(d.hunks[1]).toMatchObject({ oldStart: 23, oldLines: 5, newStart: 23, newLines: 4 });
    expect(reviewDiff(base, current, { context: 0 }).hunks.map((h) => h.lines.length)).toEqual([2, 1]);
    expect(reviewDiff(base, current, { context: 50 }).hunks.length).toBe(1);
  });

  it('pure insertions and deletions number both sides correctly', () => {
    const d = reviewDiff('a\nb\n', 'a\nx\ny\nb\n', { context: 0 });
    expect(d.hunks[0]).toMatchObject({ oldStart: 2, oldLines: 0, newStart: 2, newLines: 2 });
    const e = reviewDiff('a\nx\nb\n', 'a\nb\n', { context: 0 });
    expect(e.hunks[0]).toMatchObject({ oldStart: 2, oldLines: 1, newStart: 2, newLines: 0 });
  });

  it('a new post is all additions', () => {
    const d = reviewDiff(null, '---\nslug: a\n---\n\nHello\n');
    expect(d).toMatchObject({ changed: true, isNew: true, added: 5, removed: 0 });
    expect(d.hunks.length).toBe(1);
    expect(d.hunks[0].lines.every((l) => l.kind === 'add')).toBe(true);
    expect(reviewDiff(null, '')).toMatchObject({ changed: true, isNew: true, hunks: [] });
  });

  it('shows changes the eye cannot see: line endings, final newline, trailing spaces', () => {
    const crlf = reviewDiff('a\nb\n', 'a\r\nb\n');
    expect(crlf.changed).toBe(true);
    expect(crlf.hunks[0].lines.slice(0, 2)).toMatchObject([
      { kind: 'del', text: 'a', eol: '\n', invisible: 'eol' },
      { kind: 'add', text: 'a', eol: '\r\n', invisible: 'eol' },
    ]);

    const noFinal = reviewDiff('a\nb\n', 'a\nb');
    expect(noFinal.hunks[0].lines.slice(-2)).toMatchObject([
      { kind: 'del', text: 'b', eol: '\n', invisible: 'eol' },
      { kind: 'add', text: 'b', eol: '', invisible: 'eol' },
    ]);

    const spaces = reviewDiff('a\nb\n', 'a  \nb\n');
    expect(spaces.hunks[0].lines[0]).toMatchObject({ kind: 'del', invisible: 'whitespace' });
    expect(reviewDiff('a\n', 'A\n').hunks[0].lines[0].invisible).toBeUndefined();
  });

  it('describes both texts exactly (reassembling each side from the diff gives the input)', () => {
    const cases: [string, string][] = [
      ['a\nb\nc\n', 'a\nc\nd'],
      ['', 'x'],
      ['x', ''],
      ['a\r\nb\r\n', 'a\nb\n'],
      ['﻿a\n', 'a\n'],
      ['one\n\n\ntwo', 'one\n\ntwo\n\n'],
      ['a\rb\r', 'a\nb\n'],
    ];
    for (const [path, raw] of posts.slice(0, 15)) {
      const parts = frontmatter.split(raw);
      cases.push([raw, frontmatter.patch(parts, { title: 'Changed', tags: ['x'] }).frontmatter + parts.body.replace(/\. /g, '.\n')]);
      void path;
    }
    for (const [base, current] of cases) {
      const { before, after } = rebuild(base, current);
      expect(before).toBe(base);
      expect(after).toBe(current);
    }
  });

  it('linesOf keeps every character', () => {
    for (const text of ['', 'a', 'a\n', '\n', '\n\n', 'a\r\nb', 'a\rb\r', 'a\n\r\nb\n']) expect(linesOf(text).join('')).toBe(text);
    expect(linesOf('a\n\nb')).toEqual(['a\n', '\n', 'b']);
    expect(linesOf('')).toEqual([]);
  });

  it('inlineDiff marks the words that changed within a line', () => {
    expect(inlineDiff('the quick brown fox', 'the slow brown fox')).toEqual([
      { kind: 'same', text: 'the ' },
      { kind: 'del', text: 'quick' },
      { kind: 'add', text: 'slow' },
      { kind: 'same', text: ' brown fox' },
    ]);
    const segs = inlineDiff('a  b', 'a b');
    expect(segs.filter((s) => s.kind !== 'add').map((s) => s.text).join('')).toBe('a  b');
    expect(segs.filter((s) => s.kind !== 'del').map((s) => s.text).join('')).toBe('a b');
  });
});

describe('has the upstream file changed since the draft was started?', () => {
  const base = 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\n';
  const mine = base.replace('line 2', 'line 2 (mine)');
  const draft = { isNew: false, raw: mine, baseRaw: base, baseSha: 'sha-base' };

  it('draftBaseState', () => {
    expect(draftBaseState(draft, { raw: base, sha: 'sha-base' })).toBe('current');
    expect(draftBaseState(draft, { raw: base })).toBe('current');
    expect(draftBaseState({ ...draft, baseSha: undefined }, { raw: base, sha: 'whatever' })).toBe('current');
    expect(draftBaseState(draft, { raw: base.replace('line 8', 'line 8 (theirs)'), sha: 'sha-new' })).toBe('diverged');
    expect(draftBaseState(draft, { raw: mine, sha: 'sha-mine' })).toBe('applied');
    expect(draftBaseState(draft, null)).toBe('missing');
    expect(draftBaseState({ isNew: true, raw: 'x', baseRaw: null }, null)).toBe('new');
    // A line-ending-only difference upstream still counts: the text is the truth.
    expect(draftBaseState(draft, { raw: base.replace(/\n/g, '\r\n') })).toBe('diverged');
  });

  it('mergeDraft carries edits over when the two sides touch different lines', () => {
    const theirs = base.replace('line 8', 'line 8 (theirs)');
    expect(mergeDraft(base, mine, theirs)).toBe(base.replace('line 2', 'line 2 (mine)').replace('line 8', 'line 8 (theirs)'));
  });

  it('mergeDraft is exact when only one side changed, and refuses real conflicts', () => {
    const theirs = base.replace('line 8', 'line 8 (theirs)');
    expect(mergeDraft(base, base, theirs)).toBe(theirs);
    expect(mergeDraft(base, mine, base)).toBe(mine);
    expect(mergeDraft(base, mine, mine)).toBe(mine);
    expect(mergeDraft(base, mine, base.replace('line 2', 'line 2 (theirs)'))).toBeNull();
    expect(mergeDraft(base, mine, base.replace('line 3', 'line 3 (adjacent)'))).toBeNull();
    // No trailing newline on any side is preserved.
    expect(mergeDraft('a\nb\nc\nd\ne\nf\ng\nh', 'A\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nc\nd\ne\nf\ng\nH')).toBe('A\nb\nc\nd\ne\nf\ng\nH');
  });

  it('rebaseDraft adopts the new upstream as base', () => {
    const record = { id: 'p', path: 'p', collection: 'notes' as const, isNew: false, raw: mine, baseRaw: base, baseSha: 'old', updatedAt: 1 };
    const theirs = { raw: base.replace('line 8', 'x'), sha: 'new' };
    const merged = mergeDraft(base, mine, theirs.raw)!;
    expect(rebaseDraft(record, theirs, merged, 99)).toEqual({ ...record, raw: merged, baseRaw: theirs.raw, baseSha: 'new', updatedAt: 99 });
    expect('baseSha' in rebaseDraft(record, { raw: 'x' }, 'y', 1)).toBe(false);
    expect(draftBaseState(rebaseDraft(record, theirs, merged, 99), theirs)).toBe('current');
  });
});

/**
 * Review finding: a conflicting draft lost its "based on an older version" marker after one
 * keystroke — the first autosave stored it with the NEW upstream as its base, so the next open
 * found nothing wrong and a later save would have passed its sha check while reverting the
 * upstream change.
 */
describe('resolveDraft: a conflict stays a conflict until it is resolved', () => {
  const base = 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\n';
  const mine = base.replace('line 2', 'line 2 (mine)');
  const theirsSameLine = base.replace('line 2', 'line 2 (theirs)').replace('line 8', 'line 8 (theirs)');
  const theirsElsewhere = base.replace('line 8', 'line 8 (theirs)');
  const draft = { isNew: false, raw: mine, baseRaw: base, baseSha: 'sha-base' };

  it('the source is unchanged: show the draft on its base', () => {
    expect(resolveDraft(draft, { raw: base, sha: 'sha-base' })).toEqual({ kind: 'current', text: mine, base: { raw: base, sha: 'sha-base' } });
  });

  it('the source already says what the draft says: drop the draft', () => {
    expect(resolveDraft(draft, { raw: mine, sha: 'sha-mine' }).kind).toBe('drop');
    expect(resolveDraft({ ...draft, raw: base }, { raw: base, sha: 'sha-base' }).kind).toBe('drop');
  });

  it('changed elsewhere: the edits are carried over and the new source becomes the base', () => {
    const r = resolveDraft(draft, { raw: theirsElsewhere, sha: 'sha-new' });
    expect(r.kind).toBe('merged');
    expect(r.text).toBe(theirsElsewhere.replace('line 2', 'line 2 (mine)'));
    expect(r.base).toEqual({ raw: theirsElsewhere, sha: 'sha-new' });
    expect(r.conflict).toBeUndefined();
  });

  it('changed in the same lines: the kept text wins, and the stored base stays the OLD original', () => {
    const r = resolveDraft(draft, { raw: theirsSameLine, sha: 'sha-new' });
    expect(r).toEqual({ kind: 'conflict', text: mine, base: { raw: base, sha: 'sha-base' }, conflict: { sha: 'sha-new' } });
  });

  it('survives any number of keystrokes and reopens (the record is stored as resolveDraft says)', () => {
    const upstream = { raw: theirsSameLine, sha: 'sha-new' };
    let stored = { ...draft } as typeof draft & { conflict?: { sha?: string } };
    for (const typed of ['!', '!!', '!!!']) {
      const r = resolveDraft(stored, upstream);
      expect(r.kind).toBe('conflict');
      // What the writing screen stores after a keystroke: the new text on the resolution's base.
      stored = { isNew: false, raw: r.text.replace('(mine)', `(mine${typed})`), baseRaw: r.base.raw!, baseSha: r.base.sha!, conflict: r.conflict };
      // The sha a save would send is never the new upstream's.
      expect(stored.baseSha).toBe('sha-base');
      expect(draftBaseState(stored, upstream)).toBe('diverged');
    }
    expect(resolveDraft(stored, upstream).kind).toBe('conflict');
  });

  it('the source moves again: back to the base → no conflict; onto the draft → nothing to keep', () => {
    const conflicted = { ...draft, conflict: { sha: 'sha-new' } };
    expect(resolveDraft(conflicted, { raw: base, sha: 'sha-base' })).toEqual({ kind: 'current', text: mine, base: { raw: base, sha: 'sha-base' } });
    expect(resolveDraft(conflicted, { raw: mine, sha: 'sha-mine' }).kind).toBe('drop');
    expect(resolveDraft(conflicted, { raw: theirsElsewhere, sha: 'sha-3' }).kind).toBe('merged');
  });

  it('a new post has no upstream to conflict with', () => {
    expect(resolveDraft({ isNew: true, raw: 'x', baseRaw: null }, { raw: 'whatever' }).kind).toBe('current');
  });
});
