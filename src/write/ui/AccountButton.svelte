<!--
  The way to the Account sheet, as it sits in a header: the avatar of whoever is signed in, or
  "Sign in" (spelled out where there is room and signing in leads somewhere). A dot marks a
  session that ended and wants signing in again.
-->
<script lang="ts">
  import CircleUser from '@lucide/svelte/icons/circle-user';
  import { account, canPublishHere } from './auth.svelte';
  import { router } from './router.svelte';

  let { labelled = false }: { /** Spell out "Sign in" while signed out. */ labelled?: boolean } = $props();

  const user = $derived(account.state.status === 'signed-in' ? account.state.user : undefined);
  const ended = $derived(account.state.status !== 'signed-in' && account.state.ended !== undefined);
  let failed = $state<string | null>(null);
</script>

{#if !user && labelled && canPublishHere}
  <button type="button" class="w-btn is-quiet signin" data-open="account" data-account-state="signed-out" onclick={() => router.openSheet('account')}>
    Sign in{#if ended}<span class="pip" aria-hidden="true"></span><span class="w-sr"> again: you were signed out</span>{/if}
  </button>
{:else}
  <button
    type="button"
    class="w-icon"
    data-open="account"
    data-account-state={user ? 'signed-in' : 'signed-out'}
    aria-label={user ? `Account: signed in as ${user.login}` : ended ? 'Sign in again: you were signed out' : 'Sign in'}
    title={user ? `Signed in as ${user.login}` : 'Sign in'}
    onclick={() => router.openSheet('account')}
  >
    {#if user?.avatarUrl && failed !== user.avatarUrl}
      <img src={user.avatarUrl} alt="" width="26" height="26" referrerpolicy="no-referrer" onerror={() => (failed = user.avatarUrl ?? null)} />
    {:else if user}
      <span class="initial" aria-hidden="true">{user.login.slice(0, 1).toUpperCase()}</span>
    {:else}
      <CircleUser size={20} aria-hidden="true" />
    {/if}
    {#if ended}<span class="pip" aria-hidden="true"></span>{/if}
  </button>
{/if}

<style>
  button {
    position: relative;
    flex: none;
  }
  .signin {
    padding: 0 var(--w-space-3);
    color: var(--w-accent-text);
  }
  img,
  .initial {
    width: 26px;
    height: 26px;
    border: var(--w-border) solid var(--w-line-strong);
    border-radius: var(--w-radius-pill);
    background: var(--w-surface-2);
    object-fit: cover;
  }
  .initial {
    display: grid;
    place-items: center;
    color: var(--w-ink-2);
    font-size: var(--w-text-xs);
    font-weight: var(--w-ui-strong-weight);
  }
  .pip {
    position: absolute;
    top: 9px;
    right: 9px;
    width: 8px;
    height: 8px;
    border-radius: var(--w-radius-pill);
    background: var(--w-danger);
    box-shadow: 0 0 0 2px var(--w-bg);
  }
  .signin .pip {
    top: 8px;
    right: 2px;
  }
</style>
