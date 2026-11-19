<!--
  "Account": sign in, see who is signed in, sign out.

  Two ways in. "Sign in with GitHub" opens the GitHub App's window (through the
  auth worker); it is not offered on localhost, where the worker refuses.
  "Use a token" takes a fine-grained personal access token and works anywhere.

  Signing in is only ever needed to publish: reading, editing, drafts, copy and
  download all work signed out, and the sheet says so. A session that ended
  (expired, revoked) is said once here and beside the post, never by losing work.

  The button that opens the window calls `signInWithGithub()` directly in its
  click handler: browsers only allow a new window from the tap itself.
-->
<script lang="ts">
  import ExternalLink from '@lucide/svelte/icons/external-link';
  import LogIn from '@lucide/svelte/icons/log-in';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import LogOut from '@lucide/svelte/icons/log-out';
  import { REPO } from '../contracts';
  import licence from '../licenses/sveltia-MIT.txt?raw';
  import Sheet from './Sheet.svelte';
  import { account, canPublishHere, cancelSignIn, popupSupported, signInWithGithub, signInWithToken, signOut, tokenHelpUrl } from './auth.svelte';

  let { onClose }: { onClose: () => void } = $props();

  const repoName = `${REPO.owner}/${REPO.name}`;
  const session = $derived(account.state);
  const user = $derived(session.user);
  /** Where the owner ends the sign-in at GitHub itself: signing out here only forgets it on this device. */
  const revokeUrl = $derived(session.method === 'token' ? 'https://github.com/settings/personal-access-tokens' : 'https://github.com/settings/apps/authorizations');

  let token = $state('');
  let checking = $state(false);
  /** The token field is tucked away where the GitHub button is the way in. */
  let tokenOpen = $state(!popupSupported);
  let avatarFailed = $state(false);

  async function submitToken(event: SubmitEvent) {
    event.preventDefault();
    if (checking || token.trim() === '') return;
    checking = true;
    const ok = await signInWithToken(token);
    checking = false;
    if (ok) token = '';
  }
</script>

