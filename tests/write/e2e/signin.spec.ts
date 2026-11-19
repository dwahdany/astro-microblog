/**
 * Sign-in, in a real browser, with GitHub and the auth worker pretended (./github-mock.ts).
 *
 *   - localhost offers only the token path; a token signs in, shows who, signs out
 *   - a token GitHub refuses, one without push access, and no network: each says what to do
 *   - the GitHub popup (the app served under a host that is not localhost): success, a refusal,
 *     the window closed, Cancel, and a blocked popup
 *   - a session that ends (the refresh token is refused) loses nothing and asks to sign in again
 *   - signed out, everything but Publish works
 *
 * Runs in every project: desktop Chromium, Pixel 7 emulation and the iPhone profile on WebKit.
 */
import { expect, test } from '@playwright/test';
import {
  EDITOR,
  NOTE,
  REPO,
  SITE,
  WORKER,
  appUrl,
  closeSheet,
  kept,
  mockGithub,
  openList,
  openPost,
  openSheet,
  postHash,
  serveAsSite,
  signedIn,
  stored,
  typeAtEnd,
} from './github-mock';

const sheet = (page: import('@playwright/test').Page) => page.locator('[data-sheet="account"]');

test('localhost: only the token path; a token signs in, shows who is signed in, and signs out', async ({ page, context }) => {
  const mock = await mockGithub(context);
  await openList(page);

  // Signed out: a clear way in, and the list works as ever.
  await expect(page.locator('[data-open="account"][data-account-state="signed-out"]')).toHaveText('Sign in');
  await openSheet(page, 'account');
  await expect(sheet(page).locator('[data-account="signed-out"]')).toBeVisible();
  await expect(sheet(page).locator('[data-action="sign-in-github"]')).toHaveCount(0);
  await expect(sheet(page).locator('[data-account-local]')).toBeVisible();
  // The help link goes to GitHub's token page with the one permission prefilled.
  const help = await sheet(page).locator('a', { hasText: 'Create one on GitHub' }).getAttribute('href');
  expect(help).toContain('https://github.com/settings/personal-access-tokens/new?');
  expect(help).toContain('contents=write');

  mock.gh.reset();
  await sheet(page).locator('#account-token').fill('  github_pat_good ');
  await sheet(page).locator('[data-action="sign-in-token"]').click();
  await expect(sheet(page).locator('[data-account="signed-in"]')).toBeVisible();
  await expect(sheet(page).locator('[data-account-login]')).toHaveText('Dariush');
  await expect(sheet(page)).toContainText('@dwahdany');
  await expect(sheet(page)).toContainText('Signed in with an access token');

  // Exactly what was asked of GitHub: who the token is, and whether it may push to the repo.
  const asked = mock.gh.calls.filter((c) => c.auth !== null).slice(0, 2);
  expect(asked.map((c) => ({ method: c.method, url: c.url, auth: c.auth }))).toEqual([
    { method: 'GET', url: 'https://api.github.com/user', auth: 'token github_pat_good' },
    { method: 'GET', url: `https://api.github.com/repos/${REPO}`, auth: 'token github_pat_good' },
  ]);
  expect(await stored(page)).toMatchObject({ v: 1, method: 'token', token: 'github_pat_good', user: { login: 'dwahdany', name: 'Dariush' } });

  // The header shows the account; a reload keeps the session.
  await closeSheet(page);
  await expect(page.locator('[data-open="account"][data-account-state="signed-in"]')).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-open="account"][data-account-state="signed-in"]')).toBeVisible();

  await openSheet(page, 'account');
  // Signing out does not end the sign-in at GitHub: the sheet says where that is done.
  await expect(sheet(page).locator('[data-account-revoke]')).toHaveAttribute('href', 'https://github.com/settings/personal-access-tokens');
  await sheet(page).locator('[data-action="sign-out"]').click();
  await expect(sheet(page).locator('[data-account="signed-out"]')).toBeVisible();
  expect(await stored(page)).toBeNull();
});

test('a refused token, a token without push access, and no network each say what to do', async ({ page, context }) => {
  const mock = await mockGithub(context);
  await openList(page);
  await openSheet(page, 'account');
  const field = sheet(page).locator('#account-token');
  const go = sheet(page).locator('[data-action="sign-in-token"]');

  await field.fill('github_pat_wrong');
  await go.click();
  await expect(sheet(page).locator('[data-account-problem="invalid-token"]')).toBeVisible();

  mock.gh.state.push = false;
  await field.fill('github_pat_good');
  await go.click();
  await expect(sheet(page).locator('[data-account-problem="no-push"]')).toContainText('Contents: read and write');
  mock.gh.state.push = true;

  mock.gh.state.offline = true;
  await go.click();
  await expect(sheet(page).locator('[data-account-problem="offline"]')).toContainText('offline');
  mock.gh.state.offline = false;

  // Nothing was stored by any of it, and the next try works.
  expect(await stored(page)).toBeNull();
  await go.click();
  await expect(sheet(page).locator('[data-account="signed-in"]')).toBeVisible();
  await expect(sheet(page).locator('[data-account-problem]')).toHaveCount(0);
});

