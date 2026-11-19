/**
 * GitHub and the auth worker, pretended, for the browser tests of sign-in, publish and images.
 *
 * Nothing here reaches the network: every request to api.github.com, raw.githubusercontent.com and
 * the auth worker is answered by route interception.
 *
 *   - GitHub is the data layer's own test double (`fake-github.ts`): one repo with real git
 *     semantics (blobs, trees, commits, a branch head). It runs in the test process; the routes
 *     hand it each request and it records them (`gh.calls`), which is what the specs assert on.
 *   - The auth worker's popup is a real second window on the worker's real origin, showing a page
 *     that speaks the worker's handshake (`authorizing:github` → echo → `authorization:github:…`)
 *     and, like the forked worker, posts only to the site's origin (`origin`, else
 *     `https://<site_id>`), so the origin and source
 *     checks on both sides are exercised as in production.
 *   - NOT pretended faithfully: the worker's allow-list. `/refresh` here answers any origin with
 *     permissive CORS (the specs that refresh run on localhost, which the real worker refuses),
 *     so a refused origin — a network error in the browser — is not covered by these specs.
 *
 * The app is served by the dev server, which normally reads the working tree: `?source=github`
 * swaps in the GitHub source (see data/index.ts). On localhost the app offers only the token
 * path, so the popup specs open the same dev server under a made-up https host (`SITE`), every
 * request to it relayed to localhost.
 */
import { deflateSync } from 'node:zlib';
import { expect, type BrowserContext, type Page, type Route } from '@playwright/test';
import { fakeGithub, type FakeCall, type FakeGithub } from '../../../src/write/data/github/__tests__/fake-github';

export const WORKER = 'https://write-auth.dariush-5fc.workers.dev';
/** A host that is not localhost, for the popup sign-in. Never resolved: every request is relayed to the dev server. */
export const SITE = 'https://write.test';
export const REPO = 'dwahdany/astro-microblog';
export const AUTH_KEY = 'write:auth';
export const EDITOR = '[data-write-pane="editor"] .cm-content';

export const NOTE = 'src/content/notes/2026/hello.md';
export const NOTE_TEXT = '---\nslug: hello\ntitle: Hello\ncreated: 2026-11-18T10:00:00+00:00\ntags: []\nis_draft: false\n---\n\nFirst line.\n\nSecond line.\n';
export const OTHER = 'src/content/notes/2026/other.md';
export const OTHER_TEXT = '---\nslug: other\ntitle: Other\ncreated: 2026-11-17T10:00:00+00:00\ntags: []\nis_draft: true\n---\n\nAnother note.\n';
export const ENTRY = 'src/content/entries/2025/with-pics.md';
export const ENTRY_IMAGE = 'src/content/entries/2025/with-pics/a.png';
export const ENTRY_TEXT =
  '---\nslug: with-pics\ntitle: With pictures\ncreated: 2025-03-01T10:00:00+00:00\ntags: []\nis_draft: false\n---\n\nLook:\n\n![a picture](with-pics/a.png)\n\nThe end.\n';
/** A file outside the posts, rewritten by a bot every few hours: commits to it move the branch without touching a post. */
export const PRICES = 'src/data/portfolio-prices.json';

