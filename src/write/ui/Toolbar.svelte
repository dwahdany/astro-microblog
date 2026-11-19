<!--
  Formatting toolbar.

  Phone: docked at the bottom of the app box. The app box is sized to the
  visual viewport, so the bar rides on top of the on-screen keyboard. Footnote
  is pinned on the left, Undo (and Redo once there is something to redo, and
  "hide keyboard" while it is up) on the right; the rest scrolls sideways
  between them, ordered so that what a phone keyboard cannot type easily comes
  first (./lib/toolbar.ts).
  Wide screens: one centred row under the header, Footnote spelled out.

  Buttons cancel pointerdown/mousedown so pressing one never takes focus from
  the editor (which would dismiss the phone keyboard). A command that cannot do
  anything right now (most of them while a footnote's text is being edited) is
  disabled rather than left to do nothing.
-->
<script lang="ts">
  import Bold from '@lucide/svelte/icons/bold';
  import Code from '@lucide/svelte/icons/code';
  import Heading from '@lucide/svelte/icons/heading';
  import ImageIcon from '@lucide/svelte/icons/image';
  import IndentDecrease from '@lucide/svelte/icons/indent-decrease';
  import IndentIncrease from '@lucide/svelte/icons/indent-increase';
  import Italic from '@lucide/svelte/icons/italic';
  import KeyboardOff from '@lucide/svelte/icons/keyboard-off';
  import LinkIcon from '@lucide/svelte/icons/link';
  import List from '@lucide/svelte/icons/list';
  import ListOrdered from '@lucide/svelte/icons/list-ordered';
  import ListTodo from '@lucide/svelte/icons/list-todo';
  import Minus from '@lucide/svelte/icons/minus';
  import Radical from '@lucide/svelte/icons/radical';
  import Redo from '@lucide/svelte/icons/redo-2';
  import Sigma from '@lucide/svelte/icons/sigma';
  import SquareCode from '@lucide/svelte/icons/square-code';
  import Strikethrough from '@lucide/svelte/icons/strikethrough';
  import Superscript from '@lucide/svelte/icons/superscript';
  import TextQuote from '@lucide/svelte/icons/text-quote';
  import Undo from '@lucide/svelte/icons/undo-2';
  import type { EditorCommandId, EditorHandle, EditorNoteState, EditorSelectionState } from '../contracts';
  import type { IconComponent } from './kinds';
  import { DESKTOP_GROUPS, PHONE_GROUPS, commandAvailable } from './lib/toolbar';
  import { viewport } from './viewport.svelte';

  let {
    editor,
    selection,
    note = null,
    placement,
    onPickImage,
  }: {
    editor: EditorHandle | undefined;
    selection: EditorSelectionState | undefined;
    /** The footnote open in the note panel, if any (EditorProps.onNoteChange). */
    note?: EditorNoteState | null;
    /** 'bottom' on a phone (above the keyboard), 'top' on wide screens. */
    placement: 'top' | 'bottom';
    /**
     * What the Image button does: open the picker for a picture from this device (the writing
     * screen takes it in and inserts it). Without it the button inserts an empty `![]()`.
     */
    onPickImage?: () => void;
  } = $props();

  interface Item {
    label: string;
    icon: IconComponent;
    /** Desktop shortcut shown in the tooltip (the editor owns the actual binding). */
    keys?: string;
    active?: (s: EditorSelectionState) => boolean;
  }

  const items: Partial<Record<EditorCommandId, Item>> = {
    bold: { label: 'Bold', icon: Bold, keys: 'Mod+B', active: (s) => s.bold },
    italic: { label: 'Italic', icon: Italic, keys: 'Mod+I', active: (s) => s.italic },
    heading: { label: 'Heading', icon: Heading, active: (s) => s.heading > 0 },
    link: { label: 'Link', icon: LinkIcon, keys: 'Mod+K', active: (s) => s.link },
    quote: { label: 'Quote', icon: TextQuote, active: (s) => s.quote },
    bulletList: { label: 'Bulleted list', icon: List, active: (s) => s.list === 'bullet' },
    orderedList: { label: 'Numbered list', icon: ListOrdered, active: (s) => s.list === 'ordered' },
    taskList: { label: 'Task list', icon: ListTodo, active: (s) => s.list === 'task' },
    outdent: { label: 'Outdent', icon: IndentDecrease },
    indent: { label: 'Indent', icon: IndentIncrease },
    image: { label: 'Image', icon: ImageIcon },
    code: { label: 'Inline code', icon: Code, active: (s) => s.code },
    codeBlock: { label: 'Code block', icon: SquareCode, active: (s) => s.codeBlock },
    math: { label: 'Inline math', icon: Sigma },
    mathBlock: { label: 'Math block', icon: Radical },
    strike: { label: 'Strikethrough', icon: Strikethrough, active: (s) => s.strike },
    rule: { label: 'Divider', icon: Minus },
  };

  const groups = $derived(placement === 'bottom' ? PHONE_GROUPS : DESKTOP_GROUPS);
  const can = (id: EditorCommandId) => !!editor && commandAvailable(id, { note, selection });
  /** On a phone Redo only takes room once there is something to redo (right after an Undo). */
  const showRedo = $derived(placement === 'top' || selection?.canRedo === true);

  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const tip = (item: Item) => (item.keys ? `${item.label} (${item.keys.replace('Mod+', mac ? '⌘' : 'Ctrl+')})` : item.label);

  /**
   * Unavailable commands are `aria-disabled`, not `disabled`: a disabled button swallows the
   * pointer event, and then nothing stops the tap from taking focus (and the phone keyboard) away
   * from the text. This way the press is still cancelled; it just does nothing.
   */
  const run = (id: EditorCommandId) => {
    if (!can(id)) return false;
    if (id === 'image' && onPickImage) return onPickImage(), true;
    return (editor?.exec as ((id: EditorCommandId) => boolean) | undefined)?.(id);
  };
  const keepFocus = (event: Event) => event.preventDefault();

  /** Left/Right walk the buttons, as a toolbar should. */
  function onKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
    const bar = event.currentTarget as HTMLElement;
    const buttons = [...bar.querySelectorAll<HTMLButtonElement>('button:not(:disabled):not([aria-disabled="true"])')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    buttons[(at + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length].focus();
  }
</script>

<div
  class="toolbar {placement}"
  class:keyboard={viewport.keyboard}
  role="toolbar"
  tabindex="-1"
  aria-label={note?.editing ? 'Formatting (footnote text)' : 'Formatting'}
  data-write-toolbar={placement}
  data-note-editing={note?.editing ? '' : undefined}
  onkeydown={onKeydown}
>
  <button
    type="button"
    class="footnote"
    title={note?.editing ? 'A footnote is open: finish it first' : 'Footnote: adds the next number here and its note at the end'}
    aria-label="Footnote"
    aria-disabled={!can('footnote')}
    data-command="footnote"
    onpointerdown={keepFocus}
    onmousedown={keepFocus}
    onclick={() => run('footnote')}
  >
    <Superscript size={20} aria-hidden="true" /><span>Footnote</span>
  </button>

  <div class="scroll">
    {#each groups as group, g (g)}
      {#if g > 0}<span class="sep" aria-hidden="true"></span>{/if}
      {#each group as id (id)}
        {@const item = items[id]}
        {#if item}
          {@const Icon = item.icon}
          <button
            type="button"
            class="w-icon"
            title={tip(item)}
            aria-label={item.label}
            aria-pressed={item.active && selection && !note?.editing ? item.active(selection) : undefined}
            aria-disabled={!can(id)}
            data-command={id}
            onpointerdown={keepFocus}
            onmousedown={keepFocus}
            onclick={() => run(id)}
          >
            <Icon size={20} aria-hidden="true" />
          </button>
        {/if}
      {/each}
    {/each}
  </div>

  <div class="pin">
    {#if placement === 'top'}<span class="sep" aria-hidden="true"></span>{/if}
    {#if showRedo}
      <button
        type="button"
        class="w-icon"
        title="Redo"
        aria-label="Redo"
        aria-disabled={!can('redo')}
        data-command="redo"
        onpointerdown={keepFocus}
        onmousedown={keepFocus}
        onclick={() => run('redo')}
      >
        <Redo size={20} aria-hidden="true" />
      </button>
    {/if}
    <button
      type="button"
      class="w-icon undo"
      title="Undo"
      aria-label="Undo"
      aria-disabled={!can('undo')}
      data-command="undo"
      onpointerdown={keepFocus}
      onmousedown={keepFocus}
      onclick={() => run('undo')}
    >
      <Undo size={20} aria-hidden="true" />
    </button>
    {#if placement === 'bottom' && viewport.keyboard}
      <button
        type="button"
        class="w-icon"
        title="Hide keyboard"
        aria-label="Hide keyboard"
        data-action="hide-keyboard"
        onclick={() => (document.activeElement as HTMLElement | null)?.blur()}
      >
        <KeyboardOff size={20} aria-hidden="true" />
      </button>
    {/if}
  </div>
</div>

<style>
  .toolbar {
    flex: none;
    display: flex;
    align-items: center;
    background: var(--w-surface);
  }
  .toolbar.bottom {
    height: calc(var(--w-toolbar-h) + env(safe-area-inset-bottom));
    padding: 0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
    border-top: var(--w-border) solid var(--w-line-strong);
  }
  /* With the keyboard up there is no home indicator to clear: sit right on top of the keys. */
  .toolbar.bottom.keyboard {
    height: var(--w-toolbar-h);
    padding-bottom: 0;
  }
  .toolbar.top {
    justify-content: center;
    height: var(--w-toolbar-h);
    padding: 0 var(--w-space-3);
    border-bottom: var(--w-border) solid var(--w-line);
  }
  .w-icon {
    height: var(--w-tap);
  }
  /* On the desktop row Undo comes before Redo, as everywhere; on a phone Undo keeps its place at
     the edge and Redo appears beside it only when there is something to redo. */
  .top .undo {
    order: -1;
  }
  .top .pin .sep {
    order: -2;
  }

  /* Footnote: the one command with a filled button, because it is the one the
     old editor could not do. */
  .footnote {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--w-space-2);
    min-width: 44px;
    height: calc(var(--w-toolbar-h) - 12px);
    margin: 0 var(--w-space-1) 0 6px;
    padding: 0 var(--w-space-2);
    border: var(--w-border) solid var(--wx-btn-primary-line);
    border-radius: var(--w-radius-sm);
    background: var(--w-accent);
    color: var(--w-accent-ink);
    font: inherit;
    font-size: var(--w-text-sm);
    font-weight: var(--w-ui-strong-weight);
    text-transform: var(--wx-case);
    cursor: pointer;
    touch-action: manipulation;
    transition: transform var(--w-dur-1) var(--w-ease);
  }
  /* 36px to look at, 44px to hit. */
  .footnote {
    position: relative;
  }
  .footnote::before {
    content: '';
    position: absolute;
    inset: -6px -2px;
  }
  .footnote:active:not([aria-disabled='true']) {
    transform: var(--wx-btn-press);
  }
  .footnote[aria-disabled='true'] {
    opacity: 0.5;
    cursor: default;
  }
  .top .footnote {
    min-width: 52px;
    margin: 0 var(--w-space-1) 0 var(--w-space-2);
    padding: 0 var(--w-space-3);
  }
  .bottom .footnote span {
    display: none;
  }

  .scroll {
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .bottom .scroll {
    flex: 1;
    overflow-x: auto;
    overscroll-behavior-x: contain;
    scrollbar-width: none;
    /* The part-shown button and the fade say "there is more this way". */
    mask-image: linear-gradient(to right, transparent 0, #000 4px, #000 calc(100% - 14px), transparent 100%);
    -webkit-mask-image: linear-gradient(to right, transparent 0, #000 4px, #000 calc(100% - 14px), transparent 100%);
    padding: 0 var(--w-space-1);
  }
  .bottom .scroll::-webkit-scrollbar {
    display: none;
  }
  .pin {
    flex: none;
    display: flex;
    align-items: center;
  }
  .bottom .pin {
    padding-right: var(--w-space-1);
  }
  .sep {
    flex: none;
    width: var(--w-border);
    height: 22px;
    margin: 0 var(--w-space-2);
    background: var(--w-line);
  }
  .bottom .scroll .sep {
    margin: 0 var(--w-space-1);
  }
  @media (min-width: 480px) {
    .bottom .footnote {
      padding: 0 var(--w-space-3);
    }
    .bottom .footnote span {
      display: inline;
    }
  }
</style>