test('signed out, the app still reads, edits, keeps drafts and hands the file over; Publish asks to sign in', async ({ page, context }) => {
  const mock = await mockGithub(context);
  await openPost(page, NOTE);
  await typeAtEnd(page, 'Written signed out.');
  await kept(page);
  await openSheet(page, 'review');
  const review = page.locator('[data-sheet="review"]');
  await expect(review.locator('[data-review-diff]')).toContainText('Written signed out.');
  await expect(review.locator('[data-action="publish"]')).toHaveCount(0);
  await expect(review.locator('[data-action="copy"]')).toBeVisible();
  await expect(review.locator('[data-action="download"]')).toBeVisible();
  await expect(review).toContainText('Sign in to publish from here');

  // "Sign in to publish" leads to the account sheet; signing in comes straight back to Review,
  // where Publish now is — no closing and reopening sheets on a phone.
  await review.locator('[data-action="sign-in-to-publish"]').click();
  await sheet(page).locator('#account-token').fill('github_pat_good');
  await sheet(page).locator('[data-action="sign-in-token"]').click();
  await expect(review).toBeVisible();
  await expect(sheet(page)).toHaveCount(0);
  await expect(review.locator('[data-action="publish"]')).toBeEnabled();
  await expect(review.locator('[data-review-diff]')).toContainText('Written signed out.');
  expect(mock.writes()).toEqual([]);
});

test.describe('the GitHub popup (not on localhost)', () => {
  test.beforeEach(async ({ context, baseURL }) => {
    await serveAsSite(context, baseURL!);
  });

  test('signs in through the worker window and keeps the refresh token', async ({ page, context }) => {
    const mock = await mockGithub(context);
    await openList(page, SITE);
    await openSheet(page, 'account');
    const button = sheet(page).locator('[data-action="sign-in-github"]');
    await expect(button).toBeVisible();
    // The token field is the secondary way in: tucked behind its own button.
    await expect(sheet(page).locator('#account-token')).toHaveCount(0);
    await expect(sheet(page).locator('[data-action="use-token"]')).toBeVisible();

    const before = Date.now();
    const [popup] = await Promise.all([page.waitForEvent('popup'), button.click()]);
    await expect(sheet(page).locator('[data-account="signed-in"]')).toBeVisible();
    await expect(sheet(page)).toContainText('Signed in with GitHub');
    await expect.poll(() => popup.isClosed()).toBe(true);

    // The window went to the worker, for this site.
    const opened = new URL(mock.worker.auth[0]);
    expect(opened.origin + opened.pathname).toBe(`${WORKER}/auth`);
    expect(opened.searchParams.get('provider')).toBe('github');
    expect(opened.searchParams.get('site_id')).toBe('write.test');
    // …named by its exact origin too: that is what the worker checks against its allow-list and posts to.
    expect(opened.searchParams.get('origin')).toBe(SITE);
    expect([...opened.searchParams.keys()].sort()).toEqual(['origin', 'provider', 'site_id']);
    // The token it handed over was checked with GitHub, then stored with its refresh token and expiry.
    expect(mock.gh.calls.find((c) => c.url === 'https://api.github.com/user')?.auth).toBe('token ghu_first');
    const session = (await stored(page)) as { expiresAt: number; refreshExpiresAt: number };
    expect(session).toMatchObject({ v: 1, method: 'app', token: 'ghu_first', refreshToken: 'ghr_first', user: { login: 'dwahdany' } });
    expect(session.expiresAt).toBeGreaterThanOrEqual(before + 28_800_000 - 5_000);
    expect(session.expiresAt).toBeLessThanOrEqual(Date.now() + 28_800_000);
    expect(session.refreshExpiresAt).toBeGreaterThan(before + 15_000_000_000);
  });

  test('a refusal, a closed window, Cancel and a blocked popup each leave the app signed out with a reason', async ({ page, context }) => {
    const mock = await mockGithub(context);
    await openList(page, SITE);
    await openSheet(page, 'account');
    const button = sheet(page).locator('[data-action="sign-in-github"]');

    // GitHub (through the worker) says no.
    mock.popup.result = { ok: false, payload: { provider: 'github', error: 'The user has denied your application access', errorCode: 'access_denied' } };
    await Promise.all([page.waitForEvent('popup'), button.click()]);
    await expect(sheet(page).locator('[data-account-problem="rejected"]')).toContainText('denied');

    // The window is closed without finishing.
    // (That is also all the app ever sees of a refusal the worker only shows in its own window —
    // this address is not on its list — so the message says what to do in that case.)
    mock.popup.result = 'close';
    await Promise.all([page.waitForEvent('popup'), button.click()]);
    await expect(sheet(page).locator('[data-account-problem="cancelled"]')).toContainText('window was closed');
    await expect(sheet(page).locator('[data-account-problem="cancelled"]')).toContainText('access token');

    // The window stays open; the app waits, and Cancel ends it.
    mock.popup.result = 'wait';
    const [waiting] = await Promise.all([page.waitForEvent('popup'), button.click()]);
    await expect(sheet(page).locator('[data-account="signing-in"]')).toContainText('If that window shows an error');
    await sheet(page).locator('[data-action="cancel-sign-in"]').click();
    await expect(sheet(page).locator('[data-account-problem="cancelled"]')).toHaveText('Sign-in was cancelled. Nothing changed.');
    await expect.poll(() => waiting.isClosed()).toBe(true);

    // The browser refuses to open a window.
    await page.evaluate(() => {
      window.open = () => null;
    });
    await button.click();
    await expect(sheet(page).locator('[data-account-problem="popup-blocked"]')).toContainText('Allow pop-ups');

    expect(await stored(page)).toBeNull();
    await expect(sheet(page).locator('[data-account="signed-out"]')).toBeVisible();
    // The token path is still there.
    await sheet(page).locator('[data-action="use-token"]').click();
    await expect(sheet(page).locator('#account-token')).toBeVisible();
  });
});

