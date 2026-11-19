import { describe, expect, it } from 'vitest';
import { classifyFailure, createGithubClient, type TokenSource } from '../client';
import {
  BranchMovedError,
  INITIAL_COMMIT_PAYLOAD_SIZE,
  MAX_COMMIT_PAYLOAD_SIZE,
  MIN_COMMIT_PAYLOAD_SIZE,
  PartialCommitError,
  commitMessage,
  createCommitter,
  encodeBase64,
  entrySlug,
  getNextPayloadSize,
  type CommitterOptions,
  type FileChange,
} from '../commit';
import { estimateRemainingCommits, getPayloadSize, isUploadFailure, sortAdditions, takeAdditions, type FileAddition } from '../commit-split';
import { RequestError, SEND_FAILED } from '../http';
import { fetchBlobBytes, fetchContentTree, fetchHead } from '../read';
import { blobSha, fakeGithub, type FakeGithub } from './fake-github';

const enc = new TextEncoder();
const NOTE = 'src/content/notes/2026/hello.md';

function setup(options: CommitterOptions = {}) {
  const gh = fakeGithub();
  gh.state.tokens.add('t');
  gh.push({ 'src/content/notes/2026/first.md': 'first\n', 'README.md': 'readme\n' }, 'seed');
  const auth: TokenSource = { token: async () => 't', renew: async () => undefined };
  const client = createGithubClient({ repo: gh.repo, auth, fetch: gh.fetch, sleep: async () => {} });
  let t = 0;
  const committer = createCommitter(client, { clock: () => (t += 1000), ...options });
  return { gh, client, committer };
}

const bytesOf = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

describe('commit messages (Sveltia’s wording)', () => {
  it('Create / Update / Delete <Singular> “<year>/<slug>”, with curly quotes', () => {
    expect(commitMessage('create', 'notes', 'src/content/notes/2026/disksurvey.md')).toBe('Create Note “2026/disksurvey”');
    expect(commitMessage('update', 'entries', 'src/content/entries/2025/my-slug.md')).toBe('Update Entry “2025/my-slug”');
    expect(commitMessage('delete', 'blogmarks', 'src/content/blogmarks/2026/x.md')).toBe('Delete Blogmark “2026/x”');
    expect(commitMessage('update', 'quotations', 'src/content/quotations/2026/q.md')).toBe('Update Quotation “2026/q”');
    expect(commitMessage('update', 'photos', 'src/content/photos/2026/p.md')).toBe('Update Photo “2026/p”');
    expect(commitMessage('update', 'series', 'src/content/series/ai-safety.md')).toBe('Update Series “ai-safety”');
  });

  it('appends +N for N further files', () => {
    expect(commitMessage('create', 'notes', 'src/content/notes/2026/disksurvey.md', 1)).toBe('Create Note “2026/disksurvey” +1');
    expect(commitMessage('update', 'notes', NOTE, 3)).toBe('Update Note “2026/hello” +3');
    expect(commitMessage('update', 'notes', NOTE, 0)).toBe('Update Note “2026/hello”');
  });

  it('matches the messages already in the repo’s history', () => {
    // `378b46f Create Note “2026/disksurvey” +1` is a real commit on main (the post plus one image).
    expect(commitMessage('create', 'notes', 'src/content/notes/2026/disksurvey.md', 1)).toBe('Create Note “2026/disksurvey” +1');
  });

  it('a slug that looks like a template placeholder or a replacement pattern is inserted as it is', () => {
    expect(commitMessage('update', 'notes', 'src/content/notes/2026/{{collection}}.md')).toBe('Update Note “2026/{{collection}}”');
    expect(commitMessage('update', 'notes', 'src/content/notes/2026/a$&b.md')).toBe('Update Note “2026/a$&b”');
    expect(entrySlug('src/content/notes/2026/a.b.md')).toBe('2026/a.b');
  });
});

