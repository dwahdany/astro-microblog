/**
 * Publishing, in a real browser, with GitHub pretended (./github-mock.ts): the app's own requests
 * are checked body for body, and the pretend repo is checked for what landed.
 *
 *   update · create · delete (behind a confirmation) · move (rename) · a draft (is_draft)
 *   the branch moved under the save (retried on the new head, unseen)
 *   the post itself changed (a conflict: nothing is committed, nothing is lost)
 *   an expired access token (refreshed through the worker, then the commit goes out)
 *   a token that stops working mid-session; no network; a token that may not write
 *
 * Runs in every project: desktop Chromium, Pixel 7 emulation and the iPhone profile on WebKit.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  EDITOR,
  ENTRY,
  ENTRY_IMAGE,
  ENTRY_TEXT,
  NOTE,
  NOTE_TEXT,
  OTHER,
  OTHER_TEXT,
  PRICES,
  REPO,
  closeSheet,
  decode,
  kept,
  mockGithub,
  openList,
  openPost,
  openSheet,
  signedIn,
  stored,
  typeAtEnd,
} from './github-mock';

const review = (page: Page) => page.locator('[data-sheet="review"]');
const publishButton = (page: Page) => review(page).locator('[data-action="publish"]');
const BRANCH = { repositoryNameWithOwner: REPO, branchName: 'main' };

async function publish(page: Page) {
  await openSheet(page, 'review');
  await expect(publishButton(page)).toBeEnabled();
  await publishButton(page).click();
}

test('update: one commit with exactly the new text, on the head it was read at; then a link to the commit', async ({ page, context }) => {
  const mock = await mockGithub(context);
  await signedIn(context);
  await openPost(page, NOTE);
  const head = mock.gh.head();
  await typeAtEnd(page, 'Third line.');
  await kept(page);
  const expected = NOTE_TEXT + 'Third line.\n';

  await openSheet(page, 'review');
  // What will happen is on the sheet: the diff, the commit message, where it goes.
  await expect(review(page).locator('[data-review-diff]')).toContainText('Third line.');
  await expect(review(page).locator('[data-commit-message]')).toHaveValue('Update Note “2026/hello”');
  await expect(review(page)).toContainText(`one commit to the repository, as ${NOTE}`);
  mock.gh.reset();
  await publishButton(page).click();

  await expect(review(page).locator('[data-published]')).toContainText('Published');
  // The one write GitHub got, in full.
  expect(mock.writes().map((c) => `${c.method} ${c.url} ${c.auth}`)).toEqual(['POST https://api.github.com/graphql token github_pat_good']);
  expect(mock.inputs()).toEqual([
    {
      branch: BRANCH,
      expectedHeadOid: head,
      fileChanges: { additions: [{ path: NOTE, contents: Buffer.from(expected, 'utf8').toString('base64') }], deletions: [] },
      message: { headline: 'Update Note “2026/hello”' },
    },
  ]);
  expect(mock.gh.text(NOTE)).toBe(expected);
  expect(mock.gh.log()[0].message).toBe('Update Note “2026/hello”');
  // The link goes to that commit.
  await expect(review(page).locator('[data-commit-link]')).toHaveAttribute('href', `https://github.com/${REPO}/commit/${mock.gh.head()}`);

  // The post is clean again: nothing to publish, no draft left, also after a reload.
  await expect(review(page).locator('[data-review-state]')).toHaveAttribute('data-review-state', 'unchanged');
  await expect(publishButton(page)).toBeDisabled();
  await closeSheet(page);
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');
  await page.reload();
  await expect(page.locator(EDITOR)).toContainText('Third line.');
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');
  await expect(page.locator('[data-banner="restored"]')).toHaveCount(0);
});

test('the commit message can be changed, and a draft (is_draft) publishes like anything else', async ({ page, context }) => {
  const mock = await mockGithub(context);
  await signedIn(context);
  await openPost(page, OTHER);
  await typeAtEnd(page, 'Still a draft.');
  await kept(page);
  await openSheet(page, 'review');
  await review(page).locator('[data-commit-message]').fill('Tidy the other note');
  await publishButton(page).click();
  await expect(review(page).locator('[data-published]')).toBeVisible();
  expect(mock.inputs()[0].message).toEqual({ headline: 'Tidy the other note' });
  expect(mock.gh.text(OTHER)).toBe(OTHER_TEXT + 'Still a draft.\n');
  expect(mock.gh.text(OTHER)).toContain('is_draft: true');
});

test('create: a new post is committed at the address its slug gives it, and opens there', async ({ page, context }) => {
  const mock = await mockGithub(context);
  await signedIn(context);
  await openList(page);
  await page.locator('[data-open="new"]').click();
  await page.locator('[data-new="notes"]').click();
  await expect(page.locator(EDITOR)).toBeVisible();
  await page.locator('[data-title-input]').fill('A brand new note');
  await page.locator(EDITOR).click();
  await page.keyboard.type('Hello from the phone.');
  await kept(page);
  const year = new Date().getUTCFullYear();
  const path = `src/content/notes/${year}/a-brand-new-note.md`;
  const head = mock.gh.head();

  await openSheet(page, 'review');
  await expect(review(page).locator('[data-review-path]')).toHaveText(path);
  await expect(review(page).locator('[data-commit-message]')).toHaveValue(`Create Note “${year}/a-brand-new-note”`);
  mock.gh.reset();
  await publishButton(page).click();

  // It moves to its real address and says how it went.
  await expect(page).toHaveURL(new RegExp(`#/post/${encodeURIComponent(path)}$`));
  await expect(page.locator('[data-banner="published"]')).toContainText(`Published as ${path}`);
  await expect(page.locator('[data-banner="published"] [data-commit-link]')).toHaveAttribute('href', `https://github.com/${REPO}/commit/${mock.gh.head()}`);
  await expect(page.locator(EDITOR)).toContainText('Hello from the phone.');
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'clean');

  const inputs = mock.inputs();
  expect(inputs).toHaveLength(1);
  expect(inputs[0].branch).toEqual(BRANCH);
  expect(inputs[0].expectedHeadOid).toBe(head);
  expect(inputs[0].message).toEqual({ headline: `Create Note “${year}/a-brand-new-note”` });
  expect(inputs[0].fileChanges.deletions).toEqual([]);
  expect(inputs[0].fileChanges.additions.map((a: { path: string }) => a.path)).toEqual([path]);
  const text = decode(inputs[0].fileChanges.additions[0].contents);
  expect(text).toMatch(/^---\nslug: a-brand-new-note\n/);
  expect(text).toMatch(/\ntitle: '?A brand new note'?\n/);
  expect(text).toContain('is_draft: true\n');
  expect(text.endsWith('\nHello from the phone.\n')).toBe(true);
  expect(mock.gh.text(path)).toBe(text);

  // The list has it as a post, not as something kept on this device.
  await page.locator('[data-action="back"]').click();
  await expect(page.locator('[data-post-list]')).toContainText('A brand new note');
  await expect(page.locator('[data-post-list]')).not.toContainText('Not published');
});

test('delete: only after an explicit confirmation; the post and its images go in one commit', async ({ page, context }) => {
  const mock = await mockGithub(context);
  await signedIn(context);
  await openPost(page, ENTRY);
  const head = mock.gh.head();
  await openSheet(page, 'review');
  mock.gh.reset();

  // First tap only asks.
  await review(page).locator('[data-action="delete-post"]').click();
  await expect(review(page).locator('[data-delete-post]')).toContainText(`Delete ${ENTRY} from the repository?`);
  await expect(review(page).locator('[data-delete-post]')).toContainText('its 1 image goes with it');
  expect(mock.writes()).toEqual([]);
  // Backing out deletes nothing.
  await review(page).locator('[data-delete-post] button', { hasText: 'Keep the post' }).click();
  await expect(review(page).locator('[data-action="delete-post-confirm"]')).toHaveCount(0);
  expect(mock.writes()).toEqual([]);

  await review(page).locator('[data-action="delete-post"]').click();
  await review(page).locator('[data-action="delete-post-confirm"]').click();

  // Back at the list, which says so and no longer has the post.
  await expect(page.locator('[data-list-notice="deleted"]')).toContainText(`Deleted ${ENTRY}`);
  await expect(page.locator('[data-list-notice="deleted"] a')).toHaveAttribute('href', `https://github.com/${REPO}/commit/${mock.gh.head()}`);
  await expect(page.locator('[data-post-list]')).not.toContainText('With pictures');
  await expect(page.locator('[data-post-list]')).toContainText('Hello');

  expect(mock.inputs()).toEqual([
    {
      branch: BRANCH,
      expectedHeadOid: head,
      fileChanges: { additions: [], deletions: [{ path: ENTRY }, { path: ENTRY_IMAGE }] },
      message: { headline: 'Delete Entry “2025/with-pics” +1' },
    },
  ]);
  expect(mock.gh.paths()).not.toContain(ENTRY);
  expect(mock.gh.paths()).not.toContain(ENTRY_IMAGE);
});

test('move: a changed slug can take the file along; the old address and its images move in the same commit', async ({ page, context }) => {
  const mock = await mockGithub(context);
  await signedIn(context);
  await openPost(page, ENTRY);
  const head = mock.gh.head();
  const image = mock.gh.file(ENTRY_IMAGE)!;

  await openSheet(page, 'properties');
  const slug = page.locator('[data-sheet="properties"] [data-field="slug"] input');
  await slug.fill('with-photos');
  await slug.blur();
  await closeSheet(page);
  await kept(page);

  await openSheet(page, 'review');
  // Not done unasked: without the tick the post keeps its address.
  const tick = review(page).locator('[data-move-file]');
  await expect(tick).not.toBeChecked();
  await expect(review(page).locator('[data-commit-message]')).toHaveValue('Update Entry “2025/with-pics”');
  await tick.check();
  const to = 'src/content/entries/2025/with-photos.md';
  await expect(review(page).locator('[data-review-path]')).toContainText(`→ ${to}`);
  await expect(review(page).locator('[data-commit-message]')).toHaveValue('Update Entry “2025/with-photos” +1');
  mock.gh.reset();
  await publishButton(page).click();

  await expect(page).toHaveURL(new RegExp(`#/post/${encodeURIComponent(to)}$`));
  await expect(page.locator('[data-banner="published"]')).toContainText(`Published as ${to}`);

  const moved = ENTRY_TEXT.replace('slug: with-pics', 'slug: with-photos').replace('(with-pics/a.png)', '(with-photos/a.png)');
  const inputs = mock.inputs();
  expect(inputs).toHaveLength(1);
  expect(inputs[0].expectedHeadOid).toBe(head);
  expect(inputs[0].message).toEqual({ headline: 'Update Entry “2025/with-photos” +1' });
  const additions = Object.fromEntries(inputs[0].fileChanges.additions.map((a: { path: string; contents: string }) => [a.path, a.contents]));
  expect(Object.keys(additions).sort()).toEqual(['src/content/entries/2025/with-photos.md', 'src/content/entries/2025/with-photos/a.png']);
  expect(decode(additions[to])).toBe(moved);
  expect(additions['src/content/entries/2025/with-photos/a.png']).toBe(Buffer.from(image).toString('base64'));
  expect(inputs[0].fileChanges.deletions.map((d: { path: string }) => d.path).sort()).toEqual([ENTRY, ENTRY_IMAGE]);
  expect(mock.gh.paths()).not.toContain(ENTRY);
  expect(mock.gh.text(to)).toBe(moved);

  // The picture shows at its new address (from the bytes this session holds).
  await expect(page.locator('[data-write-editor] .cm-w-image[data-state="loaded"]').first()).toBeVisible();
});

test('the branch moved under the save (another commit, another file): committed on the new head without a word', async ({ page, context }) => {
  const mock = await mockGithub(context);
  await signedIn(context);
  await openPost(page, NOTE);
  await typeAtEnd(page, 'Mine.');
  await kept(page);
  const first = mock.gh.head();
  // The price bot commits between the app reading the head and its own commit arriving.
  let bot = '';
  mock.gh.state.beforeCommit = () => {
    mock.gh.state.beforeCommit = undefined;
    bot = mock.gh.push({ [PRICES]: '{"v":2}\n' });
  };
  mock.gh.reset();
  await publish(page);
  await expect(review(page).locator('[data-published]')).toContainText('Published');
  await expect(review(page).locator('[data-publish-error]')).toHaveCount(0);

  // Two attempts: the first on the old head (refused), the second on the bot's commit, same content.
  const inputs = mock.inputs();
  expect(inputs.map((i) => i.expectedHeadOid)).toEqual([first, bot]);
  expect(inputs[1].fileChanges).toEqual(inputs[0].fileChanges);
  expect(mock.gh.text(NOTE)).toBe(NOTE_TEXT + 'Mine.\n');
  expect(mock.gh.text(PRICES)).toBe('{"v":2}\n');
  expect(mock.gh.log().map((c) => c.message).slice(0, 2)).toEqual(['Update Note “2026/hello”', 'Refresh portfolio price cache']);
});

/**
 * The conflict Review on a phone: the footer used to take more than half the screen and three red
 * blocks said nearly the same thing. Now: one message, a footer of buttons, and the diff in view.
 */
