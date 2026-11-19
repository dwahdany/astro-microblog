<!--
  The note panel: where a footnote's text is edited in place.

  It is a view over the footnote DEFINITION IN THE DOCUMENT, not a separate
  store: every keystroke here is reported as an edit (`onEdit`) that the
  editor turns into the smallest change to the definition's text, and `text`
  flows back in from the document. Rename/delete likewise act on the
  markdown.

  Presentation is chosen by the editor: docked along the bottom of the
  writing surface on a phone (above the toolbar and keyboard), a floating
  card next to the reference on wide screens.
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
  import Trash from '@lucide/svelte/icons/trash-2';
  import type { NoteView } from './footnotes';

  let {
    note,
    mode,
    readOnly = false,
    error = null,
    onEdit,
    onRename,
    onDelete,
    onJump,
    onClose,
    onHistory,
    onFocusChange,
  }: {
    note: NoteView | null;
    /**
     * 'docked' along the bottom of the writing surface, 'floating' as a card beside the reference,
     * or 'cover': filling a writing surface too short for anything else.
     */
    mode: 'docked' | 'floating' | 'cover';
    readOnly?: boolean;
    /** Why the last rename was refused, if it was. */
    error?: string | null;
    /** The display text changed: [from, to) was replaced by `insert`; `value` is the whole new text. */
    onEdit: (from: number, to: number, insert: string, value: string) => void;
    onRename: (label: string) => void;
    onDelete: () => void;
    onJump: () => void;
    onClose: () => void;
    onHistory: (direction: 'undo' | 'redo') => void;
    /** The note's text field gained (true) or lost (false) the keyboard. */
    onFocusChange?: (editing: boolean) => void;
  } = $props();

  const floating = $derived(mode === 'floating');

  let panel = $state<HTMLElement>();
  let area = $state<HTMLTextAreaElement>();
  let labelInput = $state<HTMLInputElement>();
  /** The display text the textarea was last known to agree with. */
  let synced = '';
  let labelDraft = $state('');
  let composing = false;

  const status = $derived.by(() => {
    if (!note) return '';
    if (!note.hasDef) return 'No note yet';
    if (note.refs === 0) return 'Not used in the text';
    return note.refs > 1 ? `Used ${note.refs} times` : '';
  });
  const warn = $derived(!!note && (!note.hasDef || note.refs === 0));

  function fit() {
    if (!area) return;
    area.style.height = 'auto';
    area.style.height = `${area.scrollHeight + 2}px`;
  }

  // Document → textarea. Only writes when they differ, so typing (and IME composition) is never disturbed.
  $effect(() => {
    const text = note?.text ?? '';
    if (!area) return;
    if (area.value !== text && !composing) {
      const { selectionStart, selectionEnd } = area;
      const atEnd = selectionStart === area.value.length;
      area.value = text;
      if (document.activeElement === area) {
        const clamp = (n: number) => Math.min(n, text.length);
        area.setSelectionRange(atEnd ? text.length : clamp(selectionStart), atEnd ? text.length : clamp(selectionEnd));
      }
    }
    synced = area.value;
    fit();
  });

  // The text re-wraps when the panel changes shape (docked ↔ floating ↔ cover, or its box is resized).
  $effect(() => {
    void mode;
    if (!panel || typeof ResizeObserver === 'undefined') return;
    let width = panel.clientWidth;
    fit();
    const observer = new ResizeObserver(() => {
      if (!panel || panel.clientWidth === width) return;
      width = panel.clientWidth;
      fit();
    });
    observer.observe(panel);
    return () => observer.disconnect();
  });

  $effect(() => {
    labelDraft = note?.label ?? '';
  });

  function onInput() {
    if (!area) return;
    const next = area.value;
    const prev = synced;
    if (next === prev) return;
    // The smallest edit that turns `prev` into `next`, anchored at the caret.
    let start = 0;
    const max = Math.min(prev.length, next.length);
    while (start < max && prev.charCodeAt(start) === next.charCodeAt(start)) start++;
    let end = 0;
    while (end < max - start && prev.charCodeAt(prev.length - 1 - end) === next.charCodeAt(next.length - 1 - end)) end++;
    synced = next;
    fit();
    onEdit(start, prev.length - end, next.slice(start, next.length - end), next);
  }

  function onAreaKeydown(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === 'Escape' || (mod && event.key === 'Enter')) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (mod && !event.altKey && event.key.toLowerCase() === 'z') {
      // One history: the document's.
      event.preventDefault();
      onHistory(event.shiftKey ? 'redo' : 'undo');
    } else if (mod && !event.altKey && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      onHistory('redo');
    }
  }

  function onBeforeInput(event: InputEvent) {
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      event.preventDefault();
      onHistory(event.inputType === 'historyUndo' ? 'undo' : 'redo');
    }
  }

  function commitLabel() {
    const next = labelDraft.trim();
    if (!note || next === note.label) return;
    if (next === '') {
      labelDraft = note.label;
      return;
    }
    onRename(next);
  }

  function onLabelKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitLabel();
      area?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      labelDraft = note?.label ?? '';
      area?.focus();
    }
  }

  const keepFocus = (event: Event) => event.preventDefault();

  /* ---- what the editor needs from the panel ---- */

  export function focusText(where: 'end' | 'keep' = 'end') {
    if (!area) return;
    area.focus({ preventScroll: true });
    if (where === 'end') area.setSelectionRange(area.value.length, area.value.length);
  }
  export function hasTextFocus(): boolean {
    return !!area && document.activeElement === area;
  }
  export function hasFocus(): boolean {
    return !!panel && panel.contains(document.activeElement);
  }
  export function getSelection(): { from: number; to: number } {
    return { from: area?.selectionStart ?? 0, to: area?.selectionEnd ?? 0 };
  }
  export function setSelection(from: number, to = from) {
    area?.setSelectionRange(from, to);
  }
  export function getValue(): string {
    return area?.value ?? '';
  }
  export function element(): HTMLElement | undefined {
    return panel;
  }