describe('base64', () => {
  it('encodes text as UTF-8, keeping a BOM, CRLF and non-ASCII', () => {
    const text = '﻿---\r\ntitle: Ünïcödé “x” 🎉\r\n---\r\n';
    expect(Buffer.from(encodeBase64(text), 'base64').equals(Buffer.from(text, 'utf8'))).toBe(true);
    expect(encodeBase64('')).toBe('');
  });

  it('encodes bytes exactly, across the chunk boundary', () => {
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 31) % 256);
    expect(Buffer.from(encodeBase64(bytes), 'base64').equals(Buffer.from(bytes))).toBe(true);
  });
});

describe('createCommitOnBranch', () => {
  it('sends one mutation with expectedHeadOid, base64 additions and deletions, and returns the new blob ids', async () => {
    const { gh, committer } = setup();
    const head = gh.head();
    const image = bytesOf(500);
    const changes: FileChange[] = [
      { action: 'create', path: NOTE, data: 'Hello\n' },
      { action: 'create', path: 'src/content/notes/2026/hello/pic.png', data: image },
      { action: 'delete', path: 'src/content/notes/2026/first.md' },
    ];
    const result = await committer.commit({ changes, message: 'Create Note “2026/hello” +2', expectedHeadOid: head });

    const mutations = gh.mutations();
    expect(mutations).toHaveLength(1);
    const input = mutations[0].body.variables.input;
    expect(input.branch).toEqual({ repositoryNameWithOwner: 'dwahdany/astro-microblog', branchName: 'main' });
    expect(input.expectedHeadOid).toBe(head);
    expect(input.message).toEqual({ headline: 'Create Note “2026/hello” +2' });
    // images first, the post last
    expect(input.fileChanges.additions.map((a: { path: string }) => a.path)).toEqual(['src/content/notes/2026/hello/pic.png', NOTE]);
    expect(input.fileChanges.additions[1].contents).toBe(Buffer.from('Hello\n').toString('base64'));
    expect(input.fileChanges.deletions).toEqual([{ path: 'src/content/notes/2026/first.md' }]);
    expect(mutations[0].auth).toBe('token t');

    expect(result.via).toBe('graphql');
    expect(result.commits).toBe(1);
    expect(result.oid).toBe(gh.head());
    expect(result.files[NOTE]).toBe(blobSha(enc.encode('Hello\n')));
    expect(result.files['src/content/notes/2026/hello/pic.png']).toBe(blobSha(image));
    expect(gh.text(NOTE)).toBe('Hello\n');
    expect(gh.file('src/content/notes/2026/first.md')).toBeUndefined();
    expect(gh.log()[0].message).toBe('Create Note “2026/hello” +2');
  });

  it('a move is an addition at the new path plus a deletion of the old one, in the same commit', async () => {
    const { gh, committer } = setup();
    await committer.commit({
      changes: [{ action: 'move', path: 'src/content/notes/2026/second.md', previousPath: 'src/content/notes/2026/first.md', data: 'first\n' }],
      message: 'Update Note “2026/second”',
      expectedHeadOid: gh.head(),
    });
    expect(gh.mutations()).toHaveLength(1);
    expect(gh.text('src/content/notes/2026/second.md')).toBe('first\n');
    expect(gh.file('src/content/notes/2026/first.md')).toBeUndefined();
  });

  it('a message with a body is split into headline and body', async () => {
    const { gh, committer } = setup();
    await committer.commit({ changes: [{ action: 'update', path: NOTE, data: 'x' }], message: 'Headline\n\nBody line 1\nBody line 2\n', expectedHeadOid: gh.head() });
    expect(gh.mutations()[0].body.variables.input.message).toEqual({ headline: 'Headline', body: 'Body line 1\nBody line 2' });
  });

  it('a moved head is a typed BranchMovedError and nothing is written — never forced', async () => {
    const { gh, committer } = setup();
    const stale = gh.head();
    const theirs = gh.push({ 'src/content/portfolio/prices.json': '{}' });
    const err = await committer.commit({ changes: [{ action: 'create', path: NOTE, data: 'Hello\n' }], message: 'm', expectedHeadOid: stale }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BranchMovedError);
    expect((err as BranchMovedError).expected).toBe(stale);
    expect((err as BranchMovedError).actual).toBe(theirs);
    expect(gh.head()).toBe(theirs);
    expect(gh.file(NOTE)).toBeUndefined();
    // every request that changed anything named the expected head or forbade force
    for (const call of gh.calls) expect(JSON.stringify(call.body ?? {})).not.toContain('"force":true');
  });

  it('a commit that landed but whose answer was lost (502): the automatic repeat is refused as moved, and nothing is committed twice', async () => {
    const { gh, committer } = setup();
    gh.state.loseCommitAnswer.push(502);
    const err = await committer.commit({ changes: [{ action: 'create', path: NOTE, data: 'Hello\n' }], message: 'm', expectedHeadOid: gh.head() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BranchMovedError);
    expect(gh.mutations()).toHaveLength(2);
    expect(gh.log().filter((c) => c.via === 'graphql')).toHaveLength(1);
    expect(gh.text(NOTE)).toBe('Hello\n');
  });

  it('retries the mutation once after a 502 that was answered before anything was applied', async () => {
    const { gh, committer } = setup();
    gh.state.failGraphql.push(502);
    const result = await committer.commit({ changes: [{ action: 'create', path: NOTE, data: 'Hello\n' }], message: 'm', expectedHeadOid: gh.head() });
    expect(gh.mutations()).toHaveLength(2);
    expect(result.commits).toBe(1);
    expect(gh.log().filter((c) => c.via === 'graphql')).toHaveLength(1);
  });

  it('a failure that is not a moved head comes through as it is', async () => {
    const { gh, committer } = setup();
    gh.state.failGraphql.push(500);
    const err = await committer.commit({ changes: [{ action: 'create', path: NOTE, data: 'x' }], message: 'm', expectedHeadOid: gh.head() }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).status).toBe(500);
    expect(gh.file(NOTE)).toBeUndefined();
  });

  it('an abort stops without a head lookup', async () => {
    const { gh, committer } = setup();
    const controller = new AbortController();
    controller.abort();
    const err = await committer.commit({ changes: [{ action: 'create', path: NOTE, data: 'x' }], message: 'm', expectedHeadOid: gh.head(), signal: controller.signal }).catch((e: unknown) => e);
    expect((err as DOMException).name).toBe('AbortError');
    expect(gh.count((c) => c.url.includes('/git/ref/'))).toBe(0);
  });
});

