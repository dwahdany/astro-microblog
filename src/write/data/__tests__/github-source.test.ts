import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { PostNotFoundError, ReadOnlyError, REPO } from '../../contracts';
import { createMemoryCache } from '../cache';
import { SourceUnavailableError } from '../errors';
import { frontmatter } from '../frontmatter';
import { decodeUtf8, gitBlobSha } from '../git-sha';
import { createGithubSource } from '../github-source';
import { allFiles, posts } from './content';
import { buildManifest, gitBlobSha as nodeBlobSha } from '../../build/manifest.mjs';

const enc = new TextEncoder();
const body = (bytes: Uint8Array) => bytes as unknown as BodyInit;
const RAW = `https://raw.githubusercontent.com/${REPO.owner}/${REPO.name}/${REPO.branch}/`;
const TREE = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/git/trees/${REPO.branch}:src/content?recursive=1`;
const BLOBS = `https://api.github.com/repos/${REPO.owner}/${REPO.name}/git/blobs/`;

const post = (slug: string, created: string, body = 'Body\n') => `---\nslug: ${slug}\ntitle: ${slug}\ncreated: ${created}\ntags: []\nis_draft: false\n---\n\n${body}`;

/** A pretend GitHub: the "repo" is a map of repo path → bytes; every request is recorded. */
function fakeGithub(initial: Record<string, string | Uint8Array>) {
  const repo = new Map<string, Uint8Array>();
  /** What raw.githubusercontent.com serves when its CDN lags behind the repo. */
  const cdnOverride = new Map<string, Uint8Array | null>();
  const calls: { url: string; init?: RequestInit }[] = [];
  const state = { offline: false, rateLimited: false, rawStatus: 0 as number, blobApiDown: false, resetAt: 1_800_000_000 };
  const put = (path: string, content: string | Uint8Array) => repo.set(path, typeof content === 'string' ? enc.encode(content) : content);
  for (const [path, content] of Object.entries(initial)) put(path, content);

  const limitHeaders = (remaining: number) => ({
    'x-ratelimit-limit': '60',
    'x-ratelimit-remaining': String(remaining),
    'x-ratelimit-reset': String(state.resetAt),
  });

  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (state.offline) throw new TypeError('Failed to fetch');

    if (url.startsWith('https://api.github.com/')) {
      if (state.rateLimited)
        return new Response(JSON.stringify({ message: 'API rate limit exceeded' }), { status: 403, headers: limitHeaders(0) });
      if (url === TREE) {
        const tree = [];
        for (const [path, bytes] of repo) {
          if (!path.startsWith('src/content/')) continue;
          tree.push({ path: path.slice('src/content/'.length), type: 'blob', mode: '100644', sha: await gitBlobSha(bytes), size: bytes.byteLength });
        }
        tree.push({ path: 'notes', type: 'tree', mode: '040000', sha: 'f'.repeat(40) });
        return new Response(JSON.stringify({ sha: 'tree', tree, truncated: false }), { status: 200, headers: limitHeaders(57) });
      }
      if (url.startsWith(BLOBS)) {
        if (state.blobApiDown) return new Response('nope', { status: 500 });
        const sha = url.slice(BLOBS.length);
        for (const bytes of repo.values()) if ((await gitBlobSha(bytes)) === sha) return new Response(body(bytes), { status: 200, headers: limitHeaders(56) });
        return new Response('Not Found', { status: 404 });
      }
      return new Response('Not Found', { status: 404 });
    }

    if (url.startsWith(RAW)) {
      if (state.rawStatus) return new Response('error', { status: state.rawStatus });
      const path = decodeURIComponent(url.slice(RAW.length));
      const bytes = cdnOverride.has(path) ? cdnOverride.get(path) : repo.get(path);
      return bytes ? new Response(body(bytes), { status: 200 }) : new Response('404: Not Found', { status: 404 });
    }
    throw new Error(`unexpected request ${url}`);
  };

  const count = (prefix: string) => calls.filter((c) => c.url.startsWith(prefix)).length;
  return {
    fetch: fetchFn,
    repo,
    put,
    cdnOverride,
    state,
    calls,
    api: () => count('https://api.github.com/'),
    raw: () => count(RAW),
    reset: () => void (calls.length = 0),
  };
}