test('a session that ends keeps the draft and asks to sign in again', async ({ page, context }) => {
  const mock = await mockGithub(context);
  // A GitHub App session whose access token has expired and whose refresh token GitHub no longer takes.
  await signedIn(context, { method: 'app', token: 'ghu_dead', refreshToken: 'ghr_dead', expiresAt: Date.now() - 60_000, refreshExpiresAt: Date.now() + 86_400_000 });
  mock.refresh = { status: 401, body: { error: 'bad_refresh_token' } };

  await openPost(page, NOTE);
  await typeAtEnd(page, 'Typed while the session was ending.');
  await kept(page);

  // The app says so, where the work is — and the work is untouched.
  const banner = page.locator('[data-banner="signed-out"]');
  await expect(banner).toContainText('signed out');
  await expect(banner).toContainText('kept on this device');
  await expect(page.locator(EDITOR)).toContainText('Typed while the session was ending.');
  // Exactly what the worker was asked (once; a dev-server reload under the test would ask again, the same).
  expect(mock.worker.refresh[0]).toEqual({ refresh_token: 'ghr_dead' });
  expect(mock.worker.refresh.every((body) => JSON.stringify(body) === '{"refresh_token":"ghr_dead"}')).toBe(true);
  expect(await stored(page)).toBeNull();

  // Still there after a reload, with nothing signed in.
  await page.goto(appUrl(postHash(NOTE)));
  await page.reload();
  await expect(page.locator(EDITOR)).toContainText('Typed while the session was ending.');
  await openSheet(page, 'review');
  await expect(page.locator('[data-sheet="review"] [data-action="publish"]')).toHaveCount(0);
  await expect(page.locator('[data-sheet="review"] [data-action="sign-in-to-publish"]')).toBeVisible();
  expect(mock.writes()).toEqual([]);
});

/* ------------------------------------------------------------ the list's header */

for (const theme of ['galley', 'console', 'riso'] as const) {
  test(`${theme}: signed out, the wordmark stays on one line next to "Sign in"`, async ({ page, context }) => {
    await mockGithub(context);
    await context.addInitScript((id) => localStorage.setItem('write:theme', id), theme);
    await openList(page);
    await expect(page.locator('html')).toHaveAttribute('data-write-theme', theme);
    await expect(page.locator('[data-open="account"][data-account-state="signed-out"]')).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    const header = await page.evaluate(() => {
      const mark = document.querySelector<HTMLElement>('header.brand h1')!;
      const actions = document.querySelector<HTMLElement>('header.brand .brand-actions')!;
      const brand = document.querySelector<HTMLElement>('header.brand')!.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(mark);
      const m = mark.getBoundingClientRect();
      const a = actions.getBoundingClientRect();
      return {
        // One line box per line of text (the `$ ` of Console is generated content and counts too).
        lines: Math.round(m.height / parseFloat(getComputedStyle(mark).lineHeight)),
        clipped: mark.scrollWidth > mark.clientWidth + 1,
        overlap: m.right > a.left + 0.5 && m.left < a.right,
        actionsInside: a.right <= brand.right + 0.5 && a.left >= brand.left - 0.5,
        sideways: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    expect(header).toEqual({ lines: 1, clipped: false, overlap: false, actionsInside: true, sideways: false });
  });
}