describe('a save too large for one request is split', () => {
  it('images first in groups, the post and the deletions in the last commit, each on top of the previous one', async () => {
    const { gh, committer } = setup({ initialPayloadSize: 1500 });
    const changes: FileChange[] = [
      { action: 'create', path: NOTE, data: 'Hello\n' },
      { action: 'create', path: 'src/content/notes/2026/hello/a.png', data: bytesOf(900, 1) },
      { action: 'create', path: 'src/content/notes/2026/hello/b.png', data: bytesOf(900, 2) },
      { action: 'delete', path: 'src/content/notes/2026/first.md' },
    ];
    const progress: [number, number][] = [];
    const before = gh.head();
    const result = await committer.commit({ changes, message: 'Create Note “2026/hello” +3', expectedHeadOid: before, onProgress: (d, t) => progress.push([d, t]) });

    const inputs = gh.mutations().map((m) => m.body.variables.input);
    expect(inputs.length).toBeGreaterThan(1);
    // the chain: each commit expects the previous one
    expect(inputs[0].expectedHeadOid).toBe(before);
    for (let i = 1; i < inputs.length; i += 1) expect(inputs[i].expectedHeadOid).toBe(gh.log()[inputs.length - i].oid);
    // the post is only in the last commit, and so is the deletion
    const withPost = inputs.map((input) => input.fileChanges.additions.some((a: { path: string }) => a.path === NOTE));
    expect(withPost.lastIndexOf(true)).toBe(inputs.length - 1);
    expect(withPost.indexOf(true)).toBe(inputs.length - 1);
    expect(inputs.slice(0, -1).every((input) => input.fileChanges.deletions.length === 0)).toBe(true);
    expect(inputs.at(-1).fileChanges.deletions).toEqual([{ path: 'src/content/notes/2026/first.md' }]);
    // every commit carries the same message
    expect(new Set(inputs.map((i) => i.message.headline))).toEqual(new Set(['Create Note “2026/hello” +3']));

    expect(result.commits).toBe(inputs.length);
    expect(result.oid).toBe(gh.head());
    expect(Object.keys(result.files).sort()).toEqual([NOTE, 'src/content/notes/2026/hello/a.png', 'src/content/notes/2026/hello/b.png'].sort());
    expect(result.files['src/content/notes/2026/hello/a.png']).toBe(blobSha(bytesOf(900, 1)));
    expect(progress.at(-1)).toEqual([result.commits, result.commits]);
    expect(progress[0][0]).toBe(0);
  });

  it('when the branch moves between two of its commits: BranchMovedError naming what landed', async () => {
    const { gh, committer } = setup({ initialPayloadSize: 1500 });
    let n = 0;
    gh.state.beforeCommit = () => {
      n += 1;
      if (n === 2) gh.push({ 'src/content/portfolio/prices.json': '{}' });
    };
    const err = await committer
      .commit({
        changes: [
          { action: 'create', path: NOTE, data: 'Hello\n' },
          { action: 'create', path: 'src/content/notes/2026/hello/a.png', data: bytesOf(1400, 1) },
        ],
        message: 'm',
        expectedHeadOid: gh.head(),
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BranchMovedError);
    expect((err as BranchMovedError).landed?.commits).toBe(1);
    expect(gh.file('src/content/notes/2026/hello/a.png')).toBeDefined(); // the image commit is in
    expect(gh.file(NOTE)).toBeUndefined(); // the post is not
  });

  it('a later commit that fails for another reason is a PartialCommitError', async () => {
    const { gh, committer } = setup({ initialPayloadSize: 1500 });
    let n = 0;
    gh.state.beforeCommit = () => {
      n += 1;
      if (n === 1) gh.state.failGraphql.push(500);
    };
    const err = await committer
      .commit({
        changes: [
          { action: 'create', path: NOTE, data: 'Hello\n' },
          { action: 'create', path: 'src/content/notes/2026/hello/a.png', data: bytesOf(1400, 1) },
        ],
        message: 'm',
        expectedHeadOid: gh.head(),
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PartialCommitError);
    expect((err as PartialCommitError).landed.commits).toBe(1);
    expect(((err as PartialCommitError).cause as RequestError).status).toBe(500);
  });

  it('an upload that times out is tried again with half the files, when the head has not moved', async () => {
    const { gh, committer } = setup({ initialPayloadSize: 10_000 });
    gh.state.failGraphql.push(413);
    const result = await committer.commit({
      changes: [
        { action: 'create', path: NOTE, data: 'Hello\n' },
        { action: 'create', path: 'src/content/notes/2026/hello/a.png', data: bytesOf(2000, 1) },
        { action: 'create', path: 'src/content/notes/2026/hello/b.png', data: bytesOf(2000, 2) },
      ],
      message: 'm',
      expectedHeadOid: gh.head(),
    });
    const sizes = gh.mutations().map((m) => m.body.variables.input.fileChanges.additions.length);
    expect(sizes[0]).toBe(3); // refused
    expect(sizes.slice(1).every((n) => n < 3)).toBe(true);
    expect(result.commits).toBe(sizes.length - 1);
    expect(gh.text(NOTE)).toBe('Hello\n');
    expect(gh.file('src/content/notes/2026/hello/b.png')).toEqual(bytesOf(2000, 2));
  });

  it('the split helpers', () => {
    const add = (path: string, data: string | Uint8Array, index = 0): FileAddition => ({ index, path, data, contents: encodeBase64(data) });
    const { queue, addedAgain } = sortAdditions([add('a.md', 'text'), add('b.png', bytesOf(3)), add('c.png', bytesOf(3)), add('d.png', bytesOf(3))], new Set(['d.png']));
    expect(queue.map((a) => a.path)).toEqual(['b.png', 'c.png', 'a.md']);
    expect(addedAgain.map((a) => a.path)).toEqual(['d.png']);
    const q = [add('1', bytesOf(300)), add('2', bytesOf(300)), add('3', bytesOf(300))];
    expect(takeAdditions(q, 100).map((a) => a.path)).toEqual(['1']); // one oversize file goes alone
    expect(takeAdditions(q, 10_000).map((a) => a.path)).toEqual(['2', '3']);
    expect(getPayloadSize([add('1', bytesOf(3))])).toBe(4);
    expect(estimateRemainingCommits([], 100)).toBe(1);
    expect(estimateRemainingCommits([add('1', bytesOf(300))], 100)).toBe(4);
    expect(isUploadFailure(new RequestError(SEND_FAILED))).toBe(true);
    expect(isUploadFailure(new RequestError('Server responded with an error', { status: 504 }))).toBe(true);
    expect(isUploadFailure(new RequestError('Server responded with an error', { status: 403 }))).toBe(false);
    expect(getNextPayloadSize(2 * 1024 * 1024, 5000)).toBe(2 * 1024 * 1024);
    expect(getNextPayloadSize(2 * 1024 * 1024, 100_000)).toBe(MIN_COMMIT_PAYLOAD_SIZE);
    expect(getNextPayloadSize(INITIAL_COMMIT_PAYLOAD_SIZE, 1)).toBe(MAX_COMMIT_PAYLOAD_SIZE);
  });
});

describe('REST fallback (Git Data API)', () => {
  const changes: FileChange[] = [
    { action: 'create', path: NOTE, data: '﻿Hello\r\n' },
    { action: 'create', path: 'src/content/notes/2026/hello/pic.png', data: bytesOf(500) },
    { action: 'move', path: 'src/content/notes/2026/moved.md', previousPath: 'src/content/notes/2026/first.md', data: 'first\n' },
  ];

  it('is chosen automatically when GitHub says the mutation is not accessible, and remembered', async () => {
    const { gh, committer } = setup();
    gh.state.graphqlForbidden = true;
    expect(committer.strategy()).toBe('graphql');
    const before = gh.head();
    const result = await committer.commit({ changes, message: 'Create Note “2026/hello” +2', expectedHeadOid: before });

    expect(result.via).toBe('rest');
    expect(result.commits).toBe(1);
    expect(gh.head()).toBe(result.oid);
    const made = gh.log()[0];
    expect(made.via).toBe('rest');
    expect(made.parent).toBe(before);
    expect(made.message).toBe('Create Note “2026/hello” +2');
    expect(new TextDecoder('utf-8', { ignoreBOM: true }).decode(gh.file(NOTE))).toBe('﻿Hello\r\n');
    expect(gh.file('src/content/notes/2026/hello/pic.png')).toEqual(bytesOf(500));
    expect(gh.text('src/content/notes/2026/moved.md')).toBe('first\n');
    expect(gh.file('src/content/notes/2026/first.md')).toBeUndefined();
    expect(gh.text('README.md')).toBe('readme\n'); // base_tree: everything else is kept
    expect(result.files[NOTE]).toBe(blobSha(enc.encode('﻿Hello\r\n')));

    // blobs → tree → commit → ref, and the ref update forbids force
    const writes = gh.calls.filter((c) => c.method !== 'GET' && !c.url.endsWith('/graphql')).map((c) => `${c.method} ${c.url.split('/git/')[1].replace(/\/.*/, '')}`);
    expect(writes).toEqual(['POST blobs', 'POST blobs', 'POST blobs', 'POST trees', 'POST commits', 'PATCH refs']);
    const patch = gh.calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({ sha: result.oid, force: false });

    // From now on GraphQL is not tried again.
    expect(committer.strategy()).toBe('rest');
    gh.reset();
    await committer.commit({ changes: [{ action: 'update', path: NOTE, data: 'again\n' }], message: 'm', expectedHeadOid: gh.head() });
    expect(gh.mutations()).toHaveLength(0);
  });

  it('a moved head is refused by the ref update (not a fast forward) → BranchMovedError, branch untouched', async () => {
    const { gh, committer } = setup({ strategy: 'rest' });
    const stale = gh.head();
    gh.state.beforeCommit = () => {
      gh.state.beforeCommit = undefined;
      gh.push({ 'src/content/portfolio/prices.json': '{}' });
    };
    const err = await committer.commit({ changes: [{ action: 'create', path: NOTE, data: 'Hello\n' }], message: 'm', expectedHeadOid: stale }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BranchMovedError);
    expect(gh.file(NOTE)).toBeUndefined();
    expect(gh.log()[0].via).toBe('push');
  });

  it('is not tried when GraphQL failed for another reason, nor when pinned to graphql', async () => {
    const a = setup();
    a.gh.state.failGraphql.push(500);
    await a.committer.commit({ changes: [{ action: 'create', path: NOTE, data: 'x' }], message: 'm', expectedHeadOid: a.gh.head() }).catch(() => {});
    expect(a.gh.count((c) => c.url.includes('/git/blobs') && c.method === 'POST')).toBe(0);

    const b = setup({ strategy: 'graphql' });
    b.gh.state.graphqlForbidden = true;
    const err = await b.committer.commit({ changes: [{ action: 'create', path: NOTE, data: 'x' }], message: 'm', expectedHeadOid: b.gh.head() }).catch((e: unknown) => e);
    expect(classifyFailure(err).kind).toBe('forbidden');
    expect(b.gh.count((c) => c.url.includes('/git/blobs') && c.method === 'POST')).toBe(0);
  });

  it('when REST is refused too, the refusal is what comes back and GraphQL stays the first choice', async () => {
    const { gh, committer } = setup();
    gh.state.graphqlForbidden = true;
    gh.state.restForbidden = true;
    const err = await committer.commit({ changes: [{ action: 'create', path: NOTE, data: 'x' }], message: 'm', expectedHeadOid: gh.head() }).catch((e: unknown) => e);
    expect(classifyFailure(err)).toMatchObject({ kind: 'forbidden', status: 403 });
    expect(committer.strategy()).toBe('graphql');
    expect(gh.file(NOTE)).toBeUndefined();
  });
});

describe('authenticated read', () => {
  it('head, the tree under src/content, and a blob’s exact bytes — all with the token', async () => {
    const { gh, client } = setup();
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0x0d, 0x0a]);
    gh.push({ 'src/content/notes/2026/bom.md': bom, 'src/content/notes/2026/bom/p.png': bytesOf(9) });
    gh.reset();
    const head = await fetchHead(client);
    expect(head).toBe(gh.head());
    const tree = await fetchContentTree(client, head, 'src/content');
    expect([...tree.keys()].sort()).toEqual(['src/content/notes/2026/bom.md', 'src/content/notes/2026/bom/p.png', 'src/content/notes/2026/first.md']);
    expect(tree.get('src/content/notes/2026/bom.md')).toEqual({ sha: blobSha(bom), size: 6 });
    expect(await fetchBlobBytes(client, blobSha(bom))).toEqual(bom);
    expect(gh.calls.every((c) => c.auth === 'token t')).toBe(true);
    expect(gh.calls.map((c) => c.url.replace('https://api.github.com/repos/dwahdany/astro-microblog', ''))).toEqual([
      '/git/ref/heads/main',
      `/git/trees/${head}:src/content?recursive=1`,
      `/git/blobs/${blobSha(bom)}`,
    ]);
  });

  it('lists a truncated tree directory by directory, so nothing is missing', async () => {
    const tree = (entries: object[], truncated = false) => new Response(JSON.stringify({ tree: entries, truncated }), { status: 200 });
    const urls: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      const url = String(input).replace('https://api.github.com/repos/o/r/git/trees/', '');
      urls.push(url);
      if (url === 'main:src/content?recursive=1') return tree([{ path: 'notes/a.md', type: 'blob', sha: 'a', size: 1 }], true);
      if (url === 'main:src/content')
        return tree([
          { path: 'notes', type: 'tree', sha: 'tn' },
          { path: 'top.md', type: 'blob', sha: 't', size: 3 },
        ]);
      if (url === 'tn?recursive=1')
        return tree([
          { path: 'a.md', type: 'blob', sha: 'a', size: 1 },
          { path: '2026', type: 'tree', sha: 'x' },
          { path: '2026/b.md', type: 'blob', sha: 'b', size: 2 },
        ]);
      return new Response('{}', { status: 404 });
    };
    const client = createGithubClient({ repo: { owner: 'o', name: 'r', branch: 'main' }, fetch: fetchFn });
    const files = await fetchContentTree(client, 'main', 'src/content');
    expect([...files.keys()].sort()).toEqual(['src/content/notes/2026/b.md', 'src/content/notes/a.md', 'src/content/top.md']);
    expect(urls).toEqual(['main:src/content?recursive=1', 'main:src/content', 'tn?recursive=1']);
  });

  it('goes out anonymously when nobody is signed in', async () => {
    const gh = fakeGithub();
    gh.push({ 'src/content/notes/2026/a.md': 'a' });
    const client = createGithubClient({ repo: gh.repo, fetch: gh.fetch });
    await fetchHead(client);
    expect(gh.calls[0].auth).toBeNull();
    expect(await client.hasToken()).toBe(false);
  });
});

