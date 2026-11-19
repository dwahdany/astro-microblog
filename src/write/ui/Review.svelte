<!--
  "Review changes": what differs from the original, line by line with the
  changed words marked — and the ways out: Publish (a commit to the repo, when
  signed in), Copy markdown and Download .md (always).

  The writing screen owns the save itself (`onPublish` / `onDelete`: what is
  sent, and what becomes of the draft, the base and the route afterwards). This
  sheet shows what will happen and how it went:
    - the diff, the images that go with it (size before and after), the file
      move when the slug changed, and the commit message (editable)
    - what blocks publishing (`blockers`: frontmatter problems, a taken path) and,
      said ONCE and above the diff, an unresolved conflict: what happened, that
      nothing was published, and the way out — the footer then holds only the
      buttons, so the diff stays in view on a phone
    - progress, success with a link to the commit, and every way it can fail,
      each with the next step
    - "Delete this post", behind an explicit confirmation
  Signed out, Publish is "Sign in to publish"; with the working-tree source
  (dev) there is nothing to publish to, and the sheet says so.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Check from '@lucide/svelte/icons/check';
  import Copy from '@lucide/svelte/icons/copy';
  import Download from '@lucide/svelte/icons/download';
  import Upload from '@lucide/svelte/icons/upload';
  import type { CollectionKind } from '../contracts';
  import { commitMessage, onSaveProgress } from '../data';
  import Sheet from './Sheet.svelte';
  import { diffPost } from './lib/diff';
  import { copyText, downloadText } from './lib/io';
  import { explainSaveFailure, type PublishOptions, type SaveProblem } from './lib/publish';
  import { formatBytes } from './lib/text';
  import type { Published } from './memory.svelte';

  /** An image waiting to be committed with the post, as the sheet lists it. */
  export interface ReviewImage {
    name: string;
    size: number;
    originalSize?: number;
    width?: number;
    height?: number;
    /** False: the original file is kept, metadata (location, camera) included. */
    stripped: boolean;
    url: string | null;
  }

  let {
    path,
    baseRaw,
    raw,
    isNew,
    collection = 'notes',
    creating,
    canSave,
    canSignIn = false,
    blockers,
    conflict = false,
    keepFailed,
    images = [],
    moveTo = null,
    committedImages = 0,
    removable = false,
    published = null,
    carried = null,
    onPublish,
    onDelete,
    onSignIn,
    onKeepMine,
    onDiscard,
    onClose,
  }: {
    path: string;
    /** The original file; null for a post that is not in the repo yet. */
    baseRaw: string | null;
    raw: string;
    isNew: boolean;
    collection?: CollectionKind;
    /** The commit will create the file (a new post, or one that is gone from the repo). */
    creating?: boolean;
    /** The source can save: offer Publish. */
    canSave: boolean;
    /** Nobody is signed in, and signing in would make publishing possible: offer that. */
    canSignIn?: boolean;
    /**
     * Why this post must not be published as it is (ui/lib/publish.ts), WITHOUT the unresolved
     * conflict — that is `conflict`, which blocks by itself and is said in a message of its own.
     * Empty: nothing else in the way.
     */
    blockers: readonly string[];
    /** The kept text conflicts with the source as it is now (the diff below is against that). Blocks publishing. */
    conflict?: boolean;
    /** This device is refusing to store the draft: say so, loudly. */
    keepFailed: boolean;
    /** Images the text refers to that are not in the repo yet: they are committed with the post. */
    images?: readonly ReviewImage[];
    /** The slug of an existing post changed: where its file could move to. Null: nothing to offer. */
    moveTo?: string | null;
    /** How many images the post already has in the repo (they move or go with it). */
    committedImages?: number;
    /** The post is in the repo and may be deleted from here. */
    removable?: boolean;
    /** The last publish from this screen, to say how it went. */
    published?: Published | null;
    /**
     * How the last publish or delete from this screen failed, as the writing screen remembers it:
     * this sheet may have been closed (or rebuilt by a conflict's re-read) while the commit was
     * under way, and still has to say it when it is opened again.
     */
    carried?: SaveProblem | null;
    /** Save the post; resolves with what was published, rejects with the reason it failed. */
    onPublish: (options: PublishOptions) => Promise<Published | string | void>;
    /** Delete the post from the repo (after the confirmation here). */
    onDelete?: (options: PublishOptions) => Promise<unknown>;
    onSignIn?: () => void;
    /** Resolve a conflict in favour of the kept text. */
    onKeepMine?: () => void;
    onDiscard: () => void;
    onClose: () => void;
  } = $props();

  let copied = $state<'idle' | 'done' | 'failed'>('idle');
  let confirming = $state(false);
  let confirmingDelete = $state(false);
  let busy = $state<'publish' | 'delete' | null>(null);
  let progress = $state<{ done: number; total: number } | null>(null);
  let failed = $state<SaveProblem | null>(null);
  const changed = $derived(raw !== baseRaw);
  /** The conflict is unresolved: Publish is off, and one message above the diff says why and what to do. */
  const conflicted = $derived(conflict && changed);
  /**
   * How the last publish or delete failed. A publish refused because the post had changed is not
   * said a second time once that change is on screen as the conflict: the conflict message says it.
   */
  const refused = $derived(failed ?? carried);
  const saidWithConflict = $derived(conflicted && refused?.reason === 'conflict:changed');
  const problem = $derived(saidWithConflict ? null : refused);
  /** The commit message as typed; null while the default stands. */
  let typedMessage = $state<string | null>(null);
  let move = $state(false);

  const diff = $derived(diffPost(baseRaw, raw));
  const moving = $derived(move && moveTo !== null);
  const target = $derived(moving ? (moveTo as string) : path);
  const filename = $derived(path.slice(path.lastIndexOf('/') + 1) || 'post.md');
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /** What the commit is called when nothing is typed: the wording the repo's history already uses. */
  const defaultMessage = $derived(commitMessage((creating ?? isNew) ? 'create' : 'update', collection, target, images.length + (moving ? committedImages : 0)));
  const message = $derived(typedMessage?.trim() ? typedMessage.trim() : defaultMessage);
  const deleteMessage = $derived(commitMessage('delete', collection, path, committedImages));
  const publishable = $derived(changed && blockers.length === 0 && !conflicted && busy === null);

  async function copy() {
    copied = (await copyText(raw)) ? 'done' : 'failed';
    setTimeout(() => (copied = 'idle'), 2400);
  }

  async function run(kind: 'publish' | 'delete', work: () => Promise<unknown>) {
    busy = kind;
    progress = null;
    failed = null;
    try {
      await work();
      typedMessage = null;
      move = false;
      confirmingDelete = false;
    } catch (err) {
      failed = explainSaveFailure(err, kind);
    } finally {
      busy = null;
      progress = null;
    }
  }

  function publish() {
    if (!publishable) return;
    void run('publish', () => onPublish({ message, move: moving }));
  }

  function remove() {
    if (busy !== null || !onDelete) return;
    void run('delete', () => onDelete({ message: deleteMessage }));
  }

  // A save that large images split into several commits reports each one.
  onMount(() => onSaveProgress((done, total) => (progress = { done, total })));
