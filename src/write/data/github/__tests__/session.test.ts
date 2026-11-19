import { describe, expect, it } from 'vitest';
import { AUTH_STORAGE_KEY, AUTH_WORKER_ORIGIN, AuthError, type AuthState } from '../../../contracts';
import { RequestError, sendRequest } from '../http';
import { createSession, type KeyValueStorage, type LockManagerLike, type SessionOptions, type StoredSession } from '../session';
import type { PopupHost, PopupWindow } from '../auth';
import { fakeGithub, type FakeGithub } from './fake-github';

const REPO = { owner: 'dwahdany', name: 'astro-microblog' };
const HOUR = 3_600_000;

/** localStorage shared by "tabs", with storage events delivered to the OTHER tabs. */
function sharedStorage() {
  const map = new Map<string, string>();
  const tabs: { storage: KeyValueStorage; listeners: Set<(key: string | null) => void> }[] = [];
  const tab = () => {
    const listeners = new Set<(key: string | null) => void>();
    const others = (key: string) => tabs.forEach((t) => t.listeners !== listeners && t.listeners.forEach((l) => l(key)));
    const storage: KeyValueStorage = {
      getItem: (k) => map.get(k) ?? null,
      setItem: (k, v) => (map.set(k, v), others(k)),
      removeItem: (k) => (map.delete(k), others(k)),
    };
    const entry = { storage, listeners };
    tabs.push(entry);
    return {
      storage,
      onStorage: (l: (key: string | null) => void) => (listeners.add(l), () => void listeners.delete(l)),
    };
  };
  return { map, tab, stored: () => JSON.parse(map.get(AUTH_STORAGE_KEY) ?? 'null') as StoredSession | null };
}

/** A lock shared by tabs: one holder at a time, in order. */
function sharedLocks(): LockManagerLike {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    request(_name, callback) {
      const run = tail.then(callback, callback);
      tail = run.catch(() => {});
      return run;
    },
  };
}

/** The auth worker's /refresh endpoint in front of the fake GitHub. */
function world() {
  const gh = fakeGithub();
  const worker = {
    /** refresh token → what it yields; consumed on use (single-use, as GitHub Apps issue them) */
    valid: new Map<string, { token: string; refresh_token?: string; expires_in?: number; refresh_token_expires_in?: number }>(),
    calls: 0,
    fail: undefined as undefined | 'offline' | number,
    gate: undefined as undefined | Promise<void>,
  };
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === `${AUTH_WORKER_ORIGIN}/refresh`) {
      worker.calls += 1;
      await worker.gate;
      if (worker.fail === 'offline') throw new TypeError('Failed to fetch');
      if (typeof worker.fail === 'number') return new Response('', { status: worker.fail });
      const { refresh_token } = JSON.parse(String(init?.body));
      const next = worker.valid.get(refresh_token);
      // as the forked worker answers a refresh token GitHub refuses (src/index.js, handleRefresh)
      if (!next) return new Response(JSON.stringify({ error: 'bad_refresh_token' }), { status: 401 });
      worker.valid.delete(refresh_token);
      gh.state.tokens.add(next.token);
      return new Response(JSON.stringify(next), { status: 200 });
    }
    return gh.fetch(input, init);
  };
  return { gh, worker, fetch: fetchFn };
}

function open(w: ReturnType<typeof world>, extra: Partial<SessionOptions> = {}) {
  let now = 1_800_000_000_000;
  const states: AuthState[] = [];
  const session = createSession({
    repo: REPO,
    fetch: w.fetch,
    storage: null,
    host: null,
    locks: null,
    onStorage: () => () => {},
    now: () => now,
    sleep: async () => {},
    ...extra,
  });
  session.onChange((s) => states.push(s));
  return { session, states, advance: (ms: number) => (now += ms), now: () => now };
}

const appSession = (overrides: Partial<StoredSession> = {}): StoredSession => ({
  v: 1,
  method: 'app',
  token: 'ghu_1',
  refreshToken: 'ghr_1',
  expiresAt: 1_800_000_000_000 + 8 * HOUR,
  refreshExpiresAt: 1_800_000_000_000 + 4000 * HOUR,
  user: { login: 'dwahdany' },
  savedAt: 1_800_000_000_000,
  ...overrides,
});

