<!--
  Preview — the post as the published site would show it.

  What happens here:
    1. (debounced) the post header is built from the frontmatter (chrome.ts)
       and the body is rendered with the site's markdown pipeline (render.ts,
       loaded on first use);
    2. the result is written into the frame /write/preview-frame/, which
       carries the site's real stylesheet. Only blocks that changed are
       replaced, so images do not reload and the reader's place holds;
    3. it opens near where the writing was (`startAt`: how far through the
       text the editor was scrolled); without that, the scroll position is
       remembered per post, so coming back lands on the same paragraph.

  Why an iframe, why sandboxed this way, and why the DOM is written from
  outside instead of with postMessage: see frame.ts.

  Warnings (missing image, bad math, removed script …) go to `onRendered`.
  When the parent does not listen, they are shown in a small strip here so
  they are never lost.
-->
<script lang="ts" module>
  import type { ScrollAnchor } from './frame';

  const MEMORY_KEY = 'write:preview-scroll';
  const MEMORY_LIMIT = 40;

  /**
   * Reading position per post path. Outlives the component (Write ⇄ Preview)
   * and, through sessionStorage, a reload of the tab.
   */
  const scrollMemory = new Map<string, ScrollAnchor>();
  try {
    const stored = JSON.parse(sessionStorage.getItem(MEMORY_KEY) ?? '[]') as [string, ScrollAnchor][];
    for (const [key, anchor] of stored) {
      if (typeof key === 'string' && typeof anchor?.top === 'number' && typeof anchor.index === 'number') {
        scrollMemory.set(key, { top: anchor.top, index: anchor.index, offset: Number(anchor.offset) || 0 });
      }
    }
  } catch {
    /* private mode or malformed: start empty */
  }

  function rememberScroll(key: string, anchor: ScrollAnchor) {
    scrollMemory.delete(key); // re-insert so the most recent posts stay at the end
    scrollMemory.set(key, anchor);
    while (scrollMemory.size > MEMORY_LIMIT) scrollMemory.delete(scrollMemory.keys().next().value!);
    try {
      sessionStorage.setItem(MEMORY_KEY, JSON.stringify([...scrollMemory]));
    } catch {
      /* storage unavailable: the in-memory map still works */
    }
  }
</script>

<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import type { PreviewProps } from '../contracts';
  import { contentSource, frontmatter } from '../data';
  import { renderChrome } from './chrome';
  import {
    FRAME_PATH,
    FRAME_SANDBOX,
    anchorTop,
    applyContent,
    captureAnchor,
    detachAnchor,
    findBrokenImages,
    fractionAnchor,
    getScrollTop,
    isPreviewDocument,
    setScrollTop,
    type FrameContent,
  } from './frame';
  import { renderMarkdown, type PreviewRenderContext } from './index';
  import { createLinkLoader } from './link-loader';

  let { markdown, ctx, onRendered, startAt }: PreviewProps = $props();

  const RENDER_DELAY = 150;
  const SETTLE_INTERVAL = 120;
  const SETTLE_TICKS = 16;
  const WATCH_INTERVAL = 400;

  const loadLinkTargets = createLinkLoader({ source: contentSource, frontmatter });

  let frame = $state<HTMLIFrameElement>();
  /** Bumps every time the frame page (re)loads and is ready to be written into. */
  let frameEpoch = $state(0);
  let content = $state.raw<FrameContent | null>(null);
  let failure = $state('');
  let painted = $state(false);
  let renderWarnings = $state.raw<string[]>([]);
  let brokenImages = $state.raw<string[]>([]);

  /** De-duplicated: the same missing image can be reported by the header and the body. */
  const warnings = $derived([
    ...new Set([...renderWarnings, ...brokenImages.map((src) => `Image did not load: ${src}`)]),
  ]);

  let html = '';
  let firstRender = true;
  let recoveries = 0;
  let paintedEpoch = -1;
  let paintedKey = '';
  let settling = false;
  let settleTimer: ReturnType<typeof setInterval> | undefined;
  let watchedTop = -1;

  /* ---- 1. render ------------------------------------------------------- */

  $effect(() => {
    const source = markdown;
    const context = ctx;
    let stale = false;
    const delay = firstRender ? 0 : RENDER_DELAY;
    firstRender = false;

    const timer = setTimeout(async () => {
      try {
        const chrome = renderChrome(context);
        const linkTargets = await loadLinkTargets(source, context.posts);
        if (stale) return;
        const renderContext: PreviewRenderContext = { ...context, linkTargets };
        const result = await renderMarkdown(source, renderContext);
        if (stale) return;
        html = result.html;
        content = {
          title: chrome.title,
          header: chrome.header,
          lead: chrome.lead,
          body: result.html,
          after: chrome.after,
          wrapBody: chrome.wrapBody,
        };
        renderWarnings = [...chrome.warnings, ...result.warnings];
        failure = '';
      } catch (err) {
        if (stale) return;
        failure = err instanceof Error ? err.message : String(err);
      }
      report();
    }, delay);

    return () => {
      stale = true;
      clearTimeout(timer);
    };
  });

  function report() {
    const all = untrack(() => warnings);
    onRendered?.({ html, warnings: failure ? [`The preview could not be rendered: ${failure}`, ...all] : all });
  }

  /* ---- 2. paint into the frame ------------------------------------------ */

  function frameDocument(): Document | null {
    try {
      const doc = frame?.contentDocument ?? null;
      return isPreviewDocument(doc) ? doc : null;
    } catch {
      return null;
    }
  }

  function onFrameLoad() {
    if (frameDocument()) {
      frameEpoch++;
      return;
    }
    // Something navigated the frame away from the preview page: bring it back.
    if (frame && recoveries < 3) {
      recoveries++;
      frame.src = FRAME_PATH;
    } else {
      failure = 'The preview frame could not be loaded.';
    }
  }

  $effect(() => {
    const epoch = frameEpoch;
    const next = content;
    if (!next || epoch === 0) return;
    untrack(() => paint(next, epoch));
  });

  function paint(next: FrameContent, epoch: number) {
    const doc = frameDocument();
    if (!doc) return;
    const key = ctx.path;
    // A fresh frame (or another post) starts where the writing was (`startAt`) or, without that,
    // from the remembered place; otherwise hold on to wherever the reader is right now.
    const fresh = paintedEpoch !== epoch || paintedKey !== key;
    const from = untrack(() => startAt);
    let anchor = fresh ? (from === undefined ? (scrollMemory.get(key) ?? { top: 0, index: -1, offset: 0 }) : null) : captureAnchor(doc);

    applyContent(doc, next);
    anchor ??= fractionAnchor(doc, from ?? 0);
    paintedEpoch = epoch;
    paintedKey = key;
    painted = true;
    settle(doc, anchor);
  }

  /**
   * Put the reader back and keep them there while late layout (images, web
   * fonts) moves things — until it stops moving or the reader scrolls.
   */
  function settle(doc: Document, anchor: ScrollAnchor) {
    clearInterval(settleTimer);
    settling = true;
    let last = setScrollTop(doc, anchorTop(doc, anchor));
    let ticks = 0;
    const stop = () => {
      clearInterval(settleTimer);
      settling = false;
    };
    settleTimer = setInterval(() => {
      if (frameDocument() !== doc || ++ticks > SETTLE_TICKS) return stop();
      const now = getScrollTop(doc);
      if (Math.abs(now - last) > 3) return stop(); // the reader took over
      const target = anchorTop(doc, anchor);
      if (Math.abs(target - now) > 1) last = setScrollTop(doc, target);
    }, SETTLE_INTERVAL);
  }

  /* ---- 3. watch: remember the place, notice broken images --------------- */

  function remember(doc: Document) {
    if (paintedKey) rememberScroll(paintedKey, detachAnchor(captureAnchor(doc)));
  }

  const watchTimer = setInterval(() => {
    const doc = frameDocument();
    if (!doc || !painted) return;
    if (!settling) {
      const top = getScrollTop(doc);
      if (top !== watchedTop) {
        watchedTop = top;
        remember(doc);
      }
    }
    const broken = findBrokenImages(doc);
    if (broken.join('\n') !== brokenImages.join('\n')) {
      brokenImages = broken;
      report();
    }
  }, WATCH_INTERVAL);

  onDestroy(() => {
    clearInterval(watchTimer);
    clearInterval(settleTimer);
    const doc = frameDocument();
    if (doc && painted && !settling) remember(doc);
  });
