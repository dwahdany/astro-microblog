/**
 * A pretend GitHub for unit tests: one repo with real git semantics (blobs, trees, commits, a
 * branch head), answering the REST and GraphQL calls the data layer makes. No network.
 */
import { createHash } from 'node:crypto';

const enc = new TextEncoder();
const hex = (input: string | Uint8Array) => createHash('sha1').update(input).digest('hex');

export function blobSha(bytes: Uint8Array): string {
  return createHash('sha1')
    .update(enc.encode(`blob ${bytes.byteLength}\0`))
    .update(bytes)
    .digest('hex');
}

const fromBase64 = (b64: string): Uint8Array => new Uint8Array(Buffer.from(b64, 'base64'));
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

export interface FakeCommit {
  oid: string;
  parent?: string;
  message: string;
  /** path → blob sha */
  tree: Map<string, string>;
  via: 'graphql' | 'rest' | 'seed' | 'push';
}

export interface FakeCall {
  method: string;
  url: string;
  auth: string | null;
  body?: any;
}

export function fakeGithub(owner = 'dwahdany', name = 'astro-microblog', branch = 'main') {
  const blobs = new Map<string, Uint8Array>();
  const commits = new Map<string, FakeCommit>();
  const trees = new Map<string, Map<string, string>>();
  const calls: FakeCall[] = [];
  let counter = 0;
  let head = '';

  const state = {
    /** Tokens GitHub accepts. An `Authorization` header with any other token is answered 401. */
    tokens: new Set<string>(),
    user: { login: 'dwahdany', name: 'Dariush', avatar_url: 'https://avatars.example/u/1', id: 1 },
    /** `permissions.push` of the repo for a signed-in caller. */
    push: true,
    /** The repo is invisible to the token (404). */
    hidden: false,
    /** createCommitOnBranch is refused: "Resource not accessible by integration". */
    graphqlForbidden: false,
    /** Every write through REST is refused with 403. */
    restForbidden: false,
    offline: false,
    /** Runs right before a commit is applied (either API): push something to move the branch. */
    beforeCommit: undefined as undefined | (() => void),
    /** Answer the next N GraphQL requests with this status (no body). */
    failGraphql: [] as number[],
    /** APPLY the next N commit mutations, then answer with this status instead (the answer is lost). */
    loseCommitAnswer: [] as number[],
  };

  const storeBlob = (bytes: Uint8Array): string => {
    const sha = blobSha(bytes);
    blobs.set(sha, bytes);
    return sha;
  };

  function addCommit(tree: Map<string, string>, message: string, via: FakeCommit['via'], parent = head || undefined): string {
    counter += 1;
    const oid = hex(`commit ${counter} ${message}`);
    commits.set(oid, { oid, parent, message, tree, via });
    return oid;
  }

  /** Commit straight to the branch, as another client would (the price-cache bot). */
  function push(files: Record<string, string | Uint8Array | null>, message = 'Refresh portfolio price cache'): string {
    const tree = new Map(head ? commits.get(head)!.tree : []);
    for (const [path, content] of Object.entries(files)) {
      if (content === null) tree.delete(path);
      else tree.set(path, storeBlob(typeof content === 'string' ? enc.encode(content) : content));
    }
    head = addCommit(tree, message, counter === 0 ? 'seed' : 'push');
    return head;
  }

  const headCommit = () => commits.get(head)!;
  const file = (path: string): Uint8Array | undefined => {
    const sha = headCommit().tree.get(path);
    return sha ? blobs.get(sha) : undefined;
  };
  const text = (path: string): string | undefined => {
    const bytes = file(path);
    return bytes ? new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes) : undefined;
  };
  const log = (): FakeCommit[] => {
    const out: FakeCommit[] = [];
    for (let c = commits.get(head); c; c = c.parent ? commits.get(c.parent) : undefined) out.push(c);
    return out;
  };
  const isAncestor = (ancestor: string, of: string): boolean => {
    for (let c = commits.get(of); c; c = c.parent ? commits.get(c.parent) : undefined) if (c.oid === ancestor) return true;
    return false;
  };

  const repoApi = `https://api.github.com/repos/${owner}/${name}`;
  const rawBase = `https://raw.githubusercontent.com/${owner}/${name}/${branch}/`;

  function resolveCommit(ref: string): FakeCommit | undefined {
    return ref === branch ? headCommit() : commits.get(ref);
  }

  function graphql(body: { query: string; variables: any }): Response {
    const status = state.failGraphql.shift();
    if (status) return new Response('', { status });
    if (/createCommitOnBranch/.test(body.query)) {
      if (state.graphqlForbidden)
        return json({ data: { createCommitOnBranch: null }, errors: [{ type: 'FORBIDDEN', path: ['createCommitOnBranch'], message: 'Resource not accessible by integration' }] });
      state.beforeCommit?.();
      const input = body.variables.input;
      if (input.branch.repositoryNameWithOwner !== `${owner}/${name}` || input.branch.branchName !== branch)
        return json({ errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a Repository' }] });
      if (input.expectedHeadOid !== head)
        return json({
          data: { createCommitOnBranch: null },
          errors: [{ type: 'STALE_DATA', message: `Expected branch to point to "${head}" but it did not. Pull and try again.` }],
        });
      const tree = new Map(headCommit().tree);
      for (const { path } of input.fileChanges.deletions ?? []) {
        if (!tree.has(path)) return json({ errors: [{ type: 'UNPROCESSABLE', message: `A path was requested for deletion which does not exist as of commit oid \`${head}\`: ${path}` }] });
        tree.delete(path);
      }
      for (const { path, contents } of input.fileChanges.additions ?? []) tree.set(path, storeBlob(fromBase64(contents)));
      const message = input.message.body ? `${input.message.headline}\n\n${input.message.body}` : input.message.headline;
      head = addCommit(tree, message, 'graphql');
      const commit: Record<string, unknown> = { oid: head, committedDate: '2026-11-19T12:00:00Z' };
      for (const m of body.query.matchAll(/(file_\d+): file\(path: ("(?:[^"\\]|\\.)*")\)/g)) {
        const sha = tree.get(JSON.parse(m[2]));
        commit[m[1]] = sha ? { oid: sha } : null;
      }
      return json({ data: { createCommitOnBranch: { commit } } });
    }
    return json({ errors: [{ message: 'unexpected query' }] });
  }

  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const authHeader = headers.get('authorization');
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, auth: authHeader, body });
    if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (state.offline) throw new TypeError('Failed to fetch');

    if (url.startsWith(rawBase)) {
      const bytes = file(decodeURIComponent(url.slice(rawBase.length)));
      return bytes ? new Response(bytes as unknown as BodyInit, { status: 200 }) : new Response('404: Not Found', { status: 404 });
    }
    if (!url.startsWith('https://api.github.com/')) throw new Error(`unexpected request ${method} ${url}`);

    const token = authHeader?.replace(/^(token|Bearer) /, '') ?? null;
    if (token !== null && !state.tokens.has(token)) return json({ message: 'Bad credentials' }, 401);
    const limit = { 'x-ratelimit-limit': token ? '5000' : '60', 'x-ratelimit-remaining': token ? '4990' : '55', 'x-ratelimit-reset': '1800000000' };

    if (url === 'https://api.github.com/user') return token ? json(state.user, 200, limit) : json({ message: 'Requires authentication' }, 401);
    if (url === 'https://api.github.com/graphql') {
      if (!token) return json({ message: 'Requires authentication' }, 401);
      const before = head;
      const answer = graphql(body);
      if (head !== before) {
        const lost = state.loseCommitAnswer.shift();
        if (lost) return new Response('', { status: lost });
      }
      return answer;
    }
    if (!url.startsWith(repoApi)) return json({ message: 'Not Found' }, 404);
    if (state.hidden) return json({ message: 'Not Found' }, 404);
    const path = url.slice(repoApi.length);

    if (path === '' && method === 'GET') return json({ full_name: `${owner}/${name}`, private: false, ...(token ? { permissions: { pull: true, push: state.push, admin: state.push } } : {}) }, 200, limit);

    if (path === `/git/ref/heads/${branch}` && method === 'GET') return json({ ref: `refs/heads/${branch}`, object: { type: 'commit', sha: head } }, 200, limit);

    let m = path.match(/^\/git\/trees\/([^:?]+)(?::([^?]*))?(\?recursive=1)?$/);
    if (m && method === 'GET') {
      const commit = resolveCommit(decodeURIComponent(m[1]));
      if (!commit) return json({ message: 'Not Found' }, 404);
      const prefix = m[2] ? m[2] + '/' : '';
      const tree = [...commit.tree]
        .filter(([p]) => p.startsWith(prefix))
        .map(([p, sha]) => ({ path: p.slice(prefix.length), mode: '100644', type: 'blob', sha, size: blobs.get(sha)!.byteLength }));
      return json({ sha: 'tree', tree, truncated: false }, 200, limit);
    }

    m = path.match(/^\/git\/blobs\/([0-9a-f]{40})$/);
    if (m && method === 'GET') {
      const bytes = blobs.get(m[1]);
      return bytes ? new Response(bytes as unknown as BodyInit, { status: 200, headers: limit }) : json({ message: 'Not Found' }, 404);
    }

    if (method !== 'GET') {
      if (!token) return json({ message: 'Requires authentication' }, 401);
      if (state.restForbidden || !state.push) return json({ message: 'Resource not accessible by personal access token' }, 403);
    }

    if (path === '/git/blobs' && method === 'POST') {
      if (body.encoding !== 'base64') return json({ message: 'expected base64' }, 422);
      return json({ sha: storeBlob(fromBase64(body.content)) }, 201);
    }
    m = path.match(/^\/git\/commits\/([0-9a-f]{40})$/);
    if (m && method === 'GET') {
      const commit = commits.get(m[1]);
      if (!commit) return json({ message: 'Not Found' }, 404);
      const treeSha = hex(`tree of ${commit.oid}`);
      trees.set(treeSha, commit.tree);
      return json({ sha: commit.oid, tree: { sha: treeSha } });
    }
    if (path === '/git/trees' && method === 'POST') {
      const base = trees.get(body.base_tree);
      if (!base) return json({ message: 'base_tree not found' }, 422);
      const tree = new Map(base);
      for (const entry of body.tree) {
        if (entry.sha === null) tree.delete(entry.path);
        else if (!blobs.has(entry.sha)) return json({ message: 'blob not found' }, 422);
        else tree.set(entry.path, entry.sha);
      }
      counter += 1;
      const sha = hex(`tree ${counter}`);
      trees.set(sha, tree);
      return json({ sha }, 201);
    }
    if (path === '/git/commits' && method === 'POST') {
      const tree = trees.get(body.tree);
      if (!tree || body.parents.length !== 1 || !commits.has(body.parents[0])) return json({ message: 'bad commit' }, 422);
      const oid = addCommit(tree, body.message, 'rest', body.parents[0]);
      return json({ sha: oid, committer: { date: '2026-11-19T12:00:00Z' } }, 201);
    }
    if (path === `/git/refs/heads/${branch}` && method === 'PATCH') {
      state.beforeCommit?.();
      if (body.force !== false) return json({ message: 'the test repo refuses force pushes' }, 422);
      if (!commits.has(body.sha)) return json({ message: 'Object does not exist' }, 422);
      if (!isAncestor(head, body.sha)) return json({ message: 'Update is not a fast forward' }, 422);
      head = body.sha;
      return json({ ref: `refs/heads/${branch}`, object: { sha: head } });
    }

    return json({ message: 'Not Found' }, 404);
  };

  const count = (test: (c: FakeCall) => boolean) => calls.filter(test).length;

  return {
    fetch: fetchFn,
    state,
    calls,
    push,
    file,
    text,
    log,
    head: () => head,
    paths: () => [...headCommit().tree.keys()].sort(),
    blobs,
    count,
    api: () => count((c) => c.url.startsWith('https://api.github.com/')),
    mutations: () => calls.filter((c) => c.url.endsWith('/graphql') && /createCommitOnBranch/.test(c.body?.query ?? '')),
    reset: () => void (calls.length = 0),
    repo: { owner, name, branch },
  };
}

export type FakeGithub = ReturnType<typeof fakeGithub>;