async function expectConflictLayout(page: Page) {
  const layout = await page.evaluate(() => {
    const sheet = document.querySelector<HTMLElement>('[data-sheet="review"]')!;
    const footer = sheet.querySelector('footer')!.getBoundingClientRect();
    const body = sheet.querySelector<HTMLElement>('.body')!;
    const diff = sheet.querySelector('[data-review-diff]')!.getBoundingClientRect();
    const bodyBox = body.getBoundingClientRect();
    return {
      viewport: window.innerHeight,
      footer: Math.round(footer.height),
      // How much of the diff is on screen without scrolling.
      diffInView: Math.round(Math.min(diff.bottom, bodyBox.bottom) - Math.max(diff.top, bodyBox.top)),
      sideways: document.documentElement.scrollWidth > window.innerWidth,
    };
  });
  expect(layout.sideways).toBe(false);
  // Buttons and one line of small print, not a wall of warnings.
  expect(layout.footer).toBeLessThan(layout.viewport * 0.3);
  // At least a few lines of the diff show at once (a line is about 22px).
  expect(layout.diffInView).toBeGreaterThan(Math.min(110, layout.viewport * 0.14));
}

test('the post itself changed in the repo: nothing is committed, nothing is lost, and the conflict flow takes over', async ({ page, context }) => {
  const mock = await mockGithub(context);
  await signedIn(context);
  await openPost(page, NOTE);
  await typeAtEnd(page, 'Mine.');
  await kept(page);
  // Someone else rewrites the same last line region and the first line.
  const theirs = NOTE_TEXT.replace('Second line.\n', 'Second line, theirs.\nAnd one more.\n');
  mock.gh.push({ [NOTE]: theirs }, 'Edit from elsewhere');
  mock.gh.reset();

  await publish(page);
  await expect(review(page).locator('[data-publish-error="conflict:changed"]')).toContainText('Nothing was published');
  expect(mock.mutations()).toEqual([]);
  expect(mock.gh.text(NOTE)).toBe(theirs);

  // The post was read again: it is in conflict now, the owner's text is what is shown, Publish is blocked.
  await expect(review(page).locator('[data-review-conflict]')).toBeVisible();
  await expect(publishButton(page)).toBeDisabled();
  // It is said once: what happened, that nothing was published, and the way out — above the diff.
  await expect(review(page).locator('[data-review-conflict]')).toContainText('would undo');
  await expect(review(page).locator('[data-review-conflict]')).toContainText('Nothing was published');
  await expect(review(page).locator('[role="alert"]')).toHaveCount(1);
  await expect(review(page).locator('[data-publish-blockers]')).toHaveCount(0);
  await expectConflictLayout(page);
  await closeSheet(page);
  await expect(page.locator('[data-banner="upstream-conflict"]')).toBeVisible();
  await expect(page.locator(EDITOR)).toContainText('Mine.');

  // "Keep mine" resolves it: the next publish names the NEW blob as its base and goes through.
  await page.locator('[data-action="keep-mine"]').click();
  await expect(page.locator('[data-banner="upstream-conflict"]')).toHaveCount(0);
  await publish(page);
  await expect(review(page).locator('[data-published]')).toBeVisible();
  expect(mock.mutations()).toHaveLength(1);
  expect(mock.gh.text(NOTE)).toBe(NOTE_TEXT + 'Mine.\n');
});

