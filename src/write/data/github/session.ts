/**
 * The signed-in session: who, with which token, and keeping that token alive.
 *
 * New code. The conventions follow Sveltia CMS (fork dwahdany/sveltia-cms at 06d5552aa):
 * `backends/git/shared/user.js:24-54` (validate with `GET /user`, `Authorization: token …`) and
 * `backends/git/shared/api.js:49-257` (one shared refresh, a Web Lock across tabs, taking over the
 * tokens another tab has stored instead of spending a single-use refresh token twice).
 * Copyright (c) 2026 Kohei Yoshino for those parts. MIT License: see src/write/licenses/sveltia-MIT.txt.
 *
 * Two ways in (`AuthMethod`):
 *   'app'    the GitHub App's web flow in a popup through the auth worker. The user token lasts
 *            8 hours and comes with a single-use refresh token (about six months).
 *   'token'  a pasted personal access token. No refresh; a 401 ends the session.
 *
 * Storage: ONE localStorage entry (`AUTH_STORAGE_KEY`), /write's own. It is the truth for every
 * tab: each tab re-reads it before handing out a token and on `storage` events, so a sign-in, a
 * sign-out or a refresh made in one tab is picked up by the others.
 *
 * Refresh (`POST <worker>/refresh` with `{ refresh_token }`):
 *   - before a request, when the token expires within `refreshMarginMs` (5 minutes);
 *   - once after a 401 (`renew`), in case the clock or GitHub disagrees about the expiry;
 *   - callers that arrive while a refresh is running share it;
 *   - across tabs the refresh runs under a Web Lock, and inside the lock the stored session is
 *     read again first: if another tab already refreshed, its tokens are used. Without Web Locks
 *     a refused refresh is followed by one more look at the storage before the session is ended.
 *   - only the worker's 401 (`bad_refresh_token`) ends the session; a refresh that fails for any
 *     other reason (offline, 5xx, a worker without the route, a refused origin) leaves it alone.
 */
import { AUTH_STORAGE_KEY, AUTH_WORKER_ORIGIN, AuthError, type AuthApi, type AuthMethod, type AuthState, type AuthUser } from '../../contracts';
import { beginAuthorization, tokenPageUrl, type Authorization, type PopupHost, type PopupTokens } from './auth';
import { classifyFailure } from './client';
import { RequestError, SEND_FAILED, isLocalHostname, sendRequest } from './http';

const API = 'https://api.github.com';

export interface StoredSession {
  v: 1;
  method: AuthMethod;
  token: string;
  refreshToken?: string;
  /** Epoch ms the access token expires. */
  expiresAt?: number;
  /** Epoch ms the refresh token expires. */
  refreshExpiresAt?: number;
  user: AuthUser;
  /** Epoch ms this entry was last written. */
  savedAt: number;
}

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LockManagerLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface SessionOptions {
  repo: { owner: string; name: string };
  /** Defaults to `AUTH_WORKER_ORIGIN`. */
  workerOrigin?: string;
  /** Defaults to `AUTH_STORAGE_KEY`. */
  storageKey?: string;
  /** Defaults to `localStorage`; null = keep the session in memory only (this tab, this page load). */
  storage?: KeyValueStorage | null;
  fetch?: typeof fetch;
  now?: () => number;
  /** The window, for the popup. Defaults to `window`; null where there is none. */
  host?: PopupHost | null;
  /** Subscribes to changes of the storage made by OTHER tabs. Defaults to the window's `storage` event. */
  onStorage?: (listener: (key: string | null) => void) => () => void;
  /** Defaults to `navigator.locks`; null = no cross-tab lock. */
  locks?: LockManagerLike | null;
  /** Refresh when the token expires within this many ms. Default 5 minutes. */
  refreshMarginMs?: number;
  /** Wait before the second look at the storage after a refused refresh (no Web Locks). Default 400 ms. */
  secondLookMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Popup closed-poll interval (tests). */
  pollMs?: number;
}

