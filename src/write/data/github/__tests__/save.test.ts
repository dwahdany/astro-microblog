import { describe, expect, it } from 'vitest';
import { PostNotFoundError, ReadOnlyError, SaveConflictError, SaveError, type AuthState, type DraftRecord, type SaveRequest } from '../../../contracts';
import { imagePath, pendingAssetsFor, rewriteImageRefs } from '../../assets/names';
import { createPendingImages } from '../../assets/pending';
import { createMemoryCache } from '../../cache';
import { draftAfterSave } from '../../draft-sync';
import { frontmatter } from '../../frontmatter';
import { gitBlobSha } from '../../git-sha';
import { createGithubSource, type SourceAuth } from '../../github-source';
import type { CommitterOptions } from '../commit';
import { blobSha, fakeGithub } from './fake-github';

const enc = new TextEncoder();
const post = (slug: string, body = 'Body\n', created = '2026-03-01T10:00:00+00:00') => `---\nslug: ${slug}\ntitle: ${slug}\ncreated: ${created}\ntags: []\nis_draft: false\n---\n\n${body}`;
const A = 'src/content/notes/2026/a.md';
const B = 'src/content/notes/2026/b.md';
const png = (n: number, fill = 1) => new Blob([new Uint8Array(n).fill(fill)], { type: 'image/png' });
const bytes = (n: number, fill = 1) => new Uint8Array(n).fill(fill);

/** A session stand-in: signed in with token `t`, switchable. */
function fakeAuth() {
  const listeners = new Set<(s: AuthState) => void>();
  let state: AuthState = { status: 'signed-in', user: { login: 'dwahdany' }, method: 'app', verified: true };
  const auth: SourceAuth = {
    state: () => state,
    onChange: (l) => (listeners.add(l), () => void listeners.delete(l)),
    token: async () => (state.status === 'signed-in' ? 't' : undefined),
    renew: async () => undefined,
  };
  return {
    auth,
    set(next: AuthState) {
      state = next;
      listeners.forEach((l) => l(state));
    },
  };
}

function setup(options: { commit?: CommitterOptions; saveAttempts?: number } = {}) {
  const gh = fakeGithub();
  gh.state.tokens.add('t');
  gh.push(
    {
      [A]: post('a'),
      'src/content/notes/2026/a/one.png': bytes(10, 1),
      'src/content/notes/2026/a/two.jpg': bytes(20, 2),
      [B]: post('b', 'B body\n', '2026-02-01T10:00:00+00:00'),
      'src/content/portfolio/prices.json': '{"v":1}',
      'README.md': 'readme\n',
    },
    'seed',
  );
  const session = fakeAuth();
  const cache = createMemoryCache();
  const urls: string[] = [];
  const images = createPendingImages({ createObjectURL: (b) => (urls.push(`blob:test/${urls.length}:${b.size}`), urls.at(-1) as string), revokeObjectURL: () => {} });
  let now = 1_800_000_000_000;
  let t = 0;
  const source = createGithubSource(gh.repo, frontmatter, {
    fetch: gh.fetch,
    cache,
    auth: session.auth,
    images,
    now: () => now,
    commit: { clock: () => (t += 1000), ...options.commit },
    saveAttempts: options.saveAttempts,
  });
  /** The same app in another tab: its own memory, the same device storage and clock. */
  const otherTab = () => createGithubSource(gh.repo, frontmatter, { fetch: gh.fetch, cache, auth: session.auth, now: () => now });
  return { gh, source, session, cache, images, otherTab, advance: (ms: number) => (now += ms) };
}

const failure = <E>(p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as E);

describe('who may save', () => {
  it('canSave follows the sign-in state and onAuthChange fires when it flips', async () => {
    const { source, session } = setup();
    expect(source.canSave).toBe(true);
    let fired = 0;
    const stop = source.onAuthChange(() => (fired += 1));
    session.set({ status: 'signed-in', user: { login: 'dwahdany' }, method: 'app', verified: true, expiresAt: 5 }); // a token refresh: nothing flips
    expect(fired).toBe(0);
    session.set({ status: 'signed-out' });
    expect(source.canSave).toBe(false);
    expect(fired).toBe(1);
    session.set({ status: 'signing-in' });
    expect(fired).toBe(1);
    session.set({ status: 'signed-in', user: { login: 'dwahdany' }, method: 'token', verified: true });
    expect(source.canSave).toBe(true);
    expect(fired).toBe(2);
    stop();
    session.set({ status: 'signed-out' });
    expect(fired).toBe(2);
  });

  it('signed out: save rejects with ReadOnlyError and sends nothing', async () => {
    const { source, session, gh } = setup();
    session.set({ status: 'signed-out' });
    expect(await failure(source.save({ path: A, raw: 'x', baseSha: 'y' }))).toBeInstanceOf(ReadOnlyError);
    expect(gh.calls).toHaveLength(0);
  });

  it('a source without a session is read-only, as before', async () => {
    const gh = fakeGithub();
    gh.push({ [A]: post('a') });
    const source = createGithubSource(gh.repo, frontmatter, { fetch: gh.fetch, cache: createMemoryCache() });
    expect(source.canSave).toBe(false);
    expect(await failure(source.save({ path: A, raw: 'x' }))).toBeInstanceOf(ReadOnlyError);
  });
});

