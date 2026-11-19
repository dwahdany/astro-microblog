<!--
  Editor harness: Editor.svelte on its own, with the real theme tokens, a
  throwaway toolbar and every post under src/content. Not part of the app.

  For tests and poking from the console it exposes `window.__write`:
    handle            the EditorHandle
    load(text, key?)  open a document (resets state, like the app's docKey)
    loaded            the text last loaded
    changes           every onChange call: { doc, userEvent }
    selection         the latest EditorSelectionState
    files             repo paths of all content files;  read(path) → text
    opened            URLs passed to onOpenLink
    notes             every onNoteChange call (the note panel's state, or null)
    notices           every onNotice message
    box               the element the editor fills; shrink it to stand in for an on-screen keyboard
-->
<script module lang="ts">
  declare const __REPO_ROOT__: string;
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import type { EditorCommandId, EditorHandle, EditorNoteState, EditorSelectionState, ThemeId } from '../../../src/write/contracts';
  import Editor from '../../../src/write/editor/Editor.svelte';
  import sample from './sample.md?raw';

  const modules = import.meta.glob<string>('../../../src/content/**/*.md', { query: '?raw', import: 'default' });
  const files = Object.keys(modules)
    .map((key) => ({ key, path: key.replace(/^(\.\.\/)+/, '') }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const read = async (path: string) => {
    const hit = files.find((f) => f.path === path);
    if (!hit) throw new Error(`No such file: ${path}`);
    return modules[hit.key]();
  };
  /** The body the app would hand the editor: everything after the frontmatter and the blank lines below it. */
  const bodyOf = (raw: string) => raw.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)(?:[ \t]*\r?\n)*/, '');

  const looks = [
    { id: 'galley', theme: 'galley', scheme: 'light', label: 'Galley' },
    { id: 'galley-dark', theme: 'galley', scheme: 'dark', label: 'Galley dark' },
    { id: 'console', theme: 'console', scheme: 'dark', label: 'Console' },
    { id: 'riso', theme: 'riso', scheme: 'light', label: 'Riso' },
    { id: 'riso-dark', theme: 'riso', scheme: 'dark', label: 'Riso dark' },
  ] as const;

  const params = new URLSearchParams(location.search);
  let look = $state<(typeof looks)[number]['id']>((params.get('look') as (typeof looks)[number]['id']) ?? 'galley');
  let current = $state(params.get('file') ?? 'sample');
  const initial = params.has('empty') ? '' : sample;
  let doc = $state(initial);
  let docKey = $state('sample');
  let postPath = $state('tests/write/editor-harness/sample.md');
  let readOnly = $state(params.has('readonly'));
  /** `?sel=12` or `?sel=12-20`: restore a caret/selection on mount, as the app does after a reload. */
  const sel = /^(\d+)(?:-(\d+))?$/.exec(params.get('sel') ?? '');
  const initialSelection = sel ? { anchor: Number(sel[1]), head: Number(sel[2] ?? sel[1]) } : undefined;
  let showSource = $state(false);
  let live = $state(initial);
  let handle = $state<EditorHandle>();
  let selection = $state<EditorSelectionState>();
  let loaded = initial;
  let serial = 0;

  const theme = $derived(looks.find((l) => l.id === look)!.theme as ThemeId);
  const identical = $derived(live === doc);

  const changes: { doc: string; userEvent: boolean }[] = [];
  const opened: string[] = [];
  const notes: (EditorNoteState | null)[] = [];
  const notices: string[] = [];
  let surface = $state<HTMLDivElement>();

  function load(text: string, key?: string, path = 'tests/write/editor-harness/sample.md') {
    loaded = text;
    doc = text;
    live = text;
    postPath = path;
    changes.length = 0;
    docKey = key ?? `doc-${++serial}`;
  }

  async function pick(value: string) {
    current = value;
    if (value === 'sample') load(sample, 'sample');
    else if (value === 'empty') load('', 'empty');
    else load(bodyOf(await read(value)), value, value);
  }

  function resolveAsset(src: string): string | null {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) return src;
    if (src.startsWith('/')) return src;
    const dir = postPath.slice(0, postPath.lastIndexOf('/'));
    const parts: string[] = [];
    for (const part of `${dir}/${src}`.split('/')) {
      if (part === '..') {
        if (!parts.length) return null;
        parts.pop();
      } else if (part !== '.' && part !== '') parts.push(part);
    }
    return `/@fs${__REPO_ROOT__}/${parts.join('/')}`;
  }

  $effect(() => {
    const l = looks.find((x) => x.id === look)!;
    document.documentElement.dataset.writeTheme = l.theme;
    document.documentElement.dataset.writeScheme = l.scheme;
  });

  const commands: { id: EditorCommandId; label: string; active?: (s: EditorSelectionState) => boolean }[] = [
    { id: 'footnote', label: 'Footnote' },
    { id: 'bold', label: 'B', active: (s) => s.bold },
    { id: 'italic', label: 'I', active: (s) => s.italic },
    { id: 'strike', label: 'S', active: (s) => s.strike },
    { id: 'code', label: '</>', active: (s) => s.code },
    { id: 'link', label: 'Link', active: (s) => s.link },
    { id: 'heading', label: 'H', active: (s) => s.heading > 0 },
    { id: 'bulletList', label: '• List', active: (s) => s.list === 'bullet' },
    { id: 'orderedList', label: '1. List', active: (s) => s.list === 'ordered' },
    { id: 'taskList', label: '☐ Task', active: (s) => s.list === 'task' },
    { id: 'quote', label: 'Quote', active: (s) => s.quote },
    { id: 'codeBlock', label: 'Code', active: (s) => s.codeBlock },
    { id: 'math', label: '$' },
    { id: 'mathBlock', label: '$$' },
    { id: 'image', label: 'Image' },
    { id: 'rule', label: '—' },
    { id: 'outdent', label: '⇤' },
    { id: 'indent', label: '⇥' },
    { id: 'undo', label: 'Undo' },
    { id: 'redo', label: 'Redo' },
  ];
  const run = (id: EditorCommandId) => (handle?.exec as ((id: EditorCommandId) => boolean) | undefined)?.(id);
  const keepFocus = (event: Event) => event.preventDefault();

  onMount(() => {
    const root = document.documentElement;
    const vv = window.visualViewport;
    const size = () => root.style.setProperty('--w-vv-height', `${vv ? vv.height : window.innerHeight}px`);
    size();
    vv?.addEventListener('resize', size);
    window.addEventListener('resize', size);
    Object.assign(window, {
      __write: {
        get handle() {
          return handle;
        },
        get loaded() {
          return loaded;
        },
        get selection() {
          return selection;
        },
        load,
        changes,
        opened,
        notes,
        notices,
        get box() {
          return surface;
        },
        files: files.map((f) => f.path),
        read,
        bodyOf,
      },
    });
    const file = params.get('file');
    if (file && file !== 'sample') void pick(file);
    return () => {
      vv?.removeEventListener('resize', size);
      window.removeEventListener('resize', size);
    };
  });
</script>

<div class="harness">
  <header>
    <select aria-label="Document" value={current} onchange={(e) => pick(e.currentTarget.value)} data-harness-file>
      <option value="sample">Kitchen sink</option>
      <option value="empty">Empty</option>
      {#each files as file (file.path)}
        <option value={file.path}>{file.path.replace('src/content/', '')}</option>
      {/each}
    </select>
    <select aria-label="Theme" bind:value={look} data-harness-look>
      {#each looks as l (l.id)}<option value={l.id}>{l.label}</option>{/each}
    </select>
    <label><input type="checkbox" bind:checked={readOnly} /> read-only</label>
    <label><input type="checkbox" bind:checked={showSource} /> source</label>
    <span class="state" data-harness-identical={identical}>{identical ? 'identical' : 'edited'}</span>
  </header>

  <main>
    <div class="surface" bind:this={surface} data-harness-surface>
      <Editor
        {doc}
        {docKey}
        onChange={(text, info) => {
          live = text;
          changes.push({ doc: text, userEvent: info.userEvent });
        }}
        onReady={(h) => (handle = h)}
        onSelectionChange={(s) => (selection = s)}
        onNoteChange={(n) => notes.push(n)}
        onNotice={(m) => notices.push(m)}
        {resolveAsset}
        {theme}
        {readOnly}
        placeholder="Start writing"
        {initialSelection}
        insets={{ top: 8, bottom: 24 }}
        onOpenLink={(url) => opened.push(url)}
      />
    </div>
    {#if showSource}
      <pre class="source" data-harness-source>{live}</pre>
    {/if}
  </main>

  <div class="toolbar" role="toolbar" aria-label="Formatting">
    {#each commands as c (c.id)}
      <button
        type="button"
        data-command={c.id}
        aria-pressed={c.active && selection ? c.active(selection) : undefined}
        disabled={!handle}
        onpointerdown={keepFocus}
        onmousedown={keepFocus}
        onclick={() => run(c.id)}>{c.label}</button
      >
    {/each}
  </div>
</div>

<style>
  .harness {
    display: flex;
    flex-direction: column;
    height: var(--w-vv-height, 100dvh);
    background: var(--w-bg);
    color: var(--w-ink);
    font-family: var(--w-font-ui);
  }
  header {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--w-space-2);
    padding: var(--w-space-2) var(--w-space-3);
    border-bottom: var(--w-border) solid var(--w-line);
    font-size: var(--w-text-sm);
  }
  header select {
    max-width: 44vw;
    font: inherit;
    font-size: 16px;
  }
  .state {
    margin-left: auto;
    color: var(--w-ink-3);
  }
  .state[data-harness-identical='true'] {
    color: var(--w-ok);
  }
  main {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .surface {
    flex: 1;
    min-width: 0;
    background: var(--w-surface);
  }
  .source {
    flex: 1;
    min-width: 0;
    margin: 0;
    padding: var(--w-space-4);
    overflow: auto;
    border-left: var(--w-border) solid var(--w-line);
    font-family: var(--w-font-mono);
    font-size: var(--w-text-xs);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .toolbar {
    display: flex;
    flex: none;
    gap: var(--w-space-1);
    padding: var(--w-space-1) var(--w-space-2);
    overflow-x: auto;
    border-top: var(--w-border) solid var(--w-line);
    background: var(--w-surface);
  }
  .toolbar button {
    flex: none;
    min-width: var(--w-tap);
    height: var(--w-tap);
    padding: 0 var(--w-space-2);
    border: var(--w-border) solid var(--w-line);
    border-radius: var(--w-radius-sm);
    background: var(--w-surface);
    color: var(--w-ink);
    font: inherit;
    font-size: var(--w-text-sm);
  }
  .toolbar button[aria-pressed='true'] {
    background: var(--w-accent);
    color: var(--w-accent-ink);
    border-color: var(--w-accent);
  }
</style>
