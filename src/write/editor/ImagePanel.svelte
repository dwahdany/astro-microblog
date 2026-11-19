<!--
  The image panel: size and alt text of ONE image, and a way to remove it.

  Like the note panel it is a view over the markdown, not a store of its own: a size picked here
  replaces the `|size` suffix between that image's brackets, a keystroke in the alt field replaces
  the characters of its alt text (`onSize`, `onAlt` → ./images.ts), and what is shown flows back in
  from the document. Nothing else in the text is touched.

  Presentation is chosen by the editor, as for the note panel: docked along the bottom of the
  writing surface on a phone, a floating card beside the picture where there is room, covering a
  surface too short for anything else.
-->
<script lang="ts">
  import { tick } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import ImageIcon from '@lucide/svelte/icons/image';
  import Trash from '@lucide/svelte/icons/trash-2';
  import type { ImageSize, ImageView } from './images';

  let {
    image,
    mode,
    readOnly = false,
    error = null,
    onSize,
    onAlt,
    onRemove,
    onClose,
    onHistory,
  }: {
    image: ImageView | null;
    mode: 'docked' | 'floating' | 'cover';
    readOnly?: boolean;
    /** Why the last change was refused, if it was. */
    error?: string | null;
    onSize: (size: ImageSize) => void;
    /** The alt field now reads `text`. */
    onAlt: (text: string) => void;
    onRemove: () => void;
    onClose: () => void;
    onHistory: (direction: 'undo' | 'redo') => void;
  } = $props();

  const SIZES: { value: ImageSize; label: string; hint: string }[] = [
    { value: '', label: 'Default', hint: 'The width of the text' },
    { value: 'small', label: 'Small', hint: 'Small, centred' },
    { value: 'medium', label: 'Medium', hint: 'Medium, centred' },
    { value: 'full', label: 'Full', hint: 'Wider than the text' },
  ];

  /** `![logo][]`, `![logo]`: the bracket text is the reference label, not alt text of its own. */
  const LABEL_NOTE = 'This text is also the name of the image\u2019s reference: change it in the text.';
  const altNote = $derived(
    !image || image.altEditable
      ? null
      : image.sizeEditable
        ? { short: 'Runs over several lines: edit it in the text', long: 'This alt text runs over several lines. Edit it in the text.' }
        : { short: 'Edit it in the text', long: LABEL_NOTE },
  );

  const uid = $props.id();
  let panel = $state<HTMLElement>();
  let altInput = $state<HTMLInputElement>();
  let picked = $state<ImageSize>('');
  let composing = false;

  $effect(() => {
    picked = image?.size ?? '';
  });

  /** Document → field. Only writes when they differ, so typing (and IME composition) is never disturbed. */
  function syncAlt() {
    const text = image?.alt ?? '';
    if (!altInput || composing || altInput.value === text) return;
    const { selectionStart, selectionEnd } = altInput;
    const atEnd = selectionStart === altInput.value.length;
    altInput.value = text;
    if (document.activeElement === altInput) {
      const clamp = (n: number | null) => Math.min(n ?? text.length, text.length);
      altInput.setSelectionRange(atEnd ? text.length : clamp(selectionStart), atEnd ? text.length : clamp(selectionEnd));
    }
  }
  $effect(() => {
    void image?.alt;
    syncAlt();
  });

  async function onAltInput() {
    if (!altInput) return;
    onAlt(altInput.value);
    // What was typed is not always what is written (a refused change, a size typed as `|small`):
    // the field shows what the text says.
    await tick();
    syncAlt();
  }

  async function pick(size: ImageSize) {
    onSize(size);
    await tick();
    picked = image?.size ?? '';
  }

  function onKeydown(event: KeyboardEvent) {
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === 'Escape' || (mod && event.key === 'Enter') || (event.key === 'Enter' && event.target === altInput && !event.isComposing)) {
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

  const keepFocus = (event: Event) => event.preventDefault();

  /* ---- what the editor needs from the panel ---- */

  export function focusAlt() {
    if (!altInput) return;
    altInput.focus({ preventScroll: true });
    altInput.setSelectionRange(altInput.value.length, altInput.value.length);
  }
  export function hasFocus(): boolean {
    return !!panel && panel.contains(document.activeElement);
  }
  export function element(): HTMLElement | undefined {
    return panel;
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<section
  class="image"
  class:floating={mode === 'floating'}
  class:cover={mode === 'cover'}
  bind:this={panel}
  hidden={!image}
  aria-label={image ? `Image ${image.name}` : 'Image'}
  data-image-panel={image ? image.src : undefined}
  data-image-mode={mode}
  onkeydown={onKeydown}
>
  <header>
    <span class="name" title={image?.src}>
      <ImageIcon size={16} aria-hidden="true" />
      <span data-image-name>{image?.name ?? ''}</span>
    </span>
    <span class="status" role="status" data-image-status>{error ?? (image && !image.sizeEditable ? LABEL_NOTE : '')}</span>
  </header>
  <div class="fields">
    <span class="caption" id="{uid}-size">Size</span>
    <div class="sizes" role="radiogroup" aria-labelledby="{uid}-size" data-image-sizes>
      {#each SIZES as size (size.value)}
        <!-- Picking a size never takes the keyboard from the text (or from the alt field). -->
        <label title={size.hint} class:on={picked === size.value} onmousedown={keepFocus}>
          <input
            type="radio"
            name="{uid}-size"
            value={size.value}
            checked={picked === size.value}
            disabled={readOnly || image?.sizeEditable === false}
            data-image-size={size.value || 'default'}
            onchange={() => pick(size.value)}
          />
          <span>{size.label}</span>
        </label>
      {/each}
    </div>
    <label class="caption" for="{uid}-alt">Alt text</label>
    <input
      id="{uid}-alt"
      bind:this={altInput}
      type="text"
      placeholder={altNote?.short ?? 'What the picture shows'}
      title={altNote?.long ?? 'For screen readers and when the picture does not load. Not shown as a caption.'}
      autocapitalize="sentences"
      autocomplete="off"
      spellcheck="true"
      enterkeyhint="done"
      readonly={readOnly || image?.altEditable === false}
      data-image-alt
      oninput={onAltInput}
      onbeforeinput={onBeforeInput}
      oncompositionstart={() => (composing = true)}
      oncompositionend={() => {
        composing = false;
        void onAltInput();
      }}
    />
  </div>
  <!-- After the fields in the document, so Tab runs sizes, alt text, Remove, Done; drawn at the top right when docked. -->
  <span class="actions">
    {#if !readOnly}
      <button type="button" title="Remove image" aria-label="Remove image" data-image-action="remove" onmousedown={keepFocus} onclick={onRemove}>
        <Trash size={18} aria-hidden="true" />
      </button>
    {/if}
    <button type="button" class="done" title="Done (Esc)" aria-label="Done" data-image-action="done" onmousedown={keepFocus} onclick={onClose}>
      <Check size={20} aria-hidden="true" />
    </button>
  </span>
</section>

<style>
  /* The box is the note panel's (./NotePanel.svelte): same sheet, same card, same cover. */
  .image {
    position: absolute;
    z-index: 5;
    left: 0;
    right: 0;
    bottom: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-content: start;
    gap: var(--w-space-1) var(--w-space-2);
    /* Its four rows of controls must fit a phone on its side (a surface some 250px tall) without scrolling inside the sheet. */
    max-height: min(80%, 22rem);
    padding: var(--w-space-2) max(var(--w-space-3), env(safe-area-inset-right)) var(--w-space-3)
      max(var(--w-space-3), env(safe-area-inset-left));
    overflow-y: auto;
    overscroll-behavior: contain;
    background: var(--w-surface);
    color: var(--w-ink);
    border-top: var(--w-border) solid var(--w-line-strong);
    border-radius: var(--w-radius-lg) var(--w-radius-lg) 0 0;
    box-shadow: var(--w-shadow-2);
    font-family: var(--w-font-ui);
    animation: image-in var(--w-dur-2) var(--w-ease-out);
  }
  /* Put away: gone, whatever the mode it was last shown in says about `display`. */
  .image[hidden] {
    display: none !important;
  }
  /*
   * Floating (wide screens): ONE ROW of controls, set by the editor just above the picture (left/top
   * inline) — sizes, alt text, remove, done. It covers the image's own source line and nothing of
   * the text below. The file name and the "Size" caption are left to the picture's outline and the
   * sizes themselves (they stay in the accessibility tree).
   */
  .image.floating {
    right: auto;
    bottom: auto;
    display: grid;
    grid-template-columns: auto auto minmax(8rem, 1fr) auto;
    align-items: center;
    gap: 0 var(--w-space-2);
    width: min(42rem, calc(100% - 2 * var(--w-space-3)));
    max-height: none;
    padding: var(--w-space-1) var(--w-space-1) var(--w-space-1) var(--w-space-2);
    overflow: visible;
    border: var(--w-border) solid var(--w-line-strong);
    border-radius: var(--w-radius-md);
  }
  .image.floating header,
  .image.floating .fields {
    display: contents;
  }
  .image.floating .name,
  .image.floating .caption:not(label) {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .image.floating .sizes {
    grid-area: 1 / 1;
    min-width: 17rem;
  }
  .image.floating label.caption {
    grid-area: 1 / 2;
  }
  .image.floating input[type='text'] {
    grid-area: 1 / 3;
  }
  .image.floating .actions {
    grid-area: 1 / 4;
    margin-right: 0;
  }
  .image.floating .status {
    grid-area: 2 / 1 / 3 / -1;
    padding: var(--w-space-1) 0;
    white-space: normal;
  }
  .image.floating .status:empty {
    display: none;
  }
  .image.cover {
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
  @keyframes image-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }

  header {
    grid-area: 1 / 1;
    display: flex;
    min-width: 0;
    align-items: center;
    gap: var(--w-space-2);
    min-height: var(--w-tap);
  }
  .name {
    display: inline-flex;
    align-items: center;
    gap: var(--w-space-2);
    flex: 0 1 auto;
    min-width: 0;
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
    font-weight: var(--w-ui-strong-weight);
    letter-spacing: var(--w-ui-tracking);
  }
  .name :global(svg) {
    flex: none;
  }
  .name span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .status {
    flex: 1 1 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--w-warn);
    font-size: var(--w-text-sm);
    letter-spacing: var(--w-ui-tracking);
  }
  .actions {
    grid-area: 1 / 2;
    display: inline-flex;
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
  button:focus-visible {
    outline: 2px solid var(--w-focus);
    outline-offset: -2px;
  }

  .fields {
    grid-area: 2 / 1 / 3 / -1;
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: var(--w-space-2);
  }
  .caption {
    color: var(--w-ink-2);
    /* Capped: four sizes and a caption share 336px on a small phone, in every theme's face. */
    font-size: min(var(--w-text-sm), 0.875rem);
    letter-spacing: var(--w-ui-tracking);
    white-space: nowrap;
  }

  .sizes {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    min-width: 0;
    border: var(--w-border) solid var(--w-line-strong);
    border-radius: var(--w-radius-sm);
    background: var(--w-bg);
    overflow: hidden;
  }
  .sizes label {
    position: relative;
    display: grid;
    place-items: center;
    min-width: 0;
    min-height: var(--w-tap);
    padding: 0 2px;
    color: var(--w-ink-2);
    font-size: min(var(--w-text-sm), 0.875rem);
    letter-spacing: var(--w-ui-tracking);
    cursor: pointer;
    transition: background-color var(--w-dur-1) var(--w-ease);
  }
  .sizes label + label {
    border-left: var(--w-border) solid var(--w-line);
  }
  .sizes label:hover {
    background: var(--w-surface-2);
  }
  .sizes label.on {
    background: var(--w-accent-soft);
    color: var(--w-accent-text);
    font-weight: var(--w-ui-strong-weight);
  }
  .sizes label:has(input:focus-visible) {
    outline: 2px solid var(--w-focus);
    outline-offset: -2px;
  }
  .sizes label:has(input:disabled) {
    cursor: default;
  }
  .sizes input {
    /* The label is the control; the radio keeps the keyboard and screen-reader behaviour. */
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: inherit;
  }
  .sizes span {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    pointer-events: none;
  }

  input[type='text'] {
    display: block;
    width: 100%;
    min-width: 0;
    min-height: var(--w-tap);
    padding: 0 var(--w-space-3);
    border: var(--w-border) solid var(--w-line);
    border-radius: var(--w-radius-sm);
    outline: 0;
    background: var(--w-bg);
    color: var(--w-ink);
    font-family: var(--w-font-ui);
    /* 16px or more: iOS zooms the page when a smaller field takes focus. */
    font-size: max(1rem, var(--w-text-md));
    caret-color: var(--w-accent-text);
  }
  input[type='text']:focus {
    border-color: var(--w-focus);
  }
  input[type='text']::placeholder {
    color: var(--w-ink-3);
  }
  input[type='text'][readonly] {
    color: var(--w-ink-2);
  }
</style>