export interface Session extends AuthApi {
  /**
   * The access token to send with a request now, refreshed first when it is about to expire.
   * `undefined` when nobody is signed in.
   */
  token(): Promise<string | undefined>;
  /**
   * A request sent with `failedToken` was answered 401. Resolves with a token to try once more
   * (refreshed here, or already replaced by another tab), or `undefined` when the session is over
   * (it has then been ended and listeners told). Rejects when the refresh did not get a verdict on
   * the refresh token (offline, a worker that is down or lacks the route): the session is kept.
   */
  renew(failedToken: string): Promise<string | undefined>;
  /** The stored session, as this tab last read it. */
  current(): StoredSession | undefined;
  /** Stop listening to other tabs (tests). */
  dispose(): void;
}

const LOCK_NAME = 'write:auth:refresh';

const ENDED = {
  expired: 'You were signed out because the sign-in expired. Sign in again to publish.',
  revoked: 'You were signed out because GitHub no longer accepts the access token. Sign in again to publish.',
} as const;

function parse(raw: string | null): StoredSession | undefined {
  if (!raw) return undefined;
  try {
    const s = JSON.parse(raw) as Partial<StoredSession> | null;
    if (!s || s.v !== 1 || typeof s.token !== 'string' || s.token === '' || (s.method !== 'app' && s.method !== 'token')) return undefined;
    if (!s.user || typeof s.user.login !== 'string') return undefined;
    return s as StoredSession;
  } catch {
    return undefined;
  }
}

function defaultStorage(): KeyValueStorage | null {
  try {
    const ls = (globalThis as { localStorage?: KeyValueStorage }).localStorage;
    if (!ls) return null;
    ls.getItem(AUTH_STORAGE_KEY); // throws where storage is blocked
    return ls;
  } catch {
    return null;
  }
}

function toUser(body: unknown): AuthUser | undefined {
  const u = body as { login?: unknown; name?: unknown; avatar_url?: unknown; id?: unknown } | null;
  if (!u || typeof u.login !== 'string' || u.login === '') return undefined;
  const user: AuthUser = { login: u.login };
  if (typeof u.name === 'string' && u.name !== '') user.name = u.name;
  if (typeof u.avatar_url === 'string' && u.avatar_url !== '') user.avatarUrl = u.avatar_url;
  if (typeof u.id === 'number') user.id = u.id;
  return user;
}

/** A 403/429 that is a rate limit rather than a refusal: the client's one predicate for it. */
const isRateLimitError = (err: unknown): boolean => classifyFailure(err).kind === 'rate-limited';

