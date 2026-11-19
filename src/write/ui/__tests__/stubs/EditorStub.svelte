<!--
  Test stand-in for ../../../editor/Editor.svelte: a plain textarea that honours the parts of
  the EditorProps contract the writing screen relies on (uncontrolled `doc`, `onChange` for real
  changes only, the handle, `onNoteChange` / `onNotice`). CodeMirror itself needs a real layout
  engine and is tested in the editor's own suites.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import type { EditorHandle, EditorProps } from '../../../contracts';

  let { doc, onChange, onReady }: EditorProps = $props();

  let area = $state<HTMLTextAreaElement>();

  onMount(() => {
    // Uncontrolled, like the real editor: `doc` is read once, here.
    if (area) area.value = doc;
    // Like the real handle, every accessor answers (with nothing) once the editor is gone.
    const handle: EditorHandle = {
      exec: () => false,
      focus: () => area?.focus(),
      getDoc: () => area?.value ?? '',
      setDoc(text) {
        if (!area) return;
        area.value = text;
        onChange(text, { userEvent: false });
      },
      insertText(text) {
        if (!area) return;
        area.value += text;
        onChange(area.value, { userEvent: true });
      },
      getSelection: () => ({ anchor: area?.selectionStart ?? 0, head: area?.selectionEnd ?? 0 }),
      setSelection: () => {},
      getScrollTop: () => 0,
      setScrollTop: () => {},
      getScrollFraction: () => 0,
    };
    onReady?.(handle);
  });
</script>

<textarea bind:this={area} data-stub-editor aria-label="Post text" oninput={(e) => onChange(e.currentTarget.value, { userEvent: true })}></textarea>