const caught = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as AuthError);

describe('signing in with a pasted token', () => {
  it('checks who it belongs to and that it may push, then stores it', async () => {
    const w = world();
    w.gh.state.tokens.add('github_pat_good');
    const shared = sharedStorage();
    const { session, states } = open(w, shared.tab());
    expect(session.state()).toEqual({ status: 'signed-out' });

    const state = await session.signInWithToken('  github_pat_good \n');
    expect(state).toMatchObject({ status: 'signed-in', method: 'token', verified: true, user: { login: 'dwahdany', name: 'Dariush', avatarUrl: 'https://avatars.example/u/1', id: 1 } });
    expect(states.map((s) => s.status)).toEqual(['signing-in', 'signed-in']);
    expect(shared.stored()).toMatchObject({ v: 1, method: 'token', token: 'github_pat_good', user: { login: 'dwahdany' } });
    expect(shared.stored()?.refreshToken).toBeUndefined();
    expect(await session.token()).toBe('github_pat_good');
    // Both checks went out with the token.
    expect(w.gh.calls.map((c) => [c.url, c.auth])).toEqual([
      ['https://api.github.com/user', 'token github_pat_good'],
      ['https://api.github.com/repos/dwahdany/astro-microblog', 'token github_pat_good'],
    ]);
  });

  it('a token GitHub does not know is refused and nothing is stored', async () => {
    const w = world();
    const shared = sharedStorage();
    const { session, states } = open(w, shared.tab());
    const err = await caught(session.signInWithToken('github_pat_wrong'));
    expect(err).toBeInstanceOf(AuthError);
    expect(err?.reason).toBe('invalid-token');
    expect(session.state()).toEqual({ status: 'signed-out' });
    expect(states.map((s) => s.status)).toEqual(['signing-in', 'signed-out']);
    expect(shared.map.size).toBe(0);
  });

  it('a token that may only read is refused (no-push); a repo it cannot see is no-access', async () => {
    const w = world();
    w.gh.state.tokens.add('t');
    w.gh.state.push = false;
    const { session } = open(w);
    expect((await caught(session.signInWithToken('t')))?.reason).toBe('no-push');
    w.gh.state.push = true;
    w.gh.state.hidden = true;
    expect((await caught(session.signInWithToken('t')))?.reason).toBe('no-access');
    expect(session.state().status).toBe('signed-out');
  });

  it('empty input and input with spaces inside never reach GitHub', async () => {
    const w = world();
    const { session } = open(w);
    expect((await caught(session.signInWithToken('   ')))?.reason).toBe('invalid-token');
    expect((await caught(session.signInWithToken('two words')))?.reason).toBe('invalid-token');
    expect(w.gh.calls).toHaveLength(0);
  });

  it('offline is said as such', async () => {
    const w = world();
    w.gh.state.offline = true;
    const { session } = open(w);
    expect((await caught(session.signInWithToken('t')))?.reason).toBe('offline');
  });
});