const A = 'src/content/notes/2026/a.md';
const B = 'src/content/entries/2025/b.md';
const C = 'src/content/blogmarks/2026/c.md';
const baseRepo = () => ({
  [A]: post('a', '2026-03-01T10:00:00+00:00'),
  [B]: post('b', '2025-05-01T10:00:00+00:00'),
  [C]: post('c', '2026-08-01T10:00:00+00:00'),
  'src/content/portfolio/_README.md': '# not a post\n',
  'src/content/notes/2026/a/pic.png': new Uint8Array([137, 80, 78, 71]),
});

function setup(initial: Record<string, string | Uint8Array> = baseRepo()) {
  const gh = fakeGithub(initial);
  const cache = createMemoryCache();
  let time = 1_000_000;
  const clock = { advance: (ms: number) => (time += ms) };
  const make = () => createGithubSource(REPO, frontmatter, { fetch: gh.fetch, cache, now: () => time });
  return { gh, cache, clock, make, source: make() };
}

describe('gitBlobSha', () => {
  it('matches `git hash-object` for real files', async () => {
    for (const [path, raw] of allFiles.slice(0, 12)) {
      const expected = execFileSync('git', ['hash-object', '--no-filters', path], { encoding: 'utf8' }).trim();
      expect(await gitBlobSha(raw), path).toBe(expected);
    }
    expect(await gitBlobSha('')).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391');
  });

  it('decodeUtf8 keeps a byte-order mark', () => {
    expect(decodeUtf8(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]))).toBe('﻿a');
  });
});

describe('github source: listing and caching', () => {
  it('cold: one API call for the tree, one raw request per post; newest first; only posts', async () => {
    const { gh, source } = setup();
    const refs = await source.list();
    expect(refs.map((r) => r.path)).toEqual([C, A, B]);
    expect(gh.api()).toBe(1);
    expect(gh.raw()).toBe(3);
    expect(gh.calls[0].url).toBe(TREE);
    for (const ref of refs) expect(ref.sha).toBe(await gitBlobSha(gh.repo.get(ref.path)!));
    expect(source.status()).toMatchObject({ state: 'fresh', rateLimit: { limit: 60, remaining: 57 } });
    expect(source.kind).toBe('github');
    expect(source.label).toBe('dwahdany/astro-microblog@main');
  });

  it('the same session never asks twice; callers get their own array', async () => {
    const { gh, source } = setup();
    const first = await source.list();
    first.length = 0;
    gh.reset();
    expect((await source.list()).length).toBe(3);
    expect(gh.calls.length).toBe(0);
  });

  it('a reload within a minute costs no request at all', async () => {
    const { gh, make, source, clock } = setup();
    await source.list();
    await source.idle();
    gh.reset();
    clock.advance(30_000);
    const again = make();
    expect((await again.list()).map((r) => r.path)).toEqual([C, A, B]);
    expect(gh.calls.length).toBe(0);
  });

  it('a later visit asks for the tree only: every text comes from the sha-keyed cache', async () => {
    const { gh, make, source, clock } = setup();
    await source.list();
    await source.idle();
    gh.reset();
    clock.advance(10 * 60_000);
    expect((await make().list()).length).toBe(3);
    expect(gh.api()).toBe(1);
    expect(gh.raw()).toBe(0);
  });

  it('after a push only the changed file is fetched, and the superseded text is dropped from the cache', async () => {
    const { gh, make, source, clock, cache } = setup();
    await source.list();
    await source.idle();
    const oldSha = await gitBlobSha(gh.repo.get(A)!);
    gh.put(A, post('a', '2026-03-01T10:00:00+00:00', 'Edited upstream\n'));
    gh.put('src/content/notes/2026/d.md', post('d', '2026-09-09T09:09:00+00:00'));
    gh.reset();
    clock.advance(10 * 60_000);
    const next = make();
    const refs = await next.list();
    await next.idle();
    expect(refs.map((r) => r.slug)).toEqual(['d', 'c', 'a', 'b']);
    expect(gh.api()).toBe(1);
    expect(gh.raw()).toBe(2);
    expect((await next.load(A)).raw).toContain('Edited upstream');
    expect(cache.map.has('blob:' + oldSha)).toBe(false);
    expect([...cache.map.keys()].filter((k) => k.startsWith('blob:')).length).toBe(4);
  });

  it('refresh re-reads the tree, bypassing the HTTP cache', async () => {
    const { gh, source } = setup();
    await source.list();
    gh.reset();
    gh.put(B, post('b', '2025-05-01T10:00:00+00:00', 'New\n'));
    const refs = await source.list({ refresh: true });
    expect(gh.api()).toBe(1);
    expect(gh.raw()).toBe(1);
    expect(gh.calls[0].init?.cache).toBe('no-cache');
    expect(refs.find((r) => r.path === B)!.excerpt).toBe('New');
  });

  it('with the real content: lists every published post from a simulated repo', async () => {
    const { gh, source } = setup(Object.fromEntries(allFiles));
    const refs = await source.list();
    expect(refs.length).toBe(posts.length);
    expect(gh.api()).toBe(1);
    expect(gh.raw()).toBe(posts.length);
    for (const [path, raw] of posts) expect((await source.load(path)).raw, path).toBe(raw);
    expect(gh.raw()).toBe(posts.length); // loads were served from the session cache
    for (let i = 1; i < refs.length; i++) expect(refs[i - 1].createdMs!).toBeGreaterThanOrEqual(refs[i].createdMs!);
  });
});