/* --------------------------------------------------------------------- png */

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** A real PNG of the given size: a colour gradient (so it does not compress to nothing), plus a text chunk (metadata). */
export function png(width: number, height: number, seed = 1): Buffer {
  const row = 1 + width * 3;
  const pixels = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = y * row + 1 + x * 3;
      pixels[at] = (x * 7 + seed * 31) & 0xff;
      pixels[at + 1] = (y * 5 + seed * 17) & 0xff;
      pixels[at + 2] = ((x ^ y) + seed) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('tEXt', Buffer.from('Comment\0taken at 52.5200 N, 13.4050 E', 'latin1')),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Width and height from a PNG's header. */
export const pngSize = (bytes: Uint8Array): { width: number; height: number } => {
  const b = Buffer.from(bytes);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};

/* ------------------------------------------------------------------ github */

export interface Mock {
  gh: FakeGithub;
  /** Requests the auth worker got: the popup's URL, and each refresh with its body. */
  worker: { auth: string[]; refresh: unknown[] };
  /** What the popup page reports to the opener. Change it before the click. */
  popup: { result: { ok: true; payload: Record<string, unknown> } | { ok: false; payload: Record<string, unknown> } | 'close' | 'wait' };
  /** How the worker answers `POST /refresh`. */
  refresh: { status: number; body: unknown };
  /** createCommitOnBranch requests, as sent. */
  mutations(): FakeCall[];
  /** `variables.input` of each createCommitOnBranch request. */
  inputs(): any[];
  /** Requests that changed something (everything but GET). */
  writes(): FakeCall[];
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
  'access-control-expose-headers': '*',
};

const typeOf = (url: string): string | undefined =>
  /\.png($|\?)/.test(url) ? 'image/png' : /\.jpe?g($|\?)/.test(url) ? 'image/jpeg' : /\.md($|\?)/.test(url) ? 'text/plain; charset=utf-8' : undefined;

/** The seeded repo: two notes, an entry with a committed image, and the file the price bot keeps rewriting. */
export function seededGithub(): FakeGithub {
  const gh = fakeGithub();
  gh.push(
    {
      [NOTE]: NOTE_TEXT,
      [OTHER]: OTHER_TEXT,
      [ENTRY]: ENTRY_TEXT,
      [ENTRY_IMAGE]: new Uint8Array(png(40, 30, 9)),
      [PRICES]: '{"v":1}\n',
    },
    'seed',
  );
  for (const token of ['github_pat_good', 'ghu_first', 'ghu_renewed']) gh.state.tokens.add(token);
  gh.reset();
  return gh;
}

/** Answer everything GitHub and the auth worker would, from the pretend ones. */
export async function mockGithub(context: BrowserContext, gh: FakeGithub = seededGithub()): Promise<Mock> {
  const mock: Mock = {
    gh,
    worker: { auth: [], refresh: [] },
    popup: { result: { ok: true, payload: { provider: 'github', token: 'ghu_first', refresh_token: 'ghr_first', expires_in: 28800, refresh_token_expires_in: 15897600 } } },
    refresh: { status: 200, body: { token: 'ghu_renewed', refresh_token: 'ghr_second', expires_in: 28800, refresh_token_expires_in: 15897600 } },
    mutations: () => gh.mutations(),
    inputs: () => gh.mutations().map((c) => c.body.variables.input),
    writes: () => gh.calls.filter((c) => c.method !== 'GET' && c.method !== 'OPTIONS'),
  };

  const github = async (route: Route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    let response: Response;
    try {
      response = await gh.fetch(request.url(), { method: request.method(), headers: request.headers(), body: request.postData() ?? undefined });
    } catch {
      return route.abort('internetdisconnected');
    }
    const headers: Record<string, string> = { ...CORS };
    response.headers.forEach((value, key) => (headers[key] = value));
    const type = typeOf(request.url());
    if (type && !response.headers.get('content-type')?.includes('json')) headers['content-type'] = type;
    await route.fulfill({ status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) });
  };
  await context.route('https://api.github.com/**', github);
  await context.route('https://raw.githubusercontent.com/**', github);
  await context.route('https://avatars.example/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: png(8, 8, 3) }));

  await context.route(`${WORKER}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    if (url.pathname === '/refresh') {
      mock.worker.refresh.push(request.postDataJSON());
      return route.fulfill({ status: mock.refresh.status, headers: { ...CORS, 'content-type': 'application/json' }, body: JSON.stringify(mock.refresh.body) });
    }
    if (url.pathname === '/auth') {
      mock.worker.auth.push(request.url());
      const result = mock.popup.result;
      // The worker's page, as the forked worker writes it: everything is posted to ONE origin — the
      // `origin` parameter when the site sent one, else `https://<site_id>` (never `*`, never the
      // origin a message happened to come from) — and only an echo from that origin and from the
      // opener is answered.
      const target = JSON.stringify(url.searchParams.get('origin') ?? `https://${url.searchParams.get('site_id') ?? ''}`);
      const script =
        result === 'close'
          ? 'window.close();'
          : result === 'wait'
            ? ''
            : `const hello = 'authorizing:github';
             const target = ${target};
             window.addEventListener('message', (event) => {
               if (event.origin !== target || event.source !== window.opener || event.data !== hello) return;
               window.opener.postMessage('authorization:github:${result.ok ? 'success' : 'error'}:' + ${JSON.stringify(JSON.stringify(result.payload))}, target);
             });
             window.opener.postMessage(hello, target);`;
      return route.fulfill({ status: 200, contentType: 'text/html', body: `<!doctype html><title>Sign in</title><p>Signing in</p><script>${script}</script>` });
    }
    return route.fulfill({ status: 404, body: 'not found' });
  });
  return mock;
}

/**
 * Serve the dev server under `SITE` (not localhost), so the app offers the GitHub popup.
 * Call before the first navigation; then use `SITE + '/write/…'` URLs.
 */