describe('classifyFailure', () => {
  const err = (status: number | undefined, detail?: string, headers?: Record<string, string>, types?: string[]) =>
    new RequestError(status === undefined ? SEND_FAILED : 'Server responded with an error', { status, detail, types, headers: headers ? new Headers(headers) : undefined });
  it('sorts failures', () => {
    expect(classifyFailure(err(undefined)).kind).toBe('offline');
    expect(classifyFailure(err(401, 'Bad credentials')).kind).toBe('unauthorized');
    expect(classifyFailure(err(403, 'Resource not accessible by integration')).kind).toBe('forbidden');
    expect(classifyFailure(err(200, 'Resource not accessible by personal access token', undefined, ['FORBIDDEN'])).kind).toBe('forbidden');
    expect(classifyFailure(err(403, 'API rate limit exceeded', { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' }))).toMatchObject({ kind: 'rate-limited', retryAt: 1_800_000_000_000 });
    expect(classifyFailure(err(403, 'You have exceeded a secondary rate limit', { 'retry-after': '60' })).kind).toBe('rate-limited');
    expect(classifyFailure(err(429)).kind).toBe('rate-limited');
    expect(classifyFailure(err(404, 'Not Found')).kind).toBe('not-found');
    expect(classifyFailure(err(413)).kind).toBe('too-large');
    expect(classifyFailure(err(422, 'Update is not a fast forward')).kind).toBe('conflict');
    expect(classifyFailure(err(500)).kind).toBe('other');
    expect(classifyFailure(new Error('x')).kind).toBe('other');
  });
});
