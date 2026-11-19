import { describe, expect, it } from 'vitest';
import { MAX_RETRY_DELAY, RequestError, SEND_FAILED, SERVER_ERROR, getRetryDelay, isRetryableRequest, isSecureURL, sendRequest } from '../http';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

/** A fetch that answers from a queue and records what it was sent. */
function queue(...responses: (Response | Error | (() => Response))[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const waits: number[] = [];
  const fetchFn: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error('no more responses queued');
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  return { fetch: fetchFn, calls, waits, sleep: async (ms: number) => void waits.push(ms) };
}

const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as RequestError);

describe('sendRequest', () => {
  it('parses JSON and serialises a plain object body', async () => {
    const q = queue(json({ ok: true }));
    expect(await sendRequest('https://api.example/x', { method: 'POST', body: { a: 1 } }, q)).toEqual({ ok: true });
    const { init } = q.calls[0];
    expect(init.body).toBe('{"a":1}');
    expect(new Headers(init.headers).get('content-type')).toBe('application/json');
    expect(init.cache).toBe('no-cache');
  });

  it('does not mutate the caller’s init', async () => {
    const init = { method: 'POST', body: { a: 1 }, headers: { 'X-A': '1' } };
    await sendRequest('https://api.example/x', init, queue(json({})));
    expect(init).toEqual({ method: 'POST', body: { a: 1 }, headers: { 'X-A': '1' } });
  });

  it('returns bytes, text and the raw response on request', async () => {
    expect(await sendRequest('https://x/y', {}, { ...queue(new Response(new Uint8Array([0xef, 0xbb, 0xbf, 0x41]))), responseType: 'bytes' })).toEqual(
      new Uint8Array([0xef, 0xbb, 0xbf, 0x41]),
    );
    expect(await sendRequest('https://x/y', {}, { ...queue(new Response('hi')), responseType: 'text' })).toBe('hi');
    const raw = await sendRequest<Response>('https://x/y', {}, { ...queue(new Response('no', { status: 404 })), responseType: 'raw' });
    expect(raw.status).toBe(404);
  });

  it('retries a read once after 502, then gives up', async () => {
    const q = queue(new Response('', { status: 502 }), json({ ok: 1 }));
    expect(await sendRequest('https://x/y', {}, q)).toEqual({ ok: 1 });
    expect(q.calls).toHaveLength(2);
    expect(q.waits).toEqual([1000]);

    const twice = queue(new Response('', { status: 502 }), new Response('', { status: 502 }));
    const err = await failure(sendRequest('https://x/y', {}, twice));
    expect(err).toBeInstanceOf(RequestError);
    expect(err?.status).toBe(502);
    expect(twice.calls).toHaveLength(2);
  });

  it('waits as long as Retry-After says for a rate-limited read, and not at all when that is too long or unknown', async () => {
    const q = queue(json({}, 429, { 'Retry-After': '3' }), json({ ok: 1 }));
    await sendRequest('https://x/y', {}, q);
    expect(q.waits).toEqual([3000]);

    const long = queue(json({ message: 'slow down' }, 429, { 'Retry-After': '120' }));
    const err = await failure(sendRequest('https://x/y', {}, long));
    expect(err?.status).toBe(429);
    expect(long.calls).toHaveLength(1);

    const unknown = queue(json({}, 429));
    await failure(sendRequest('https://x/y', {}, unknown));
    expect(unknown.calls).toHaveLength(1);
  });

  it('never repeats a write by itself — a GraphQL mutation included', async () => {
    const post = queue(new Response('', { status: 502 }));
    await failure(sendRequest('https://x/y', { method: 'POST', body: { a: 1 } }, post));
    expect(post.calls).toHaveLength(1);

    const mutation = queue(new Response('', { status: 502 }));
    await failure(sendRequest('https://api.github.com/graphql', { method: 'POST', body: { query: 'mutation { x }' } }, mutation));
    expect(mutation.calls).toHaveLength(1);

    // a query is a read, though it is a POST
    const query = queue(new Response('', { status: 503 }), json({ data: {} }));
    await sendRequest('https://api.github.com/graphql', { method: 'POST', body: { query: 'query { viewer { login } }' } }, query);
    expect(query.calls).toHaveLength(2);
  });

  it('repeats a write that opted in, on 502 only', async () => {
    const q = queue(new Response('', { status: 502 }), json({ data: { ok: 1 } }));
    await sendRequest('https://api.github.com/graphql', { method: 'POST', body: { query: 'mutation { x }' } }, { ...q, retryable: true });
    expect(q.calls).toHaveLength(2);

    const timeout = queue(new Response('', { status: 504 }));
    const err = await failure(sendRequest('https://api.github.com/graphql', { method: 'POST', body: { query: 'mutation { x }' } }, { ...timeout, retryable: true }));
    expect(err?.status).toBe(504);
    expect(timeout.calls).toHaveLength(1);
  });

  it('refreshes the token once on 401 and resends with the new one', async () => {
    const q = queue(json({ message: 'Bad credentials' }, 401), json({ login: 'me' }));
    let refreshed = 0;
    const result = await sendRequest(
      'https://api.github.com/user',
      { headers: { Authorization: 'token old' } },
      { ...q, refreshAccessToken: async () => (refreshed++, { token: 'new' }) },
    );
    expect(result).toEqual({ login: 'me' });
    expect(refreshed).toBe(1);
    expect(new Headers(q.calls[1].init.headers).get('authorization')).toBe('token new');
  });

  it('a second 401 after the refresh is final (no loop), and so is a refresh that yields nothing', async () => {
    const q = queue(json({ message: 'Bad credentials' }, 401), json({ message: 'Bad credentials' }, 401));
    let refreshed = 0;
    const err = await failure(sendRequest('https://api.github.com/user', { headers: { Authorization: 'token old' } }, { ...q, refreshAccessToken: async () => (refreshed++, { token: 'new' }) }));
    expect(err?.status).toBe(401);
    expect(refreshed).toBe(1);
    expect(q.calls).toHaveLength(2);

    const none = queue(json({ message: 'Bad credentials' }, 401));
    const err2 = await failure(sendRequest('https://api.github.com/user', { headers: { Authorization: 'token old' } }, { ...none, refreshAccessToken: async () => undefined }));
    expect(err2?.status).toBe(401);
    expect(none.calls).toHaveLength(1);
  });

  it('treats GraphQL errors on a 200 as a failure and keeps their types', async () => {
    const q = queue(json({ data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] }));
    const err = await failure(sendRequest('https://api.github.com/graphql', { method: 'POST', body: { query: 'mutation { x }' } }, q));
    expect(err?.message).toBe(SERVER_ERROR);
    expect(err?.detail).toBe('Resource not accessible by integration');
    expect(err?.types).toEqual(['FORBIDDEN']);
    expect(err?.status).toBe(200);
    expect((err?.cause as { message: string }).message).toBe('Resource not accessible by integration');
  });

  it('reports a REST message, and a body that is not JSON', async () => {
    const err = await failure(sendRequest('https://x/y', {}, queue(json({ message: 'Not Found' }, 404))));
    expect(err?.detail).toBe('Not Found');
    expect(err?.status).toBe(404);
    const html = await failure(sendRequest('https://x/y', { method: 'POST' }, queue(new Response('<html>', { status: 500 }))));
    expect(html?.status).toBe(500);
    expect(html?.detail).toBeUndefined();
  });

  it('reports no response at all as "Failed to send the request"', async () => {
    const err = await failure(sendRequest('https://x/y', {}, queue(new TypeError('Failed to fetch'))));
    expect(err?.message).toBe(SEND_FAILED);
    expect(err?.status).toBeUndefined();
  });

  it('lets an abort through as an abort', async () => {
    const err = await failure(sendRequest('https://x/y', {}, queue(new DOMException('Aborted', 'AbortError'))));
    expect((err as unknown as DOMException).name).toBe('AbortError');
  });

  it('refuses to send credentials over plain http', async () => {
    const q = queue(json({}));
    await expect(sendRequest('http://example.com/x', { headers: { Authorization: 'token t' } }, q)).rejects.toThrow(/insecure/);
    expect(q.calls).toHaveLength(0);
    await sendRequest('http://localhost:4310/x', { headers: { Authorization: 'token t' } }, q);
    expect(q.calls).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('isRetryableRequest', () => {
    expect(isRetryableRequest({})).toBe(true);
    expect(isRetryableRequest({ method: 'head' })).toBe(true);
    expect(isRetryableRequest({ method: 'POST', body: 'not json' })).toBe(false);
    expect(isRetryableRequest({ method: 'POST', body: JSON.stringify({ query: '{ viewer { login } }' }) })).toBe(true);
    expect(isRetryableRequest({ method: 'POST', body: { query: '# c\n mutation($i: X!) { y }' } })).toBe(false);
    expect(isRetryableRequest({ method: 'PATCH', body: { sha: 'x' } })).toBe(false);
  });

  it('getRetryDelay', () => {
    const h = (v: string) => new Headers({ 'Retry-After': v });
    expect(getRetryDelay(503)).toBe(1000);
    expect(getRetryDelay(429)).toBeUndefined();
    expect(getRetryDelay(429, h('2'))).toBe(2000);
    expect(getRetryDelay(503, h(String(MAX_RETRY_DELAY / 1000 + 1)))).toBeUndefined();
    expect(getRetryDelay(503, h('Thu, 19 Nov 2026 12:00:05 GMT'), Date.parse('2026-11-19T12:00:00Z'))).toBe(5000);
    expect(getRetryDelay(503, h('Thu, 19 Nov 2026 11:00:00 GMT'), Date.parse('2026-11-19T12:00:00Z'))).toBe(0);
  });

  it('isSecureURL', () => {
    expect(isSecureURL('https://api.github.com/x')).toBe(true);
    expect(isSecureURL('http://api.github.com/x')).toBe(false);
    expect(isSecureURL('http://localhost:4310/x')).toBe(true);
    expect(isSecureURL('http://app.localhost/x')).toBe(true);
    expect(isSecureURL('http://127.0.0.1/x')).toBe(true);
    expect(isSecureURL('http://[::1]/x')).toBe(true);
  });
});