export async function serveAsSite(context: BrowserContext, baseURL: string): Promise<void> {
  await context.route(`${SITE}/**`, async (route) => {
    const url = route.request().url().replace(SITE, baseURL.replace(/\/$/, ''));
    try {
      const response = await route.fetch({ url });
      await route.fulfill({ response });
    } catch {
      await route.abort();
    }
  });
}

/* ----------------------------------------------------------------- the app */

export interface SeedSession {
  method?: 'app' | 'token';
  token?: string;
  refreshToken?: string;
  /** Epoch ms; in the past = the access token has expired. */
  expiresAt?: number;
  refreshExpiresAt?: number;
}

/** Start the page signed in: a session as an earlier visit would have left it. Applied once per tab. */
export async function signedIn(context: BrowserContext, session: SeedSession = {}): Promise<void> {
  const stored = {
    v: 1,
    method: session.method ?? 'token',
    token: session.token ?? 'github_pat_good',
    ...(session.refreshToken ? { refreshToken: session.refreshToken } : {}),
    ...(session.expiresAt !== undefined ? { expiresAt: session.expiresAt } : {}),
    ...(session.refreshExpiresAt !== undefined ? { refreshExpiresAt: session.refreshExpiresAt } : {}),
    user: { login: 'dwahdany', name: 'Dariush', avatarUrl: 'https://avatars.example/u/1', id: 1 },
    savedAt: Date.now(),
  };
  await context.addInitScript(
    ([key, value]) => {
      try {
        if (sessionStorage.getItem('test:seeded')) return;
        sessionStorage.setItem('test:seeded', '1');
        localStorage.setItem(key, value);
      } catch {
        /* an opaque origin (about:blank): nothing to seed */
      }
    },
    [AUTH_KEY, JSON.stringify(stored)] as const,
  );
}

export const appUrl = (hash = '#/', origin = ''): string => `${origin}/write/?source=github${hash}`;
export const postHash = (id: string, sheet = ''): string => `#/post/${encodeURIComponent(id)}${sheet ? `/${sheet}` : ''}`;

export async function openList(page: Page, origin = ''): Promise<void> {
  await page.goto(appUrl('#/', origin));
  await expect(page.locator('[data-post-list] li').first()).toBeVisible({ timeout: 30_000 });
}

export async function openPost(page: Page, id: string, origin = ''): Promise<void> {
  await page.goto(appUrl(postHash(id), origin));
  await expect(page.locator(EDITOR)).toBeVisible({ timeout: 30_000 });
}

/** Open a sheet from wherever its button is: in the header, or behind "more" on the phone's writing screen. */
export async function openSheet(page: Page, name: 'properties' | 'review' | 'look' | 'account'): Promise<void> {
  const sheet = page.locator(`[data-sheet="${name}"]`);
  // Tried again when the dev server reloads the page under the click (it does while it is still optimising dependencies).
  await expect(async () => {
    if (!(await sheet.isVisible())) {
      const button = page.locator(`[data-open="${name}"]:visible`).first();
      if ((await button.count()) === 0) await page.locator('[data-open="more"]').click({ timeout: 2_000 });
      await button.click({ timeout: 2_000 });
    }
    await expect(sheet).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

export async function closeSheet(page: Page): Promise<void> {
  await page.locator('[data-sheet] [data-sheet-close]').click();
  await expect(page.locator('[data-sheet]')).toHaveCount(0);
}

/** Type at the very end of the post. */
export async function typeAtEnd(page: Page, text: string): Promise<void> {
  const content = page.locator(EDITOR);
  // In the first line's corner, not the middle of the text: a rendered picture there would take the click.
  await content.click({ position: { x: 6, y: 6 } });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+End');
  await page.keyboard.type(text);
}

export const keepState = (page: Page) => page.locator('[data-keep-state]');

/** Wait until the draft is stored (the status line says "kept"). */
export async function kept(page: Page): Promise<void> {
  await expect(keepState(page)).toHaveAttribute('data-keep-state', 'kept');
}

export const stored = (page: Page): Promise<Record<string, unknown> | null> =>
  page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), AUTH_KEY);

export const decode = (base64: string): string => Buffer.from(base64, 'base64').toString('utf8');

/**
 * The text of the open post as the draft store holds it (the editor's DOM shows markdown rendered,
 * with addresses folded away, so the exact text is read from where it is kept). Null: no draft.
 */
export const draftText = (page: Page): Promise<string | null> =>
  page.evaluate(async (mod) => {
    const data = await import(/* @vite-ignore */ mod);
    const id = decodeURIComponent(/#\/post\/([^/]+)/.exec(location.hash)?.[1] ?? '');
    return ((await data.draftStore.get(id)) as { raw: string } | undefined)?.raw ?? null;
  }, '/src/write/data/index.ts');
