import { describe, expect, it } from 'vitest';
import { AuthError } from '../../../contracts';
import { authUrl, beginAuthorization, parseResultMessage, readResult, tokenPageUrl, type PopupHost, type PopupWindow } from '../auth';

const WORKER = 'https://write-auth.dariush-5fc.workers.dev';

/** A window with a popup that can be scripted. */
function fakeWindow(options: { blocked?: boolean; hostname?: string } = {}) {
  const listeners = new Set<(event: MessageEvent) => void>();
  const sent: { message: unknown; target: string }[] = [];
  const opened: { url: string; target: string; features: string }[] = [];
  const popup: PopupWindow & { closeCalls: number } = {
    closed: false,
    closeCalls: 0,
    close() {
      this.closed = true;
      this.closeCalls += 1;
    },
    postMessage: (message, target) => void sent.push({ message, target }),
  };
  const timers: (() => void)[] = [];
  const host: PopupHost = {
    open(url, target, features) {
      opened.push({ url, target, features });
      return options.blocked ? null : popup;
    },
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
    screen: { availWidth: 1200, availHeight: 1000 },
    location: { hostname: options.hostname ?? 'blog.wahdany.eu', origin: `https://${options.hostname ?? 'blog.wahdany.eu'}` },
  };
  /** Deliver a message event to the opener. */
  const deliver = (data: unknown, origin = WORKER, source: unknown = popup) => listeners.forEach((l) => l({ data, origin, source } as MessageEvent));
  return {
    host,
    popup,
    sent,
    opened,
    listeners,
    deliver,
    tick: () => timers.forEach((t) => t()),
    start: () => beginAuthorization({ host, workerOrigin: WORKER, setInterval: (fn) => timers.push(fn), clearInterval: () => void (timers.length = 0) }),
  };
}

const success = (content: object) => `authorization:github:success:${JSON.stringify(content)}`;
const caught = (p: Promise<unknown>) => p.then(() => undefined, (e: unknown) => e as AuthError);

describe('the popup URL', () => {
  it('names the provider and this site — by host and by exact origin — and nothing else (the worker takes the scope from its own settings)', () => {
    expect(authUrl(WORKER, 'blog.wahdany.eu', 'https://blog.wahdany.eu')).toBe(
      `${WORKER}/auth?provider=github&site_id=blog.wahdany.eu&origin=https%3A%2F%2Fblog.wahdany.eu`,
    );
    // The origin carries what the host name alone does not: the scheme and the port.
    expect(new URL(authUrl(WORKER, 'preview.example', 'http://preview.example:8443')).searchParams.get('origin')).toBe('http://preview.example:8443');
    // Without an origin to name (a test double, an opaque origin) only `site_id` is sent, as Sveltia CMS does.
    expect(authUrl(WORKER, 'blog.wahdany.eu')).toBe(`${WORKER}/auth?provider=github&site_id=blog.wahdany.eu`);
    expect(authUrl(WORKER, 'blog.wahdany.eu', 'null')).toBe(`${WORKER}/auth?provider=github&site_id=blog.wahdany.eu`);
  });

  it('the token page is prefilled with the one permission needed', () => {
    const url = new URL(tokenPageUrl({ owner: 'dwahdany', name: 'astro-microblog' }));
    expect(url.origin + url.pathname).toBe('https://github.com/settings/personal-access-tokens/new');
    expect(url.searchParams.get('contents')).toBe('write');
    expect(url.searchParams.get('target_name')).toBe('dwahdany');
  });
});

