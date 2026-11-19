/**
 * Request helper with retry.
 *
 * Lifted from Sveltia CMS — https://github.com/sveltia/sveltia-cms (fork dwahdany/sveltia-cms)
 * at commit 06d5552aa, `src/lib/services/utils/networking.js`.
 * Copyright (c) 2026 Kohei Yoshino. MIT License: see src/write/licenses/sveltia-MIT.txt.
 * Changes: TypeScript; `sleep` and `isObject` inlined; `fetch` and the wait are injectable (tests);
 * errors are a typed `RequestError` carrying status, detail and headers (the two message strings
 * and the `cause: { status, message }` shape are kept, because `commit-split.ts` reads them);
 * the caller's `init` is copied instead of mutated; an aborted request rethrows the AbortError;
 * `fetchOK` and `assertResponseOK` dropped (unused here).
 */

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Regular expression to match `localhost` and its subdomains like `mysite.localhost`. */
const LOCALHOST_REGEX = /^(.+\.)?localhost$/;

/**
 * Check if a hostname refers to the local computer, which browsers treat as a secure context over
 * HTTP: `localhost` and its subdomains, and the IPv4 and IPv6 loopback addresses, the latter
 * written in brackets as `URL` and `location` give it.
 */
export const isLocalHostname = (hostname: string): boolean => ['127.0.0.1', '[::1]'].includes(hostname) || LOCALHOST_REGEX.test(hostname);

/** Check if a URL can be requested without exposing credentials over an insecure transport. */
export const isSecureURL = (
  url: string,
  baseURL: string = (globalThis as { location?: { origin?: string } }).location?.origin ?? 'https://localhost',
): boolean => {
  try {
    const { hostname, protocol } = new URL(url, baseURL);
    return protocol === 'https:' || isLocalHostname(hostname);
  } catch {
    return false;
  }
};

/** Request options: `RequestInit`, except that a plain object body is serialised as JSON. */
export type RequestOptions = Omit<RequestInit, 'body'> & { body?: BodyInit | Record<string, unknown> | null };

/**
 * Check if a request can be sent again after a transient error without side effects: a `GET` or
 * `HEAD` request, or a GraphQL query, which is sent with `POST` but only reads data. Any other
 * request, including a GraphQL mutation, may have taken effect behind a gateway that still answered
 * with an error, so sending it again could create a duplicate commit, or report a false conflict.
 */