<Sheet title="Account" name="account" {onClose}>
  {#if session.status === 'signed-in' && user}
    <div class="who" data-account="signed-in">
      {#if user.avatarUrl && !avatarFailed}
        <img class="avatar" src={user.avatarUrl} alt="" width="48" height="48" referrerpolicy="no-referrer" onerror={() => (avatarFailed = true)} />
      {:else}
        <span class="avatar initial" aria-hidden="true">{user.login.slice(0, 1).toUpperCase()}</span>
      {/if}
      <p class="names">
        <strong data-account-login>{user.name ?? user.login}</strong>
        <span>@{user.login} on GitHub</span>
      </p>
    </div>
    <p class="note">
      {#if !canPublishHere}
        Signed in, but this page reads the working tree, which the app does not write to. Open <code>/write/?source=github</code>
        to publish from here.
      {:else if session.method === 'token'}
        Signed in with an access token. You can publish to <code>{repoName}</code> until the token is deleted or expires.
      {:else}
        Signed in with GitHub. You can publish to <code>{repoName}</code>; the sign-in renews itself while you keep using
        this device.
      {/if}
    </p>
    <button type="button" class="w-btn is-block" data-action="sign-out" onclick={signOut}>
      <LogOut size={18} aria-hidden="true" />Sign out
    </button>
    <p class="fine">
      Signing out only forgets the sign-in on this device; it is not withdrawn at GitHub. Drafts stay where they are.
      <a href={revokeUrl} target="_blank" rel="noopener noreferrer" data-account-revoke
        >{session.method === 'token' ? 'Delete the token on GitHub' : 'Withdraw the sign-in on GitHub'}<ExternalLink size={14} aria-hidden="true" /></a
      >
    </p>
  {:else}
    {#if session.ended}
      <p class="alert" role="alert" data-account-ended={session.ended.reason}>
        {session.ended.message} Everything you wrote is still on this device.
      </p>
    {/if}

    <p class="note" data-account="signed-out">
      Sign in to publish to <code>{repoName}</code>. Reading, writing, drafts, copy and download all work without it.
    </p>

    {#if session.status === 'signing-in' && !checking}
      <div class="waiting" role="status" data-account="signing-in">
        <p>
          Waiting for GitHub in the other window. Finish there, then come back. If that window shows an error instead,
          close it and use a token.
        </p>
        <button type="button" class="w-btn" data-action="cancel-sign-in" onclick={cancelSignIn}>Cancel</button>
      </div>
    {:else if popupSupported}
      <button type="button" class="w-btn is-primary is-block" data-action="sign-in-github" disabled={checking} onclick={() => void signInWithGithub()}>
        <LogIn size={18} aria-hidden="true" />Sign in with GitHub
      </button>
    {:else}
      <p class="fine" data-account-local>
        Signing in with GitHub is not available at this address (it only works on the published site). Use a token here.
      </p>
    {/if}

    {#if account.problem}
      <p class="alert" class:soft={account.problem.reason === 'cancelled'} role="alert" data-account-problem={account.problem.reason}>
        {account.problem.message}
      </p>
    {/if}

    {#if session.status !== 'signing-in' || checking}
      {#if !tokenOpen}
        <button type="button" class="w-btn is-quiet is-block" data-action="use-token" onclick={() => (tokenOpen = true)}>
          <KeyRound size={18} aria-hidden="true" />Use a token instead
        </button>
      {:else}
        <form class="token" onsubmit={submitToken} data-account-token>
          <label for="account-token">Access token</label>
          <input
            id="account-token"
            class="w-input is-mono"
            type="password"
            autocomplete="off"
            autocapitalize="none"
            autocorrect="off"
            spellcheck="false"
            placeholder="github_pat_…"
            enterkeyhint="go"
            bind:value={token}
          />
          <p class="fine">
            A fine-grained token for <code>{repoName}</code> only, with <em>Contents: read and write</em>. It is stored in this
            browser and sent to GitHub, nowhere else.
            <a href={tokenHelpUrl} target="_blank" rel="noopener noreferrer">Create one on GitHub<ExternalLink size={14} aria-hidden="true" /></a>
          </p>
          <button type="submit" class="w-btn is-block" class:is-primary={!popupSupported} data-action="sign-in-token" disabled={checking || token.trim() === ''}>
            {checking ? 'Checking with GitHub' : 'Sign in with this token'}
          </button>
        </form>
      {/if}
    {/if}
  {/if}

  <details class="notices">
    <summary>Open-source notices</summary>
    <p class="fine">
      Sign-in, committing and image handling include code from Sveltia CMS
      (<a href="https://github.com/sveltia/sveltia-cms" target="_blank" rel="noopener noreferrer">sveltia/sveltia-cms</a>), used under the MIT
      License:
    </p>
    <pre>{licence}</pre>
  </details>
</Sheet>

<style>
  .who {
    display: flex;
    align-items: center;
    gap: var(--w-space-3);
    margin-bottom: var(--w-space-3);
  }
  .avatar {
    flex: none;
    width: 48px;
    height: 48px;
    border: var(--w-border) solid var(--w-line-strong);
    border-radius: var(--w-radius-pill);
    background: var(--w-surface-2);
    object-fit: cover;
  }
  .avatar.initial {
    display: grid;
    place-items: center;
    color: var(--w-ink-2);
    font-family: var(--w-font-display);
    font-size: var(--w-text-lg);
    font-weight: var(--w-display-weight);
  }
  .names {
    display: grid;
    gap: 2px;
    min-width: 0;
    margin: 0;
  }
  .names strong {
    font-size: var(--w-text-md);
    font-weight: var(--w-ui-strong-weight);
    overflow-wrap: anywhere;
  }
  .names span {
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
    overflow-wrap: anywhere;
  }
  .note {
    margin: 0 0 var(--w-space-4);
    color: var(--w-ink-2);
    font-size: var(--w-text-md);
    line-height: 1.45;
  }
  .fine {
    margin: var(--w-space-3) 0 0;
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
    line-height: 1.45;
  }
  .fine a {
    /* A 44px tap target without loosening the lines around it: the padding is taken back by the margin. */
    display: inline-flex;
    align-items: center;
    padding-block: 13px;
    margin-block: -13px;
    gap: 4px;
    color: var(--w-accent-text);
    text-underline-offset: 3px;
  }
  code {
    font-family: var(--w-font-mono);
    font-size: 0.92em;
    overflow-wrap: anywhere;
  }
  .alert {
    margin: 0 0 var(--w-space-4);
    padding: var(--w-space-3) var(--w-space-4);
    border-left: 3px solid var(--w-danger);
    border-radius: var(--w-radius-xs);
    background: var(--w-del-bg);
    color: var(--w-del-ink);
    font-size: var(--w-text-sm);
    line-height: 1.45;
  }
  .w-btn + .alert,
  .waiting + .alert,
  .fine + .alert {
    margin-top: var(--w-space-3);
  }
  .alert.soft {
    border-left-color: var(--w-line-strong);
    background: var(--w-surface-2);
    color: var(--w-ink-2);
  }
  .waiting {
    display: grid;
    justify-items: start;
    gap: var(--w-space-3);
    padding: var(--w-space-3) var(--w-space-4);
    border: var(--w-border) solid var(--w-line);
    border-radius: var(--w-radius-md);
    background: var(--w-accent-soft);
    font-size: var(--w-text-sm);
    line-height: 1.45;
  }
  .waiting p {
    margin: 0;
  }
  [data-action='use-token'] {
    margin-top: var(--w-space-2);
  }
  .token {
    display: grid;
    gap: var(--w-space-2);
    margin-top: var(--w-space-4);
  }
  .token label {
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
    font-weight: var(--w-ui-strong-weight);
    text-transform: var(--wx-case);
  }
  .token .fine {
    margin: 0 0 var(--w-space-2);
  }
  .notices {
    margin-top: var(--w-space-6);
    border-top: var(--w-border) solid var(--w-line);
    padding-top: var(--w-space-3);
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
  }
  .notices summary {
    min-height: var(--w-tap);
    display: flex;
    align-items: center;
    cursor: pointer;
    text-transform: var(--wx-case);
  }
  .notices pre {
    margin: var(--w-space-3) 0 0;
    padding: var(--w-space-3);
    border-radius: var(--w-radius-sm);
    background: var(--w-surface-2);
    font-family: var(--w-font-mono);
    font-size: var(--w-text-xs);
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