describe('signing in with the GitHub App (popup)', () => {
  function popupHost(hostname = 'blog.wahdany.eu') {
    const listeners = new Set<(e: MessageEvent) => void>();
    const opened: string[] = [];
    const popup: PopupWindow = { closed: false, close() { this.closed = true; }, postMessage: () => {} };
    const host: PopupHost = {
      open: (url) => (opened.push(url), popup),
      addEventListener: (_t, l) => void listeners.add(l),
      removeEventListener: (_t, l) => void listeners.delete(l),
      location: { hostname, origin: `https://${hostname}` },
    };
    const answer = (content: object, kind = 'success') =>
      listeners.forEach((l) => l({ data: `authorization:github:${kind}:${JSON.stringify(content)}`, origin: AUTH_WORKER_ORIGIN, source: popup } as unknown as MessageEvent));
    return { host, popup, opened, answer, listeners };
  }

  it('opens the popup in the same turn, validates the token and stores it with its expiry', async () => {
    const w = world();
    w.gh.state.tokens.add('ghu_new');
    const shared = sharedStorage();
    const p = popupHost();
    const { session, now } = open(w, { ...shared.tab(), host: p.host });
    expect(session.popupSupported).toBe(true);

    const pending = session.signInWithGithub();
    expect(p.opened).toEqual([`${AUTH_WORKER_ORIGIN}/auth?provider=github&site_id=blog.wahdany.eu&origin=https%3A%2F%2Fblog.wahdany.eu`]); // before any await
    expect(session.state().status).toBe('signing-in');

    p.answer({ provider: 'github', token: 'ghu_new', refresh_token: 'ghr_new', expires_in: 28800, refresh_token_expires_in: 15811200 });
    const state = await pending;
    expect(state).toMatchObject({ status: 'signed-in', method: 'app', verified: true, expiresAt: now() + 28800_000 });
    expect(shared.stored()).toMatchObject({ method: 'app', token: 'ghu_new', refreshToken: 'ghr_new', expiresAt: now() + 28800_000, refreshExpiresAt: now() + 15811200_000 });
    expect(w.gh.calls.map((c) => c.url)).toEqual(['https://api.github.com/user']);
  });

  it('a token the popup hands over that GitHub rejects is not stored', async () => {
    const w = world();
    const p = popupHost();
    const { session } = open(w, { host: p.host });
    const pending = session.signInWithGithub();
    p.answer({ token: 'forged' });
    expect((await caught(pending))?.reason).toBe('invalid-token');
    expect(session.state().status).toBe('signed-out');
  });

  it('cancelSignIn closes the popup and rejects as cancelled', async () => {
    const w = world();
    const p = popupHost();
    const { session, states } = open(w, { host: p.host });
    const pending = session.signInWithGithub();
    session.cancelSignIn();
    expect((await caught(pending))?.reason).toBe('cancelled');
    expect(p.popup.closed).toBe(true);
    expect(p.listeners.size).toBe(0);
    expect(states.at(-1)).toEqual({ status: 'signed-out' });
  });

  it('is marked unsupported on localhost, and without a window', () => {
    const w = world();
    expect(open(w, { host: popupHost('localhost').host }).session.popupSupported).toBe(false);
    expect(open(w, { host: popupHost('127.0.0.1').host }).session.popupSupported).toBe(false);
    expect(open(w).session.popupSupported).toBe(false);
  });
});