export const isRetryableRequest = ({ method = 'GET', body }: RequestOptions): boolean => {
  if (['GET', 'HEAD'].includes(method.toUpperCase())) return true;

  let data: unknown = body;
  if (typeof body === 'string') {
    try {
      data = JSON.parse(body);
    } catch {
      return false;
    }
  }

  // The query is sent as a JSON `query` property. An operation without a keyword, e.g.
  // `{ viewer { login } }`, is a query
  return isObject(data) && typeof data.query === 'string' && !/^\s*(?:#[^\n]*\n\s*)*mutation\b/.test(data.query);
};

/**
 * Statuses of a transient server error, other than 502 Bad Gateway, that a request without side
 * effects is retried once for: 429 Too Many Requests, 503 Service Unavailable and 504 Gateway
 * Timeout. A write that opts in with `retryable` is only retried on 502: a gateway can time out
 * with 504 after a large commit has landed, and the repeat would be refused as a conflict.
 */
const TRANSIENT_STATUSES = [429, 503, 504];
/** Wait before a retry when the server doesn't say how long to wait, in milliseconds. */
const DEFAULT_RETRY_DELAY = 1000;
/**
 * Longest wait before a retry, in milliseconds. A request the server asks to send again later than
 * that isn't retried, as the wait would look like a hang.
 */
export const MAX_RETRY_DELAY = 10 * 1000;

/**
 * Get how long to wait before sending a request again after a transient error, from the
 * `Retry-After` header of the response, which gives either a number of seconds or an HTTP date. A
 * request isn't to be sent again sooner than the server asks: GitHub may ban an integration that
 * keeps sending requests while it's rate limited. A rate limit that doesn't say how long to wait
 * typically lasts a minute or more, so it isn't retried either.
 * @returns Delay in milliseconds, between `0` and `MAX_RETRY_DELAY`, or `undefined` if the request
 * is not to be retried now.
 */
export const getRetryDelay = (status: number, headers?: Headers, now: number = Date.now()): number | undefined => {
  const value = headers?.get('Retry-After')?.trim();

  if (value) {
    const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
    if (!Number.isNaN(delay)) return delay > MAX_RETRY_DELAY ? undefined : Math.max(delay, 0);
  }

  return status === 429 ? undefined : DEFAULT_RETRY_DELAY;
};

/** `'Failed to send the request'`: no response at all (offline, CORS, a request the server closed). */
export const SEND_FAILED = 'Failed to send the request';
/** `'Server responded with an error'`: a response with a non-OK status, or a GraphQL `errors` body. */
export const SERVER_ERROR = 'Server responded with an error';

/**
 * What `sendRequest` throws. `message` is one of Sveltia's fixed strings (`SEND_FAILED`,
 * `SERVER_ERROR`, 'Failed to parse the response'); what the server said is in `detail`.
 */
export class RequestError extends Error {
  readonly status?: number;
  /** The server's own message (REST `message`, GraphQL `errors[].message` joined), when it sent one. */
  readonly detail?: string;
  /** GraphQL error `type`s (`FORBIDDEN`, `NOT_FOUND`, `STALE_DATA` …), when present. */
  readonly types: string[];
  readonly headers?: Headers;
  constructor(message: string, info: { status?: number; detail?: string; types?: string[]; headers?: Headers; cause?: unknown } = {}) {
    super(message, { cause: info.cause ?? { status: info.status, message: info.detail } });
    this.name = 'RequestError';
    this.status = info.status;
    this.detail = info.detail;
    this.types = info.types ?? [];
    this.headers = info.headers;
  }
}

export interface SendOptions {
  /** Response parser. Default `json`. `raw` returns the `Response` as is (the caller checks the status). */
  responseType?: 'json' | 'text' | 'blob' | 'bytes' | 'raw';
  /**
   * Refreshes the access token when the request fails with 401. When given, the request is sent
   * once more with the new token (`undefined` from it means "there is no new token": the 401 stands).
   */
  refreshAccessToken?: () => Promise<{ token: string } | undefined>;
  /** Remaining retries for transient server errors. Default 1. */
  retries?: number;
  /**
   * Whether the request can be sent again after a transient error. Default: true for a request
   * without side effects. A write can opt in when the server refuses a repeat of a request that
   * has already taken effect, like a commit guarded by the expected head.
   */
  retryable?: boolean;
  /** Defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
}

const isAbort = (err: unknown): boolean => typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';

/**
 * A `fetch` wrapper to send an HTTP request to an API endpoint, parse the response as JSON or
 * another format, and handle errors: one retry for transient failures, one token refresh on 401.
 * @throws {RequestError} When there was an error in the request or response.
 */
export async function sendRequest<T = unknown>(url: string, init: RequestOptions = {}, options: SendOptions = {}): Promise<T> {
  const { responseType = 'json', refreshAccessToken, retries = 1 } = options;
  const doFetch = options.fetch ?? globalThis.fetch;
  const wait = options.sleep ?? sleep;
  const headers = new Headers(init.headers);
  const request: RequestInit = { ...init, cache: 'no-cache', headers, body: init.body as BodyInit | null | undefined };

  if (headers.has('Authorization') && !isSecureURL(url)) {
    throw new Error('Refusing to send credentials over an insecure connection');
  }

  if (responseType === 'json' && !headers.has('Accept')) headers.set('Accept', 'application/json');

  // Serialize a plain object body for any method that accepts one
  if (isObject(init.body)) {
    headers.set('Content-Type', 'application/json');
    request.body = JSON.stringify(init.body);
  }

  const retryable = options.retryable ?? isRetryableRequest({ ...init, body: request.body as BodyInit | null | undefined });
  let response: Response;

  try {
    response = await doFetch(url, request);
  } catch (ex) {
    if (isAbort(ex)) throw ex;
    throw new RequestError(SEND_FAILED, { cause: ex });
  }

  const { ok, status } = response;
  const again: RequestOptions = { ...init, headers, body: request.body };

  /** Refresh the access token and send the request again with the new token. */
  const retryWithNewToken = async (): Promise<T | undefined> => {
    const [scheme] = headers.get('Authorization')?.split(' ') ?? ['token'];
    const renewed = await (refreshAccessToken as NonNullable<SendOptions['refreshAccessToken']>)();
    if (!renewed) return undefined;
    headers.set('Authorization', `${scheme} ${renewed.token}`);
    // Omit `refreshAccessToken` to avoid infinite loops
    return sendRequest<T>(url, again, { ...options, refreshAccessToken: undefined, retryable });
  };

  // A transient error that may succeed on retry: 502 Bad Gateway, which the GitHub GraphQL API is
  // known to occasionally answer with, and, for a request without side effects only, a rate limit
  // or a server under load
  const retryDelay =
    retries > 0 && retryable && (status === 502 || (TRANSIENT_STATUSES.includes(status) && isRetryableRequest(again)))
      ? getRetryDelay(status, response.headers)
      : undefined;
  const shouldRetry = retryDelay !== undefined;

  const retryAfterDelay = async (): Promise<T> => {
    await wait(retryDelay as number);
    return sendRequest<T>(url, again, { ...options, retries: retries - 1, retryable });
  };

  // A raw response is returned as is for the caller to check the status, but a transient error is
  // still retried and an expired token refreshed, the same as for the other response types
  if (responseType === 'raw') {
    if (shouldRetry) return retryAfterDelay();
    if (status === 401 && refreshAccessToken) {
      const renewed = await retryWithNewToken();
      if (renewed !== undefined) return renewed;
    }
    return response as T;
  }

  let result: unknown;

  if (ok) {
    try {
      if (responseType === 'blob') return (await response.blob()) as T;
      if (responseType === 'bytes') return new Uint8Array(await response.arrayBuffer()) as T;
      if (responseType === 'text') return (await response.text()) as T;
      result = await response.json();
    } catch (ex) {
      if (isAbort(ex)) throw ex;
      throw new RequestError('Failed to parse the response', { status, headers: response.headers, cause: ex });
    }
  } else {
    try {
      result = await response.json();
    } catch {
      // An error response doesn't always come with a JSON body, e.g. a gateway's HTML error page,
      // but its status still decides whether to retry, refresh the token or report the error
      result = undefined;
    }
  }

  // A GraphQL error is typically returned with 200 OK, so check the content for the `errors` key
  if (ok && !(url.endsWith('/graphql') && isObject(result) && result.errors)) return result as T;

  if (shouldRetry) return retryAfterDelay();

  if (status === 401 && refreshAccessToken) {
    const renewed = await retryWithNewToken();
    if (renewed !== undefined) return renewed;
  }

  if (!isObject(result)) throw new RequestError(SERVER_ERROR, { status, headers: response.headers });

  let message = '';
  const types: string[] = [];

  if (typeof result.error === 'string') message = result.error;
  // Typical REST
  if (typeof result.message === 'string') message = result.message;

  if (Array.isArray(result.errors)) {
    if (typeof result.errors[0] === 'string') message = result.errors.join(', ');
    // Typical GraphQL
    if (isObject(result.errors[0]) && typeof result.errors[0].message === 'string') {
      message = (result.errors as { message?: unknown; type?: unknown }[]).map((e) => e.message).join(', ');
      for (const e of result.errors as { type?: unknown }[]) if (typeof e.type === 'string') types.push(e.type);
    }
  }

  throw new RequestError(SERVER_ERROR, { status, detail: message, types, headers: response.headers });
}
