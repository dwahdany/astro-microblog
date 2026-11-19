<!--
  A text field bound to a value that lives in the post's text.

  While the field has focus it shows what was typed, not what came back from
  the frontmatter: YAML may hand a value back changed (a trailing space is
  dropped from a plain scalar, for one), and echoing that would fight the
  typist. On blur it shows the stored value again.

  `wrap`: a one-line VALUE in a field that wraps (a long title read in full on
  a phone). It grows with its text and never holds a line break: Enter is
  swallowed and pasted breaks become spaces.
-->
<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';

  let {
    value,
    onInput,
    multiline = false,
    wrap = false,
    class: className = 'w-input',
    ...rest
  }: Omit<HTMLInputAttributes, 'value' | 'oninput' | 'class'> & {
    value: string;
    onInput: (value: string) => void;
    multiline?: boolean;
    wrap?: boolean;
    class?: string;
  } = $props();

  let typed = $state<string | null>(null);
  const shown = $derived(typed ?? value);

  function input(text: string) {
    typed = text;
    onInput(text);
  }

  /** A wrapping one-line field: whatever arrives, the value has no line break. */
  function inputWrapped(area: HTMLTextAreaElement) {
    const flat = area.value.replace(/\s*[\r\n]+\s*/g, ' ');
    if (flat !== area.value) {
      const at = Math.min(area.selectionStart, flat.length);
      area.value = flat;
      area.setSelectionRange(at, at);
    }
    input(flat);
  }
</script>

{#if wrap}
  <textarea
    class="{className} is-wrap"
    rows="1"
    value={shown}
    oninput={(e) => inputWrapped(e.currentTarget)}
    onkeydown={(e) => {
      if (e.key === 'Enter' && !e.isComposing) e.preventDefault();
    }}
    onblur={() => (typed = null)}
    id={rest.id}
    placeholder={rest.placeholder}
    aria-invalid={rest['aria-invalid']}
    aria-describedby={rest['aria-describedby']}
    autocapitalize={rest.autocapitalize}
    autocomplete="off"
    enterkeyhint="done"
    spellcheck={rest.spellcheck}
  ></textarea>
{:else if multiline}
  <textarea
    class={className}
    rows="3"
    value={shown}
    oninput={(e) => input(e.currentTarget.value)}
    onblur={() => (typed = null)}
    id={rest.id}
    placeholder={rest.placeholder}
    aria-invalid={rest['aria-invalid']}
    aria-describedby={rest['aria-describedby']}
    spellcheck={rest.spellcheck}
  ></textarea>
{:else}
  <input
    {...rest}
    class={className}
    value={shown}
    oninput={(e) => input(e.currentTarget.value)}
    onblur={() => (typed = null)}
  />
{/if}