describe('github source: exact bytes', () => {
  it('load returns the bytes of the file, including BOM and CRLF', async () => {
    const weird = '﻿---\r\nslug: w\r\ncreated: 2026-01-01\r\n---\r\n\r\nBödy — 😀\r\nno final newline';
    const { source } = setup({ ...baseRepo(), 'src/content/notes/2026/w.md': weird });
    const loaded = await source.load('src/content/notes/2026/w.md');
    expect(loaded.raw).toBe(weird);
    expect(loaded.parts.bom).toBe('﻿');
    expect(loaded.eol).toBe('crlf');
    expect(loaded.ref.sha).toBe(await gitBlobSha(weird));
    const viaList = (await source.list()).find((r) => r.slug === 'w')!;
    expect(viaList.sha).toBe(loaded.ref.sha);
  });

  it('a deep link loads one post without touching the API', async () => {
    const { gh, source } = setup();
    const loaded = await source.load(A);
    expect(loaded.raw).toBe(decodeUtf8(gh.repo.get(A)!));
    expect(loaded.ref).toMatchObject({ path: A, slug: 'a', sha: await gitBlobSha(gh.repo.get(A)!) });
    expect(gh.api()).toBe(0);
    expect(gh.raw()).toBe(1);
  });

  it('after list(), load() is answered from memory', async () => {
    const { gh, source } = setup();
    await source.list();
    gh.reset();
    await source.load(A);
    await source.load(B);
    expect(gh.calls.length).toBe(0);
  });

  it('when raw.githubusercontent.com lags behind the tree, the exact blob is fetched by sha', async () => {
    const { gh, source, cache } = setup();
    const stale = enc.encode(post('a', '2026-03-01T10:00:00+00:00', 'OLD revision\n'));
    gh.cdnOverride.set(A, stale);
    const refs = await source.list();
    await source.idle();
    const a = refs.find((r) => r.path === A)!;
    const trueSha = await gitBlobSha(gh.repo.get(A)!);
    expect(a.sha).toBe(trueSha);
    expect((await source.load(A)).raw).toBe(decodeUtf8(gh.repo.get(A)!));
    expect(gh.api()).toBe(2); // tree + one blob
    expect(cache.map.get('blob:' + trueSha)).toBe(decodeUtf8(gh.repo.get(A)!));
  });

  it('a file the CDN does not have yet (404) is fetched by sha too', async () => {
    const { gh, source } = setup();
    gh.cdnOverride.set(C, null);
    const refs = await source.list();
    expect(refs.map((r) => r.path)).toEqual([C, A, B]);
    expect(gh.api()).toBe(2);
  });

  it('if the exact blob cannot be had, the stale text is labelled with ITS sha and never cached under the new one', async () => {
    const { gh, source, cache } = setup();
    const stale = post('a', '2026-03-01T10:00:00+00:00', 'OLD revision\n');
    gh.cdnOverride.set(A, enc.encode(stale));
    gh.state.blobApiDown = true;
    const refs = await source.list();
    await source.idle();
    const a = refs.find((r) => r.path === A)!;
    expect(a.sha).toBe(await gitBlobSha(stale));
    expect(a.excerpt).toBe('OLD revision');
    expect(cache.map.has('blob:' + (await gitBlobSha(gh.repo.get(A)!)))).toBe(false);
    expect(cache.map.get('blob:' + a.sha)).toBe(stale);
  });
});

