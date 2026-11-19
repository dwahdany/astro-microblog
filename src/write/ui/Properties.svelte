<!--
  The frontmatter as a compact form. The YAML text stays the source of truth:
  every control reads the parsed value and writes through `onPatch`
  (→ frontmatter.patch), which touches only the key that changed. Nothing is
  written until a value actually differs — opening a picker and choosing the
  same moment, or focusing a field, never rewrites a line.

  Fields come from the data layer's definitions for the collection. For a
  blogmark, pasting the link fetches the page's title and a slug from the
  site's own /api/fetch-meta, as the old admin did.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import {
    type CollectionKind,
    type FieldSpec,
    type FrontmatterPatch,
    type PostParts,
    type PostRef,
  } from '../contracts';
  import { formatLike, frontmatter } from '../data';
  import BoundInput from './fields/BoundInput.svelte';
  import TagField from './fields/TagField.svelte';
  import { localInputDate, toDateInput, toLocalInput } from './lib/datetime';
  import { fetchPageMeta } from './lib/io';
  import { takenBy } from './lib/publish';
  import { isAutoSlug } from './lib/slug';
  import { emptyValue } from './lib/values';

  let {
    parts,
    collection,
    path,
    isNew,
    baseData,
    tagSuggestions,
    posts = [],
    postId = '',
    problem = '',
    onPatch,
  }: {
    parts: PostParts;
    collection: CollectionKind;
    /** Where the post lives (or will live) in the repo. */
    path: string;
    isNew: boolean;
    /** Parsed frontmatter of the original file; null for a new post. */
    baseData: Record<string, unknown> | null;
    /** Tags already used on the blog, most used first. */
    tagSuggestions: readonly string[];
    /** The post list, to warn when a new post's path is already taken. */
    posts?: readonly Pick<PostRef, 'id' | 'path'>[];
    /** `PostRef.id` of the post being edited. */
    postId?: string;
    /** Why the last change was refused (frontmatter the data layer will not rewrite), or ''. */
    problem?: string;
    onPatch: (changes: FrontmatterPatch) => void;
  } = $props();

  const parsed = $derived(frontmatter.parse(parts.frontmatter));
  const specs = $derived(frontmatter.fields(collection));
  const allIssues = $derived(parsed.issues.length ? [] : frontmatter.validate(collection, parsed.data));

  /**
   * A NEW post opens with its required fields empty — that is where everyone starts, not an
   * error. A field's problem is said once there is something to say it about: the field has a
   * value (a bad slug, a bad address), or it has been visited and left. Existing posts show
   * every problem straight away. (Publish checks everything regardless.)
   */
  let visited = $state<Record<string, boolean>>({});
  const speaksUp = (key: string | undefined): boolean => {
    if (!isNew || key === undefined) return true;
    const v = parsed.data[key];
    const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
    return !empty || visited[key] === true;
  };
  const issues = $derived(allIssues.filter((i) => speaksUp(i.key)));
  const pathTaken = $derived(takenBy({ id: postId, isNew, path, posts }) !== undefined);
  const unknownKeys = $derived(parsed.keys.filter((k) => !specs.some((f) => f.key === k)));

  /** A link or a quote starts from its own fields, so those lead; everything else leads with the core five. */
  const sourceFirst = $derived(collection === 'blogmarks' || collection === 'quotations');
  const main = $derived.by(() => {
    const core = specs.filter((f) => f.group === 'core');
    const own = specs.filter((f) => f.group === 'collection');
    return sourceFirst ? [...own, ...core] : [...core, ...own];
  });
  const advanced = $derived(specs.filter((f) => f.group === 'advanced'));
  const advancedInUse = $derived(advanced.some((f) => text(f.key) !== ''));

  function text(key: string): string {
    const v = parsed.data[key];
    if (v === undefined || v === null) return '';
    return typeof v === 'object' ? '' : String(v);
  }
  const tagsOf = (key: string): string[] => {
    const v = parsed.data[key];
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  };
  const issueFor = (key: string) => issues.find((i) => i.key === key)?.message;

  const emptied = (key: string, list = false) => emptyValue(baseData, key, list);

  function setText(field: FieldSpec, value: string) {
    onPatch({ [field.key]: value === '' ? emptied(field.key) : value });
    if (field.key === 'link_url') scheduleMeta(value.trim());
  }

  function setFlag(field: FieldSpec, on: boolean) {
    // Switching a flag back off in a file that never had the key removes the key again.
    const absentBefore = baseData !== null && !(field.key in baseData);
    onPatch({ [field.key]: on ? true : absentBefore ? undefined : false });
  }

  function setNumber(field: FieldSpec, value: string) {
    const n = Number(value);
    if (value === '' || Number.isNaN(n)) {
      const empty = emptied(field.key);
      onPatch({ [field.key]: empty === '' ? null : empty });
    } else onPatch({ [field.key]: n });
  }

  function setChoice(field: FieldSpec, value: string) {
    const empty = emptied(field.key);
    onPatch({ [field.key]: value === '' ? (empty === '' ? null : empty) : value });
  }

  function setMoment(field: FieldSpec, local: string) {
    // The picker shows minutes in local time. If that is what is already stored, there is nothing to write.
    if (local === (toLocalInput(text(field.key)) ?? '')) return;
    const moment = localInputDate(local);
    // Written the way the file already writes it (`…Z` stays `…Z`); Sveltia's format for an empty field.
    if (moment) onPatch({ [field.key]: formatLike(text(field.key), moment) });
  }

  function setNow(field: FieldSpec) {
    onPatch({ [field.key]: formatLike(text(field.key), new Date()) });
  }

  function setDate(field: FieldSpec, value: string) {
    if (value === (toDateInput(text(field.key)) ?? '')) return;
    onPatch({ [field.key]: value === '' ? emptied(field.key) : value });
  }

  /* ---- Blogmark: fill the link title and slug from the linked page ---- */

  let meta = $state<{ status: 'idle' | 'loading' | 'filled' | 'nothing' | 'failed'; note: string }>({ status: 'idle', note: '' });
  let metaTimer: ReturnType<typeof setTimeout> | undefined;
  let metaAbort: AbortController | undefined;
  let lastFetched = '';

  function scheduleMeta(url: string) {
    clearTimeout(metaTimer);
    if (collection !== 'blogmarks' || !/^https?:\/\//.test(url) || url === lastFetched) return;
    metaTimer = setTimeout(() => void fillFromPage(url), 500);
  }

  async function fillFromPage(url: string) {
    lastFetched = url;
    metaAbort?.abort();
    metaAbort = new AbortController();
    meta = { status: 'loading', note: 'Reading the page title' };
    const found = await fetchPageMeta(url, metaAbort.signal);
    if (metaAbort.signal.aborted) return;
    if (!found) {
      meta = { status: 'failed', note: 'That page could not be read. Type the link title yourself.' };
      return;
    }
    // Only fill what is still empty (or, for a new post, a slug nobody chose) — same rule as the old admin.
    const changes: FrontmatterPatch = {};
    const filled: string[] = [];
    const current = untrack(() => parsed.data);
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    const titleEmpty = str(current.link_title).trim() === '';
    if (titleEmpty) {
      changes.link_title = found.title;
      filled.push('link title');
    }
    // The slug goes with the title: a slug that follows a title the owner wrote is theirs, too.
    const slug = str(current.slug);
    if (found.slug && (slug === '' || (isNew && titleEmpty && isAutoSlug(slug, '', frontmatter.slugify)))) {
      changes.slug = found.slug;
      filled.push('slug');
    }
    if (filled.length) {
      onPatch(changes);
      meta = { status: 'filled', note: `Filled the ${filled.join(' and ')} from the page.` };
    } else meta = { status: 'nothing', note: 'The link title and slug are already filled in, so they were left alone.' };
  }

  $effect(() => () => {
    clearTimeout(metaTimer);
    metaAbort?.abort();
  });
</script>

{#snippet control(field: FieldSpec)}
  {@const id = `prop-${field.key}`}
  {@const problem = issueFor(field.key)}
  {@const describedBy = problem || field.hint ? `${id}-note` : undefined}
  <div class="field" data-field={field.key} data-kind={field.kind} onfocusout={() => (visited[field.key] = true)}>
    {#if field.kind === 'boolean'}
      <button
        type="button"
        class="switch"
        role="switch"
        {id}
        aria-checked={parsed.data[field.key] === true}
        aria-describedby={describedBy}
        onclick={() => setFlag(field, parsed.data[field.key] !== true)}
      >
        <span class="label">{field.label}</span>
        <span class="track" aria-hidden="true"><span class="thumb"></span></span>
      </button>
    {:else}
      <label for={id}>{field.label}{#if !field.required}<span class="optional">optional</span>{:else if isNew && text(field.key) === ''}<span class="optional" data-required>required</span>{/if}</label>
      {#if field.kind === 'yaml'}
        <pre class="raw" {id}>{JSON.stringify(parsed.data[field.key] ?? null, null, 2)}</pre>
      {:else if field.kind === 'tags'}
        <TagField {id} value={tagsOf(field.key)} suggestions={tagSuggestions} onChange={(tags) => onPatch({ [field.key]: tags.length ? tags : emptied(field.key, true) })} />
      {:else if field.kind === 'select'}
        <select class="w-input" {id} value={text(field.key)} onchange={(e) => setChoice(field, e.currentTarget.value)}>
          <option value="">Not set</option>
          {#each field.options ?? [] as option (option)}<option value={option}>{option}</option>{/each}
        </select>
      {:else if field.kind === 'number'}
        <input class="w-input" {id} type="number" inputmode="decimal" step="any" value={text(field.key)} onchange={(e) => setNumber(field, e.currentTarget.value)} />
      {:else if field.kind === 'datetime' && (text(field.key) === '' || toLocalInput(text(field.key)) !== null)}
        <div class="moment">
          <input
            class="w-input"
            {id}
            type="datetime-local"
            value={toLocalInput(text(field.key)) ?? ''}
            aria-invalid={problem ? 'true' : undefined}
            aria-describedby={describedBy}
            onchange={(e) => setMoment(field, e.currentTarget.value)}
          />
          <button type="button" class="w-btn" data-action="now" onclick={() => setNow(field)}>Now</button>
        </div>
      {:else if field.kind === 'date' && (text(field.key) === '' || toDateInput(text(field.key)) !== null)}
        <input class="w-input" {id} type="date" value={toDateInput(text(field.key)) ?? ''} onchange={(e) => setDate(field, e.currentTarget.value)} />
      {:else}
        <BoundInput
          {id}
          multiline={field.kind === 'text'}
          wrap={field.kind === 'string'}
          type={field.kind === 'url' ? 'url' : 'text'}
          inputmode={field.kind === 'url' ? 'url' : undefined}
          autocapitalize={field.kind === 'string' || field.kind === 'text' ? 'sentences' : 'none'}
          autocomplete="off"
          spellcheck={field.kind === 'string' || field.kind === 'text'}
          class={field.kind === 'slug' || field.kind === 'image' || field.kind === 'datetime' || field.kind === 'date' ? 'w-input is-mono' : 'w-input'}
          placeholder={field.placeholder}
          aria-invalid={problem ? 'true' : undefined}
          aria-describedby={describedBy}
          value={text(field.key)}
          onInput={(value) => setText(field, value)}
        />
      {/if}
    {/if}

    {#if problem}
      <p class="note bad" id="{id}-note">{problem}</p>
    {:else if field.hint}
      <p class="note" id="{id}-note">{field.hint}</p>
    {/if}
    {#if field.kind === 'datetime' && text(field.key) !== ''}
      <p class="note">Picked in your time zone. In the file: <code>{text(field.key)}</code></p>
    {:else if field.kind === 'yaml'}
      <p class="note">Structured value. Edit it in the file for now; it is left exactly as written.</p>
    {:else if field.key === 'slug' && isNew}
      {#if pathTaken}
        <p class="note bad" role="alert" data-path-taken>There is already a post at <code>{path}</code>. Change the slug.</p>
      {:else}
        <p class="note">Will be saved as <code>{path}</code></p>
      {/if}
    {/if}
    {#if field.key === 'link_url' && meta.status !== 'idle'}
      <p class="note" class:bad={meta.status === 'failed'} class:good={meta.status === 'filled'} role="status" data-meta-status={meta.status}>{meta.note}</p>
    {/if}
  </div>
{/snippet}

{#if parsed.issues.length}
  <div class="problem" role="alert">
    <strong>The frontmatter is not valid YAML, so it is shown as text.</strong>
    <span>{parsed.issues[0].message}</span>
    <span>Fix it in the file; nothing here will change it.</span>
  </div>
  <pre class="raw">{parts.frontmatter}</pre>
{:else}
  {#if problem}
    <div class="problem" role="alert" data-patch-problem>
      <strong>That change was not made.</strong>
      <span>{problem}</span>
      <span>The file is left exactly as written; edit this value in the file itself.</span>
    </div>
  {/if}
  {#if issues.length}
    <div class="problem" role="status" data-issues={issues.length}>
      <strong>{issues.length === 1 ? 'One thing to fix before publishing' : `${issues.length} things to fix before publishing`}</strong>
      <ul>
        {#each issues as issue, i (i)}<li>{issue.message}</li>{/each}
      </ul>
    </div>
  {/if}

  <form class="fields" onsubmit={(e) => e.preventDefault()}>
    {#each main as field (field.key)}{@render control(field)}{/each}

    {#if advanced.length}
      <details class="more" open={advancedInUse}>
        <summary>Rarely needed</summary>
        <div class="fields">
          {#each advanced as field (field.key)}{@render control(field)}{/each}
        </div>
      </details>
    {/if}
  </form>

  {#if unknownKeys.length}
    <p class="note aside">Also in this file, left exactly as written: {unknownKeys.join(', ')}.</p>
  {/if}

  <details class="more">
    <summary>Frontmatter as text</summary>
    <pre class="raw" data-frontmatter-text>{parts.frontmatter || '(none)'}</pre>
    {#if !isNew}<p class="note"><code>{path}</code></p>{/if}
  </details>
{/if}

<style>
  .fields {
    display: grid;
    gap: var(--w-space-5);
  }
  .field {
    display: grid;
    gap: var(--w-space-1);
    min-width: 0;
  }
  label,
  .switch .label {
    display: flex;
    align-items: baseline;
    gap: var(--w-space-2);
    color: var(--w-ink);
    font-size: var(--w-text-sm);
    font-weight: var(--w-ui-strong-weight);
    text-transform: var(--wx-case);
  }
  .optional {
    color: var(--w-ink-3);
    font-weight: var(--w-ui-weight);
  }
  .note {
    margin: 0;
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .note.bad {
    color: var(--w-danger);
  }
  .note.good {
    color: var(--w-ok);
  }
  .note.aside {
    margin-top: var(--w-space-5);
  }
  code {
    font-family: var(--w-font-mono);
    font-size: 0.92em;
  }
  select.w-input {
    appearance: auto;
  }
  .moment {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--w-space-2);
  }
  /* The switch: the whole row is the control. */
  .switch {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--w-space-4);
    width: 100%;
    min-height: var(--w-tap);
    padding: 0;
    border: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
    touch-action: manipulation;
  }
  .track {
    flex: none;
    display: flex;
    align-items: center;
    width: 48px;
    height: 28px;
    padding: 2px;
    border: var(--w-border) solid var(--w-line-strong);
    border-radius: var(--w-radius-pill);
    background: var(--w-surface-2);
    transition: background-color var(--w-dur-2) var(--w-ease);
  }
  .thumb {
    width: 20px;
    height: 20px;
    border-radius: var(--w-radius-pill);
    background: var(--w-ink-2);
    transition: transform var(--w-dur-2) var(--w-ease);
  }
  .switch[aria-checked='true'] .track {
    background: var(--w-accent);
    border-color: var(--wx-btn-primary-line);
  }
  .switch[aria-checked='true'] .thumb {
    background: var(--w-accent-ink);
    transform: translateX(20px);
  }
  .more {
    margin-top: var(--w-space-2);
    border-top: var(--w-border) solid var(--w-line);
  }
  .fields > .more {
    margin-top: 0;
  }
  form + .more,
  .note.aside + .more {
    margin-top: var(--w-space-5);
  }
  summary {
    display: flex;
    align-items: center;
    min-height: var(--w-tap);
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
    font-weight: var(--w-ui-strong-weight);
    text-transform: var(--wx-case);
    cursor: pointer;
  }
  .more[open] > summary {
    margin-bottom: var(--w-space-2);
  }
  .raw {
    margin: 0;
    padding: var(--w-space-3);
    overflow: auto;
    border: var(--w-border) solid var(--w-line);
    border-radius: var(--w-radius-sm);
    background: var(--w-surface-2);
    color: var(--w-ink-2);
    font-family: var(--w-font-mono);
    font-size: var(--w-text-sm);
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .problem {
    display: grid;
    gap: var(--w-space-1);
    margin-bottom: var(--w-space-5);
    padding: var(--w-space-3) var(--w-space-4);
    border-left: 3px solid var(--w-danger);
    border-radius: var(--w-radius-xs);
    background: var(--w-del-bg);
    color: var(--w-del-ink);
    font-size: var(--w-text-sm);
  }
  .problem ul {
    margin: 0;
    padding-left: 1.2em;
  }
</style>