describe('a stored session', () => {
  it('is picked up on load, unverified until checked', async () => {
    const w = world();
    w.gh.state.tokens.add('ghu_1');
    const shared = sharedStorage();
    shared.map.set(AUTH_STORAGE_KEY, JSON.stringify(appSession()));
    const { session, states } = open(w, shared.tab());
    expect(session.state()).toMatchObject({ status: 'signed-in', verified: false, user: { login: 'dwahdany' } });
    const state = await session.verify();
    expect(state).toMatchObject({ status: 'signed-in', verified: true, user: { login: 'dwahdany', name: 'Dariush' } });
    expect(states.at(-1)?.verified).toBe(true);
    expect(shared.stored()?.user.name).toBe('Dariush'); // refreshed profile is kept
  });

  it('garbage in storage is not a session', () => {
    const w = world();
    for (const junk of ['{', '[]', '{"v":2,"token":"x"}', JSON.stringify({ v: 1, method: 'app', token: '', user: { login: 'a' } }), JSON.stringify({ v: 1, method: 'app', token: 'x' })]) {
      const shared = sharedStorage();
      shared.map.set(AUTH_STORAGE_KEY, junk);
      expect(open(w, shared.tab()).session.state()).toEqual({ status: 'signed-out' });
    }
  });

  it('a pasted token that was revoked is cleared on the 401, and listeners hear why', async () => {
    const w = world();
    const shared = sharedStorage();
    shared.map.set(AUTH_STORAGE_KEY, JSON.stringify(appSession({ method: 'token', token: 'revoked', refreshToken: undefined, expiresAt: undefined })));
    const { session, states } = open(w, shared.tab());
    const state = await session.verify();
    expect(state.status).toBe('signed-out');
    expect(state.ended?.reason).toBe('revoked');
    expect(shared.map.has(AUTH_STORAGE_KEY)).toBe(false);
    expect(states.at(-1)?.status).toBe('signed-out');
    expect(await session.token()).toBeUndefined();
  });

  it('being offline says nothing about the session: it stays, unverified', async () => {
    const w = world();
    w.gh.state.offline = true;
    const shared = sharedStorage();
    shared.map.set(AUTH_STORAGE_KEY, JSON.stringify(appSession()));
    const { session } = open(w, shared.tab());
    expect(await session.verify()).toMatchObject({ status: 'signed-in', verified: false });
    expect(shared.map.has(AUTH_STORAGE_KEY)).toBe(true);
  });

  it('signOut forgets it everywhere and tells listeners', async () => {
    const w = world();
    const shared = sharedStorage();
    shared.map.set(AUTH_STORAGE_KEY, JSON.stringify(appSession()));
    const a = open(w, shared.tab());
    const b = open(w, shared.tab());
    a.session.signOut();
    expect(shared.map.has(AUTH_STORAGE_KEY)).toBe(false);
    expect(a.states.at(-1)).toEqual({ status: 'signed-out' });
    expect(b.states.at(-1)).toEqual({ status: 'signed-out' }); // the other tab, through the storage event
    expect(await b.session.token()).toBeUndefined();
  });

  it('a sign-in in one tab signs the other tab in', async () => {
    const w = world();
    w.gh.state.tokens.add('pat');
    const shared = sharedStorage();
    const a = open(w, shared.tab());
    const b = open(w, shared.tab());
    await a.session.signInWithToken('pat');
    expect(b.session.state()).toMatchObject({ status: 'signed-in', user: { login: 'dwahdany' }, verified: false });
    expect(b.states.at(-1)?.status).toBe('signed-in');
    expect(await b.session.token()).toBe('pat');
  });

  it('works without any storage (private mode): the session lives in the tab', async () => {
    const w = world();
    w.gh.state.tokens.add('pat');
    const throwing: KeyValueStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      removeItem: () => {},
    };
    for (const storage of [null, throwing]) {
      const { session } = open(w, { storage });
      await session.signInWithToken('pat');
      expect(await session.token()).toBe('pat');
      session.signOut();
      expect(await session.token()).toBeUndefined();
    }
  });
});