test('an expired access token is refreshed through the worker, then the commit goes out with the new one', async ({ page, context }) => {
  const mock = await mockGithub(context);
  // A GitHub App session whose 8 hours are over; the refresh token is still good.
  await signedIn(context, { method: 'app', token: 'ghu_expired', refreshToken: 'ghr_first', expiresAt: Date.now() - 60_000, refreshExpiresAt: Date.now() + 86_400_000 });
  await openPost(page, NOTE);
  await typeAtEnd(page, 'After the refresh.');
  await kept(page);
  const before = Date.now();
  await publish(page);
  await expect(review(page).locator('[data-published]')).toBeVisible();

  // The worker was asked once, with exactly the refresh token; the new pair is what is stored.
  expect(mock.worker.refresh).toEqual([{ refresh_token: 'ghr_first' }]);
  const session = (await stored(page)) as { expiresAt: number };
  expect(session).toMatchObject({ method: 'app', token: 'ghu_renewed', refreshToken: 'ghr_second' });
  expect(session.expiresAt).toBeGreaterThan(before + 28_000_000);
  // GitHub never saw the expired token, and the commit carried the new one.
  expect(mock.gh.calls.some((c) => c.auth?.includes('ghu_expired'))).toBe(false);
  expect(mock.mutations().map((c) => c.auth)).toEqual(['token ghu_renewed']);
  expect(mock.gh.text(NOTE)).toBe(NOTE_TEXT + 'After the refresh.\n');
});