describe('beginAuthorization', () => {
  it('opens the popup before it returns — synchronously, inside the tap', () => {
    const w = fakeWindow();
    const authorization = w.start();
    // No await has happened yet.
    expect(w.opened).toHaveLength(1);
    expect(w.opened[0].url).toBe(authUrl(WORKER, 'blog.wahdany.eu', 'https://blog.wahdany.eu'));
    expect(new URL(w.opened[0].url).searchParams.get('origin')).toBe('https://blog.wahdany.eu');
    expect(w.opened[0].target).toBe('auth');
    expect(w.opened[0].features).toContain('width=600');
    authorization.cancel();
    return caught(authorization.result);
  });

  it('answers the handshake to the worker’s origin only, then resolves with the tokens', async () => {
    const w = fakeWindow();
    const { result } = w.start();
    w.deliver('authorizing:github');
    expect(w.sent).toEqual([{ message: 'authorizing:github', target: WORKER }]);
    w.deliver(success({ provider: 'github', token: 'ghu_abc', refresh_token: 'ghr_def', expires_in: 28800, refresh_token_expires_in: 15811200 }));
    expect(await result).toEqual({ token: 'ghu_abc', refreshToken: 'ghr_def', expiresIn: 28800, refreshTokenExpiresIn: 15811200 });
    expect(w.popup.closed).toBe(true);
    expect(w.listeners.size).toBe(0);
  });

  it('accepts a result without a refresh token (an OAuth app, or expiry switched off)', async () => {
    const w = fakeWindow();
    const { result } = w.start();
    w.deliver(success({ provider: 'github', token: 'gho_abc' }));
    expect(await result).toEqual({ token: 'gho_abc', refreshToken: undefined, expiresIn: undefined, refreshTokenExpiresIn: undefined });
  });

  it('ignores messages from another origin, another window, or that are not strings', async () => {
    const w = fakeWindow();
    const { result, cancel } = w.start();
    let settled = false;
    void result.then(
      () => (settled = true),
      () => (settled = true),
    );
    const token = success({ provider: 'github', token: 'stolen' });
    w.deliver('authorizing:github', 'https://evil.example'); // right window, wrong origin
    w.deliver(token, 'https://evil.example');
    w.deliver('authorizing:github', WORKER, {}); // right origin, another window
    w.deliver(token, WORKER, {});
    w.deliver(token, WORKER, null);
    w.deliver({ token: 'x' }, WORKER); // not a string
    w.deliver('authorization:gitlab:success:{"token":"x"}'); // another provider
    w.deliver('hello'); // noise from the popup itself
    await Promise.resolve();
    expect(w.sent).toEqual([]);
    expect(settled).toBe(false);
    expect(w.popup.closed).toBe(false);
    cancel();
    expect((await caught(result))?.reason).toBe('cancelled');
  });

  it('rejects with the worker’s error; an unsupported domain is its own reason', async () => {
    const w = fakeWindow({ hostname: 'localhost' });
    const { result } = w.start();
    w.deliver(`authorization:github:error:${JSON.stringify({ provider: 'github', error: 'Your domain is not allowed to use the authenticator.', errorCode: 'UNSUPPORTED_DOMAIN' })}`);
    const err = await caught(result);
    expect(err).toBeInstanceOf(AuthError);
    expect(err?.reason).toBe('unsupported-domain');
    expect(w.listeners.size).toBe(0);

    const w2 = fakeWindow();
    const second = w2.start();
    w2.deliver(`authorization:github:error:${JSON.stringify({ provider: 'github', error: 'Potential CSRF attack detected.', errorCode: 'CSRF_DETECTED' })}`);
    const err2 = await caught(second.result);
    expect(err2?.reason).toBe('rejected');
    expect(err2?.message).toContain('CSRF');
  });

  it('rejects as cancelled when the owner closes the popup, and detaches', async () => {
    const w = fakeWindow();
    const { result } = w.start();
    w.tick();
    w.popup.closed = true;
    w.tick();
    const err = await caught(result);
    expect(err?.reason).toBe('cancelled');
    // The worker shows a refusal (site not allowed, sign-in session expired) only inside its window
    // and posts nothing, so a closed window is the only sign of it: say what to do then.
    expect(err?.message).toMatch(/closed/);
    expect(err?.message).toMatch(/access token/);
    expect(w.listeners.size).toBe(0);
    // A late message changes nothing.
    w.deliver(success({ token: 'late' }));
  });

  it('reports a blocked popup without attaching anything', async () => {
    const w = fakeWindow({ blocked: true });
    const { result } = w.start();
    expect((await caught(result))?.reason).toBe('popup-blocked');
    expect(w.listeners.size).toBe(0);
  });

  it('cancel after success does nothing', async () => {
    const w = fakeWindow();
    const { result, cancel } = w.start();
    w.deliver(success({ token: 't' }));
    cancel();
    expect((await result).token).toBe('t');
    expect(w.popup.closeCalls).toBe(1);
  });
});

describe('result parsing', () => {
  it('parseResultMessage', () => {
    expect(parseResultMessage('github', 'authorization:github:success:{"token":"a"}')).toBe('{"token":"a"}');
    expect(parseResultMessage('github', 'authorization:github:error:{"error":"x"}')).toBe('{"error":"x"}');
    expect(parseResultMessage('github', 'authorization:gitlab:success:{}')).toBeUndefined();
    expect(parseResultMessage('github', ' authorization:github:success:{}')).toBeUndefined();
  });

  it('readResult turns nonsense into a typed failure', () => {
    for (const bad of [undefined, 'not json', '[]', '"x"', '{}', '{"token":""}', '{"token":5}']) {
      const r = readResult(bad);
      expect(r).toBeInstanceOf(AuthError);
    }
    expect(readResult('{"token":"t","refreshToken":"r","expires_in":"60"}')).toEqual({ token: 't', refreshToken: 'r', expiresIn: 60, refreshTokenExpiresIn: undefined });
  });
});
