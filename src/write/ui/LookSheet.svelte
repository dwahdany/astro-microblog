<!--
  "Look": pick one of the three themes and, where a theme has both, whether it
  follows the system's light/dark setting. Each choice is a small specimen set
  in that theme's own tokens (a nested element carrying the theme attributes),
  so what you tap is what you get.
-->
<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import { THEMES, resolveScheme, schemesOf, type SchemePref } from '../theme';
  import Sheet from './Sheet.svelte';
  import { chooseScheme, chooseTheme, look } from './look.svelte';

  let { onClose }: { onClose: () => void } = $props();

  const prefs: { id: SchemePref; label: string }[] = [
    { id: 'auto', label: 'Match system' },
    { id: 'light', label: 'Light' },
    { id: 'dark', label: 'Dark' },
  ];

  const systemDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const current = $derived(THEMES.find((t) => t.id === look.theme)!);
  const oneScheme = $derived(schemesOf(look.theme).length === 1);

  /**
   * A radio group as the keyboard expects it: one tab stop (the checked choice), arrow keys move
   * and choose, Home/End jump to the ends.
   */
  function onRadioKeydown(event: KeyboardEvent) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined && event.key !== 'Home' && event.key !== 'End') return;
    const radios = [...(event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const at = radios.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? radios.length - 1 : (at + step! + radios.length) % radios.length;
    radios[next].focus();
    radios[next].click();
  }
</script>

<Sheet title="Look" name="look" {onClose}>
  <div class="themes" role="radiogroup" aria-label="Theme" tabindex="-1" onkeydown={onRadioKeydown}>
    {#each THEMES as t (t.id)}
      <button
        type="button"
        class="theme"
        role="radio"
        aria-checked={look.theme === t.id}
        tabindex={look.theme === t.id ? 0 : -1}
        data-theme-choice={t.id}
        onclick={() => chooseTheme(t.id)}
      >
        <span
          class="specimen"
          data-write-theme={t.id}
          data-write-scheme={resolveScheme(t.id, look.pref, systemDark)}
          aria-hidden="true"
        >
          <span class="page">
            <span class="head">Aa</span>
            <span class="line">Write it down<sup>1</sup></span>
            <span class="dot"></span>
          </span>
        </span>
        <span class="about">
          <span class="name">{t.label}</span>
          <span class="desc">{t.description}</span>
        </span>
        <span class="tick" aria-hidden="true">{#if look.theme === t.id}<Check size={18} />{/if}</span>
      </button>
    {/each}
  </div>

  <h3 id="look-scheme">Light or dark</h3>
  <div class="schemes" role="radiogroup" aria-labelledby="look-scheme" tabindex="-1" onkeydown={onRadioKeydown}>
    {#each prefs as p (p.id)}
      <button
        type="button"
        class="w-chip"
        role="radio"
        aria-checked={look.pref === p.id}
        tabindex={look.pref === p.id ? 0 : -1}
        data-scheme-choice={p.id}
        onclick={() => chooseScheme(p.id)}
      >
        {p.label}
      </button>
    {/each}
  </div>
  <p class="note">
    {#if oneScheme}
      {current.label} is {schemesOf(look.theme)[0]} only, so this applies when you switch to Galley or Riso.
    {:else if look.pref === 'auto'}
      Follows your device. It is showing {look.scheme} now.
    {:else}
      Stays {look.pref} whatever your device is set to.
    {/if}
  </p>
</Sheet>

<style>
  .themes {
    display: grid;
    gap: var(--w-space-3);
  }
  .theme {
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr) 20px;
    align-items: center;
    gap: var(--w-space-4);
    min-height: 88px;
    padding: var(--w-space-2) var(--w-space-3) var(--w-space-2) var(--w-space-2);
    border: var(--w-border) solid var(--w-line);
    border-radius: var(--w-radius-md);
    background: transparent;
    color: var(--w-ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
    touch-action: manipulation;
  }
  .theme[aria-checked='true'] {
    border-color: var(--w-line-strong);
    background: var(--w-accent-soft);
  }
  /* The specimen is a different theme inside this one: every colour, face and
     radius below resolves against the nested element's own tokens. */
  .specimen {
    display: grid;
    place-items: center;
    height: 72px;
    border-radius: var(--w-radius-sm);
    background-color: var(--w-bg);
    background-image: var(--wx-canvas);
    background-size: var(--wx-canvas-size);
    color: var(--w-ink);
    overflow: hidden;
  }
  .page {
    position: relative;
    display: grid;
    gap: 2px;
    width: 76px;
    padding: 8px 9px;
    border: var(--wx-row-outline) solid var(--w-line-strong);
    border-radius: var(--w-radius-xs);
    background: var(--wx-page-bg);
    box-shadow: var(--w-shadow-1);
  }
  .head {
    font-family: var(--w-font-display);
    font-size: 22px;
    font-weight: var(--w-display-weight);
    font-stretch: var(--w-display-stretch);
    letter-spacing: var(--w-display-tracking);
    line-height: 1;
  }
  .line {
    font-family: var(--w-font-prose);
    font-size: 8px;
    line-height: 1.3;
    white-space: nowrap;
  }
  .line sup {
    color: var(--w-syn-footnote);
    font-size: 6px;
  }
  .dot {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 10px;
    height: 10px;
    border-radius: var(--w-radius-pill);
    background: var(--w-accent);
  }
  .about {
    display: grid;
    gap: 2px;
  }
  .name {
    font-family: var(--w-font-display);
    font-size: var(--w-text-lg);
    font-weight: var(--w-display-weight);
    font-stretch: var(--w-display-stretch);
    letter-spacing: var(--w-display-tracking);
    text-transform: var(--wx-case);
  }
  .desc {
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
    line-height: 1.35;
  }
  .tick {
    color: var(--w-accent-text);
  }
  h3 {
    margin: var(--w-space-5) 0 var(--w-space-2);
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
    font-weight: var(--w-ui-strong-weight);
    text-transform: var(--wx-case);
  }
  .schemes {
    display: flex;
    flex-wrap: wrap;
    gap: var(--w-space-2);
  }
  .note {
    margin: var(--w-space-3) 0 0;
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
  }
</style>
