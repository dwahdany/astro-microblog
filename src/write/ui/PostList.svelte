<!--
  The post list (home). Every collection in one index: posts with changes kept
  on this device first, then everything else grouped by how recent it is.
  Search-as-you-type over title, slug, tags and the opening text; filters for
  type and drafts; "New post" for the four kinds the app can create.

  One DOM, two layouts: a single column with a floating "New post" button on a
  phone; a filter rail beside the index on wide screens.
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import Palette from '@lucide/svelte/icons/palette';
  import Plus from '@lucide/svelte/icons/plus';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Search from '@lucide/svelte/icons/search';
  import X from '@lucide/svelte/icons/x';
  import {
    COLLECTIONS,
    COLLECTION_INFO,
    CREATABLE_COLLECTIONS,
    assemblePost,
    type CollectionKind,
    type CreatableCollection,
    type DraftSummary,
    type PostRef,
    type SourceStatus,
  } from '../contracts';
  import { contentSource, draftStore, frontmatter } from '../data';
  import AccountButton from './AccountButton.svelte';
  import Sheet from './Sheet.svelte';
  import { account } from './auth.svelte';
  import { KIND_BLURB, KIND_ICON } from './kinds';
  import { dayMonth, groupByRecency, relativeTime } from './lib/groups';
  import { splitHit } from './lib/text';
  import { filters, handoff, listMemory, published, rememberFilters } from './memory.svelte';
  import { router } from './router.svelte';
  import { postHref, type ListSheet } from './routes';
  import { media, viewport } from './viewport.svelte';

  let { sheet }: { sheet: ListSheet | null } = $props();

  let posts = $state.raw<PostRef[]>(listMemory.posts ?? []);
  let status = $state<'loading' | 'ready' | 'failed'>(listMemory.posts ? 'ready' : 'loading');
  let problem = $state('');
  let reloading = $state(false);
  let drafts = $state.raw<DraftSummary[]>([]);
  /** List entries for posts that exist only on this device. */
  let unpublished = $state.raw<PostRef[]>([]);
  /**
   * List entries, built from the kept text itself, for changes whose post is NOT in the list: it
   * was renamed or deleted in the source, or the source could not deliver it this time. Without
   * these the work would be on the device with no way to reach it.
   */
  let orphaned = $state.raw<PostRef[]>([]);
  let now = $state(Date.now());
  /** Whether the list is live or a copy kept from an earlier visit (GitHub unreachable or rate-limiting). */
  let source = $state.raw<SourceStatus>(contentSource.status());

  let scroller: HTMLDivElement | undefined = $state();
  let searchInput: HTMLInputElement | undefined = $state();

  interface Row {
    post: PostRef;
    /** Set when the post has changes kept on this device. */
    local?: { updatedAt: number };
    /** The kept changes belong to a post the list does not have. */
    gone?: boolean;
  }

  const terms = $derived(filters.query.trim().toLowerCase().split(/\s+/).filter(Boolean));

  function matches(p: PostRef): boolean {
    if (filters.kind !== 'all' && p.collection !== filters.kind) return false;
    if (terms.length === 0) return true;
    const haystack = `${p.title}\n${p.slug}\n${p.tags.join(' ')}\n${p.excerpt}`.toLowerCase();
    return terms.every((t) => haystack.includes(t));
  }

  /** Posts with unsaved work on this device: new ones, existing ones that were edited, and edits whose post is gone. */
  const localAll = $derived.by((): Row[] => {
    const rows: Row[] = [];
    for (const d of drafts) {
      if (!d.dirty) continue;
      const listed = d.isNew ? unpublished.find((p) => p.id === d.id) : posts.find((p) => p.id === d.id);
      const lost = listed ? undefined : orphaned.find((p) => p.id === d.id);
      const post = listed ?? lost;
      if (post) rows.push({ post, local: { updatedAt: d.updatedAt }, gone: lost !== undefined });
    }
    return rows;
  });
  const localRows = $derived(localAll.filter((r) => matches(r.post)));
  const localIds = $derived(new Set(localAll.map((r) => r.post.id)));

  const groups = $derived(
    groupByRecency(
      posts.filter((p) => !localIds.has(p.id) && matches(p) && (!filters.draftsOnly || p.draft)),
      now,
    ),
  );
  const shown = $derived(localRows.length + groups.reduce((n, g) => n + g.items.length, 0));
  const total = $derived(posts.length + unpublished.length + orphaned.length);

  const counts = $derived.by(() => {
    const by = Object.fromEntries(COLLECTIONS.map((c) => [c, 0])) as Record<CollectionKind, number>;
    for (const p of posts) by[p.collection]++;
    for (const p of unpublished) by[p.collection]++;
    for (const p of orphaned) by[p.collection]++;
    return by;
  });
  /** Only offer a type filter when there is something of that type (or it can be created). */
  const kinds = $derived(COLLECTIONS.filter((c) => counts[c] > 0 || COLLECTION_INFO[c].creatable));
  /** What "Drafts only" shows: posts flagged as drafts plus everything kept on this device — and nothing it cannot show. */
  const draftCount = $derived(posts.filter((p) => p.draft && !localIds.has(p.id)).length + localAll.length);
  const filtered = $derived(filters.kind !== 'all' || filters.draftsOnly || terms.length > 0);

  async function loadDrafts() {
    const list = await draftStore.list();
    const records = await Promise.all(list.filter((d) => d.isNew).map((d) => draftStore.get(d.id)));
    unpublished = records
      .filter((r) => r !== undefined)
      .map((r) => frontmatter.describe(r.path, r.raw, { id: r.id, isNew: true }));
    drafts = list;
    await loadOrphans();
  }

  /** Kept changes for posts the list does not have: describe them from the kept text. */
  async function loadOrphans() {
    if (status !== 'ready') return; // not before the list is known
    const listed = new Set(posts.map((p) => p.id));
    const missing = drafts.filter((d) => d.dirty && !d.isNew && !listed.has(d.id));
    const records = await Promise.all(missing.map((d) => draftStore.get(d.id).catch(() => undefined)));
    orphaned = records.filter((r) => r !== undefined).map((r) => frontmatter.describe(r.path, r.raw, { id: r.id }));
  }

  async function load(refresh = false) {
    if (posts.length === 0) status = 'loading';
    reloading = refresh;
    try {
      // Drafts failing to load (storage blocked) must not hide the posts.
      const [list] = await Promise.all([contentSource.list({ refresh }), loadDrafts().catch(() => {})]);
      posts = list;
      listMemory.posts = list;
      now = Date.now();
      status = 'ready';
      await loadOrphans().catch(() => {});
    } catch (err) {
      if (posts.length === 0) {
        problem = err instanceof Error ? err.message : String(err);
        status = 'failed';
      }
    } finally {
      reloading = false;
    }
  }

  async function create(collection: CreatableCollection) {
    const post = frontmatter.scaffold(collection);
    handoff.set(post.ref.id, post);
    try {
      await draftStore.put({
        id: post.ref.id,
        path: post.ref.path,
        collection,
        isNew: true,
        raw: assemblePost(post.parts),
        baseRaw: null,
        updatedAt: Date.now(),
      });
    } catch {
      // The writing screen still opens from the hand-off and warns that nothing is being kept.
    }
    // A blogmark starts from its link, so it opens with the properties sheet up, ready for the URL.
    router.go(postHref(post.ref.id, collection === 'blogmarks' ? 'properties' : null), { replace: true });
  }

  function clearFilters() {
    filters.query = '';
    filters.kind = 'all';
    filters.draftsOnly = false;
  }

  function rowLinks(): HTMLElement[] {
    return scroller ? [...scroller.querySelectorAll<HTMLElement>('a[data-post-row]')] : [];
  }

  /** Desktop keyboard: `/` jumps to search, arrows walk the rows. */
  function onKeydown(event: KeyboardEvent) {
    if (sheet !== null || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target as HTMLElement;
    const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
    if (event.key === '/' && !typing) {
      event.preventDefault();
      searchInput?.focus();
      return;
    }
    if (event.key === 'Escape' && target === searchInput && filters.query !== '') {
      filters.query = '';
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const links = rowLinks();
    if (links.length === 0) return;
    const at = links.indexOf(document.activeElement as HTMLElement);
    if (at < 0 && target !== searchInput) return;
    event.preventDefault();
    if (event.key === 'ArrowDown') links[Math.min(links.length - 1, at + 1)].focus();
    else if (at <= 0) searchInput?.focus();
    else links[at - 1].focus();
  }

  $effect(() => {
    void [filters.query, filters.kind, filters.draftsOnly];
    rememberFilters();
  });

  onMount(() => {
    void load().then(async () => {
      await tick();
      if (scroller) scroller.scrollTop = listMemory.scrollTop;
    });
    const stop = draftStore.subscribe(() => void loadDrafts().catch(() => {}));
    const stopStatus = contentSource.onStatus((next) => (source = next));
    return () => {
      stop();
      stopStatus();
      listMemory.scrollTop = scroller?.scrollTop ?? 0;
    };
  });
</script>

<svelte:window onkeydown={onKeydown} />

{#snippet row(r: Row)}
  {@const p = r.post}
  {@const Icon = KIND_ICON[p.collection]}
  {@const [before, hit, after] = splitHit(p.title, terms[0] ?? '')}
  <li>
    <a class="row" href={postHref(p.id)} data-post-row data-collection={p.collection}>
      <span class="glyph"><Icon size={18} aria-hidden="true" /></span>
      <span class="main">
        <span class="title">{before}{#if hit}<mark>{hit}</mark>{/if}{after}</span>
        {#if (p.excerpt && p.excerpt !== p.title) || p.tags.length}
          <span class="sub">
            {#if p.excerpt && p.excerpt !== p.title}{p.excerpt}{/if}
            <!-- Keyed by position: tags come from the file and may repeat (a repeated key crashes the list). -->
            {#each p.tags.slice(0, 4) as tag, i (i)}<span class="tag">#{tag}</span>{/each}
          </span>
        {/if}
      </span>
      <span class="meta">
        <span class="kind">{COLLECTION_INFO[p.collection].singular}</span>
        {#if r.local}
          <span class="when">{p.isNew ? 'Started' : 'Edited'} {relativeTime(r.local.updatedAt, now)}</span>
          <span class="w-flag is-local">{p.isNew ? 'Not published' : 'Changed here'}</span>
          {#if r.gone}<span class="w-flag" data-row-gone>Not in {contentSource.kind === 'local' ? 'the working tree' : 'the repository'} list</span>{/if}
        {:else if p.createdMs !== null}
          <time class="when" datetime={p.created}>{dayMonth(p.createdMs)}</time>
        {/if}
        {#if p.draft && !p.isNew}<span class="w-flag">Draft</span>{/if}
      </span>
    </a>
  </li>
{/snippet}

<!-- Short on height (a phone on its side) or typing with the keyboard up: the wordmark gives its row to the list. -->
<div class="screen" class:short={!media.wide && !viewport.keyboard && viewport.height > 0 && viewport.height < 480} class:typing={!media.wide && viewport.keyboard}>
  <header class="brand">
    <h1>Write</h1>
    <span class="brand-actions">
      <AccountButton labelled />
      <button type="button" class="w-icon" data-open="look" aria-label="Change the look" title="Look" onclick={() => router.openSheet('look')}>
        <Palette size={20} aria-hidden="true" />
      </button>
    </span>
  </header>

  <button type="button" class="w-btn is-primary new" data-open="new" onclick={() => router.openSheet('new')}>
    <Plus size={20} aria-hidden="true" />New post
  </button>

  <div class="searchbar">
    <label class="search">
      <Search size={18} aria-hidden="true" />
      <span class="w-sr">Search posts</span>
      <input
        type="search"
        enterkeyhint="search"
        autocomplete="off"
        autocapitalize="none"
        spellcheck="false"
        placeholder="Search titles, tags and text"
        bind:value={filters.query}
        bind:this={searchInput}
      />
      {#if filters.query !== ''}
        <button type="button" class="clear" aria-label="Clear search" onclick={() => ((filters.query = ''), searchInput?.focus())}>
          <X size={18} aria-hidden="true" />
        </button>
      {/if}
    </label>
  </div>

  <nav class="filters" aria-label="Filter posts">
    <button type="button" class="filter" aria-pressed={filters.kind === 'all'} data-kind="all" onclick={() => (filters.kind = 'all')}>
      <span>All</span><span class="n">{total}</span>
    </button>
    {#each kinds as c (c)}
      {@const Icon = KIND_ICON[c]}
      <button type="button" class="filter" aria-pressed={filters.kind === c} data-kind={c} onclick={() => (filters.kind = c)}>
        <Icon size={16} aria-hidden="true" /><span>{COLLECTION_INFO[c].label}</span><span class="n">{counts[c]}</span>
      </button>
    {/each}
    <button
      type="button"
      class="filter drafts"
      aria-pressed={filters.draftsOnly}
      data-filter="drafts"
      onclick={() => (filters.draftsOnly = !filters.draftsOnly)}
    >
      <span>Drafts only</span><span class="n">{draftCount}</span>
    </button>
  </nav>

  <div class="list w-scroll" bind:this={scroller}>
    <div class="column" aria-busy={status === 'loading'}>
      {#if status === 'loading'}
        <p class="w-sr" role="status">Loading posts from {contentSource.label}</p>
        <ul class="rows skeleton" aria-hidden="true">
          {#each [72, 54, 88, 61, 79, 47, 66] as width (width)}
            <li><span class="row"><span class="bone" style:width="{width}%"></span><span class="bone short"></span></span></li>
          {/each}
        </ul>
      {:else if status === 'failed'}
        <div class="state" role="alert">
          <h2>The posts did not load</h2>
          <p>{problem}</p>
          <button type="button" class="w-btn" onclick={() => load(true)}>Try again</button>
        </div>
      {:else}
        {#if published.last?.deleted}
          <!-- A post was just deleted from the writing screen: say so where the owner lands. -->
          <p class="stale done" role="status" data-list-notice="deleted">
            <span>
              Deleted <code>{published.last.path}</code>.
              {#if published.last.commitUrl}<a href={published.last.commitUrl} target="_blank" rel="noopener noreferrer">View the commit</a>{/if}
            </span>
            <button type="button" class="reload" onclick={() => (published.last = null)}>OK</button>
          </p>
        {/if}
        {#if account.state.status !== 'signed-in' && account.state.ended}
          <p class="stale" role="status" data-list-notice="signed-out">
            <span>{account.state.ended.message} Your drafts are still on this device.</span>
            <button type="button" class="reload" data-open="account" onclick={() => router.openSheet('account')}>Sign in</button>
          </p>
        {/if}
        {#if source.state === 'stale'}
          <p class="stale" role="status" data-source-state="stale">
            <span>{source.message ?? `${contentSource.label} could not be reached. This is the copy kept on this device.`}</span>
            <button type="button" class="reload" onclick={() => load(true)} disabled={reloading}>
              <RefreshCw size={14} aria-hidden="true" />{reloading ? 'Trying' : 'Try again'}
            </button>
          </p>
        {/if}
        <div data-post-list>
          {#if localRows.length}
            <section aria-labelledby="group-local">
              <h2 class="group" id="group-local">Kept on this device</h2>
              <ul class="rows">
                {#each localRows as r (r.post.id)}{@render row(r)}{/each}
              </ul>
            </section>
          {/if}
          {#each groups as g (g.key)}
            <section aria-labelledby="group-{g.key}">
              <h2 class="group" id="group-{g.key}">{g.label}</h2>
              <ul class="rows">
                {#each g.items as p (p.id)}{@render row({ post: p })}{/each}
              </ul>
            </section>
          {/each}
        </div>

        {#if shown === 0}
          <div class="state">
            {#if total === 0}
              <h2>Nothing here yet</h2>
              <p>{contentSource.label} has no posts. Start the first one.</p>
              <button type="button" class="w-btn is-primary" onclick={() => router.openSheet('new')}>New post</button>
            {:else}
              <h2>No posts match</h2>
              <p>
                {#if terms.length}Nothing matches “{filters.query.trim()}”{filters.kind !== 'all' ? ` in ${COLLECTION_INFO[filters.kind].label.toLowerCase()}` : ''}{filters.draftsOnly ? ' among drafts' : ''}.
                {:else}There are no {filters.draftsOnly ? 'draft ' : ''}{filters.kind !== 'all' ? COLLECTION_INFO[filters.kind].label.toLowerCase() : 'posts'}.{/if}
              </p>
              <button type="button" class="w-btn" data-action="clear-filters" onclick={clearFilters}>Show all posts</button>
            {/if}
          </div>
        {:else}
          <p class="source">
            <span data-post-count>{filtered ? `${shown} of ${total}` : total} posts, read from {contentSource.label}.</span>
            <button type="button" class="reload" onclick={() => load(true)} disabled={reloading}>
              <RefreshCw size={14} aria-hidden="true" />{reloading ? 'Reloading' : 'Reload'}
            </button>
          </p>
        {/if}
      {/if}
    </div>
  </div>
</div>

{#if sheet === 'new'}
  <Sheet title="New post" name="new" onClose={() => router.closeSheet()}>
    <ul class="kinds">
      {#each CREATABLE_COLLECTIONS as c (c)}
        {@const Icon = KIND_ICON[c]}
        <li>
          <button type="button" class="kind-choice" data-new={c} onclick={() => create(c)}>
            <span class="glyph"><Icon size={22} aria-hidden="true" /></span>
            <span class="name">{COLLECTION_INFO[c].singular}</span>
            <span class="blurb">{KIND_BLURB[c]}</span>
          </button>
        </li>
      {/each}
    </ul>
    <p class="hint">A new post starts as a draft and is kept on this device until you publish it.</p>
  </Sheet>
{/if}

<style>
  .screen {
    position: relative;
    flex: 1;
    min-height: 0;
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: auto auto auto minmax(0, 1fr);
    grid-template-areas: 'brand' 'search' 'filters' 'list';
  }

  /* ------------------------------------------------------------- brand */
  .brand {
    grid-area: brand;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--w-space-2);
    padding: calc(var(--w-space-2) + env(safe-area-inset-top)) calc(var(--w-gutter) - 10px) 0 var(--w-gutter);
  }
  .brand-actions {
    flex: none;
    display: flex;
    align-items: center;
  }
  h1 {
    margin: 0;
    font-family: var(--w-font-display);
    font-size: var(--wx-wordmark-size);
    font-weight: var(--w-display-weight);
    font-stretch: var(--w-display-stretch);
    letter-spacing: var(--w-display-tracking);
    line-height: 1;
    text-transform: var(--wx-case);
    /* One word, with or without a prefix (`$ write` has a space in it): never broken over two lines. */
    white-space: nowrap;
  }
  h1::before {
    content: var(--wx-wordmark-prefix);
    color: var(--w-accent-text);
  }

  /* While a search is typed on a phone the keyboard takes half the screen: the wordmark row goes. */
  .screen.typing .brand {
    display: none;
  }
  /* A phone on its side: search and the Look button share one row, the wordmark is dropped. */
  .screen.short {
    grid-template-columns: minmax(0, 1fr) auto;
    grid-template-rows: auto auto minmax(0, 1fr);
    grid-template-areas: 'search brand' 'filters filters' 'list list';
  }
  .screen.short .brand {
    align-self: end;
    padding: 0 calc(var(--w-gutter) - 10px) 0 0;
  }
  .screen.short h1 {
    display: none;
  }
  .screen.short .searchbar {
    padding-top: calc(var(--w-space-2) + env(safe-area-inset-top));
    padding-right: var(--w-space-1);
  }
  .screen.short .filters {
    padding-top: var(--w-space-2);
    padding-bottom: var(--w-space-2);
  }

  /* --------------------------------------------------------------- new */
  /* Phone: a floating button in thumb reach. Wide: the first thing in the rail. */
  .new {
    position: absolute;
    z-index: 5;
    right: var(--w-gutter);
    bottom: calc(var(--w-space-4) + env(safe-area-inset-bottom));
    min-height: 52px;
    padding: 0 var(--w-space-5) 0 var(--w-space-4);
    border-radius: var(--w-radius-pill);
    font-size: var(--w-text-md);
    box-shadow: var(--w-shadow-2);
  }

  /* ------------------------------------------------------------ search */
  .searchbar {
    grid-area: search;
    padding: var(--w-space-3) var(--w-gutter) 0;
  }
  .search {
    display: flex;
    align-items: center;
    gap: var(--w-space-2);
    min-height: var(--w-tap);
    padding: 0 var(--w-space-1) 0 var(--w-space-3);
    border: var(--w-border) solid var(--w-line);
    border-radius: var(--w-radius-sm);
    background: var(--w-surface);
    color: var(--w-ink-3);
  }
  .search:focus-within {
    border-color: var(--w-focus);
    outline: 2px solid var(--w-focus);
    outline-offset: 1px;
  }
  .search input {
    flex: 1;
    min-width: 0;
    height: var(--w-tap);
    padding: 0;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--w-ink);
    font: inherit;
    font-size: max(1rem, var(--w-text-md));
    appearance: none;
  }
  .search input::placeholder {
    color: var(--w-ink-3);
    opacity: 1;
  }
  .search input::-webkit-search-cancel-button {
    display: none;
  }
  .clear {
    flex: none;
    display: grid;
    place-items: center;
    width: var(--w-tap);
    height: var(--w-tap);
    border: 0;
    background: transparent;
    color: var(--w-ink-2);
    cursor: pointer;
  }

  /* ----------------------------------------------------------- filters */
  .filters {
    grid-area: filters;
    display: flex;
    gap: var(--w-space-2);
    padding: var(--w-space-3) var(--w-gutter);
    overflow-x: auto;
    scrollbar-width: none;
    border-bottom: var(--w-border) solid var(--w-line);
  }
  .filters::-webkit-scrollbar {
    display: none;
  }
  /* Phone: one sideways strip. "Drafts only" is the one filter that is not a post type, so it
     comes right after "All" instead of at the far end; the fade says the strip goes on. */
  :global(html:not([data-write-wide])) .filters {
    mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
    -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 28px), transparent);
    padding-right: calc(var(--w-gutter) + 12px);
  }
  :global(html:not([data-write-wide])) .filter[data-kind='all'] {
    order: -2;
  }
  :global(html:not([data-write-wide])) .filter.drafts {
    order: -1;
  }
  .filter {
    position: relative;
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: var(--w-space-2);
    min-height: 36px;
    padding: 0 var(--w-space-3);
    border: var(--w-border) solid var(--w-line);
    border-radius: var(--w-radius-pill);
    background: transparent;
    color: var(--w-ink-2);
    font: inherit;
    font-size: var(--w-text-sm);
    text-transform: var(--wx-case);
    white-space: nowrap;
    cursor: pointer;
    touch-action: manipulation;
  }
  /* 36px to look at, 44px to hit. */
  .filter::before {
    content: '';
    position: absolute;
    inset: -5px 0;
  }
  .filter .n {
    color: var(--w-ink-3);
    font-variant-numeric: tabular-nums;
  }
  .filter[aria-pressed='true'] {
    background: var(--w-ink);
    border-color: var(--w-ink);
    color: var(--w-bg);
    font-weight: var(--w-ui-strong-weight);
  }
  .filter[aria-pressed='true'] .n {
    color: inherit;
    opacity: 0.75;
  }
  .filter.drafts[aria-pressed='true'] {
    background: var(--wx-flag-bg);
    border-color: var(--w-line-strong);
    color: var(--wx-flag-ink);
  }

  /* -------------------------------------------------------------- list */
  .list {
    grid-area: list;
    min-height: 0;
  }
  .column {
    max-width: 54rem;
    margin: 0 auto;
    /* Room at the end so the floating button never covers the last row. */
    padding: var(--w-space-2) var(--w-gutter) calc(96px + env(safe-area-inset-bottom));
  }
  .group {
    margin: var(--w-space-5) 0 var(--w-space-2);
    color: var(--wx-group-ink);
    font-family: var(--wx-group-font);
    font-size: var(--wx-group-size);
    font-style: var(--wx-group-style);
    font-weight: var(--wx-group-weight);
    font-stretch: var(--wx-group-stretch);
    line-height: 1.2;
    text-transform: var(--wx-case);
  }
  .group::before {
    content: var(--wx-group-prefix);
  }
  section:first-child .group {
    margin-top: var(--w-space-4);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--wx-row-gap);
    border-top: var(--wx-row-rule) solid var(--w-line);
  }
  .row {
    display: grid;
    grid-template-columns: 26px minmax(0, 1fr);
    grid-template-areas: 'glyph main' 'glyph meta';
    column-gap: var(--w-space-2);
    row-gap: 3px;
    min-height: var(--w-tap);
    padding: var(--wx-row-pad-y) var(--wx-row-pad-x);
    border: var(--wx-row-outline) solid var(--w-line-strong);
    border-radius: var(--wx-row-radius);
    background: var(--wx-row-bg);
    box-shadow: var(--wx-row-shadow);
    color: inherit;
    text-decoration: none;
  }
  /* The hairline between rows of a ruled list (zero-width where rows are cards). */
  .rows li {
    border-bottom: var(--wx-row-rule) solid var(--w-line);
  }
  .row:focus-visible {
    outline-offset: 0;
  }
  .glyph {
    grid-area: glyph;
    padding-top: 3px;
    color: var(--wx-kind-ink);
  }
  .main {
    grid-area: main;
    display: grid;
    gap: 2px;
    min-width: 0;
  }
  .title {
    font-family: var(--w-font-display);
    font-size: var(--wx-row-title-size);
    font-weight: var(--w-display-weight);
    font-stretch: var(--w-display-stretch);
    letter-spacing: var(--w-display-tracking);
    line-height: 1.22;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .title mark {
    background: var(--w-mark);
    color: inherit;
    border-radius: var(--w-radius-xs);
  }
  .sub {
    display: none;
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
    line-height: 1.4;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .tag {
    margin-left: 0.75ch;
    color: var(--w-ink-3);
  }
  .tag:first-child {
    margin-left: 0;
  }
  .meta {
    grid-area: meta;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px var(--w-space-3);
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
    font-variant-numeric: tabular-nums;
  }
  .kind {
    color: var(--wx-kind-ink);
    font-family: var(--wx-kind-font);
    font-style: var(--wx-kind-style);
    font-weight: var(--wx-kind-weight);
    text-transform: var(--wx-case);
  }
  .when {
    text-transform: var(--wx-case);
  }
  @media (hover: hover) {
    .row:hover .title {
      color: var(--w-accent-text);
    }
  }

  /* ------------------------------------------------- loading and states */
  .skeleton .row {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas: none;
    row-gap: var(--w-space-2);
  }
  .bone {
    display: block;
    height: 1.1em;
    border-radius: var(--w-radius-xs);
    background: var(--w-surface-2);
  }
  .bone.short {
    width: 28%;
    height: 0.8em;
  }
  .state {
    margin-top: var(--w-space-7);
    display: grid;
    justify-items: start;
    gap: var(--w-space-3);
  }
  .state h2 {
    margin: 0;
    font-family: var(--w-font-display);
    font-size: var(--w-text-xl);
    font-weight: var(--w-display-weight);
    font-stretch: var(--w-display-stretch);
    letter-spacing: var(--w-display-tracking);
    line-height: 1.15;
  }
  .state p {
    margin: 0;
    max-width: 44ch;
    color: var(--w-ink-2);
  }
  .stale {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--w-space-2) var(--w-space-4);
    margin: var(--w-space-3) 0 0;
    padding: var(--w-space-2) var(--w-space-3);
    border-left: 3px solid var(--w-warn);
    border-radius: var(--w-radius-xs);
    background: var(--w-surface-2);
    color: var(--w-ink);
    font-size: var(--w-text-sm);
    line-height: 1.4;
  }
  .stale.done {
    border-left-color: var(--w-ok);
  }
  .stale code {
    font-family: var(--w-font-mono);
    font-size: 0.92em;
    overflow-wrap: anywhere;
  }
  .stale a {
    color: var(--w-accent-text);
    text-underline-offset: 3px;
    white-space: nowrap;
  }
  .source {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--w-space-2) var(--w-space-4);
    margin: var(--w-space-6) 0 0;
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
  }
  .reload {
    display: inline-flex;
    align-items: center;
    gap: var(--w-space-2);
    min-height: var(--w-tap);
    padding: 0 var(--w-space-2);
    margin-left: calc(-1 * var(--w-space-2));
    border: 0;
    border-radius: var(--w-radius-sm);
    background: transparent;
    color: var(--w-accent-text);
    font: inherit;
    font-weight: var(--w-ui-strong-weight);
    text-transform: var(--wx-case);
    cursor: pointer;
  }
  .reload:disabled {
    color: var(--w-ink-3);
    cursor: default;
  }

  /* ---------------------------------------------------------- new sheet */
  .kinds {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--w-space-2);
  }
  .kind-choice {
    display: grid;
    grid-template-columns: 40px minmax(0, 1fr);
    grid-template-areas: 'glyph name' 'glyph blurb';
    align-items: center;
    column-gap: var(--w-space-3);
    width: 100%;
    min-height: 64px;
    padding: var(--w-space-3);
    border: var(--w-border) solid var(--w-line);
    border-radius: var(--w-radius-md);
    background: transparent;
    color: var(--w-ink);
    font: inherit;
    text-align: left;
    cursor: pointer;
    touch-action: manipulation;
    transition: transform var(--w-dur-1) var(--w-ease);
  }
  .kind-choice:active {
    transform: var(--wx-btn-press);
  }
  .kind-choice .glyph {
    grid-area: glyph;
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border-radius: var(--w-radius-sm);
    background: var(--w-accent-soft);
    color: var(--w-accent-text);
  }
  .kind-choice .name {
    grid-area: name;
    font-family: var(--w-font-display);
    font-size: var(--w-text-lg);
    font-weight: var(--w-display-weight);
    font-stretch: var(--w-display-stretch);
    letter-spacing: var(--w-display-tracking);
    line-height: 1.2;
    text-transform: var(--wx-case);
  }
  .kind-choice .blurb {
    grid-area: blurb;
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
  }
  @media (hover: hover) {
    .kind-choice:hover {
      border-color: var(--w-line-strong);
      background: var(--w-surface-2);
    }
  }
  .hint {
    margin: var(--w-space-4) 0 0;
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
  }

  /* ---------------------------------------------------------- wide layout */
  @media (min-width: 640px) {
    .row {
      grid-template-columns: 26px minmax(0, 1fr) auto;
      grid-template-areas: 'glyph main meta';
      column-gap: var(--w-space-3);
    }
    .sub {
      display: block;
    }
    .meta {
      flex-wrap: nowrap;
      justify-content: flex-end;
      align-self: start;
      padding-top: 3px;
      white-space: nowrap;
    }
    .meta :global(.w-flag) {
      order: -1;
    }
    .when {
      min-width: 6ch;
      text-align: right;
    }
  }
  /* Desktop layout: wide AND tall enough (see viewport.svelte.ts); a phone on its side keeps the phone layout. */
  :global(html[data-write-wide]) .screen {
    grid-template-columns: 272px minmax(0, 1fr);
    grid-template-rows: auto auto minmax(0, 1fr);
    grid-template-areas: 'brand search' 'new list' 'filters list';
  }
  /* The rail's edge, drawn once across all three rows. */
  :global(html[data-write-wide]) .screen::before {
    content: '';
    grid-column: 1;
    grid-row: 1 / -1;
    border-right: var(--w-border) solid var(--w-line);
    pointer-events: none;
  }
  :global(html[data-write-wide]) .brand {
    grid-column: 1;
    grid-row: 1;
    /* The buttons carry their own inset: the same optical edge as the phone header, and room for "Sign in". */
    padding: var(--w-space-5) var(--w-space-2) var(--w-space-4) var(--w-space-5);
  }
  :global(html[data-write-wide]) .new {
    position: static;
    grid-area: new;
    justify-self: stretch;
    margin: 0 var(--w-space-5) var(--w-space-5);
    min-height: var(--w-tap);
    border-radius: var(--w-radius-sm);
    font-size: var(--w-text-sm);
    box-shadow: var(--wx-btn-shadow);
  }
  :global(html[data-write-wide]) .searchbar {
    width: 100%;
    max-width: 54rem;
    margin: 0 auto;
    padding: var(--w-space-5) var(--w-gutter) var(--w-space-3);
  }
  :global(html[data-write-wide]) .filters {
    flex-direction: column;
    align-content: start;
    gap: 2px;
    padding: 0 var(--w-space-3) var(--w-space-5);
    overflow: auto;
    border-bottom: 0;
  }
  :global(html[data-write-wide]) .filter {
    justify-content: flex-start;
    min-height: 40px;
    padding: 0 var(--w-space-3);
    border-color: transparent;
    border-radius: var(--w-radius-sm);
  }
  :global(html[data-write-wide]) .filter .n {
    margin-left: auto;
  }
  :global(html[data-write-wide]) .filter.drafts {
    margin-top: var(--w-space-4);
  }
  :global(html[data-write-wide]) .column {
    padding-bottom: var(--w-space-8);
  }
  @media (hover: hover) {
    :global(html[data-write-wide]) .filter:hover:not([aria-pressed='true']) {
      background: var(--w-surface-2);
    }
  }
</style>