describe('reading while signed in', () => {
  it('sends the token on the listing and reads post text from raw (not rate limited)', async () => {
    const { source, gh } = setup();
    const refs = await source.list();
    expect(refs.map((r) => r.path)).toEqual([A, B]);
    const api = gh.calls.filter((c) => c.url.startsWith('https://api.github.com/'));
    expect(api.map((c) => [c.url.replace('https://api.github.com/repos/dwahdany/astro-microblog', ''), c.auth])).toEqual([['/git/trees/main:src/content?recursive=1', 'token t']]);
    expect(source.status().state).toBe('fresh');
    expect(source.imageNames(A).sort()).toEqual(['one.png', 'two.jpg']);
    expect(source.imageNames(B)).toEqual([]);
  });

  it('falls back to the anonymous listing when the token turns out to be dead', async () => {
    const { source, gh } = setup();
    gh.state.tokens.clear();
    const refs = await source.list();
    expect(refs).toHaveLength(2);
    const tree = gh.calls.filter((c) => c.url.includes('/git/trees/'));
    expect(tree.map((c) => c.auth)).toEqual(['token t', null]);
  });
});

describe('update', () => {
  it('commits exactly the text given, in ONE commit, on the head it looked at', async () => {
    const { source, gh } = setup();
    const loaded = await source.load(A);
    gh.reset();
    const raw = loaded.raw.replace('Body\n', 'Body, edited — “quotes” 🎉\n');
    const head = gh.head();
    const result = await source.save({ path: A, raw, baseSha: loaded.ref.sha });

    expect(gh.text(A)).toBe(raw);
    expect(result).toMatchObject({ path: A, sha: await gitBlobSha(raw), commitSha: gh.head(), commits: 1, via: 'graphql' });
    expect(result.commitUrl).toBe(`https://github.com/dwahdany/astro-microblog/commit/${gh.head()}`);
    const [made, before] = gh.log();
    expect(before.oid).toBe(head);
    expect(made.message).toBe('Update Note “2026/a”');
    expect(gh.mutations()).toHaveLength(1);
    expect(gh.mutations()[0].body.variables.input.expectedHeadOid).toBe(head);
    // head + tree + the mutation: three requests
    expect(gh.api()).toBe(3);
    // nothing else in the repo was touched
    expect(gh.text(B)).toBe(post('b', 'B body\n', '2026-02-01T10:00:00+00:00'));
    expect(gh.file('src/content/notes/2026/a/one.png')).toEqual(bytes(10, 1));
  });

  it('keeps a BOM, CRLF, a bare CR and a missing final newline byte for byte', async () => {
    const { source, gh } = setup();
    const loaded = await source.load(A);
    for (const raw of ['﻿---\r\nslug: a\r\n---\r\n\r\nline\r\n', '---\nslug: a\n---\n\nmixed\r\nold mac\rend', 'no frontmatter, no newline']) {
      const base = (await source.load(A)).ref.sha;
      await source.save({ path: A, raw, baseSha: base });
      expect(Buffer.from(gh.file(A) as Uint8Array).equals(Buffer.from(raw, 'utf8'))).toBe(true);
    }
    expect(loaded.raw).toBe(post('a'));
  });

  it('after the save the post reads clean: list() and load() answer from the cache, with the new sha, without a request', async () => {
    const { source, gh } = setup();
    await source.list();
    const loaded = await source.load(A);
    const raw = loaded.raw + 'More.\n';
    const result = await source.save({ path: A, raw, baseSha: loaded.ref.sha });
    gh.reset();

    const again = await source.load(A);
    expect(again.raw).toBe(raw);
    expect(again.ref.sha).toBe(result.sha);
    const refs = await source.list();
    expect(refs.find((r) => r.path === A)?.sha).toBe(result.sha);
    expect(gh.calls).toHaveLength(0);
    expect(source.status().state).toBe('fresh');

    // …and a forced refresh agrees with it, still without downloading the text again.
    const fresh = await source.list({ refresh: true });
    expect(fresh.find((r) => r.path === A)?.sha).toBe(result.sha);
    expect(gh.count((c) => c.url.startsWith('https://raw.githubusercontent.com/'))).toBe(0);
  });

  it('the committed text survives a reload of the page (it is in the persistent cache)', async () => {
    const { source, gh, cache } = setup();
    await source.list();
    const loaded = await source.load(A);
    const raw = loaded.raw + 'More.\n';
    const result = await source.save({ path: A, raw, baseSha: loaded.ref.sha });
    await source.idle();
    const reopened = createGithubSource(gh.repo, frontmatter, { fetch: gh.fetch, cache, now: () => 1_800_000_000_000 });
    gh.reset();
    expect((await reopened.list()).find((r) => r.path === A)?.sha).toBe(result.sha);
    expect((await reopened.load(A)).raw).toBe(raw);
    expect(gh.calls).toHaveLength(0);
  });

  it('conflict: the file changed upstream → SaveConflictError("changed") with the current sha, nothing written', async () => {
    const { source, gh } = setup();
    const loaded = await source.load(A);
    const theirs = post('a', 'Changed elsewhere\n');
    gh.push({ [A]: theirs }, 'Update Note “2026/a”');
    const head = gh.head();
    const err = await failure<SaveConflictError>(source.save({ path: A, raw: loaded.raw + 'mine\n', baseSha: loaded.ref.sha }));
    expect(err).toBeInstanceOf(SaveConflictError);
    expect(err).toMatchObject({ reason: 'changed', path: A, currentSha: blobSha(enc.encode(theirs)) });
    expect(gh.head()).toBe(head);
    expect(gh.mutations()).toHaveLength(0);
  });

  it('conflict: the file is gone → "missing"', async () => {
    const { source, gh } = setup();
    const loaded = await source.load(A);
    gh.push({ [A]: null });
    const err = await failure<SaveConflictError>(source.save({ path: A, raw: loaded.raw + 'x', baseSha: loaded.ref.sha }));
    expect(err).toMatchObject({ reason: 'missing', path: A });
  });

  it('after a conflict the post reads as the repo has it now — not as the listing from before the save remembers it', async () => {
    const { source, gh } = setup();
    await source.list();
    const loaded = await source.load(A);
    const theirs = post('a', 'Changed elsewhere\n');
    gh.push({ [A]: theirs }, 'Update Note “2026/a”');
    await failure(source.save({ path: A, raw: loaded.raw + 'mine\n', baseSha: loaded.ref.sha }));
    // The caller re-reads the post to show the conflict: it must get THEIR text and its sha.
    const again = await source.load(A);
    expect(again.raw).toBe(theirs);
    expect(again.ref.sha).toBe(blobSha(enc.encode(theirs)));

    // …and a post that turned out to be gone reads as gone.
    const b = await source.load(B);
    gh.push({ [B]: null });
    expect(await failure(source.save({ path: B, raw: b.raw + 'x', baseSha: b.ref.sha }))).toMatchObject({ reason: 'missing' });
    await expect(source.load(B)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('an unrelated commit landing first (the price bot) is not a conflict: the save goes on top of it', async () => {
    const { source, gh } = setup();
    const loaded = await source.load(A);
    const theirs = gh.push({ 'src/content/portfolio/prices.json': '{"v":2}' });
    const result = await source.save({ path: A, raw: loaded.raw + 'mine\n', baseSha: loaded.ref.sha });
    const [made, parent] = gh.log();
    expect(parent.oid).toBe(theirs);
    expect(made.oid).toBe(result.commitSha);
    expect(gh.text('src/content/portfolio/prices.json')).toBe('{"v":2}'); // their change is kept
    expect(gh.text(A)).toBe(loaded.raw + 'mine\n');
  });

  it('the branch moving BETWEEN the look and the commit: looks again and commits on the new head, never forcing', async () => {
    const { source, gh } = setup();
    const loaded = await source.load(A);
    gh.reset();
    let pushes = 0;
    gh.state.beforeCommit = () => {
      if (pushes++ === 0) gh.push({ 'src/content/portfolio/prices.json': '{"v":3}' });
    };
    const result = await source.save({ path: A, raw: loaded.raw + 'mine\n', baseSha: loaded.ref.sha });
    expect(gh.mutations()).toHaveLength(2); // refused once, then accepted
    expect(gh.log().map((c) => c.via).slice(0, 2)).toEqual(['graphql', 'push']);
    expect(gh.text('src/content/portfolio/prices.json')).toBe('{"v":3}');
    expect(gh.text(A)).toBe(loaded.raw + 'mine\n');
    expect(result.commits).toBe(1);
    expect(gh.calls.some((c) => JSON.stringify(c.body ?? '').includes('"force":true'))).toBe(false);
  });

  it('…but if it was THIS post that moved meanwhile, the second look finds the conflict', async () => {
    const { source, gh } = setup();
    const loaded = await source.load(A);
    let pushes = 0;
    gh.state.beforeCommit = () => {
      if (pushes++ === 0) gh.push({ [A]: post('a', 'theirs\n') });
    };
    const err = await failure<SaveConflictError>(source.save({ path: A, raw: loaded.raw + 'mine\n', baseSha: loaded.ref.sha }));
    expect(err).toMatchObject({ reason: 'changed' });
    expect(gh.text(A)).toBe(post('a', 'theirs\n'));
  });

  it('a branch that keeps moving gives up with a typed conflict ("branch-moved") after a few looks', async () => {
    const { source, gh } = setup({ saveAttempts: 3 });
    const loaded = await source.load(A);
    let n = 0;
    gh.state.beforeCommit = () => void gh.push({ 'src/content/portfolio/prices.json': `{"v":${++n}}` });
    const err = await failure<SaveConflictError>(source.save({ path: A, raw: loaded.raw + 'mine\n', baseSha: loaded.ref.sha }));
    expect(err).toBeInstanceOf(SaveConflictError);
    expect(err?.reason).toBe('branch-moved');
    expect(gh.mutations()).toHaveLength(3);
    expect(gh.text(A)).toBe(loaded.raw);
  });

  it('is idempotent: saving text the repo already has (a lost answer) commits nothing and succeeds', async () => {
    const { source, gh } = setup();
    const loaded = await source.load(A);
    const raw = loaded.raw + 'mine\n';
    await source.save({ path: A, raw, baseSha: loaded.ref.sha });
    const head = gh.head();
    const again = await source.save({ path: A, raw, baseSha: loaded.ref.sha }); // same request, stale base
    expect(again).toMatchObject({ path: A, sha: await gitBlobSha(raw), commits: 0 });
    expect(again.commitSha).toBeUndefined();
    expect(gh.head()).toBe(head);
  });
});

describe('another tab of the app', () => {
  it('shows what this tab published, not the text it remembers from before (which would read as the publish undone)', async () => {
    const { source, otherTab, gh, advance } = setup();
    const tabB = otherTab();
    await tabB.list();
    const before = await tabB.load(A);
    advance(5_000);
    const raw = before.raw + 'published from tab A\n';
    const result = await source.save({ path: A, raw, baseSha: before.ref.sha });
    await source.idle();
    gh.reset();
    const after = await tabB.load(A);
    expect(after.raw).toBe(raw);
    expect(after.ref.sha).toBe(result.sha);
    expect((await tabB.list()).find((r) => r.path === A)?.sha).toBe(result.sha);
    expect(gh.calls).toHaveLength(0); // from what tab A stored on this device: no request
  });

  it('does not bring back a post this tab deleted', async () => {
    const { source, otherTab, advance } = setup();
    const tabB = otherTab();
    await tabB.list();
    const loaded = await tabB.load(A);
    advance(5_000);
    await source.save({ path: A, raw: '', delete: true, baseSha: loaded.ref.sha });
    await source.idle();
    expect(await failure(tabB.load(A))).toBeInstanceOf(PostNotFoundError);
  });
});

describe('create', () => {
  const NEW = 'src/content/notes/2026/fresh.md';

  it('creates the post with Sveltia’s message, and the list shows it without a refetch', async () => {
    const { source, gh } = setup();
    await source.list();
    const raw = post('fresh', 'New\n', '2026-11-19T09:00:00+00:00');
    const result = await source.save({ path: NEW, raw });
    expect(gh.text(NEW)).toBe(raw);
    expect(gh.log()[0].message).toBe('Create Note “2026/fresh”');
    expect(result.sha).toBe(await gitBlobSha(raw));
    gh.reset();
    const refs = await source.list();
    expect(refs[0]).toMatchObject({ path: NEW, slug: 'fresh', sha: result.sha, isNew: false });
    expect((await source.load(NEW)).raw).toBe(raw);
    expect(gh.calls).toHaveLength(0);
  });

  it('a taken path is a conflict ("exists") — an existing post is never overwritten by a new one', async () => {
    const { source, gh } = setup();
    const err = await failure<SaveConflictError>(source.save({ path: A, raw: post('a', 'other\n') }));
    expect(err).toMatchObject({ reason: 'exists', path: A });
    expect(gh.text(A)).toBe(post('a'));
    expect(gh.mutations()).toHaveLength(0);
  });

  it('with pending images: one commit, images at <dir>/<stem>/<name>, message +N', async () => {
    const { source, gh, images } = setup();
    const raw = post('fresh', '![x](fresh/pic.png)\n\n![y](fresh/shot-1.png)\n');
    const assets = pendingAssetsFor(NEW, [
      { name: 'pic.png', data: png(300, 5), type: 'image/png', size: 300, stripped: true, addedAt: 1 },
      { name: 'shot-1.png', data: png(400, 6), type: 'image/png', size: 400, stripped: true, addedAt: 2 },
    ]);
    expect(assets.map((a) => a.path)).toEqual(['src/content/notes/2026/fresh/pic.png', 'src/content/notes/2026/fresh/shot-1.png']);
    const result = await source.save({ path: NEW, raw, assets });

    expect(gh.mutations()).toHaveLength(1);
    expect(gh.log()[0].message).toBe('Create Note “2026/fresh” +2');
    expect(gh.file('src/content/notes/2026/fresh/pic.png')).toEqual(bytes(300, 5));
    expect(gh.file('src/content/notes/2026/fresh/shot-1.png')).toEqual(bytes(400, 6));
    expect(result.assets).toEqual([
      { path: 'src/content/notes/2026/fresh/pic.png', sha: blobSha(bytes(300, 5)) },
      { path: 'src/content/notes/2026/fresh/shot-1.png', sha: blobSha(bytes(400, 6)) },
    ]);
    // images first, the post last in the mutation
    expect(gh.mutations()[0].body.variables.input.fileChanges.additions.map((a: { path: string }) => a.path).at(-1)).toBe(NEW);
    // just committed: shown from memory, because raw.githubusercontent.com lags
    expect(source.resolveAssetUrl(NEW, 'fresh/pic.png')).toMatch(/^blob:test\//);
    expect(images.url('src/content/notes/2026/fresh/pic.png')).toMatch(/^blob:/);
    expect(source.imageNames(NEW).sort()).toEqual(['pic.png', 'shot-1.png']);
  });

  it('large images split the save into several commits, the post last; a retry after a failure re-uses what landed', async () => {
    const { source, gh } = setup({ commit: { initialPayloadSize: 1500 } });
    const raw = post('fresh', '![x](fresh/a.png) ![y](fresh/b.png)\n');
    const assets = [
      { path: imagePath(NEW, 'a.png'), data: png(1000, 1) },
      { path: imagePath(NEW, 'b.png'), data: png(1000, 2) },
    ];
    // The commit carrying the post fails after the first image commit has landed.
    let n = 0;
    gh.state.beforeCommit = () => {
      if (++n === 1) gh.state.failGraphql.push(500);
    };
    const err = await failure<SaveError>(source.save({ path: NEW, raw, assets }));
    expect(err).toBeInstanceOf(SaveError);
    expect(err?.partial).toBe(true);
    expect(err?.message).toContain('publishing again');
    expect(gh.file(NEW)).toBeUndefined(); // the post is NOT live without its images
    expect(gh.file(imagePath(NEW, 'a.png'))).toBeDefined();

    gh.state.beforeCommit = undefined;
    gh.reset();
    const result = await source.save({ path: NEW, raw, assets });
    const added = gh.mutations().flatMap((m) => m.body.variables.input.fileChanges.additions.map((a: { path: string }) => a.path));
    expect(added).not.toContain(imagePath(NEW, 'a.png')); // already in the repo: not sent again
    expect(added).toContain(NEW);
    expect(gh.text(NEW)).toBe(raw);
    expect(gh.file(imagePath(NEW, 'b.png'))).toEqual(bytes(1000, 2));
    // BOTH images are accounted for by this save — also the one an earlier attempt had already
    // committed — so the caller can drop both from the draft.
    expect(result.assets?.map((a) => a.path).sort()).toEqual([imagePath(NEW, 'a.png'), imagePath(NEW, 'b.png')]);
    const pending = (name: string, fill: number) => ({ name, type: 'image/png', size: 1000, addedAt: 1, stripped: true, data: png(1000, fill) });
    const draft: DraftRecord = { id: 'new:1', path: NEW, collection: 'notes', isNew: true, raw, baseRaw: null, updatedAt: 1, assets: [pending('a.png', 1), pending('b.png', 2)] };
    expect(draftAfterSave(draft, { raw, result })).toBeNull();
  });

  it('publishing again what is already there (a reload before the draft was dropped) still reports the images as carried', async () => {
    const { source } = setup();
    const raw = post('fresh', '![x](fresh/a.png)\n');
    const assets = [{ path: imagePath(NEW, 'a.png'), data: png(10, 1) }];
    await source.save({ path: NEW, raw, assets });
    const again = await source.save({ path: NEW, raw, assets });
    expect(again.commits).toBe(0);
    expect(again.assets).toEqual([{ path: imagePath(NEW, 'a.png'), sha: blobSha(bytes(10, 1)) }]);
    const draft: DraftRecord = { id: 'new:1', path: NEW, collection: 'notes', isNew: true, raw, baseRaw: null, updatedAt: 1, assets: [{ name: 'a.png', type: 'image/png', size: 10, addedAt: 1, stripped: true, data: png(10, 1) }] };
    expect(draftAfterSave(draft, { raw, result: again })).toBeNull();
  });

  it('an image may only go directly into the post’s own image folder, as an image file', async () => {
    const { source, gh } = setup();
    gh.reset();
    for (const path of [
      'src/content/config.ts',
      'src/content/notes/2026/a/stolen.png', // another post's folder
      'src/content/notes/2026/fresh/deep/er.png',
      'src/content/notes/2026/fresh/script.svg',
      'src/content/notes/2026/fresh/noextension',
    ]) {
      const err = await failure<SaveError>(source.save({ path: NEW, raw: post('fresh'), assets: [{ path, data: png(1) }] }));
      expect(err, path).toBeInstanceOf(SaveError);
      expect(err?.reason, path).toBe('invalid');
    }
    expect(gh.mutations()).toHaveLength(0);
  });

  it('text with half an emoji (a lone surrogate) is refused: the repo would get U+FFFD where the screen shows something else', async () => {
    const { source, gh } = setup();
    const loaded = await source.load(A);
    gh.reset();
    const err = await failure<SaveError>(source.save({ path: A, raw: loaded.raw + 'bad \uD83D end\n', baseSha: loaded.ref.sha }));
    expect(err).toBeInstanceOf(SaveError);
    expect(err?.reason).toBe('invalid');
    expect(err?.message).toContain('broken character');
    expect(gh.mutations()).toHaveLength(0);
    // a real U+FFFD, a BOM and whole emoji are fine
    const fine = '\uFEFF' + loaded.raw + 'ok \uFFFD \u{1F600}\n';
    await source.save({ path: A, raw: fine, baseSha: loaded.ref.sha });
    expect(gh.text(A)).toBe(fine);
  });

  it('an image whose path already holds OTHER bytes is a conflict, not an overwrite', async () => {
    const { source, gh } = setup();
    const loaded = await source.load(A);
    const err = await failure<SaveConflictError>(source.save({ path: A, raw: loaded.raw + 'x', baseSha: loaded.ref.sha, assets: [{ path: imagePath(A, 'one.png'), data: png(10, 9) }] }));
    expect(err).toMatchObject({ reason: 'exists', path: 'src/content/notes/2026/a/one.png' });
    expect(gh.file('src/content/notes/2026/a/one.png')).toEqual(bytes(10, 1));
  });

  it('refuses paths outside src/content before anything is sent', async () => {
    const { source, gh } = setup();
    gh.reset();
    for (const req of [
      { path: 'README.md', raw: 'x' },
      { path: 'src/content/notes/../../../README.md', raw: 'x' },
      { path: 'src/content/notes/2026/x.txt', raw: 'x' },
      { path: 'src/content/nowhere/2026/x.md', raw: 'x' },
      { path: NEW, raw: 'x', assets: [{ path: 'public/evil.png', data: png(1) }] },
      { path: NEW, raw: 'x', assets: [{ path: 'src/content/notes/2026/b.md', data: png(1) }] },
    ] satisfies SaveRequest[]) {
      const err = await failure<SaveError>(source.save(req));
      expect(err, req.path).toBeInstanceOf(SaveError);
      expect(err?.reason).toBe('invalid');
    }
    expect(gh.mutations()).toHaveLength(0);
  });
});

describe('rename (a slug change moves the post and its image folder)', () => {
  const C = 'src/content/notes/2026/c.md';

  it('moves the post and every file of its folder in one commit; references rewritten by the caller land as given', async () => {
    const { source, gh } = setup();
    await source.list();
    const loaded = await source.load(A);
    const edited = loaded.raw.replace('slug: a', 'slug: c').replace('Body\n', '![1](a/one.png) and ![2](./a/two.jpg)\n');
    const raw = rewriteImageRefs(edited, A, C, source.imageNames(A));
    expect(raw).toContain('![1](c/one.png) and ![2](./c/two.jpg)');
    const result = await source.save({ path: C, previousPath: A, raw, baseSha: loaded.ref.sha });

    expect(gh.mutations()).toHaveLength(1);
    expect(gh.paths().filter((p) => p.startsWith('src/content/notes/'))).toEqual([
      B,
      C,
      'src/content/notes/2026/c/one.png',
      'src/content/notes/2026/c/two.jpg',
    ]);
    expect(gh.text(C)).toBe(raw);
    expect(gh.file('src/content/notes/2026/c/one.png')).toEqual(bytes(10, 1));
    expect(gh.file('src/content/notes/2026/c/two.jpg')).toEqual(bytes(20, 2));
    expect(gh.log()[0].message).toBe('Update Note “2026/c” +2');
    expect(result.removed?.sort()).toEqual([A, 'src/content/notes/2026/a/one.png', 'src/content/notes/2026/a/two.jpg']);
    expect(result.path).toBe(C);

    // the caches moved too
    gh.reset();
    const refs = await source.list();
    expect(refs.map((r) => r.path)).toEqual([C, B]);
    expect((await source.load(C)).raw).toBe(raw);
    expect(source.imageNames(C).sort()).toEqual(['one.png', 'two.jpg']);
    expect(source.imageNames(A)).toEqual([]);
    expect(gh.calls).toHaveLength(0);
    await expect(source.load(A)).rejects.toThrow(/No post/);
  });

  it('with new images in the same save', async () => {
    const { source, gh } = setup();
    const loaded = await source.load(A);
    const raw = loaded.raw.replace('slug: a', 'slug: c') + '![n](c/new.png)\n';
    await source.save({ path: C, previousPath: A, raw, baseSha: loaded.ref.sha, assets: [{ path: imagePath(C, 'new.png'), data: png(7, 7) }] });
    expect(gh.mutations()).toHaveLength(1);
    expect(gh.file('src/content/notes/2026/c/new.png')).toEqual(bytes(7, 7));
    expect(gh.log()[0].message).toBe('Update Note “2026/c” +3');
  });

  it('a taken target is a conflict; so is an old address that changed', async () => {
    const { source, gh } = setup();
    const loaded = await source.load(A);
    expect(await failure(source.save({ path: B, previousPath: A, raw: loaded.raw, baseSha: loaded.ref.sha }))).toMatchObject({ reason: 'exists', path: B });
    gh.push({ [A]: post('a', 'theirs\n') });
    expect(await failure(source.save({ path: C, previousPath: A, raw: loaded.raw, baseSha: loaded.ref.sha }))).toMatchObject({ reason: 'changed', path: A });
    expect(gh.file(C)).toBeUndefined();
  });

  it('works through the REST fallback too (GraphQL refused for the token)', async () => {
    const { source, gh } = setup();
    gh.state.graphqlForbidden = true;
    const loaded = await source.load(A);
    const raw = loaded.raw.replace('slug: a', 'slug: c');
    const result = await source.save({ path: C, previousPath: A, raw, baseSha: loaded.ref.sha, assets: [{ path: imagePath(C, 'new.png'), data: png(7, 7) }] });
    expect(result.via).toBe('rest');
    expect(result.commits).toBe(1);
    expect(gh.log()[0].via).toBe('rest');
    expect(gh.paths().filter((p) => p.startsWith('src/content/notes/2026/c'))).toEqual([C, 'src/content/notes/2026/c/new.png', 'src/content/notes/2026/c/one.png', 'src/content/notes/2026/c/two.jpg']);
    expect(gh.file(A)).toBeUndefined();
    expect(gh.text('README.md')).toBe('readme\n');
  });
});

describe('delete', () => {
  it('removes the post and its image folder in one commit', async () => {
    const { source, gh } = setup();
    await source.list();
    const loaded = await source.load(A);
    const result = await source.save({ path: A, raw: '', delete: true, baseSha: loaded.ref.sha });
    expect(result).toMatchObject({ path: A, sha: '', deleted: true, commits: 1 });
    expect(result.removed?.sort()).toEqual([A, 'src/content/notes/2026/a/one.png', 'src/content/notes/2026/a/two.jpg']);
    expect(gh.paths().filter((p) => p.startsWith('src/content/notes/'))).toEqual([B]);
    expect(gh.log()[0].message).toBe('Delete Note “2026/a” +2');
    gh.reset();
    expect((await source.list()).map((r) => r.path)).toEqual([B]);
    expect(gh.calls).toHaveLength(0);
  });

  it('keepImages leaves the folder', async () => {
    const { source, gh } = setup();
    const loaded = await source.load(A);
    await source.save({ path: A, raw: '', delete: true, keepImages: true, baseSha: loaded.ref.sha });
    expect(gh.file(A)).toBeUndefined();
    expect(gh.file('src/content/notes/2026/a/one.png')).toBeDefined();
    expect(gh.log()[0].message).toBe('Delete Note “2026/a”');
  });

  it('will not delete a post that changed since it was read, or one that is already gone', async () => {
    const { source, gh } = setup();
    const loaded = await source.load(A);
    gh.push({ [A]: post('a', 'theirs\n') });
    expect(await failure(source.save({ path: A, raw: '', delete: true, baseSha: loaded.ref.sha }))).toMatchObject({ reason: 'changed' });
    expect(gh.file(A)).toBeDefined();
    gh.push({ [A]: null });
    expect(await failure(source.save({ path: A, raw: '', delete: true, baseSha: loaded.ref.sha }))).toMatchObject({ reason: 'missing' });
  });

  it('a delete that landed but whose answer was lost (502, then the retry is refused) is reported as deleted, not as a conflict', async () => {
    const { source, gh } = setup();
    await source.list();
    const loaded = await source.load(A);
    gh.state.loseCommitAnswer.push(502);
    const result = await source.save({ path: A, raw: '', delete: true, baseSha: loaded.ref.sha });
    expect(result).toMatchObject({ path: A, deleted: true, commits: 0 });
    expect(result.removed).toContain(A);
    expect(gh.file(A)).toBeUndefined();
    expect(gh.paths().filter((p) => p.startsWith('src/content/notes/2026/a/'))).toEqual([]);
    expect(gh.log().filter((c) => c.via === 'graphql')).toHaveLength(1);
    expect((await source.list()).map((r) => r.path)).toEqual([B]);
  });
});

describe('failures are typed and showable', () => {
  it('GraphQL refused → REST is tried; refused there too → SaveError("forbidden"), nothing written', async () => {
    const { source, gh } = setup();
    gh.state.graphqlForbidden = true;
    gh.state.restForbidden = true;
    const loaded = await source.load(A);
    const err = await failure<SaveError>(source.save({ path: A, raw: loaded.raw + 'x', baseSha: loaded.ref.sha }));
    expect(err).toBeInstanceOf(SaveError);
    expect(err?.reason).toBe('forbidden');
    expect(err?.partial).toBe(false);
    expect(err?.message).toContain('dwahdany/astro-microblog');
    expect(gh.text(A)).toBe(loaded.raw);
  });

  it('offline → SaveError("offline")', async () => {
    const { source, gh } = setup();
    const loaded = await source.load(A);
    gh.state.offline = true;
    expect((await failure<SaveError>(source.save({ path: A, raw: loaded.raw + 'x', baseSha: loaded.ref.sha })))?.reason).toBe('offline');
  });

  it('a dead token → SaveError("signed-out")', async () => {
    const { source, gh } = setup();
    const loaded = await source.load(A);
    gh.state.tokens.clear();
    expect((await failure<SaveError>(source.save({ path: A, raw: loaded.raw + 'x', baseSha: loaded.ref.sha })))?.reason).toBe('signed-out');
  });

  it('an explicit message is used as given', async () => {
    const { source, gh } = setup();
    const loaded = await source.load(A);
    await source.save({ path: A, raw: loaded.raw + 'x', baseSha: loaded.ref.sha, message: 'Fix typo' });
    expect(gh.log()[0].message).toBe('Fix typo');
  });

  it('reports the progress of a split save', async () => {
    const { source } = setup({ commit: { initialPayloadSize: 1500 } });
    const seen: [number, number][] = [];
    const stop = source.onSaveProgress((d, t) => seen.push([d, t]));
    const NEW = 'src/content/notes/2026/fresh.md';
    await source.save({ path: NEW, raw: post('fresh'), assets: [{ path: imagePath(NEW, 'a.png'), data: png(1400, 1) }] });
    stop();
    expect(seen[0][0]).toBe(0);
    expect(seen.at(-1)).toEqual([2, 2]);
  });
});