describe('token refresh', () => {
  function signedIn(w: ReturnType<typeof world>, shared = sharedStorage(), extra: Partial<SessionOptions> = {}) {
    w.gh.state.tokens.add('ghu_1');
    if (!shared.map.has(AUTH_STORAGE_KEY)) shared.map.set(AUTH_STORAGE_KEY, JSON.stringify(appSession()));
    w.worker.valid.set('ghr_1', { token: 'ghu_2', refresh_token: 'ghr_2', expires_in: 28800, refresh_token_expires_in: 15811200 });
    return { ...open(w, { ...shared.tab(), ...extra }), shared };
  }

  it('hands out the stored token while it is fresh, without asking the worker', async () => {
    const w = world();
    const { session, advance } = signedIn(w);
    expect(await session.token()).toBe('ghu_1');
    advance(7 * HOUR + 50 * 60_000); // 10 minutes left
    expect(await session.token()).toBe('ghu_1');
    expect(w.worker.calls).toBe(0);
  });

  it('refreshes shortly before expiry: POST <worker>/refresh with the refresh token, and stores the rotation', async () => {
    const w = world();
    const { session, advance, shared, now, states } = signedIn(w);
    advance(7 * HOUR + 56 * 60_000); // 4 minutes left: inside the 5-minute margin
    expect(await session.token()).toBe('ghu_2');
    expect(w.worker.calls).toBe(1);
    expect(shared.stored()).toMatchObject({ token: 'ghu_2', refreshToken: 'ghr_2', expiresAt: now() + 28800_000, refreshExpiresAt: now() + 15811200_000, user: { login: 'dwahdany' } });
    expect(states.at(-1)).toMatchObject({ status: 'signed-in', expiresAt: now() + 28800_000 });
    // and the new one is fresh again
    expect(await session.token()).toBe('ghu_2');
    expect(w.worker.calls).toBe(1);
  });

  it('sends exactly { refresh_token } as JSON', async () => {
    const w = world();
    const seen: { url: string; method?: string; body: string; type: string | null }[] = [];
    const inner = w.fetch;
    const spy: typeof fetch = (input, init) => {
      if (String(input).endsWith('/refresh')) seen.push({ url: String(input), method: init?.method, body: String(init?.body), type: new Headers(init?.headers).get('content-type') });
      return inner(input, init);
    };
    const { session, advance } = signedIn(w, sharedStorage(), { fetch: spy });
    advance(8 * HOUR);
    await session.token();
    expect(seen).toEqual([{ url: `${AUTH_WORKER_ORIGIN}/refresh`, method: 'POST', body: '{"refresh_token":"ghr_1"}', type: 'application/json' }]);
  });

  it('keeps the old refresh token and lifetimes when the worker returns only a token', async () => {
    const w = world();
    const { session, advance, shared } = signedIn(w);
    w.worker.valid.set('ghr_1', { token: 'ghu_2' });
    advance(8 * HOUR);
    expect(await session.token()).toBe('ghu_2');
    expect(shared.stored()).toMatchObject({ token: 'ghu_2', refreshToken: 'ghr_1' });
    expect(shared.stored()?.expiresAt).toBeUndefined(); // unknown lifetime: no proactive refresh, the 401 path covers it
  });

  it('concurrent callers share one refresh', async () => {
    const w = world();
    const { session, advance } = signedIn(w);
    advance(8 * HOUR);
    let release = () => {};
    w.worker.gate = new Promise<void>((r) => (release = r));
    const all = Promise.all([session.token(), session.token(), session.token(), session.renew('ghu_1')]);
    release();
    expect(await all).toEqual(['ghu_2', 'ghu_2', 'ghu_2', 'ghu_2']);
    expect(w.worker.calls).toBe(1);
  });

  it('refreshes once on a 401 and the request goes through with the new token', async () => {
    const w = world();
    const { session, shared } = signedIn(w);
    w.gh.state.tokens.delete('ghu_1'); // GitHub expired it early; the clock says it is still fresh
    const token = (await session.token()) as string;
    const user = await sendRequest<{ login: string }>(
      'https://api.github.com/user',
      { headers: { Authorization: `token ${token}` } },
      { fetch: w.fetch, refreshAccessToken: async () => ((t) => (t ? { token: t } : undefined))(await session.renew(token)) },
    );
    expect(user.login).toBe('dwahdany');
    expect(w.worker.calls).toBe(1);
    expect(shared.stored()?.token).toBe('ghu_2');
  });

  it('ends the session when the refresh token is refused, and says it expired', async () => {
    const w = world();
    const { session, shared, states } = signedIn(w);
    w.worker.valid.clear();
    expect(await session.renew('ghu_1')).toBeUndefined();
    expect(session.state()).toMatchObject({ status: 'signed-out', ended: { reason: 'expired' } });
    expect(states.at(-1)?.status).toBe('signed-out');
    expect(shared.map.has(AUTH_STORAGE_KEY)).toBe(false);
  });

  it('only a refused refresh token ends the session: a worker without the route (404), a bad request (400) or a refused origin (403) keep it', async () => {
    for (const [status, body] of [
      [404, ''],
      [400, JSON.stringify({ error: 'invalid_request' })],
      [403, JSON.stringify({ error: 'origin_not_allowed' })],
      [405, ''],
    ] as const) {
      const w = world();
      const { session, shared } = signedIn(w, sharedStorage(), {
        fetch: async (input, init) => (String(input).endsWith('/refresh') ? new Response(body, { status }) : w.fetch(input, init)),
      });
      const err = await session.renew('ghu_1').then(() => undefined, (e: unknown) => e);
      expect(err, String(status)).toBeInstanceOf(RequestError);
      expect(session.state().status, String(status)).toBe('signed-in');
      expect(shared.stored()?.refreshToken, String(status)).toBe('ghr_1'); // the six-month token is still there
    }
  });

  it('a 400 that names the refresh token as bad (a worker passing GitHub’s answer through) does end it', async () => {
    const w = world();
    const { session } = signedIn(w, sharedStorage(), {
      fetch: async (input, init) =>
        String(input).endsWith('/refresh') ? new Response(JSON.stringify({ error: 'bad_refresh_token' }), { status: 400 }) : w.fetch(input, init),
    });
    expect(await session.renew('ghu_1')).toBeUndefined();
    expect(session.state()).toMatchObject({ status: 'signed-out', ended: { reason: 'expired' } });
  });

  it('ends the session when the refresh token itself has expired, without asking the worker', async () => {
    const w = world();
    const { session, advance } = signedIn(w);
    advance(4001 * HOUR);
    expect(await session.token()).toBeUndefined();
    expect(w.worker.calls).toBe(0);
    expect(session.state().ended?.reason).toBe('expired');
  });

  it('a 200 that carries an error instead of a token counts as refused', async () => {
    const w = world();
    const { session } = signedIn(w, sharedStorage(), {
      fetch: async (input, init) =>
        String(input).endsWith('/refresh') ? new Response(JSON.stringify({ error: 'bad_refresh_token' }), { status: 200 }) : w.fetch(input, init),
    });
    expect(await session.renew('ghu_1')).toBeUndefined();
    expect(session.state().status).toBe('signed-out');
  });

  it('a worker that is down or unreachable does not end the session', async () => {
    const w = world();
    const { session, advance, shared } = signedIn(w);
    advance(7 * HOUR + 58 * 60_000);
    w.worker.fail = 'offline';
    expect(await session.token()).toBe('ghu_1'); // the old one may still work
    w.worker.fail = 503;
    expect(await session.token()).toBe('ghu_1');
    const err = await session.renew('ghu_1').then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect(session.state().status).toBe('signed-in');
    expect(shared.stored()?.token).toBe('ghu_1');
    // back up: the next call succeeds with the SAME refresh token (it was never spent)
    w.worker.fail = undefined;
    expect(await session.token()).toBe('ghu_2');
  });

  it('a pasted token is never refreshed: a 401 ends the session', async () => {
    const w = world();
    const shared = sharedStorage();
    shared.map.set(AUTH_STORAGE_KEY, JSON.stringify(appSession({ method: 'token', token: 'pat', refreshToken: undefined, expiresAt: undefined })));
    const { session } = open(w, shared.tab());
    expect(await session.renew('pat')).toBeUndefined();
    expect(w.worker.calls).toBe(0);
    expect(session.state().ended?.reason).toBe('revoked');
  });

  describe('across tabs', () => {
    it('two tabs whose token expired refresh ONCE under the lock; the second takes the first one’s tokens', async () => {
      const w = world();
      const shared = sharedStorage();
      const locks = sharedLocks();
      const a = signedIn(w, shared, { locks });
      const b = open(w, { ...shared.tab(), locks });
      a.advance(8 * HOUR);
      b.advance(8 * HOUR);
      const [ta, tb] = await Promise.all([a.session.token(), b.session.token()]);
      expect([ta, tb]).toEqual(['ghu_2', 'ghu_2']);
      expect(w.worker.calls).toBe(1); // the single-use refresh token was spent once
      expect(b.session.state().status).toBe('signed-in');
    });

    it('a tab learns of another tab’s refresh from the storage event alone', async () => {
      const w = world();
      const shared = sharedStorage();
      const a = signedIn(w, shared);
      const b = open(w, shared.tab());
      a.advance(8 * HOUR);
      await a.session.token();
      expect(b.session.current()?.token).toBe('ghu_2');
      expect(await b.session.renew('ghu_1')).toBe('ghu_2'); // a request that failed with the old token just retries
      expect(w.worker.calls).toBe(1);
    });

    it('without Web Locks: the loser of the race looks at the storage again instead of signing out', async () => {
      const w = world();
      const shared = sharedStorage();
      const a = signedIn(w, shared);
      const b = open(w, shared.tab());
      a.advance(8 * HOUR);
      b.advance(8 * HOUR);
      // Both read the same stale session and both ask the worker; only one refresh token use can succeed.
      const [ta, tb] = await Promise.all([a.session.token(), b.session.token()]);
      expect(w.worker.calls).toBe(2);
      expect([ta, tb]).toEqual(['ghu_2', 'ghu_2']);
      expect(a.session.state().status).toBe('signed-in');
      expect(b.session.state().status).toBe('signed-in');
      expect(shared.stored()?.token).toBe('ghu_2');
    });
  });
});
