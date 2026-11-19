/**
 * The sign-in popup and its handshake with the auth worker.
 *
 * Lifted from Sveltia CMS — https://github.com/sveltia/sveltia-cms (fork dwahdany/sveltia-cms)
 * at commit 06d5552aa, `src/lib/services/backends/git/shared/auth.js` (lines 63-84, 136-144,
 * 163-298, 310-339) and `backends/git/github/auth.js` (19-38, the token page URL).
 * Copyright (c) 2026 Kohei Yoshino. MIT License: see src/write/licenses/sveltia-MIT.txt.
 * Changes: TypeScript; GitHub only; the BroadcastChannel/`state` branch, localisation (`_()`),
 * `createRawState` and the Gitea check are dropped; `site_id` is this page's hostname and `origin`
 * its origin (the forked worker prefers `origin`); the window
 * is injectable (tests); failures are typed `AuthError`s; the result also carries the refresh token
 * and lifetimes a GitHub App issues; `beginAuthorization` is synchronous up to and including
 * `window.open`, so the popup opens inside the tap that asked for it.
 *
 * Protocol (the one Netlify/Decap CMS authenticators use, as the forked worker speaks it):
 *   1. the popup posts `authorizing:github` to its opener, addressed to the ONE allow-listed
 *      origin it was started for (the `origin` sent, else `https://<site_id>`) — never to `*`;
 *   2. the opener echoes the same string to the popup, addressed to the WORKER'S ORIGIN;
 *   3. the popup posts `authorization:github:success:{…}` or `authorization:github:error:{…}`,
 *      again to that one origin only.
 * A message is accepted only when it comes from the popup window itself, from the worker's origin,
 * and is a string — so no other window, even on this origin, can take part or inject a token.
 *
 * What the worker does NOT post: a refusal it decides before it trusts an origin — a site that is
 * not on its allow-list (`UNSUPPORTED_DOMAIN`), an unknown provider, a missing or forged state
 * cookie. Those are only shown as text in the popup. The opener then hears nothing until the
 * window is closed, which is why a closed window is reported with a hint (see `beginAuthorization`).
 */
import { AuthError } from '../../contracts';

export const PROVIDER = 'github';

/** The message the popup sends to start the handshake, which the opener sends back to ask for the result. */
export const formatHandshakeMessage = (provider: string = PROVIDER): string => `authorizing:${provider}`;

/** Extract the serialised result from an `authorization:{provider}:{status}:{result}` message. */
export const parseResultMessage = (provider: string, data: string): string | undefined =>
  data.match(`^authorization:${provider}:(success|error):(?<result>.+)`)?.groups?.result;

/** What the popup hands back on success. Lifetimes are in seconds, as GitHub reports them. */
export interface PopupTokens {
  token: string;
  refreshToken?: string;
  /** Seconds until `token` expires (28800 for a GitHub App user token). */
  expiresIn?: number;
  /** Seconds until `refreshToken` expires (about six months). */
  refreshTokenExpiresIn?: number;
}

/** The parts of `window` the flow uses. */
export interface PopupHost {
  open(url: string, target: string, features: string): PopupWindow | null;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  screen?: { availWidth?: number; availHeight?: number };
  /** `origin` is sent to the worker as well (it prefers it to `site_id`); absent only in a test double. */
  location: { hostname: string; origin?: string };
}
export interface PopupWindow {
  closed: boolean;
  close(): void;
  postMessage(message: unknown, targetOrigin: string): void;
}

/**
 * The popup URL: `<worker>/auth?provider=github&site_id=<hostname>&origin=<origin>`. The worker
 * checks the site against its allow-list of exact origins: it takes the site from `origin` when
 * that is there, otherwise from `https://<site_id>` (what Sveltia CMS sends). Both are sent, so
 * the exact origin of this page is what is checked (scheme and port included) and a worker that
 * only knows `site_id` still works. No `scope`: the worker reads only `provider`, `site_id` and
 * `origin` from the query (its scope comes from its own `GITHUB_SCOPE` setting), and a GitHub App
 * takes its permissions from the App anyway.
 */
export function authUrl(workerOrigin: string, hostname: string, origin?: string): string {
  const params = new URLSearchParams({ provider: PROVIDER, site_id: hostname });
  // An opaque origin (`null`, a sandboxed frame) is nothing the worker could allow or post to.
  if (origin && origin !== 'null') params.set('origin', origin);
  return `${workerOrigin}/auth?${params}`;
}

