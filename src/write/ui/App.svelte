<!--
  App root, mounted by src/pages/write/index.astro (client:only).

  Two screens on hash routes — the post list and one post open for writing —
  plus the sheets that belong to a route (see ./routes.ts). Everything the app
  knows about posts comes through the contracts (../data, ../editor, ../preview).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import AccountSheet from './AccountSheet.svelte';
  import LookSheet from './LookSheet.svelte';
  import PostList from './PostList.svelte';
  import Workspace from './Workspace.svelte';
  import { followSystem } from './look.svelte';
  import { router } from './router.svelte';
  import { trackViewport } from './viewport.svelte';

  const route = $derived(router.route);

  onMount(() => {
    const stopViewport = trackViewport();
    const stopRouter = router.start();
    const stopScheme = followSystem();
    return () => {
      stopViewport();
      stopRouter();
      stopScheme();
    };
  });
</script>

<div class="app" data-write-app data-route={route.name}>
  {#if route.name === 'post'}
    {#key route.id}
      <Workspace id={route.id} sheet={route.sheet} />
    {/key}
  {:else}
    <PostList sheet={route.sheet} />
  {/if}

  {#if route.sheet === 'look'}
    <LookSheet onClose={() => router.closeSheet()} />
  {:else if route.sheet === 'account'}
    <AccountSheet onClose={() => router.closeSheet()} />
  {/if}
</div>

<style>
  /* Sized to the VISIBLE viewport, so nothing ever sits under the keyboard. */
  .app {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: var(--w-vv-height);
    transform: translateY(var(--w-vv-offset));
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background-color: var(--w-bg);
    background-image: var(--wx-canvas);
    background-size: var(--wx-canvas-size);
    color: var(--w-ink);
  }
</style>
