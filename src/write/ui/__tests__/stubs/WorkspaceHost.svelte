<!--
  Test stand-in for App.svelte's part in the writing screen: it owns which sheet is open, so a
  test can close or swap the sheet while the screen stays mounted (as the router does in the app).
-->
<script lang="ts">
  import type { PostSheet } from '../../routes';
  import Workspace from '../../Workspace.svelte';

  let { id, initialSheet = null }: { id: string; initialSheet?: PostSheet | null } = $props();
  // svelte-ignore state_referenced_locally
  let sheet = $state<PostSheet | null>(initialSheet);

  export function setSheet(next: PostSheet | null) {
    sheet = next;
  }
</script>

<Workspace {id} {sheet} />