</script>

<!-- Always mounted (hidden when closed) so the textarea can take focus synchronously inside a tap,
     which is what keeps the phone keyboard up. -->
<section
  class="note"
  class:floating
  class:cover={mode === 'cover'}
  class:warn
  bind:this={panel}
  hidden={!note}
  aria-label={note ? `Footnote ${note.label}` : 'Footnote'}
  data-note-panel={note ? note.label : undefined}
  data-note-mode={mode}
>
  <header>
    <label class="label" title="Rename this note everywhere it is used">
      <span class="caret" aria-hidden="true">[^</span>
      <input
        bind:this={labelInput}
        bind:value={labelDraft}
        size={Math.max(2, labelDraft.length)}
        aria-label="Footnote label"
        aria-invalid={error ? 'true' : undefined}
        autocapitalize="off"
        autocomplete="off"
        autocorrect="off"
        spellcheck="false"
        readonly={readOnly}
        data-note-label
        onblur={commitLabel}
        onkeydown={onLabelKeydown}
      />
      <span class="caret" aria-hidden="true">]</span>
    </label>
    <span class="status" role="status" data-note-status>{error ?? status}</span>
    <span class="actions">
      <button
        type="button"
        title={note?.refs ? 'Show where this note is used / where it is written' : 'Show the note in the text'}
        aria-label="Show in the text"
        data-note-action="jump"
        onmousedown={keepFocus}
        onclick={onJump}
      >
        <ArrowUpDown size={18} aria-hidden="true" />
      </button>
      {#if !readOnly}
        <button type="button" title="Delete this footnote" aria-label="Delete footnote" data-note-action="delete" onmousedown={keepFocus} onclick={onDelete}>
          <Trash size={18} aria-hidden="true" />
        </button>
      {/if}
      <button type="button" class="done" title="Done (Esc)" aria-label="Done" data-note-action="done" onmousedown={keepFocus} onclick={onClose}>
        <Check size={20} aria-hidden="true" />
      </button>
    </span>
  </header>
  <textarea
    bind:this={area}
    rows="1"
    placeholder={note?.hasDef === false ? 'Write the note. It is added at the end of the post.' : 'Note text'}
    aria-label="Footnote text"
    autocapitalize="sentences"
    spellcheck="true"
    readonly={readOnly}
    data-note-text
    oninput={onInput}
    onfocus={() => onFocusChange?.(true)}
    onblur={() => onFocusChange?.(false)}
    onkeydown={onAreaKeydown}
    onbeforeinput={onBeforeInput}
    oncompositionstart={() => (composing = true)}
    oncompositionend={() => {
      composing = false;
      onInput();
    }}
  ></textarea>
</section>

<style>
  .note {
    position: absolute;
    z-index: 5;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    gap: var(--w-space-1);
    max-height: min(60%, 22rem);
    padding: var(--w-space-2) max(var(--w-space-3), env(safe-area-inset-right)) var(--w-space-3)
      max(var(--w-space-3), env(safe-area-inset-left));
    background: var(--w-surface);
    color: var(--w-ink);
    border-top: var(--w-border) solid var(--w-line-strong);
    border-radius: var(--w-radius-lg) var(--w-radius-lg) 0 0;
    box-shadow: var(--w-shadow-2);
    font-family: var(--w-font-ui);
    animation: note-in var(--w-dur-2) var(--w-ease-out);
  }
  .note[hidden] {
    display: none;
  }
  .note.floating {
    /* Positioned by the editor next to the reference (left/top set inline). */
    right: auto;
    bottom: auto;
    width: min(26rem, calc(100% - 2 * var(--w-space-4)));
    max-height: min(70%, 24rem);
    padding: var(--w-space-2) var(--w-space-3) var(--w-space-3);
    border: var(--w-border) solid var(--w-line-strong);
    border-radius: var(--w-radius-md);
  }
  /* A writing surface too short for a sheet (a phone on its side with the keyboard up): the note
     takes all of it, with tighter chrome, so the text being typed is always in view. */
  .note.cover {
    top: 0;
    max-height: none;
    gap: 0;
    padding-top: 0;
    padding-bottom: var(--w-space-1);
    border-top: 0;
    border-radius: 0;
    box-shadow: none;
    animation: none;
  }
  .note.cover header {
    min-height: 40px;
  }
  .note.cover textarea {
    min-height: 0;
    padding: var(--w-space-1) var(--w-space-2);
  }
  @keyframes note-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }

  header {
    display: flex;
    align-items: center;
    gap: var(--w-space-2);
    min-height: var(--w-tap);
  }

  .label {
    display: inline-flex;
    align-items: baseline;
    flex: none;
    max-width: 45%;
    padding: 0 var(--w-space-2);
    border-radius: var(--w-radius-pill);
    background: color-mix(in srgb, var(--w-syn-footnote) 13%, transparent);
    color: var(--w-syn-footnote);
    font-weight: var(--w-ui-strong-weight);
    line-height: 2;
  }
  .label:focus-within {
    outline: 2px solid var(--w-focus);
    outline-offset: 1px;
  }
  .label .caret {
    /* Decoration, but still legible: at 0.55 the brackets fell to 2.4:1 in the light themes. */
    opacity: 0.8;
    font-family: var(--w-font-mono);
    font-size: var(--w-text-sm);
  }
  .label input {
    min-width: 1.2em;
    max-width: 100%;
    padding: 0 0.1em;
    border: 0;
    outline: 0;
    background: none;
    color: inherit;
    font: inherit;
    /* 16px or more: iOS zooms the page when a smaller field takes focus. */
    font-size: max(1rem, var(--w-text-md));
    font-variant-numeric: tabular-nums;
    text-align: center;
    field-sizing: content;
  }
  .warn .label {
    background: none;
    color: var(--w-warn);
    box-shadow: inset 0 0 0 var(--w-border) var(--w-warn);
  }

  .status {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--w-ink-3);
    font-size: var(--w-text-sm);
    letter-spacing: var(--w-ui-tracking);
  }
  .warn .status,
  .label:has(input[aria-invalid='true']) + .status {
    color: var(--w-warn);
  }

  .actions {
    display: inline-flex;
    flex: none;
    margin-right: calc(var(--w-space-2) * -1);
  }
  button {
    display: inline-grid;
    place-items: center;
    width: var(--w-tap);
    height: var(--w-tap);
    padding: 0;
    border: 0;
    border-radius: var(--w-radius-sm);
    background: none;
    color: var(--w-ink-2);
    cursor: pointer;
    transition: background-color var(--w-dur-1) var(--w-ease);
  }
  button:hover {
    background: var(--w-surface-2);
    color: var(--w-ink);
  }
  button.done {
    color: var(--w-accent-text);
  }

  textarea {
    display: block;
    width: 100%;
    min-height: 2.6em;
    max-height: 100%;
    flex: 1 1 auto;
    padding: var(--w-space-2) var(--w-space-3);
    border: var(--w-border) solid var(--w-line);
    border-radius: var(--w-radius-sm);
    outline: 0;
    background: var(--w-bg);
    color: var(--w-ink);
    font-family: var(--w-font-prose);
    /* 16px or more: see above. */
    font-size: max(1rem, calc(var(--w-prose-size) * 0.94));
    font-weight: var(--w-prose-weight);
    line-height: 1.5;
    resize: none;
    overflow-y: auto;
    overscroll-behavior: contain;
    caret-color: var(--w-accent-text);
  }
  textarea:focus {
    border-color: var(--w-focus);
  }
  textarea::placeholder {
    color: var(--w-ink-3);
  }
</style>
