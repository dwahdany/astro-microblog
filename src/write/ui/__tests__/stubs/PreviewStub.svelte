<!-- Test stand-in for ../../../preview/Preview.svelte (an iframe pipeline that needs a browser). -->
<script lang="ts">
  import type { PreviewProps } from '../../../contracts';
  let { markdown, startAt }: PreviewProps = $props();
</script>

<pre data-stub-preview data-start-at={startAt}>{markdown}</pre>