test('a token GitHub stops accepting mid-session: refreshed once on the 401 and the publish still succeeds', async ({ page, context }) => {
  const mock = await mockGithub(context);
  await signedIn(context, { method: 'app', token: 'ghu_first', refreshToken: 'ghr_first', expiresAt: Date.now() + 3_600_000 });
  await openPost(page, NOTE);
  await typeAtEnd(page, 'Carried over.');
  await kept(page);
  mock.gh.state.tokens.delete('ghu_first');
  mock.gh.reset();
  await publish(page);
  await expect(review(page).locator('[data-published]')).toBeVisible();
  expect(mock.worker.refresh).toEqual([{ refresh_token: 'ghr_first' }]);
  expect(mock.mutations().map((c) => c.auth)).toEqual(['token ghu_renewed']);
  expect(mock.gh.text(NOTE)).toBe(NOTE_TEXT + 'Carried over.\n');
});

test('a session that cannot be renewed fails the publish gently: the draft stays, and signing in again publishes it', async ({ page, context }) => {
  const mock = await mockGithub(context);
  await signedIn(context, { method: 'app', token: 'ghu_first', refreshToken: 'ghr_first', expiresAt: Date.now() + 3_600_000 });
  await openPost(page, NOTE);
  await typeAtEnd(page, 'Not lost.');
  await kept(page);
  mock.gh.state.tokens.delete('ghu_first');
  mock.refresh = { status: 401, body: { error: 'bad_refresh_token' } };
  await publish(page);

  const error = review(page).locator('[data-publish-error]');
  await expect(error).toContainText('Nothing was published');
  await expect(error).toContainText('still on this device');
  expect(mock.mutations()).toEqual([]);
  await expect(publishButton(page)).toHaveCount(0);
  await expect(review(page).locator('[data-review-diff]')).toContainText('Not lost.');

  // ONE way to sign in is offered, not three: the main button. (It used to be doubled by a
  // button inside the error and a status line saying the same.)
  await expect(review(page).locator('[data-action="sign-in-to-publish"]')).toBeVisible();
  await expect(review(page).locator('[data-action="sign-in-again"]')).toHaveCount(0);
  await expect(review(page).locator('[data-publish-status]')).not.toContainText('Sign in to publish from here');

  // Sign in again (a token this time): that comes straight back to Review, the old error gone.
  await review(page).locator('[data-action="sign-in-to-publish"]').click();
  const account = page.locator('[data-sheet="account"]');
  await expect(account.locator('[data-account-ended]')).toContainText('still on this device');
  await account.locator('#account-token').fill('github_pat_good');
  await account.locator('[data-action="sign-in-token"]').click();
  await expect(review(page)).toBeVisible();
  await expect(review(page).locator('[data-publish-error]')).toHaveCount(0);
  await publish(page);
  await expect(review(page).locator('[data-published]')).toBeVisible();
  expect(mock.gh.text(NOTE)).toBe(NOTE_TEXT + 'Not lost.\n');
});