export function createSession(options: SessionOptions): Session {
  const workerOrigin = options.workerOrigin ?? AUTH_WORKER_ORIGIN;
  const key = options.storageKey ?? AUTH_STORAGE_KEY;
  const storage = options.storage === undefined ? defaultStorage() : options.storage;
  const now = options.now ?? Date.now;
  const margin = options.refreshMarginMs ?? 5 * 60_000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const host = options.host === undefined ? ((globalThis as { window?: unknown }).window as PopupHost | undefined) ?? null : options.host;
  const locks =
    options.locks === undefined
      ? (((globalThis as { navigator?: { locks?: LockManagerLike } }).navigator?.locks as LockManagerLike | undefined) ?? null)
      : options.locks;
  const send = <T>(url: string, init: Parameters<typeof sendRequest>[1], opts: Parameters<typeof sendRequest>[2] = {}) =>
    sendRequest<T>(url, init, { fetch: options.fetch, sleep: options.sleep, ...opts });

  const listeners = new Set<(state: AuthState) => void>();
  /** In-memory copy for a browser without usable storage. */
  let memoryRaw: string | null = null;
  let lastRaw: string | null = null;
  let session: StoredSession | undefined;
  let signingIn = false;
  let verified = false;
  let ended: AuthState['ended'];
  let pending: Authorization | undefined;
  let refreshing: Promise<string | undefined> | undefined;
  let verifying: Promise<AuthState> | undefined;

  /** The storage refused a write (full, or blocked): from then on the session lives in this tab only. */
  let memoryOnly = false;

  const readRaw = (): string | null => {
    if (!storage || memoryOnly) return memoryRaw;
    try {
      return storage.getItem(key);
    } catch {
      return memoryRaw;
    }
  };

  function state(): AuthState {
    if (signingIn) return ended ? { status: 'signing-in', ended } : { status: 'signing-in' };
    if (!session) return ended ? { status: 'signed-out', ended } : { status: 'signed-out' };
    const s: AuthState = { status: 'signed-in', user: session.user, method: session.method, verified };
    if (session.expiresAt !== undefined) s.expiresAt = session.expiresAt;
    return s;
  }

  const notify = () => {
    const s = state();
    listeners.forEach((l) => l(s));
  };

  /** Take over what the storage holds now. Tells listeners when who is signed in changed. */
  function sync(): void {
    const raw = readRaw();
    if (raw === lastRaw) return;
    const before = session;
    lastRaw = raw;
    session = parse(raw);
    if (session?.token !== before?.token || session?.user.login !== before?.user.login) {
      // Signed in or out elsewhere: what this tab knew about the old session no longer applies.
      if (session?.user.login !== before?.user.login || session?.method !== before?.method) verified = false;
      if (session) ended = undefined;
      notify();
    }
  }

  function write(next: StoredSession): void {
    const raw = JSON.stringify(next);
    memoryRaw = raw;
    try {
      if (!memoryOnly) storage?.setItem(key, raw);
    } catch {
      memoryOnly = true;
    }
    lastRaw = raw;
    session = next;
  }

  function clear(): void {
    memoryRaw = null;
    try {
      storage?.removeItem(key);
    } catch {
      /* nothing stored */
    }
    lastRaw = readRaw();
    session = undefined;
    verified = false;
  }

  function end(reason: 'expired' | 'revoked'): void {
    clear();
    ended = { reason, message: ENDED[reason] };
    notify();
  }

  const authHeaders = (token: string) => ({ Authorization: `token ${token}`, Accept: 'application/vnd.github+json' });

  /** Who a token belongs to. Typed failures; never stores anything. */
  async function fetchUser(token: string): Promise<AuthUser> {
    let body: unknown;
    try {
      body = await send(`${API}/user`, { headers: authHeaders(token) });
    } catch (err) {
      throw asAuthError(err, 'GitHub does not accept this sign-in.');
    }
    const user = toUser(body);
    if (!user) throw new AuthError('GitHub answered, but not with an account. Try again.', 'failed');
    return user;
  }

  function asAuthError(err: unknown, rejected: string): AuthError {
    if (err instanceof AuthError) return err;
    if (err instanceof RequestError) {
      if (err.status === 401) return new AuthError(rejected, 'invalid-token', { cause: err });
      if (isRateLimitError(err)) return new AuthError('GitHub is limiting requests right now. Try again in a few minutes.', 'rate-limited', { cause: err });
      if (err.status === undefined && err.message === SEND_FAILED)
        return new AuthError('GitHub cannot be reached — this device seems to be offline.', 'offline', { cause: err });
      return new AuthError(`Sign-in could not be checked with GitHub${err.status ? ` (${err.status})` : ''}. Try again.`, 'failed', { cause: err });
    }
    return new AuthError('Sign-in could not be completed. Try again.', 'failed', { cause: err });
  }

  /**
   * May this token push to the repo? `GET /repos/<owner>/<name>` reports the permissions of the
   * account the token acts for. That is necessary, not sufficient: a fine-grained token (or an App
   * installation) that does not cover the repo still shows the owner's own `push: true` on a public
   * repo, and is only refused by the first commit (`SaveError`, reason 'forbidden').
   */
  async function checkPush(token: string): Promise<void> {
    const repoName = `${options.repo.owner}/${options.repo.name}`;
    let body: { permissions?: { push?: unknown } } | undefined;
    try {
      body = await send(`${API}/repos/${options.repo.owner}/${options.repo.name}`, { headers: authHeaders(token) });
    } catch (err) {
      if (err instanceof RequestError && err.status === 404)
        throw new AuthError(`This sign-in cannot see ${repoName}. Give it access to that repository and try again.`, 'no-access', { cause: err });
      if (err instanceof RequestError && err.status === 403 && !isRateLimitError(err))
        throw new AuthError(`This sign-in is not allowed to read ${repoName}.`, 'no-access', { cause: err });
      throw asAuthError(err, 'GitHub does not accept this sign-in.');
    }
    if (body?.permissions?.push !== true)
      throw new AuthError(`This sign-in may read ${repoName} but not write to it. It needs “Contents: read and write” on that repository.`, 'no-push');
  }

  /** Sign-ins under way (a second one can start while the first is being cancelled). */
  let attempts = 0;

  async function finishSignIn(run: () => Promise<StoredSession>, authorization?: Authorization): Promise<AuthState> {
    attempts += 1;
    signingIn = true;
    notify();
    try {
      const next = await run();
      write(next);
      verified = true;
      ended = undefined;
    } finally {
      attempts -= 1;
      signingIn = attempts > 0;
      if (pending === authorization) pending = undefined;
      notify();
    }
    return state();
  }

  const withLock = <T>(run: () => Promise<T>): Promise<T> => (locks ? locks.request(LOCK_NAME, run) : run());

  /** Exchange the refresh token. Resolves with the token to use, or undefined when the session is over. */
  function refresh(staleToken: string): Promise<string | undefined> {
    refreshing ??= withLock(async (): Promise<string | undefined> => {
      sync();
      if (!session) return undefined;
      // Another tab (or an earlier caller) already replaced the token.
      if (session.token !== staleToken) return session.token;
      const refreshToken = session.refreshToken;
      if (!refreshToken) return session.token;
      if (session.refreshExpiresAt !== undefined && now() >= session.refreshExpiresAt) {
        end('expired');
        return undefined;
      }

      /** The refresh token was not accepted. It is single-use: maybe another tab spent it a moment ago. */
      const refused = async (): Promise<string | undefined> => {
        await sleep(options.secondLookMs ?? 400);
        sync();
        if (session && session.token !== staleToken) return session.token;
        if (session) end('expired');
        return undefined;
      };

      let body: { token?: unknown; refresh_token?: unknown; expires_in?: unknown; refresh_token_expires_in?: unknown } | undefined;
      try {
        body = await send(`${workerOrigin}/refresh`, { method: 'POST', body: { refresh_token: refreshToken } }, { retryable: false });
      } catch (err) {
        // The worker says the REFRESH TOKEN is no good with 401 (`bad_refresh_token`); a worker that
        // passes GitHub's answer through may say it with 400. Nothing else is a verdict on the
        // token: 404/405 is a worker without this route (an old build, a rollback), 400
        // `invalid_request` a malformed call, 403 a refused origin, 5xx trouble on the way. Ending
        // the session for those would throw away a refresh token that is good for six months.
        const status = err instanceof RequestError ? err.status : undefined;
        const said = err instanceof RequestError ? err.detail : undefined;
        if (status === 401 || (status === 400 && said === 'bad_refresh_token')) return refused();
        throw err;
      }
      // GitHub reports a failed refresh with 200 and an `error`; a worker may pass that through.
      if (!body || typeof body.token !== 'string' || body.token === '') return refused();

      const at = now();
      const seconds = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);
      const base = session as StoredSession;
      const next: StoredSession = { ...base, token: body.token, savedAt: at };
      if (typeof body.refresh_token === 'string' && body.refresh_token !== '') next.refreshToken = body.refresh_token;
      const expiresIn = seconds(body.expires_in);
      if (expiresIn !== undefined) next.expiresAt = at + expiresIn * 1000;
      else delete next.expiresAt;
      const refreshIn = seconds(body.refresh_token_expires_in);
      if (refreshIn !== undefined) next.refreshExpiresAt = at + refreshIn * 1000;
      write(next);
      notify();
      return next.token;
    }).finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  }

  const stopStorage = (
    options.onStorage ??
    ((listener: (key: string | null) => void) => {
      const w = (globalThis as { window?: { addEventListener?: Function; removeEventListener?: Function } }).window;
      if (!w?.addEventListener) return () => {};
      const handler = (e: { key: string | null }) => listener(e.key);
      w.addEventListener('storage', handler);
      return () => w.removeEventListener?.('storage', handler);
    })
  )((changed) => {
    if (changed === null || changed === key) sync();
  });

  // What an earlier visit left.
  lastRaw = readRaw();
  session = parse(lastRaw);

  const api: Session = {
    state,

    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },

    popupSupported: !!host && !isLocalHostname(host.location.hostname),
    tokenHelpUrl: tokenPageUrl(options.repo),

    // NOT `async`: the popup must be opened in the caller's own turn (see ./auth.ts).
    signInWithGithub() {
      if (!host) return Promise.reject(new AuthError('There is no window to sign in from.', 'popup-blocked'));
      pending?.cancel();
      const authorization = beginAuthorization({ host, workerOrigin, pollMs: options.pollMs });
      pending = authorization;
      return finishSignIn(async () => {
        const tokens: PopupTokens = await authorization.result;
        const user = await fetchUser(tokens.token);
        const at = now();
        const next: StoredSession = { v: 1, method: 'app', token: tokens.token, user, savedAt: at };
        if (tokens.refreshToken) next.refreshToken = tokens.refreshToken;
        if (tokens.expiresIn) next.expiresAt = at + tokens.expiresIn * 1000;
        if (tokens.refreshTokenExpiresIn) next.refreshExpiresAt = at + tokens.refreshTokenExpiresIn * 1000;
        return next;
      }, authorization);
    },

    cancelSignIn() {
      pending?.cancel();
    },

    signInWithToken(input) {
      const token = String(input ?? '').trim();
      if (token === '' || /\s/.test(token)) return Promise.reject(new AuthError('That does not look like an access token.', 'invalid-token'));
      return finishSignIn(async () => {
        const user = await fetchUser(token);
        await checkPush(token);
        return { v: 1, method: 'token', token, user, savedAt: now() };
      });
    },

    signOut() {
      pending?.cancel();
      clear();
      ended = undefined;
      notify();
    },

    verify() {
      verifying ??= (async (): Promise<AuthState> => {
        const token = await api.token();
        if (!token) return state();
        let body: unknown;
        try {
          body = await send(
            `${API}/user`,
            { headers: authHeaders(token) },
            {
              refreshAccessToken: async () => {
                const renewed = await api.renew(token);
                return renewed ? { token: renewed } : undefined;
              },
            },
          );
        } catch (err) {
          // Still 401 after the one refresh: the session is over (if `renew` has not ended it already).
          if (err instanceof RequestError && err.status === 401 && session) end(session.method === 'token' || !session.refreshToken ? 'revoked' : 'expired');
          // Anything else (offline, rate limit, 5xx) says nothing about the session: keep it, unverified.
          return state();
        }
        const user = toUser(body);
        if (user && session) {
          if (JSON.stringify(user) !== JSON.stringify(session.user)) write({ ...session, user, savedAt: now() });
          verified = true;
          notify();
        }
        return state();
      })().finally(() => {
        verifying = undefined;
      });
      return verifying;
    },

    async token() {
      sync();
      if (!session) return undefined;
      const { token, expiresAt, refreshToken } = session;
      if (refreshToken && expiresAt !== undefined && now() >= expiresAt - margin) {
        try {
          return await refresh(token);
        } catch {
          // Could not refresh right now. The old token may still work; if not, the request's 401 says so.
          return session?.token;
        }
      }
      return token;
    },

    async renew(failedToken) {
      sync();
      if (!session) return undefined;
      if (session.token !== failedToken) return session.token;
      if (!session.refreshToken) {
        end(session.method === 'token' ? 'revoked' : 'expired');
        return undefined;
      }
      return refresh(failedToken);
    },

    current: () => session,

    dispose() {
      stopStorage();
      pending?.cancel();
      listeners.clear();
    },
  };

  return api;
}
