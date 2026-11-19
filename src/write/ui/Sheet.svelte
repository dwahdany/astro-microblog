<!--
  A modal sheet: rises from the bottom on a phone, slides in as a right-hand
  panel on wide screens. Because the app box is sized to the visual viewport,
  a bottom sheet always ends above the on-screen keyboard.

  Closes on Escape, on a tap outside, and with its close button. Focus moves
  into the sheet when it opens, Tab cycles inside it, and focus returns to
  whatever opened it when it closes.
-->
<script lang="ts">
  import { onMount, type Snippet } from 'svelte';
  import X from '@lucide/svelte/icons/x';

  let {
    title,
    name,
    onClose,
    children,
    footer,
    size = 'regular',
  }: {
    title: string;
    /** Stable hook for tests and deep links: `data-sheet`. */
    name: string;
    onClose: () => void;
    children: Snippet;
    /** Pinned under the scrolling body (primary actions). */
    footer?: Snippet;
    /** Panel width on wide screens. */
    size?: 'regular' | 'wide';
  } = $props();

  let panel: HTMLDivElement;

  const FOCUSABLE =
    'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = [...panel.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (!panel.contains(active)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  onMount(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Focus the panel itself, not a field: focusing a field would raise the phone keyboard uninvited.
    panel.focus({ preventScroll: true });
    return () => {
      if (opener && opener.isConnected && opener !== document.body) opener.focus({ preventScroll: true });
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

<div class="scrim" onclick={onClose} aria-hidden="true"></div>
<div
  class="sheet"
  class:wide={size === 'wide'}
  role="dialog"
  aria-modal="true"
  aria-label={title}
  tabindex="-1"
  data-sheet={name}
  bind:this={panel}
>
  <span class="grip" aria-hidden="true"></span>
  <header>
    <h2>{title}</h2>
    <button type="button" class="w-icon" onclick={onClose} aria-label="Close {title.toLowerCase()}" data-sheet-close>
      <X size={20} aria-hidden="true" />
    </button>
  </header>
  <div class="body w-scroll">
    {@render children()}
  </div>
  {#if footer}
    <footer>{@render footer()}</footer>
  {/if}
</div>

<style>
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 30;
    background: var(--w-scrim);
    animation: fade var(--w-dur-2) var(--w-ease-out);
  }
  .sheet {
    position: absolute;
    z-index: 31;
    left: 0;
    right: 0;
    bottom: 0;
    max-height: min(92%, 100% - env(safe-area-inset-top) - 12px);
    display: flex;
    flex-direction: column;
    background: var(--w-surface);
    color: var(--w-ink);
    border: var(--w-border) solid var(--w-line-strong);
    border-bottom: 0;
    border-radius: var(--w-radius-lg) var(--w-radius-lg) 0 0;
    box-shadow: var(--w-shadow-2);
    outline: none;
    animation: rise var(--w-dur-3) var(--w-ease-out);
  }
  .grip {
    flex: none;
    align-self: center;
    width: 36px;
    height: 4px;
    margin-top: var(--w-space-2);
    border-radius: var(--w-radius-pill);
    background: var(--w-line);
  }
  header {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--w-space-3);
    padding: var(--w-space-1) var(--w-space-2) var(--w-space-2) var(--w-space-5);
    border-bottom: var(--w-border) solid var(--w-line);
  }
  h2 {
    margin: 0;
    font-family: var(--w-font-display);
    font-size: var(--w-text-lg);
    font-weight: var(--w-display-weight);
    font-stretch: var(--w-display-stretch);
    letter-spacing: var(--w-display-tracking);
    line-height: 1.2;
    text-transform: var(--wx-case);
  }
  .body {
    flex: 1;
    min-height: 0;
    padding: var(--w-space-4) var(--w-space-5) calc(var(--w-space-6) + env(safe-area-inset-bottom));
  }
  footer {
    /*
     * Its own height, never squeezed by the body — but capped to what a short viewport (the
     * keyboard up, a phone on its side) leaves under the header and a strip of the body, and
     * scrolling beyond that, so the actions in it can always be reached. 92% is the sheet's own
     * limit; 120px is the grip, the header and that strip.
     */
    flex: none;
    max-height: calc(var(--w-vv-height, 100vh) * 0.92 - 120px);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: var(--w-space-3) var(--w-space-5) calc(var(--w-space-3) + env(safe-area-inset-bottom));
    border-top: var(--w-border) solid var(--w-line);
    background: var(--w-surface);
  }
  .sheet:has(footer) .body {
    padding-bottom: var(--w-space-5);
  }
  /* Desktop layout: wide AND tall enough (see viewport.svelte.ts); a phone on its side keeps the phone layout. */
  :global(html[data-write-wide]) .sheet {
    top: 0;
    left: auto;
    width: min(440px, 100%);
    max-height: none;
    border: 0;
    border-left: var(--w-border) solid var(--w-line-strong);
    border-radius: 0;
    animation-name: slide;
  }
  :global(html[data-write-wide]) .sheet.wide {
    width: min(760px, 100%);
  }
  :global(html[data-write-wide]) .grip {
    display: none;
  }
  :global(html[data-write-wide]) header {
    padding-top: var(--w-space-3);
    padding-bottom: var(--w-space-3);
  }
  @keyframes fade {
    from {
      opacity: 0;
    }
  }
  @keyframes rise {
    from {
      transform: translateY(32px);
      opacity: 0;
    }
  }
  @keyframes slide {
    from {
      transform: translateX(32px);
      opacity: 0;
    }
  }
</style>