describe('github source: offline and rate limits', () => {
  it('offline with a cache: serves the saved copy and says so', async () => {
    const { gh, make, source, clock } = setup();
    await source.list();
    await source.idle();
    clock.advance(10 * 60_000);
    gh.state.offline = true;
    const later = make();
    const seen: string[] = [];
    later.onStatus((s) => seen.push(s.state));
    const refs = await later.list();
    expect(refs.map((r) => r.path)).toEqual([C, A, B]);
    expect(later.status()).toMatchObject({ state: 'stale', reason: 'offline', fetchedAt: 1_000_000 });
    expect(later.status().message).toMatch(/offline.*Showing the copy saved at/);
    expect(seen).toEqual(['stale']);
    expect((await later.load(B)).ref.slug).toBe('b');
  });

  it('offline without a cache: a typed error with a message for the owner', async () => {
    const { gh, source } = setup();
    gh.state.offline = true;
    const err = await source.list().catch((e) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect(err).toMatchObject({ code: 'UNAVAILABLE', reason: 'offline' });
    expect(err.message).toMatch(/offline/);
    // The failure is not cached: once back online it works.
    gh.state.offline = false;
    expect((await source.list()).length).toBe(3);
  });

  it('rate-limited with a cache: stale list plus the time to retry', async () => {
    const { gh, make, source, clock } = setup();
    await source.list();
    await source.idle();
    clock.advance(10 * 60_000);
    gh.state.rateLimited = true;
    const later = make();
    expect((await later.list()).length).toBe(3);
    expect(later.status()).toMatchObject({ state: 'stale', reason: 'rate-limited', retryAt: gh.state.resetAt * 1000, rateLimit: { remaining: 0 } });
  });

  it('rate-limited without a cache: error carries reason, status and retry time', async () => {
    const { gh, source } = setup();
    gh.state.rateLimited = true;
    const err = await source.list().catch((e) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect(err).toMatchObject({ reason: 'rate-limited', status: 403, retryAt: gh.state.resetAt * 1000 });
    expect(err.message).toMatch(/limiting anonymous requests/);
    // Posts can still be opened by path: raw content is not rate-limited.
    expect((await source.load(A)).ref.slug).toBe('a');
  });

  it('load offline: from an earlier session when cached, a typed error when not', async () => {
    const { gh, make, source, clock } = setup();
    await source.list();
    await source.idle();
    clock.advance(10 * 60_000);
    gh.state.offline = true;
    const later = make();
    expect((await later.load(A)).raw).toBe(decodeUtf8(gh.repo.get(A)!));
    expect(later.status().state).toBe('stale');

    const fresh = setup();
    fresh.gh.state.offline = true;
    const err = await fresh.source.load(A).catch((e) => e);
    expect(err).toBeInstanceOf(SourceUnavailableError);
    expect(err.message).toMatch(/not cached on this device/);
  });

  it('some files failing: the rest is listed and the status reports the gap', async () => {
    const { gh, source } = setup();
    const real = gh.fetch;
    const flaky: typeof fetch = (input, init) => (String(input).endsWith('/b.md') ? Promise.resolve(new Response('boom', { status: 502 })) : real(input, init));
    const partial = createGithubSource(REPO, frontmatter, { fetch: flaky, cache: createMemoryCache(), now: () => 1 });
    const refs = await partial.list();
    expect(refs.map((r) => r.path)).toEqual([C, A]);
    expect(partial.status()).toMatchObject({ state: 'stale', reason: 'http' });
    expect(partial.status().message).toMatch(/1 of 3 posts could not be loaded/);
    void source;
  });

  it('a non-JSON answer for the tree (captive portal) is treated as unreachable', async () => {
    const portal: typeof fetch = async () => new Response('<html>Sign in to WiFi</html>', { status: 200 });
    const source = createGithubSource(REPO, frontmatter, { fetch: portal, cache: createMemoryCache() });
    await expect(source.list()).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  it('abort propagates as AbortError and is not cached', async () => {
    const { source } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(source.list({ signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect((await source.list()).length).toBe(3);
  });
});

describe('github source: not found, assets, save', () => {
  it('rejects with PostNotFoundError for absent or non-post paths', async () => {
    const { gh, source } = setup();
    await expect(source.load('src/content/notes/2026/nope.md')).rejects.toBeInstanceOf(PostNotFoundError);
    await expect(source.load('src/content/notes/2026/a/pic.png')).rejects.toBeInstanceOf(PostNotFoundError);
    await expect(source.load('package.json')).rejects.toBeInstanceOf(PostNotFoundError);
    await source.list();
    await expect(source.load('src/content/notes/2026/nope.md')).rejects.toMatchObject({ code: 'NOT_FOUND', path: 'src/content/notes/2026/nope.md' });
    void gh;
  });

  it('resolves assets against raw.githubusercontent.com and the public site', () => {
    const { source } = setup();
    const r = (src: string) => source.resolveAssetUrl('src/content/notes/2025/new-blog.md', src);
    expect(r('new-blog/IMG_6328.jpeg')).toBe(RAW + 'src/content/notes/2025/new-blog/IMG_6328.jpeg');
    expect(r('./new-blog/IMG_6328.jpeg')).toBe(RAW + 'src/content/notes/2025/new-blog/IMG_6328.jpeg');
    expect(r('../2026/x/y.png')).toBe(RAW + 'src/content/notes/2026/x/y.png');
    expect(r('a b/ü.png?raw=1#frag')).toBe(RAW + 'src/content/notes/2025/a%20b/%C3%BC.png?raw=1#frag');
    expect(r('a%20b/x.png')).toBe(RAW + 'src/content/notes/2025/a%20b/x.png');
    expect(r('/og-default.png')).toBe('https://blog.wahdany.eu/og-default.png');
    expect(r('https://example.com/x.png')).toBe('https://example.com/x.png');
    expect(r('//cdn.example.com/x.png')).toBe('//cdn.example.com/x.png');
    expect(r('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(r('blob:https://x/1')).toBe('blob:https://x/1');
    expect(r('#fn-1')).toBe('#fn-1');
    expect(r('')).toBeNull();
    expect(r('   ')).toBeNull();
    expect(r('../../../../../etc/passwd')).toBeNull();
    expect(r('?x=1')).toBeNull();
  });

  it('a source without a session cannot save: canSave is false and save rejects with ReadOnlyError, sending nothing', async () => {
    const { source, gh } = setup();
    expect(source.canSave).toBe(false);
    const err = await source.save({ path: A, raw: 'x', baseSha: 'abc' }).catch((e) => e);
    expect(err).toBeInstanceOf(ReadOnlyError);
    expect(err.code).toBe('READ_ONLY');
    expect(gh.calls.length).toBe(0);
  });
});

/**
 * Review finding: the production list depended on one anonymous GitHub API call (60 per hour per
 * IP, shared behind carrier NAT). A first visit that got a 403 showed "The posts did not load".
 */
describe('github source: the build-time manifest as fallback', () => {
  const MANIFEST = '/write/manifest.json';

  /** A source with a manifest; the fake GitHub does not serve it, so it is answered here. */
  async function withManifest(listed: Record<string, string>, fetchedAt = 500_000) {
    const env = setup();
    const files = await Promise.all(Object.entries(listed).map(async ([path, text]) => [path, await gitBlobSha(text), enc.encode(text).byteLength]));
    const manifest = { v: 1, fetchedAt, truncated: false, files };
    const served = { ok: true, requests: 0 };
    const fetchFn: typeof fetch = async (input, init) => {
      if (String(input) === MANIFEST) {
        served.requests++;
        return served.ok ? new Response(JSON.stringify(manifest), { status: 200 }) : new Response('nope', { status: 404 });
      }
      return env.gh.fetch(input, init);
    };
    let time = 1_000_000;
    const make = () => createGithubSource(REPO, frontmatter, { fetch: fetchFn, cache: env.cache, now: () => time, manifestUrl: MANIFEST });
    return { ...env, make, source: make(), served, advance: (ms: number) => (time += ms) };
  }

  it('rate-limited on a first visit (nothing cached): the list comes from the manifest, and says so', async () => {
    const repo = baseRepo();
    const { gh, source, served } = await withManifest({ [A]: repo[A] as string, [B]: repo[B] as string, [C]: repo[C] as string });
    gh.state.rateLimited = true;
    const list = await source.list();
    expect(list.map((p) => p.slug)).toEqual(['c', 'a', 'b']);
    expect(served.requests).toBe(1);
    expect(source.status()).toMatchObject({ state: 'stale', reason: 'rate-limited', retryAt: gh.state.resetAt * 1000 });
    expect(source.status().message).toMatch(/last site build/);
    // Texts came from raw.githubusercontent.com (not rate-limited), verified against the manifest's shas.
    expect(gh.raw()).toBe(3);
    expect((await source.load(A)).raw).toBe(repo[A]);
  });

  it('offline on a first visit with the manifest still reachable (served by the site itself)', async () => {
    const repo = baseRepo();
    const { gh, source } = await withManifest({ [A]: repo[A] as string });
    // GitHub is unreachable; the site is not.
    gh.state.rateLimited = true;
    gh.state.rawStatus = 0;
    expect((await source.list()).map((p) => p.slug)).toEqual(['a']);
  });

  it('GitHub answering normally never touches the manifest', async () => {
    const repo = baseRepo();
    const { source, served } = await withManifest({ [A]: repo[A] as string });
    expect((await source.list()).length).toBe(3);
    expect(served.requests).toBe(0);
    expect(source.status().state).toBe('fresh');
  });

  it('with a cached listing too, the newer of the two is used', async () => {
    const repo = baseRepo();
    // The cached listing (fetched at 1,000,000) is newer than this manifest (500,000).
    const older = await withManifest({ [A]: repo[A] as string }, 500_000);
    await older.source.list();
    await older.source.idle();
    older.advance(10 * 60_000);
    older.gh.state.rateLimited = true;
    const later = older.make();
    expect((await later.list()).length).toBe(3);
    expect(later.status().message).toMatch(/copy saved at/);

    // A manifest from a newer build than the cached listing wins.
    const newer = await withManifest({ [A]: repo[A] as string }, 5_000_000);
    await newer.source.list();
    await newer.source.idle();
    newer.advance(10 * 60_000);
    newer.gh.state.rateLimited = true;
    const afterDeploy = newer.make();
    expect((await afterDeploy.list()).map((p) => p.slug)).toEqual(['a']);
    expect(afterDeploy.status().message).toMatch(/last site build/);
  });

  it('a post that changed after the build is shown as it is now, under its real sha', async () => {
    const repo = baseRepo();
    const { gh, source } = await withManifest({ [A]: repo[A] as string });
    gh.put(A, post('a', '2026-03-01T10:00:00+00:00', 'Edited after the build\n'));
    gh.state.rateLimited = true;
    const [ref] = await source.list();
    const loaded = await source.load(A);
    expect(loaded.raw).toContain('Edited after the build');
    expect(loaded.ref.sha).toBe(await gitBlobSha(loaded.raw));
    expect(ref.sha).toBe(loaded.ref.sha);
  });

  it('no manifest and no cache: still the typed error', async () => {
    const { gh, source, served } = await withManifest({});
    served.ok = false;
    gh.state.rateLimited = true;
    await expect(source.list()).rejects.toBeInstanceOf(SourceUnavailableError);
  });

  it('the build script lists every markdown file under src/content with git’s own blob ids', async () => {
    const manifest = buildManifest(process.cwd(), 42) as { v: number; fetchedAt: number; truncated: boolean; files: [string, string, number][] };
    expect(manifest).toMatchObject({ v: 1, fetchedAt: 42, truncated: false });
    expect(manifest.files.map((f) => f[0]).sort()).toEqual(allFiles.map(([path]) => path).sort());
    for (const [path, sha, size] of manifest.files.slice(0, 12)) {
      expect(sha, path).toBe(execFileSync('git', ['hash-object', '--no-filters', path], { encoding: 'utf8' }).trim());
      const raw = allFiles.find(([p]) => p === path)![1];
      expect(sha).toBe(await gitBlobSha(raw));
      expect(size).toBe(enc.encode(raw).byteLength);
    }
    expect(nodeBlobSha(enc.encode('hello\n'))).toBe('ce013625030ba8dba906f756967f9e9ca394464a');
  });
});

describe('github source: leftovers from review', () => {
  it('a failed attempt does not clear the refresh that replaced it', async () => {
    const { gh, source, clock } = setup();
    gh.state.offline = true;
    const failing = source.list();
    const failed = failing.catch((e) => e);
    // The first attempt's request has gone out (and failed); its rejection is still on its way.
    while (gh.calls.length === 0) await Promise.resolve();
    gh.state.offline = false;
    const refreshed = source.list({ refresh: true });
    expect(await failed).toBeInstanceOf(SourceUnavailableError);
    expect((await refreshed).length).toBe(3);
    gh.reset();
    // The refreshed list is still this session's answer: no further API call, even after the 60 s reuse window.
    clock.advance(5 * 60_000);
    expect((await source.list()).length).toBe(3);
    expect(gh.api()).toBe(0);
  });

  it('a source without a session never fires onAuthChange; subscribing still returns an unsubscribe', () => {
    const { source } = setup();
    const off = source.onAuthChange(() => {
      throw new Error('there is no session to change');
    });
    expect(typeof off).toBe('function');
    off();
  });
});
