<!--
  Tags as removable chips plus one input. Enter or a comma adds what was typed;
  Backspace in the empty input takes the last tag back. Below, the tags already
  used on the blog (most used first, narrowed as you type) — one tap adds one,
  without the keyboard going away.
-->
<script lang="ts">
  import X from '@lucide/svelte/icons/x';

  let {
    id,
    value,
    suggestions,
    onChange,
  }: {
    id: string;
    value: string[];
    /** Existing tags, most used first. */
    suggestions: readonly string[];
    onChange: (tags: string[]) => void;
  } = $props();

  let typed = $state('');

  const offered = $derived.by(() => {
    const q = typed.trim().toLowerCase();
    const have = new Set(value.map((t) => t.toLowerCase()));
    return suggestions.filter((t) => !have.has(t.toLowerCase()) && (q === '' || t.toLowerCase().includes(q))).slice(0, 10);
  });

  function add(raw: string) {
    const tag = raw.trim().replace(/^#/, '');
    typed = '';
    if (tag === '' || value.some((t) => t.toLowerCase() === tag.toLowerCase())) return;
    onChange([...value, tag]);
  }

  /** By position, not by text: a file may list the same tag twice, and removing one must leave the other. */
  function remove(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      add(typed);
    } else if (event.key === 'Backspace' && typed === '' && value.length > 0) {
      event.preventDefault();
      remove(value.length - 1);
    }
  }

  /** Phone keyboards may not send a `,` keydown; catch the character itself too. */
  function onInput() {
    if (typed.includes(',')) {
      const pieces = typed.split(',');
      const rest = pieces.pop() ?? '';
      const next = [...value];
      for (const piece of pieces) {
        const tag = piece.trim().replace(/^#/, '');
        if (tag !== '' && !next.some((t) => t.toLowerCase() === tag.toLowerCase())) next.push(tag);
      }
      typed = rest;
      if (next.length !== value.length) onChange(next);
    }
  }
</script>

<div class="tags" data-tag-field>
  <!-- A label, so a tap anywhere in the box lands in the field. -->
  <label class="box" for={id}>
    <!-- Keyed by position: the tags come from the file and may repeat (a repeated key is a crash in Svelte). -->
    {#each value as tag, i (i)}
      <span class="tag" data-tag={tag}>
        {tag}
        <button type="button" aria-label="Remove tag {tag}" onclick={() => remove(i)}><X size={14} aria-hidden="true" /></button>
      </span>
    {/each}
    <input
      {id}
      type="text"
      autocapitalize="none"
      autocomplete="off"
      autocorrect="off"
      spellcheck="false"
      enterkeyhint="done"
      placeholder={value.length ? 'Add another' : 'Add a tag'}
      bind:value={typed}
      onkeydown={onKeydown}
      oninput={onInput}
      onblur={() => add(typed)}
    />
  </label>
  {#if offered.length}
    <div class="offer" role="group" aria-label="Tags already in use">
      {#each offered as tag (tag)}
        <button
          type="button"
          class="suggestion"
          data-tag-suggestion={tag}
          onpointerdown={(e) => e.preventDefault()}
          onclick={() => add(tag)}
        >
          {tag}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .tags {
    display: grid;
    gap: var(--w-space-2);
  }
  .box {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 var(--w-space-2);
    min-height: var(--w-tap);
    padding: 0 var(--w-space-2);
    border: var(--w-border) solid var(--w-line);
    border-radius: var(--w-radius-sm);
    background: var(--w-surface-2);
    cursor: text;
  }
  .box:focus-within {
    outline: 2px solid var(--w-focus);
    outline-offset: 1px;
    border-color: var(--w-focus);
  }
  .tag {
    display: inline-flex;
    align-items: center;
    min-height: 32px;
    margin: 5px 0;
    padding-left: var(--w-space-3);
    border-radius: var(--w-radius-pill);
    background: var(--w-ink);
    color: var(--w-bg);
    font-size: var(--w-text-sm);
    font-weight: var(--w-ui-strong-weight);
    cursor: default;
  }
  .tag button {
    position: relative;
    display: grid;
    place-items: center;
    width: 30px;
    height: 32px;
    border: 0;
    border-radius: var(--w-radius-pill);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  /* A 44px target around the small ×. */
  .tag button::before {
    content: '';
    position: absolute;
    inset: -6px -6px -6px -8px;
  }
  input {
    flex: 1;
    min-width: 9ch;
    /* The field itself is the full 44px target, not just the box around it. */
    height: calc(var(--w-tap) - 2 * var(--w-border));
    padding: 0 var(--w-space-1);
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--w-ink);
    font: inherit;
    font-size: max(1rem, var(--w-text-md));
  }
  input::placeholder {
    color: var(--w-ink-3);
    opacity: 1;
  }
  .offer {
    display: flex;
    gap: var(--w-space-2);
    overflow-x: auto;
    padding: 7px 0;
    scrollbar-width: none;
  }
  .offer::-webkit-scrollbar {
    display: none;
  }
  .suggestion {
    position: relative;
    flex: none;
    min-height: 32px;
    padding: 0 var(--w-space-3);
    border: var(--w-border) dashed var(--w-line-strong);
    border-radius: var(--w-radius-pill);
    background: transparent;
    color: var(--w-ink-2);
    font: inherit;
    font-size: var(--w-text-sm);
    white-space: nowrap;
    cursor: pointer;
    touch-action: manipulation;
  }
  .suggestion::before {
    content: '';
    position: absolute;
    inset: -7px 0;
  }
</style>