</script>

<Sheet title="Review changes" name="review" size="wide" {onClose}>
  <p class="path" data-review-path>{path}{#if moving}<span class="to"> → {moveTo}</span>{/if}</p>

  {#if published && !changed}
    <div class="done" role="status" data-published>
      <p>
        <strong>Published.</strong>
        {published.commits && published.commits > 1 ? `It took ${published.commits} commits (large images). ` : ''}The site
        rebuilds with it in a minute or two.
      </p>
      {#if published.commitUrl}
        <a href={published.commitUrl} target="_blank" rel="noopener noreferrer" data-commit-link>View the commit</a>
      {/if}
    </div>
  {/if}

  {#if keepFailed}
    <p class="warning" role="alert">
      This browser is not storing your changes (private browsing, or storage is full). Copy the markdown or download the
      file before you close this tab.
    </p>
  {/if}

  {#if conflicted}
    <!-- The one place the conflict is said: what happened, what became of a publish, and the way out. -->
    <div class="warning" role="alert" data-review-conflict data-publish-error={saidWithConflict ? 'conflict:changed' : undefined}>
      <p>
        <strong>This post changed in the source in the same lines you changed.</strong>
        {saidWithConflict ? 'Nothing was published. ' : ''}Below is your version against the post as it is now. Lines you did
        not touch show up as changes because publishing your version would undo them. Keep your version or discard it, then
        publish.
      </p>
      {#if onKeepMine}
        <button type="button" class="w-btn" data-action="keep-mine" onclick={onKeepMine}>Keep my version anyway</button>
      {/if}
    </div>
  {/if}

  {#if !changed}
    <p class="summary" data-review-state="unchanged">
      <strong>No changes.</strong> The text is identical to the original, byte for byte.
    </p>
  {:else}
    <p class="summary" data-review-state="changed">
      {#if isNew}
        <strong>A new post.</strong> {plural(diff.added, 'line')}, none of it published yet.
      {:else}
        <strong class="plus">{plural(diff.added, 'line')} added</strong>, <strong class="minus">{diff.removed} removed</strong>,
        compared with the original.
      {/if}
    </p>
    <div class="diff" data-review-diff>
      {#each diff.hunks as hunk, i (i)}
        <div class="hunk">
          {#if !isNew}<div class="range">From line {hunk.newStart || hunk.oldStart}</div>{/if}
          {#each hunk.lines as line, j (j)}
            <div class="line {line.type}" class:add={line.type === 'add'} class:del={line.type === 'del'}>
              <span class="no" aria-hidden="true">{line.newNo ?? line.oldNo ?? ''}</span>
              <span class="sign" aria-hidden="true">{line.type === 'add' ? '+' : line.type === 'del' ? '−' : line.type === 'edit' ? '±' : ''}</span>
              {#if line.type === 'edit'}
                <!-- One long line edited in place: what went and what came, side by side, the rest shortened. -->
                <span class="text"
                  ><span class="w-sr">{'Changed: '}</span>{#each line.segments as seg, k (k)}{#if seg.side === 'del'}<del><span class="w-sr">{' removed '}</span>{seg.text}</del>{:else if seg.side === 'add'}<ins><span class="w-sr">{' added '}</span>{seg.text}</ins>{:else if seg.elided}<span class="gap">{seg.text}</span>{:else}{seg.text}{/if}{/each}</span
                >
              {:else}
                <span class="text"
                  >{#if line.type === 'add'}<span class="w-sr">{'Added: '}</span>{:else if line.type === 'del'}<span class="w-sr">{'Removed: '}</span>{/if}{#each line.segments as seg, k (k)}{#if seg.changed}<em>{seg.text}</em>{:else}{seg.text}{/if}{/each}{#if line.segments.every((s) => s.text === '')}&nbsp;{/if}</span
                >
              {/if}
            </div>
          {/each}
        </div>
      {/each}
    </div>

    {#if images.length > 0}
      <section class="images" data-review-images aria-label="Images">
        <h3>{plural(images.length, 'image')} {canSave ? 'will be published with it' : 'kept with this draft'}</h3>
        <ul>
          {#each images as image (image.name)}
            <li data-review-image={image.name}>
              {#if image.url}<img src={image.url} alt="" loading="lazy" />{:else}<span class="thumb" aria-hidden="true"></span>{/if}
              <span class="about">
                <span class="name">{image.name}</span>
                <span class="size" data-image-size>
                  {#if image.originalSize !== undefined && image.originalSize !== image.size}{formatBytes(image.originalSize)} → {/if}{formatBytes(image.size)}{#if image.width && image.height}, {image.width} × {image.height}{/if}
                </span>
                {#if !image.stripped}
                  <span class="w-flag" data-image-original>Original file: location and camera data go with it</span>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    {#if canSave && moveTo !== null}
      <label class="move">
        <input type="checkbox" bind:checked={move} disabled={busy !== null} data-move-file />
        <span>
          The slug changed. Also move the file to <code>{moveTo}</code>{committedImages > 0 ? `, with its ${plural(committedImages, 'image')}` : ''}.
          Links to the old address stop working.
        </span>
      </label>
    {/if}

    <div class="discard">
      {#if confirming}
        <p>{isNew ? 'Delete this draft from this device? It exists nowhere else.' : 'Throw away every change and go back to the original?'}</p>
        <div class="pair">
          <button type="button" class="w-btn is-danger" data-action="discard-confirm" onclick={onDiscard}>
            {isNew ? 'Delete draft' : 'Discard changes'}
          </button>
          <button type="button" class="w-btn is-quiet" onclick={() => (confirming = false)}>Keep {isNew ? 'draft' : 'changes'}</button>
        </div>
      {:else}
        <button type="button" class="w-btn is-quiet is-danger" data-action="discard" disabled={busy !== null} onclick={() => (confirming = true)}>
          {isNew ? 'Delete this draft' : 'Discard changes'}
        </button>
      {/if}
    </div>
  {/if}

  {#if canSave && removable && onDelete}
    <div class="discard" data-delete-post>
      {#if confirmingDelete}
        <p>
          Delete <code>{path}</code> from the repository? This is a commit: the post leaves the site with the next build{committedImages > 0
            ? `, and its ${plural(committedImages, 'image')} ${committedImages === 1 ? 'goes' : 'go'} with it`
            : ''}.{changed ? ' Your unpublished changes are thrown away too.' : ''}
        </p>
        <p class="commit">Commit: {deleteMessage}</p>
        <div class="pair">
          <button type="button" class="w-btn is-danger" data-action="delete-post-confirm" disabled={busy !== null} onclick={remove}>
            {busy === 'delete' ? 'Deleting' : 'Delete the post'}
          </button>
          <button type="button" class="w-btn is-quiet" disabled={busy !== null} onclick={() => (confirmingDelete = false)}>Keep the post</button>
        </div>
      {:else}
        <button type="button" class="w-btn is-quiet is-danger" data-action="delete-post" disabled={busy !== null} onclick={() => (confirmingDelete = true)}>
          Delete this post
        </button>
      {/if}
    </div>
  {/if}

  {#snippet footer()}
    {#if problem}
      <div class="warning" role="alert" data-publish-error={problem.reason}>
        <p>{problem.message}</p>
        <!-- Signed out, the main button below is already "Sign in to publish": one way in is enough. -->
        {#if problem.signIn && onSignIn && !(canSignIn && !canSave)}
          <button type="button" class="w-btn" data-action="sign-in-again" onclick={onSignIn}>Sign in again</button>
        {/if}
      </div>
    {/if}
    {#if canSave && changed && blockers.length > 0}
      <ul class="blockers" data-publish-blockers>
        {#each blockers as blocker, i (i)}<li>{blocker}</li>{/each}
      </ul>
    {/if}
    {#if canSave}
      {#if changed && !conflicted}
        <label class="message" for="review-commit-message">Commit message</label>
        <input
          id="review-commit-message"
          class="w-input"
          type="text"
          autocomplete="off"
          autocapitalize="sentences"
          enterkeyhint="done"
          placeholder={defaultMessage}
          value={typedMessage ?? defaultMessage}
          disabled={busy !== null}
          data-commit-message
          oninput={(e) => (typedMessage = e.currentTarget.value)}
          onblur={() => typedMessage !== null && typedMessage.trim() === '' && (typedMessage = null)}
        />
      {/if}
      <button type="button" class="w-btn is-primary is-block main" data-action="publish" disabled={!publishable} onclick={publish}>
        <Upload size={18} aria-hidden="true" />
        {#if busy === 'publish'}
          {progress && progress.total > 1 ? `Publishing, part ${Math.min(progress.done + 1, progress.total)} of ${progress.total}` : 'Publishing'}
        {:else}
          Publish
        {/if}
      </button>
    {:else if canSignIn && onSignIn}
      <button type="button" class="w-btn is-primary is-block main" data-action="sign-in-to-publish" onclick={onSignIn}>Sign in to publish</button>
    {/if}
    <div class="out">
      <button type="button" class="w-btn" class:is-primary={!canSave && !canSignIn} data-action="copy" onclick={copy}>
        {#if copied === 'done'}<Check size={18} aria-hidden="true" />Copied{:else}<Copy size={18} aria-hidden="true" />Copy markdown{/if}
      </button>
      <button type="button" class="w-btn" data-action="download" onclick={() => downloadText(filename, raw)}>
        <Download size={18} aria-hidden="true" />Download .md
      </button>
    </div>
    <p class="fine" role="status" data-publish-status={busy ?? ''}>
      {#if copied === 'failed'}
        Copying is blocked in this browser. Download the file instead.
      {:else if busy === 'publish'}
        Sending the commit to GitHub. Keep this open.
      {:else if canSave}
        {#if conflicted}Publish is off until the conflict above is settled.{:else if changed}Publishing is one commit to the repository, as <code>{target}</code>.{/if}
      {:else if canSignIn}
        {#if !problem?.signIn}Sign in to publish from here. Until then, copy or download the file; your changes stay on this device.{/if}
      {:else}
        Publishing from here is not turned on yet. Copy or download the file and commit it as <code>{path}</code>.
      {/if}
    </p>
  {/snippet}
</Sheet>

<style>
  .path {
    margin: 0 0 var(--w-space-3);
    color: var(--w-ink-2);
    font-family: var(--w-font-mono);
    font-size: var(--w-text-sm);
    overflow-wrap: anywhere;
  }
  .summary {
    margin: 0 0 var(--w-space-3);
    color: var(--w-ink-2);
    font-size: var(--w-text-md);
  }
  .summary strong {
    color: var(--w-ink);
    font-weight: var(--w-ui-strong-weight);
  }
  .summary .plus {
    color: var(--w-ok);
  }
  .summary .minus {
    color: var(--w-danger);
  }
  .warning {
    margin: 0 0 var(--w-space-4);
    padding: var(--w-space-3) var(--w-space-4);
    border-left: 3px solid var(--w-danger);
    border-radius: var(--w-radius-xs);
    background: var(--w-del-bg);
    color: var(--w-del-ink);
    font-size: var(--w-text-sm);
  }
  .diff {
    border: var(--w-border) solid var(--w-line);
    border-radius: var(--w-radius-sm);
    overflow: hidden;
    background: var(--w-surface);
    font-family: var(--w-font-mono);
    font-size: var(--w-text-sm);
    line-height: 1.55;
  }
  .hunk + .hunk {
    border-top: var(--w-border) solid var(--w-line);
  }
  .range {
    padding: var(--w-space-1) var(--w-space-3);
    background: var(--w-surface-2);
    color: var(--w-ink-2);
    font-family: var(--w-font-ui);
    font-size: var(--w-text-xs);
    text-transform: var(--wx-case);
  }
  .line {
    display: grid;
    grid-template-columns: 1.4em minmax(0, 1fr);
    padding: 0 var(--w-space-2) 0 var(--w-space-1);
    color: var(--w-ink-2);
  }
  .no {
    display: none;
    padding-right: var(--w-space-2);
    color: var(--w-ink-3);
    text-align: right;
    font-variant-numeric: tabular-nums;
    user-select: none;
    -webkit-user-select: none;
  }
  .sign {
    text-align: center;
    user-select: none;
    -webkit-user-select: none;
  }
  .text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .line.add {
    background: var(--w-add-bg);
    color: var(--w-add-ink);
  }
  .line.del {
    background: var(--w-del-bg);
    color: var(--w-del-ink);
  }
  .line.note {
    color: var(--w-ink-3);
    font-family: var(--w-font-ui);
    font-style: italic;
  }
  .warning p {
    margin: 0;
  }
  .warning .w-btn {
    margin-top: var(--w-space-3);
  }
  .blockers {
    margin: 0 0 var(--w-space-3);
    padding-left: 1.2em;
    color: var(--w-danger);
    font-size: var(--w-text-sm);
    line-height: 1.4;
  }
  /* One long line edited in place. */
  .line.edit {
    color: var(--w-ink-2);
  }
  .line.edit del {
    background: var(--w-del-bg);
    color: var(--w-del-ink);
    border-radius: var(--w-radius-xs);
    text-decoration: line-through;
  }
  .line.edit ins {
    background: var(--w-add-bg);
    color: var(--w-add-ink);
    border-radius: var(--w-radius-xs);
    text-decoration: none;
    font-weight: 700;
  }
  .line.edit .gap {
    color: var(--w-ink-3);
    user-select: none;
    -webkit-user-select: none;
  }
  /* The words that changed inside an edited line. */
  .text em {
    font-style: normal;
    font-weight: 700;
    border-radius: var(--w-radius-xs);
    box-shadow: inset 0 -0.5em 0 color-mix(in srgb, currentColor 22%, transparent);
  }
  .line.del .text em {
    text-decoration: line-through;
  }
  .discard + .discard {
    margin-top: var(--w-space-2);
  }
  .discard {
    margin-top: var(--w-space-5);
    font-size: var(--w-text-sm);
  }
  .discard p {
    margin: 0 0 var(--w-space-3);
    color: var(--w-ink);
  }
  .discard > .w-btn {
    margin-left: calc(-1 * var(--w-space-4));
  }
  .pair {
    display: flex;
    flex-wrap: wrap;
    gap: var(--w-space-2);
  }
  .out {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(0, 1fr));
    gap: var(--w-space-2);
  }
  .out .w-btn {
    padding: 0 var(--w-space-2);
  }
  .fine {
    margin: var(--w-space-2) 0 0;
    min-height: 1.4em;
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .fine code {
    font-family: var(--w-font-mono);
    font-size: 0.92em;
  }
  @media (min-width: 640px) {
    .line {
      grid-template-columns: 3.5em 1.4em minmax(0, 1fr);
    }
    .no {
      display: block;
    }
  }
  .path .to {
    color: var(--w-accent-text);
  }
  .done {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--w-space-2) var(--w-space-4);
    margin: 0 0 var(--w-space-4);
    padding: var(--w-space-3) var(--w-space-4);
    border-left: 3px solid var(--w-ok);
    border-radius: var(--w-radius-xs);
    background: var(--w-add-bg);
    color: var(--w-add-ink);
    font-size: var(--w-text-sm);
    line-height: 1.45;
  }
  .done p {
    margin: 0;
  }
  .done a {
    display: inline-flex;
    align-items: center;
    min-height: var(--w-tap);
    color: inherit;
    font-weight: var(--w-ui-strong-weight);
    text-underline-offset: 3px;
    white-space: nowrap;
  }
  .images {
    margin-top: var(--w-space-4);
  }
  .images h3 {
    margin: 0 0 var(--w-space-2);
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
    font-weight: var(--w-ui-strong-weight);
    text-transform: var(--wx-case);
  }
  .images ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--w-space-2);
  }
  .images li {
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr);
    align-items: center;
    gap: var(--w-space-3);
    padding: var(--w-space-2);
    border: var(--w-border) solid var(--w-line);
    border-radius: var(--w-radius-sm);
    background: var(--w-surface);
  }
  .images img,
  .images .thumb {
    width: 56px;
    height: 56px;
    border-radius: var(--w-radius-xs);
    background: var(--w-surface-2);
    object-fit: cover;
  }
  .images .about {
    display: grid;
    justify-items: start;
    gap: 2px;
    min-width: 0;
    font-size: var(--w-text-sm);
  }
  .images .name {
    font-family: var(--w-font-mono);
    overflow-wrap: anywhere;
  }
  .images .size {
    color: var(--w-ink-2);
    font-variant-numeric: tabular-nums;
  }
  .images .w-flag {
    white-space: normal;
  }
  .move {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: var(--w-space-3);
    margin-top: var(--w-space-4);
    padding: var(--w-space-3);
    border: var(--w-border) solid var(--w-line);
    border-radius: var(--w-radius-sm);
    color: var(--w-ink-2);
    font-size: var(--w-text-sm);
    line-height: 1.45;
    cursor: pointer;
  }
  .move input {
    width: 20px;
    height: 20px;
    margin: 1px 0 0;
    accent-color: var(--w-accent);
  }
  .move code,
  .discard code {
    font-family: var(--w-font-mono);
    font-size: 0.92em;
    overflow-wrap: anywhere;
  }
  .discard .commit {
    color: var(--w-ink-2);
    font-family: var(--w-font-mono);
    font-size: var(--w-text-xs);
    overflow-wrap: anywhere;
  }
  .message {
    display: block;
    margin: 0 0 var(--w-space-1);
    color: var(--w-ink-2);
    font-size: var(--w-text-xs);
    font-weight: var(--w-ui-strong-weight);
    text-transform: var(--wx-case);
  }
  .main {
    margin: var(--w-space-2) 0;
  }
</style>