/** Open the sign-in popup, centred. Returns null when the browser refuses. */
export function openPopup(host: PopupHost, url: string): PopupWindow | null {
  const width = 600;
  const height = 800;
  const { availHeight = height, availWidth = width } = host.screen ?? {};
  const top = Math.max(0, availHeight / 2 - height / 2);
  const left = Math.max(0, availWidth / 2 - width / 2);

  try {
    return host.open(url, 'auth', `width=${width},height=${height},top=${top},left=${left}`);
  } catch {
    return null;
  }
}

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Turn the popup's result object into tokens or a typed error. */
export function readResult(resultStr: string | undefined): PopupTokens | AuthError {
  let result: unknown;
  try {
    result = resultStr ? JSON.parse(resultStr) : undefined;
  } catch {
    result = undefined;
  }
  if (typeof result !== 'object' || result === null || Array.isArray(result))
    return new AuthError('Sign-in did not complete: the sign-in service sent an answer that could not be read.', 'failed');

  const r = result as Record<string, unknown>;
  const token = str(r.token);
  if (token) {
    return {
      token,
      refreshToken: str(r.refresh_token) ?? str(r.refreshToken),
      expiresIn: num(r.expires_in) ?? num(r.expiresIn),
      refreshTokenExpiresIn: num(r.refresh_token_expires_in) ?? num(r.refreshTokenExpiresIn),
    };
  }
  const code = str(r.errorCode);
  const said = str(r.error) ?? 'no reason given';
  // The forked worker never posts this one (it only shows it in the popup, see the header); kept
  // for a worker that does.
  if (code === 'UNSUPPORTED_DOMAIN')
    return new AuthError('The sign-in service does not accept this address. Sign in with an access token instead.', 'unsupported-domain');
  return new AuthError(`Sign-in did not complete: ${said}${code ? ` (${code})` : ''}.`, 'rejected');
}

export interface Authorization {
  /** Resolves with the tokens; rejects with `AuthError`. */
  result: Promise<PopupTokens>;
  /** Close the popup and reject with reason 'cancelled'. No effect once settled. */
  cancel(): void;
}

export interface AuthorizeOptions {
  host: PopupHost;
  workerOrigin: string;
  /** How often to look whether the popup was closed. Default 1000 ms. */
  pollMs?: number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/**
 * Open the popup and wait for the worker's answer. Everything up to `window.open` runs in the
 * caller's own turn — call this directly from the click handler, with no `await` before it.
 */
export function beginAuthorization(options: AuthorizeOptions): Authorization {
  const { host, workerOrigin, pollMs = 1000 } = options;
  const startTimer = options.setInterval ?? ((fn, ms) => setInterval(fn, ms));
  const stopTimer = options.clearInterval ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>));
  const origin = new URL(workerOrigin).origin;
  const popup = openPopup(host, authUrl(workerOrigin, host.location.hostname, host.location.origin));

  // Without a popup, there is no window the result could come from
  if (!popup) {
    return {
      result: Promise.reject(
        new AuthError('The sign-in window could not be opened. Allow pop-ups for this site, or sign in with an access token.', 'popup-blocked'),
      ),
      cancel: () => {},
    };
  }

  let settled = false;
  let cancel = () => {};

  const result = new Promise<PopupTokens>((resolve, reject) => {
    let timer: unknown;

    /** Message handler. Only messages from the popup itself, from the worker's origin, are handled. */
    const handler = (event: MessageEvent) => {
      const { origin: from, data, source } = event;
      if (source !== (popup as unknown) || from !== origin || typeof data !== 'string') return;

      // First message: answer the handshake, addressed to the worker's origin only
      if (data === formatHandshakeMessage()) {
        popup.postMessage(data, origin);
        return;
      }

      // Second message: the result. Anything else from the popup is ignored.
      const serialised = parseResultMessage(PROVIDER, data);
      if (serialised === undefined) return;
      const outcome = readResult(serialised);
      finish();
      if (outcome instanceof AuthError) reject(outcome);
      else resolve(outcome);
    };

    /** Stop listening, on every exit path, so a cancelled sign-in leaves nothing attached to the window. */
    const finish = () => {
      settled = true;
      host.removeEventListener('message', handler);
      stopTimer(timer);
      try {
        popup.close();
      } catch {
        /* already gone */
      }
    };

    const giveUp = (message: string) => {
      if (settled) return;
      finish();
      reject(new AuthError(message, 'cancelled'));
    };
    cancel = () => giveUp('Sign-in was cancelled.');

    host.addEventListener('message', handler);
    timer = startTimer(() => {
      // Closed without an answer: the owner gave up, or the window showed a refusal the worker
      // does not post (this address is not on its list, the sign-in session expired).
      if (popup.closed) giveUp('The sign-in window was closed before sign-in finished. If it showed an error, sign in with an access token instead.');
    }, pollMs);
  });

  return { result, cancel: () => cancel() };
}

/**
 * The GitHub page for creating a fine-grained personal access token, with the name and the one
 * permission the app needs (Contents: read and write) prefilled. The owner still has to choose
 * "Only select repositories" and pick the repo; GitHub's template URLs cannot do that.
 * @see https://github.blog/changelog/2025-08-26-template-urls-for-fine-grained-pats-and-updated-permissions-ui/
 */
export function tokenPageUrl(repo: { owner: string; name: string }): string {
  const params = new URLSearchParams({
    name: `write (${repo.name})`,
    description: `Publishing to ${repo.owner}/${repo.name} from /write`,
    target_name: repo.owner,
    contents: 'write',
  });
  return `https://github.com/settings/personal-access-tokens/new?${params}`;
}