</script>

<div class="preview" data-preview data-preview-state={failure ? 'failed' : painted ? 'ready' : 'loading'}>
  {#if failure}
    <p class="failed" role="alert">The preview could not be rendered: {failure}</p>
  {/if}

  <div class="stage">
    <iframe
      bind:this={frame}
      class="frame"
      class:painted
      title="Preview of the post as published"
      src={FRAME_PATH}
      sandbox={FRAME_SANDBOX}
      onload={onFrameLoad}
    ></iframe>
    {#if !painted && !failure}
      <p class="status" aria-live="polite">Rendering the preview…</p>
    {/if}
  </div>

  {#if !onRendered && warnings.length > 0}
    <details class="notes" data-preview-notes>
      <summary>{warnings.length === 1 ? '1 thing to check' : `${warnings.length} things to check`}</summary>
      <ul>
        {#each warnings as warning (warning)}
          <li>{warning}</li>
        {/each}
      </ul>
    </details>
  {/if}
</div>

<style>
  .preview {
    display: flex;
    flex-direction: column;
    width: 100%;
    height: 100%;
    min-height: 0;
    background: var(--w-bg);
    font-family: var(--w-font-ui);
  }
  .stage {
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
  }
  .frame {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    border: 0;
    opacity: 0;
    transition: opacity var(--w-dur-2) var(--w-ease-out);
  }
  .frame.painted {
    opacity: 1;
  }
  .status {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    margin: 0;
    color: var(--w-ink-3);
    font-size: var(--w-text-sm);
    letter-spacing: var(--w-ui-tracking);
  }
  .failed {
    flex: none;
    margin: 0;
    padding: var(--w-space-3) var(--w-gutter);
    color: var(--w-danger);
    font-size: var(--w-text-sm);
    border-bottom: var(--w-border) solid var(--w-line);
  }
  .notes {
    flex: none;
    max-height: 40%;
    overflow-y: auto;
    border-top: var(--w-border) solid var(--w-line);
    background: var(--w-surface);
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
  }
  .notes summary {
    display: flex;
    align-items: center;
    gap: var(--w-space-2);
    min-height: var(--w-tap);
    padding: 0 var(--w-gutter);
    color: var(--w-warn);
    font-weight: var(--w-ui-strong-weight);
    cursor: pointer;
    list-style: none;
  }
  .notes summary::-webkit-details-marker {
    display: none;
  }
  .notes summary::before {
    content: '';
    width: 0.5em;
    height: 0.5em;
    border-radius: var(--w-radius-pill);
    background: currentColor;
  }
  .notes summary:focus-visible {
    outline: 2px solid var(--w-focus);
    outline-offset: -2px;
  }
  .notes ul {
    margin: 0;
    padding: 0 var(--w-gutter) var(--w-space-3) calc(var(--w-gutter) + 1.2em);
    line-height: 1.5;
  }
  .notes li + li {
    margin-top: var(--w-space-1);
  }
</style>