test('no network, and a token that may not write: each fails with a reason and keeps the text', async ({ page, context }) => {
  const mock = await mockGithub(context);
  await signedIn(context);
  await openPost(page, NOTE);
  await typeAtEnd(page, 'Kept either way.');
  await kept(page);

  mock.gh.state.offline = true;
  await publish(page);
  await expect(review(page).locator('[data-publish-error="offline"]')).toContainText('Nothing was published');
  mock.gh.state.offline = false;

  // GitHub refuses the write both ways (GraphQL and the Git Data API).
  mock.gh.state.graphqlForbidden = true;
  mock.gh.state.restForbidden = true;
  await expect(publishButton(page)).toBeEnabled();
  await publishButton(page).click();
  await expect(review(page).locator('[data-publish-error="forbidden"]')).toContainText('Nothing was published');
  expect(mock.gh.text(NOTE)).toBe(NOTE_TEXT);

  // Allowed again: the same button publishes what was kept.
  mock.gh.state.graphqlForbidden = false;
  mock.gh.state.restForbidden = false;
  await publishButton(page).click();
  await expect(review(page).locator('[data-published]')).toBeVisible();
  expect(mock.gh.text(NOTE)).toBe(NOTE_TEXT + 'Kept either way.\n');
});

test('a publish that fails after Review was closed is said on the writing screen, and again in Review', async ({ page, context }) => {
  const mock = await mockGithub(context);
  await signedIn(context);
  await openPost(page, NOTE);
  await typeAtEnd(page, 'Sent, then the sheet was closed.');
  await kept(page);

  // The commit is held on its way; when let go, the network is gone.
  let reached!: () => void;
  const arrived = new Promise<void>((resolve) => (reached = resolve));
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route('https://api.github.com/graphql', async (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    reached();
    await held;
    await route.abort('internetdisconnected');
  });

  await publish(page);
  await arrived;
  // The writer does not wait: closes the sheet and looks at the text.
  await closeSheet(page);
  await expect(page.locator('[data-banner="publish-failed"]')).toHaveCount(0);
  release();

  const banner = page.locator('[data-banner="publish-failed"]');
  await expect(banner).toHaveAttribute('data-publish-failed', 'offline');
  await expect(banner).toContainText('Nothing was published');
  await expect(banner).toContainText('still on this device');
  await expect(page.locator('[data-write-state]')).toHaveAttribute('data-write-state', 'edited');
  expect(mock.gh.text(NOTE)).toBe(NOTE_TEXT);

  // Its "Review" leads back to the sheet, which says the same and offers Publish again.
  await banner.locator('[data-open="review"]').click();
  await expect(review(page).locator('[data-publish-error="offline"]')).toContainText('Nothing was published');
  await page.unroute('https://api.github.com/graphql');
  await publishButton(page).click();
  await expect(review(page).locator('[data-published]')).toBeVisible();
  expect(mock.gh.text(NOTE)).toBe(NOTE_TEXT + 'Sent, then the sheet was closed.\n');
});

