/**
 * The GitHub API client: REST and GraphQL for one repo, with the session's token.
 *
 * New code, replacing Sveltia's `backends/git/shared/api.js:274-379` (which reads module
 * singletons); `isRateLimited` is lifted from `backends/git/github/repository.js:46-49`
 * (fork dwahdany/sveltia-cms at 06d5552aa). Copyright (c) 2026 Kohei Yoshino for that part.
 * MIT License: see src/write/licenses/sveltia-MIT.txt.
 *
 * Every request carries `Authorization: token <t>` when someone is signed in (5000 requests an hour
 * instead of 60 per IP) and goes out anonymously otherwise. A 401 gets ONE refreshed retry
 * (`Session.renew`); if that fails the session has been ended and the 401 is thrown.
 */
import { RequestError, SEND_FAILED, sendRequest, type RequestOptions, type SendOptions } from './http';

export const GITHUB_API = 'https://api.github.com';

export interface RepoRef {
  owner: string;
  name: string;
  branch: string;
}

/** The part of the session the client needs. */
export interface TokenSource {
  token(): Promise<string | undefined>;
  renew(failedToken: string): Promise<string | undefined>;
}

export interface ClientOptions {
  repo: RepoRef;
  /** Absent: every request is anonymous. */
  auth?: TokenSource;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface CallOptions {
  responseType?: SendOptions['responseType'];
  retryable?: boolean;
  signal?: AbortSignal;
}

export interface GithubClient {
  readonly repo: RepoRef;
  /** `https://api.github.com/repos/<owner>/<name>` */
  readonly repoUrl: string;
  /** REST. `path` is absolute (`https://…`) or starts with `/` (relative to api.github.com). */
  rest<T = unknown>(path: string, init?: RequestOptions, options?: CallOptions): Promise<T>;
  /** REST under `/repos/<owner>/<name>`; `path` starts with `/`. */
  repoRest<T = unknown>(path: string, init?: RequestOptions, options?: CallOptions): Promise<T>;
  /** GraphQL; resolves with `data`. A response carrying `errors` rejects (`RequestError`, `types` set). */
  graphql<T = unknown>(query: string, variables?: Record<string, unknown>, options?: CallOptions): Promise<T>;
  /** Whether a token is available right now. */
  hasToken(): Promise<boolean>;
}

export function createGithubClient(options: ClientOptions): GithubClient {
  const { repo, auth } = options;
  const repoUrl = `${GITHUB_API}/repos/${repo.owner}/${repo.name}`;

  async function call<T>(url: string, init: RequestOptions = {}, opts: CallOptions = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (!headers.has('Accept')) headers.set('Accept', 'application/vnd.github+json');
    const token = await auth?.token();
    if (token) headers.set('Authorization', `token ${token}`);
    return sendRequest<T>(
      url,
      { ...init, headers, signal: opts.signal ?? init.signal },
      {
        responseType: opts.responseType,
        retryable: opts.retryable,
        fetch: options.fetch,
        sleep: options.sleep,
        refreshAccessToken:
          token && auth
            ? async () => {
                const renewed = await auth.renew(token);
                return renewed ? { token: renewed } : undefined;
              }
            : undefined,
      },
    );
  }

  return {
    repo,
    repoUrl,
    rest: (path, init, opts) => call(path.startsWith('/') ? GITHUB_API + path : path, init, opts),
    repoRest: (path, init, opts) => call(repoUrl + path, init, opts),
    async graphql<T>(query: string, variables: Record<string, unknown> = {}, opts: CallOptions = {}) {
      const body = { query: query.replace(/\s+/g, ' ').trim(), variables };
      const result = await call<{ data?: T }>(`${GITHUB_API}/graphql`, { method: 'POST', body }, opts);
      return result?.data as T;
    },
    hasToken: async () => !!(await auth?.token()),
  };
}

/**
 * Check if the given response or failed request was rate limited: a 429, or a 403 that says how
 * long to wait or that no request is left. GitHub answers a spent primary limit with a 403, the
 * same status it uses to refuse access, so the remaining-request count is what tells the two apart.
 */
export const isRateLimited = ({ status, headers }: { status?: number; headers?: Headers }): boolean =>
  status === 429 || ((status === 403 || status === 429) && (headers?.get('retry-after') != null || headers?.get('x-ratelimit-remaining') === '0'));

/** When a rate-limited request may be sent again (epoch ms), if the response said. */
export function rateLimitReset(headers: Headers | undefined, now: number = Date.now()): number | undefined {
  const retryAfter = headers?.get('retry-after');
  if (retryAfter != null && /^\d+$/.test(retryAfter.trim())) return now + Number(retryAfter) * 1000;
  const reset = Number(headers?.get('x-ratelimit-reset'));
  return Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined;
}

export type FailureKind =
  /** no response: offline, or a request the server dropped */
  | 'offline'
  /** 401 that survived the one refresh: the session is over */
  | 'unauthorized'
  /** the token may not do this ("Resource not accessible by integration / personal access token", FORBIDDEN) */
  | 'forbidden'
  | 'rate-limited'
  | 'not-found'
  /** 409 / 422 / GraphQL STALE_DATA: the request no longer fits the repository's state */
  | 'conflict'
  | 'too-large'
  | 'other';

const NOT_ACCESSIBLE = /resource not accessible|not accessible by|must have (?:push|write) access|permission to/i;

/** Sort a thrown value into the handful of cases callers treat differently. */
export function classifyFailure(err: unknown): { kind: FailureKind; status?: number; detail?: string; retryAt?: number } {
  if (!(err instanceof RequestError)) return { kind: 'other' };
  const { status, detail, headers, types } = err;
  const base = { status, detail };
  if (status === undefined && err.message === SEND_FAILED) return { kind: 'offline', ...base };
  if (status === 401) return { kind: 'unauthorized', ...base };
  if (isRateLimited({ status, headers }) || ((status === 403 || status === 200) && /rate limit/i.test(detail ?? '')) || types.includes('RATE_LIMITED'))
    return { kind: 'rate-limited', ...base, retryAt: rateLimitReset(headers) };
  if (status === 403 || types.includes('FORBIDDEN') || NOT_ACCESSIBLE.test(detail ?? '')) return { kind: 'forbidden', ...base };
  if (status === 404 || types.includes('NOT_FOUND')) return { kind: 'not-found', ...base };
  if (status === 413) return { kind: 'too-large', ...base };
  if (status === 409 || status === 422 || types.includes('STALE_DATA')) return { kind: 'conflict', ...base };
  return { kind: 'other', ...base };
}