test('a short viewport (the keyboard up, a phone on its side): Publish, Copy and Download can still be reached', async ({ page, context }) => {
  const mock = await mockGithub(context);
  await signedIn(context);
  await page.setViewportSize({ width: 390, height: 360 });
  await openPost(page, NOTE);
  await typeAtEnd(page, 'Short screen.');
  await kept(page);
  // With an error showing, the sheet's footer is at its tallest.
  mock.gh.state.offline = true;
  await publish(page);
  await expect(review(page).locator('[data-publish-error="offline"]')).toBeVisible();
  mock.gh.state.offline = false;

  // The footer ends inside the viewport and scrolls by itself (a finger can only scroll what
  // scrolls: `scrollIntoView` would also move clipped boxes a finger cannot).
  const footer = review(page).locator('footer');
  const inView = async (action: string) => {
    const box = (await review(page).locator(`[data-action="${action}"]`).boundingBox())!;
    const within = (await footer.boundingBox())!;
    // (a pixel of slack: the sheet's edges fall on fractions of a pixel)
    return box.y >= within.y - 1 && box.y + box.height <= Math.min(within.y + within.height, 360) + 1;
  };
  const area = (await footer.boundingBox())!;
  expect(area.y).toBeGreaterThanOrEqual(0);
  expect(area.y + area.height).toBeLessThanOrEqual(361);
  await footer.evaluate((el) => (el.scrollTop = el.scrollHeight));
  expect(await inView('copy'), 'copy').toBe(true);
  expect(await inView('download'), 'download').toBe(true);
  // Publish is further up in the footer: scrolled to, it is whole as well.
  await review(page).locator('[data-action="publish"]').evaluate((el) => {
    const strip = el.closest('footer')!;
    strip.scrollTop += el.getBoundingClientRect().top - strip.getBoundingClientRect().top - 4;
  });
  expect(await inView('publish'), 'publish').toBe(true);
  // Nothing else was moved to get there.
  expect(await page.evaluate(() => [document.scrollingElement?.scrollTop ?? 0, document.querySelector('[data-write-app]')!.scrollTop])).toEqual([0, 0]);
  // And it works from there.
  await publishButton(page).click();
  await expect.poll(() => mock.gh.text(NOTE)).toBe(NOTE_TEXT + 'Short screen.\n');
});
