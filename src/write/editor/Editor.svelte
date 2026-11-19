<!--
  The writing surface: a CodeMirror 6 live-preview markdown editor.

  THE DOCUMENT TEXT IS THE ONLY STATE THAT MATTERS. Everything the reader sees
  rendered — headings, emphasis, links, lists, images, math, footnote chips —
  is decoration over the exact text (./livePreview.ts); nothing here ever
  rewrites what the user did not edit. The document changes only through
  typing, a toolbar command (./commands.ts), or the note panel, which edits a
  footnote definition's own characters (./footnotes.ts).

  Contract: EditorProps / EditorHandle in ../contracts.ts. The component is
  uncontrolled — `doc` is read on mount and when `docKey` changes.

  Files:  markdown.ts     parser (GFM + footnotes + math)
          livePreview.ts  decorations      widgets.ts   what they draw
          commands.ts     toolbar commands footnotes.ts footnote model
          interaction.ts  focus + links    theme.ts     token-only styling
          NotePanel.svelte the footnote editor
          images.ts       image model      ImagePanel.svelte size / alt text / remove
-->
<script lang="ts">
  import { flushSync, onMount, untrack } from 'svelte';
  import { Annotation, Compartment, EditorSelection, EditorState, Prec, type TransactionSpec } from '@codemirror/state';
  import { EditorView, drawSelection, keymap, placeholder as placeholderExt, type ViewUpdate } from '@codemirror/view';
  import { defaultKeymap, history, historyKeymap, indentLess, indentMore, isolateHistory, redo, undo } from '@codemirror/commands';
  import { syntaxTree } from '@codemirror/language';
  import { languages } from '@codemirror/language-data';
  import { NOTE_COMMANDS, type EditorCommandId, type EditorHandle, type EditorProps } from '../contracts';
  import { enclosing, exitEmptyListItem, pureCommands, selectionState, type CommandResult } from './commands';
  import {
    appendDefinitionSafely,
    deleteFootnote,
    docToNote,
    footnoteIndex,
    footnoteInsertPos,
    footnoteKey,
    getFootnotes,
    hasDefinitionLine,
    insertFootnote,
    mapNoteEdit,
    noteModel,
    noteToDoc,
    renameFootnote,
    type NoteView,
  } from './footnotes';
  import ImagePanel from './ImagePanel.svelte';
  import { imageAt, imagesOnLine, imageView, removeImage, setImageAlt, setImageSize, type ImageSize, type ImageView } from './images';
  import { interaction, linkOpener, syncFocus } from './interaction';
  import { onKatexReady } from './katex';
  import { docText, lineBreaks, lineBreaksOf } from './lineBreaks';
  import { editorFocused, livePreview, livePreviewConfig, refreshPreview, setActiveFootnote, type LivePreviewConfig } from './livePreview';
  import { isMarkdownAt, writeMarkdown } from './markdown';
  import { markdownKeymap } from './markdownKeys';
  import NotePanel from './NotePanel.svelte';
  import { editorTheme } from './theme';
  import type { FootnoteTap } from './widgets';

  let {
    doc,
    docKey,
    onChange,
    onReady,
    onSelectionChange,
    resolveAsset,
    theme,
    lineSeparator,
    readOnly = false,
    placeholder = '',
    initialSelection,
    initialScrollTop,
    insets,
    onOpenLink,
    onNoteChange,
    onNotice,
  }: EditorProps = $props();

  let root: HTMLDivElement;
  let host: HTMLDivElement;
  let view: EditorView | undefined;
  let panel = $state<ReturnType<typeof NotePanel>>();
  let imagePanel = $state<ReturnType<typeof ImagePanel>>();

  const editable = new Compartment();
  const assets = new Compartment();
  /** Marks transactions made by `setDoc` so `onChange` can report `userEvent: false`. */
  const programmatic = Annotation.define<boolean>();

  /* ------------------------------------------------------------------------ *
   * The note panel
   * ------------------------------------------------------------------------ */

  /** The footnote open in the panel. `pos` follows the reference/definition it was opened from. */
  let open = $state<{ label: string; key: string; pos: number; from: 'ref' | 'def' } | null>(null);
  let note = $state<NoteView | null>(null);
  let noteError = $state<string | null>(null);
  /**
   * How the panel is shown: docked along the bottom (phone), floating beside the reference (room
   * to spare), or covering the whole writing surface (so short that nothing else fits: a phone on
   * its side with the keyboard up).
   */
  let panelMode = $state<'docked' | 'floating' | 'cover'>('docked');
  /** The note's text field has the keyboard. */
  let noteEditing = $state(false);
  /** Height the docked panel covers at the bottom of the scroller. */
  let dockInset = 0;

  const coarsePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const trailingBreaks = (text: string) => /\n*$/.exec(text)![0].length;

  /**
   * The definition being shown and its display model. `shown` is the panel text the model must line
   * up with: line breaks typed at the end of a note are not part of the parsed definition until text
   * follows them, so that many blank lines below it are counted as (empty) lines of the note.
   */
  function currentNote(state: EditorState, key: string, shown: string) {
    const entry = getFootnotes(state).byKey.get(key);
    const def = entry?.defs[0];
    if (!def) return { entry, def: undefined, model: undefined };
    const plain = noteModel(state, def);
    const pending = Math.max(0, trailingBreaks(shown) - trailingBreaks(plain.text));
    return { entry, def, model: pending ? noteModel(state, def, pending) : plain };
  }

  function refreshNote(state: EditorState) {
    if (!open) return;
    const { entry, def, model } = currentNote(state, open.key, panel?.getValue() ?? '');
    if (!entry) {
      closeNote({ refocus: false });
      return;
    }
    const label = def?.label ?? entry.refs[0]?.label ?? open.label;
    if (label !== open.label) open.label = label;
    const next: NoteView = { label, text: model?.text ?? '', refs: entry.refs.length, hasDef: !!def };
    if (!note || note.label !== next.label || note.text !== next.text || note.refs !== next.refs || note.hasDef !== next.hasDef) note = next;
  }

  function openNote(tap: FootnoteTap, opts: { focus: boolean }) {
    const v = view;
    if (!v) return;
    const key = footnoteKey(tap.label);
    closeImage({ refocus: false });
    open = { label: tap.label, key, pos: tap.pos, from: tap.kind };
    noteError = null;
    refreshNote(v.state);
    if (!open) return;
    v.dispatch({ effects: setActiveFootnote.of(key) });
    // The panel must exist in the DOM before it can take focus within this same tap.
    flushSync();
    if (opts.focus) panel?.focusText('end');
    placePanel(true);
  }

  function closeNote(opts: { refocus: boolean }) {
    if (!open) return;
    const was = open;
    open = null;
    note = null;
    noteError = null;
    dockInset = 0;
    panelMode = 'docked';
    const v = view;
    if (!v) return;
    v.dispatch({ effects: setActiveFootnote.of(null) });
    if (opts.refocus) {
      // Back to the text, with the caret just after the reference the note belongs to.
      const entry = getFootnotes(v.state).byKey.get(was.key);
      const ref = entry?.refs.find((r) => r.from === was.pos) ?? (was.from === 'ref' ? entry?.refs[0] : undefined);
      if (ref) v.dispatch({ selection: EditorSelection.cursor(ref.to) });
      v.focus();
      // This focus is ours, not a tap whose caret is still on its way: do not let the focus tracker
      // hold it back. Held back, a chip tapped right after "Done" would count as a tap while reading,
      // and the note it opens would be put away again when the late focus finally registers.
      syncFocus(v);
    }
  }

  /** Below this height of writing surface the panel takes all of it: header, one line of text and nothing else would fit. */
  const COVER_BELOW = 250;
  /**
   * …and it stays that way until the surface is clearly taller again. While the panel covers, the
   * shell may fold its header away (EditorNoteState.cover), which makes the surface taller: without
   * this margin the two would switch each other back and forth.
   */
  const COVER_RELEASE = COVER_BELOW + 110;
  /** A floating card needs this much room; in less, the panel docks along the bottom. */
  const FLOAT_MIN = { width: 720, height: 420 };

  /** The panel that is open (the note's or the image's) and the position it belongs to. */
  function openPanel(): { el: HTMLElement; pos: number; image: boolean } | null {
    const el = open ? panel?.element() : pic ? imagePanel?.element() : undefined;
    if (!el) return null;
    return { el, pos: open ? open.pos : pic!.pos, image: !open };
  }

  /** The picture drawn for the image the panel is open for (CodeMirror only draws what is near the viewport). */
  function pictureOf(v: EditorView, pos: number): HTMLElement | null {
    const info = imageAt(v.state, pos);
    if (!info) return null;
    const lineEnd = v.state.doc.lineAt(info.to).to;
    const index = imagesOnLine(v.state, info.to).findIndex((i) => i.from === info.from);
    let nth = 0;
    for (const dom of v.contentDOM.querySelectorAll<HTMLElement>(':scope > .cm-w-image')) {
      if (dom.previousElementSibling?.classList.contains('cm-w-image')) nth += 1;
      else nth = 0;
      let at = -1;
      try {
        at = v.posAtDOM(dom);
      } catch {
        continue;
      }
      if (at === lineEnd && nth === index) return dom;
    }
    return null;
  }

  /** Mark the picture the image panel is open for (and no other). */
  function markPicture(dom: HTMLElement | null) {
    for (const el of root.querySelectorAll('.cm-w-image[data-panel-open]')) if (el !== dom) el.removeAttribute('data-panel-open');
    dom?.setAttribute('data-panel-open', '');
  }

  /**
   * Dock the panel (phone), float it beside what it belongs to (wide and tall enough) or let it
   * cover a very short surface. A note floats as a card under its reference. The image panel
   * floats as one row of controls just above its picture, over the image's own source line —
   * never over the paragraphs below, where the writer goes on — and stays at the top edge while
   * a tall picture is scrolled through.
   */
  function placePanel(reveal = false) {
    const v = view;
    const target = openPanel();
    if (!v || !target) return;
    const { el, image } = target;
    const anchor = Math.min(target.pos, v.state.doc.length);
    v.requestMeasure({
      key: 'write-note-panel',
      read: () => {
        const box = root.getBoundingClientRect();
        const cover = box.height < (panelMode === 'cover' ? COVER_RELEASE : COVER_BELOW);
        const wide = !cover && box.width >= FLOAT_MIN.width && box.height >= FLOAT_MIN.height;
        const drawn = image ? pictureOf(v, anchor) : null;
        let at: { top: number; bottom: number; left: number } | null = null;
        if (wide && image) {
          const rect = drawn?.getBoundingClientRect();
          if (rect) at = { top: rect.top, bottom: rect.bottom, left: rect.left };
        } else if (wide) {
          const line = v.coordsAtPos(anchor);
          if (line) at = { top: line.top, bottom: line.bottom, left: line.left - 28 };
        }
        return { box, at, cover, drawn, height: el.offsetHeight, width: el.offsetWidth };
      },
      write: ({ box, at, cover, drawn, height, width }) => {
        if (image) markPicture(drawn);
        const visible = at && at.bottom > box.top + 8 && at.top < box.bottom - 8;
        if (cover) {
          panelMode = 'cover';
          el.style.left = '';
          el.style.top = '';
          dockInset = 0;
        } else if (visible && at) {
          panelMode = 'floating';
          const edge = 8 + (image ? (insets?.top ?? 0) : 0);
          let top: number;
          if (image) top = at.top - box.top - height - 4;
          else {
            const below = at.bottom - box.top + 8;
            const above = at.top - box.top - height - 8;
            top = below + height <= box.height - 8 || above < 8 ? below : above;
          }
          const left = Math.max(12, Math.min(at.left - box.left, box.width - width - 12));
          el.style.left = `${left}px`;
          el.style.top = `${Math.max(edge, top)}px`;
          dockInset = 0;
        } else {
          panelMode = 'docked';
          el.style.left = '';
          el.style.top = '';
          dockInset = height;
        }
        if (reveal && panelMode === 'docked') {
          // Docked: scroll so the reference (or the picture) sits above the panel.
          requestAnimationFrame(() => {
            const now = openPanel();
            if (!now || !view) return;
            dockInset = now.el.offsetHeight || dockInset;
            const pos = Math.min(now.pos, view.state.doc.length);
            view.dispatch({
              effects: now.image
                ? EditorView.scrollIntoView(pos, { y: 'start', yMargin: 12 })
                : EditorView.scrollIntoView(pos, { y: 'nearest', yMargin: 28 }),
            });
          });
        }
      },
    });
  }

  function onNoteEdit(from: number, to: number, insert: string, value: string) {
    const v = view;
    if (!v || !open || readOnly) return;
    // Positions in the edit refer to the text as it was before this keystroke.
    const { def, model } = currentNote(v.state, open.key, note?.text ?? '');
    if (def && model) {
      // Tagged like ordinary typing so the history groups a run of keystrokes into one undo step.
      v.dispatch({ changes: mapNoteEdit(v.state, model, from, to, insert), userEvent: insert === '' ? 'delete.backward' : 'input.type' });
    } else if (value !== '') {
      // A reference without a note: the first keystroke writes its definition at the end — once.
      // If a `[^label]:` line is already in the text but is not read as a note (it sits inside a
      // code block, say), appending another would only pile them up, one per keystroke.
      if (hasDefinitionLine(v.state, open.label)) {
        noteError = `[^${open.label}]: is in the text but is not read as a note there. Fix it in the text.`;
        return;
      }
      const changes = appendDefinitionSafely(v.state, open.label, value);
      if (!changes) {
        noteError = 'The note cannot be added at the end of this post. Check how the post ends.';
        return;
      }
      noteError = null;
      v.dispatch({ changes, userEvent: 'input.note' });
    }
  }

  function onNoteRename(label: string) {
    const v = view;
    if (!v || !open || readOnly) return;
    const result = renameFootnote(v.state, open.label, label);
    if ('error' in result) {
      noteError =
        result.error === 'exists' ? `[^${label}] is already another note` : result.error === 'invalid' ? 'No spaces, brackets or backslashes in a label' : null;
      if (result.error === 'same') noteError = null;
      return;
    }
    noteError = null;
    open.key = footnoteKey(label);
    open.label = label;
    v.dispatch({ ...result.spec, effects: setActiveFootnote.of(open.key) });
  }

  function onNoteDelete() {
    const v = view;
    if (!v || !open || readOnly) return;
    const spec = deleteFootnote(v.state, open.label);
    closeNote({ refocus: false });
    if (spec) v.dispatch({ ...spec, scrollIntoView: true });
    v.focus();
  }

  /** Flip between where the note is used and where it is written. */
  function onNoteJump() {
    const v = view;
    if (!v || !open) return;
    const entry = getFootnotes(v.state).byKey.get(open.key);
    if (!entry) return;
    const def = entry.defs[0];
    const refs = entry.refs;
    let target: { pos: number; from: 'ref' | 'def' } | null = null;
    if (open.from === 'ref') {
      target = def ? { pos: def.markFrom, from: 'def' } : null;
    } else {
      target = refs.length ? { pos: refs[0].from, from: 'ref' } : null;
    }
    if (!target) return;
    open.pos = target.pos;
    open.from = target.from;
    v.dispatch({ effects: EditorView.scrollIntoView(target.pos, { y: 'center' }) });
    placePanel();
  }

  function onNoteHistory(direction: 'undo' | 'redo') {
    if (view && !readOnly) (direction === 'undo' ? undo : redo)(view);
  }

  /** Run an inline command on the selection inside the note panel's text. */
  function execInNote(id: EditorCommandId, arg: unknown): boolean {
    const v = view;
    if (!v || !open || !panel) return false;
    if (id === 'undo' || id === 'redo') {
      onNoteHistory(id);
      return true;
    }
    if (!(NOTE_COMMANDS as readonly EditorCommandId[]).includes(id)) return false;
    const { model } = currentNote(v.state, open.key, panel.getValue());
    if (!model) return false;
    const sel = panel.getSelection();
    const scratch = v.state.update({ selection: EditorSelection.range(noteToDoc(model, sel.from), noteToDoc(model, sel.to)) }).state;
    const spec = (pureCommands[id as keyof typeof pureCommands] as (s: EditorState, a?: unknown) => CommandResult)(scratch, arg);
    if (!spec) return false;
    // Apply only the text change; the editor's own selection stays where it is.
    const tr = scratch.update(spec);
    if (!tr.changes.empty) v.dispatch({ changes: tr.changes, userEvent: 'input.note' });
    flushSync();
    const after = currentNote(v.state, open.key, panel.getValue()).model;
    const range = tr.state.selection.main;
    if (after) panel.setSelection(docToNote(after, range.from), docToNote(after, range.to));
    return true;
  }

  /* ------------------------------------------------------------------------ *
   * The image panel
   * ------------------------------------------------------------------------ */

  /** The image open in the image panel: `pos` is where its `![` is, and follows it through edits. */
  let pic = $state<{ pos: number } | null>(null);
  let picture = $state<ImageView | null>(null);
  let imageError = $state<string | null>(null);
  /** Above zero while a change is being made through the panel or the handle, not by the writer in the text. */
  let quiet = 0;
  const quietly = <T,>(run: () => T): T => {
    quiet += 1;
    try {
      return run();
    } finally {
      quiet -= 1;
    }
  };

  /** Said for `![logo][]` and `![logo]`: the bracket text finds the definition, so the panel leaves it alone. */
  const LABEL_IMAGE = 'This text is also the name of the image\u2019s reference. Change it in the text.';

  function refreshImage(state: EditorState) {
    if (!pic) return;
    const info = imageAt(state, Math.min(pic.pos, state.doc.length));
    if (!info) {
      closeImage({ refocus: false });
      return;
    }
    if (info.from !== pic.pos) pic.pos = info.from;
    const next = imageView(info);
    if (
      !picture ||
      picture.name !== next.name ||
      picture.src !== next.src ||
      picture.alt !== next.alt ||
      picture.size !== next.size ||
      picture.altEditable !== next.altEditable ||
      picture.sizeEditable !== next.sizeEditable
    )
      picture = next;
  }

  /** Open the panel for the image at `pos`. `focus`: hand the keyboard to its alt field. */
  function openImage(pos: number, opts: { focus: boolean }) {
    const v = view;
    if (!v) return;
    const info = imageAt(v.state, pos);
    if (!info) return;
    closeNote({ refocus: false });
    pic = { pos: info.from };
    imageError = null;
    refreshImage(v.state);
    if (!pic) return;
    // The panel must exist in the DOM before it can take focus within this same tap.
    flushSync();
    if (opts.focus) imagePanel?.focusAlt();
    placePanel(true);
  }

  function closeImage(opts: { refocus: boolean }) {
    if (!pic) return;
    const hadFocus = imagePanel?.hasFocus() === true;
    // Where it floated is forgotten: a put-away panel must not sit anywhere on the surface.
    const el = imagePanel?.element();
    if (el) {
      el.style.left = '';
      el.style.top = '';
    }
    pic = null;
    picture = null;
    imageError = null;
    dockInset = 0;
    panelMode = 'docked';
    markPicture(null);
    const v = view;
    if (!v) return;
    // Back to the text, with the caret where it was: the panel never moved it.
    if (opts.refocus || hadFocus) {
      v.focus();
      syncFocus(v);
    }
  }

  /** Make a change that comes from the image panel. Each is one step of its own in the history unless `joins`. */
  function editImage(spec: TransactionSpec, joins = false) {
    const v = view;
    if (!v) return;
    quietly(() => v.dispatch(joins ? spec : { ...spec, annotations: isolateHistory.of('full') }));
  }

  function onImageSize(size: ImageSize) {
    const v = view;
    if (!v || !pic || readOnly) return;
    const info = imageAt(v.state, pic.pos);
    if (!info || info.size === size) return;
    const spec = setImageSize(v.state, info, size);
    imageError = spec ? null : info.isLabel ? LABEL_IMAGE : 'The size cannot be written here. Change it in the text.';
    if (spec) editImage(spec);
  }

  function onImageAlt(text: string) {
    const v = view;
    if (!v || !pic || readOnly) return;
    const info = imageAt(v.state, pic.pos);
    if (!info) return;
    const result = setImageAlt(v.state, info, text);
    imageError = 'refused' in result ? (info.isLabel ? LABEL_IMAGE : 'That cannot be written as alt text here.') : null;
    if ('spec' in result) editImage(result.spec, true);
  }

  function onImageRemove() {
    const v = view;
    if (!v || !pic || readOnly) return;
    const info = imageAt(v.state, pic.pos);
    closeImage({ refocus: false });
    if (info) editImage(removeImage(v.state, info));
    v.focus();
    syncFocus(v);
  }

  function onImageHistory(direction: 'undo' | 'redo') {
    const v = view;
    if (v && !readOnly) quietly(() => (direction === 'undo' ? undo : redo)(v));
  }

  /* ------------------------------------------------------------------------ *
   * Editor state
   * ------------------------------------------------------------------------ */

  const previewConfig = (): LivePreviewConfig => ({
    resolveAsset: (src) => resolveAsset(src),
    onFootnote: (v, tap) => {
      // A tap while reading (phone, keyboard down) peeks at the note; otherwise go straight to editing it.
      // Ask the DOM, not only the state: the `editorFocused` field can trail real focus by a moment after a tap.
      const editing =
        v.root.activeElement === v.contentDOM || v.state.field(editorFocused, false) === true || panel?.hasFocus() === true;
      openNote(tap, { focus: !readOnly && (editing || !coarsePointer()) });
    },
    onImage: (v, tap) => {
      const hit = imagesOnLine(v.state, tap.lineEnd)[tap.index];
      // With a mouse the alt field takes the keyboard; a tap leaves it where it is (no keyboard popping up).
      if (hit) openImage(hit.from, { focus: !readOnly && !coarsePointer() });
    },
  });

  const editableExt = (ro: boolean) => [EditorState.readOnly.of(ro), EditorView.editable.of(!ro)];

  /** Run a pure command against the view. */
  function apply(v: EditorView, spec: TransactionSpec | null): boolean {
    if (!spec) return false;
    v.dispatch(spec);
    return true;
  }
  const bind = (id: Exclude<EditorCommandId, 'undo' | 'redo'>) => (v: EditorView) =>
    !v.state.readOnly && apply(v, (pureCommands[id] as (s: EditorState) => CommandResult)(v.state));

  function shift(v: EditorView, dir: 1 | -1): boolean {
    if (apply(v, (dir > 0 ? pureCommands.indent : pureCommands.outdent)(v.state))) return true;
    // Inside code, indent the lines themselves.
    const { from, to } = v.state.selection.main;
    if (enclosing(v.state, from, to, ['FencedCode', 'CodeBlock'])) return (dir > 0 ? indentMore : indentLess)(v);
    return false;
  }

  function onUpdate(update: ViewUpdate) {
    if (update.docChanged) {
      const user = !update.transactions.some((tr) => tr.annotation(programmatic));
      onChange(docText(update.state), { userEvent: user });
    }
    if (update.docChanged || update.selectionSet) onSelectionChange?.(selectionState(update.state));
    if (open) {
      if (update.docChanged) open.pos = update.changes.mapPos(open.pos, 1);
      if (update.docChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) refreshNote(update.state);
      // Clicking back into the text puts the note away.
      const focused = update.state.field(editorFocused);
      if (open && focused && !update.startState.field(editorFocused)) closeNote({ refocus: false });
      else if (open && (update.docChanged || update.geometryChanged)) placePanel();
    }
    if (pic) {
      if (update.docChanged) pic.pos = update.changes.mapPos(pic.pos, 1);
      // The writer went on in the text (typed, or put the caret somewhere): the panel is put away.
      const writing = !quiet && (update.docChanged || update.selectionSet) && update.view.root.activeElement === update.view.contentDOM;
      if (writing) closeImage({ refocus: false });
      else if (update.docChanged || syntaxTree(update.state) !== syntaxTree(update.startState)) refreshImage(update.state);
      if (pic && (update.docChanged || update.geometryChanged)) placePanel();
    }
  }

  function createState(text: string): EditorState {
    const max = text.length;
    const sel = initialSelection
      ? EditorSelection.single(Math.min(initialSelection.anchor, max), Math.min(initialSelection.head, max))
      : undefined;
    return EditorState.create({
      doc: text,
      selection: sel,
      extensions: [
        // Every line break in `text` is kept as it is; new lines get the kind the text uses most.
        // `lineSeparator` only decides for a text without any break. Never `EditorState.lineSeparator`:
        // see ./lineBreaks.ts.
        lineBreaks(text, /[\r\n]/.test(text) ? undefined : lineSeparator),
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        // Prose, not code: let the phone keyboard capitalise, correct and check spelling.
        EditorView.contentAttributes.of({
          spellcheck: 'true',
          autocorrect: 'on',
          autocapitalize: 'sentences',
          'aria-label': 'Post text',
          'data-write-content': '',
        }),
        writeMarkdown({ codeLanguages: languages }),
        footnoteIndex,
        assets.of(livePreviewConfig.of(previewConfig())),
        livePreview(),
        interaction(),
        onOpenLink ? linkOpener.of((url) => onOpenLink?.(url)) : [],
        editorTheme(),
        placeholder ? placeholderExt(placeholder) : [],
        Prec.high(
          keymap.of([
            // Markdown-aware Enter (continue lists/quotes, end them on an empty item) and Backspace.
            { key: 'Enter', run: (v) => !v.state.readOnly && apply(v, exitEmptyListItem(v.state)) },
            ...markdownKeymap(isMarkdownAt),
            { key: 'Mod-b', run: bind('bold') },
            { key: 'Mod-i', run: bind('italic') },
            { key: 'Mod-k', run: bind('link') },
            { key: 'Mod-e', run: bind('code') },
            { key: 'Mod-Shift-x', run: bind('strike') },
            // Tab only acts where it means something; elsewhere it still moves focus.
            { key: 'Tab', run: (v) => !v.state.readOnly && shift(v, 1) },
            { key: 'Shift-Tab', run: (v) => !v.state.readOnly && shift(v, -1) },
            // Keyboard access to what is otherwise tap-only: the footnote chip next to the caret, the
            // note the caret is in, or the task checkbox of the current line.
            { key: 'Mod-Enter', run: (v) => activateAtCaret(v) },
            {
              key: 'Escape',
              run: () => {
                if (!open && !pic) return false;
                closeNote({ refocus: false });
                closeImage({ refocus: false });
                return true;
              },
            },
          ]),
        ),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        editable.of(editableExt(readOnly)),
        // Keep the caret clear of the app's chrome and of the docked note panel.
        EditorView.scrollMargins.of(() => ({ top: insets?.top ?? 0, bottom: (insets?.bottom ?? 0) + dockInset })),
        EditorView.updateListener.of(onUpdate),
      ],
    });
  }

  /* ------------------------------------------------------------------------ *
   * The handle
   * ------------------------------------------------------------------------ */

  function exec(id: EditorCommandId, arg?: unknown): boolean {
    const v = view;
    if (!v || readOnly) return false;
    if (open && panel?.hasTextFocus()) return execInNote(id, arg);
    if (pic && imagePanel?.hasFocus() && (id === 'undo' || id === 'redo')) {
      // One history, and the alt field keeps the keyboard.
      onImageHistory(id);
      return true;
    }

    if (id === 'footnote') {
      const made = insertFootnote(v.state);
      if (!made) {
        onNotice?.(
          footnoteInsertPos(v.state, v.state.selection.main.to) === null
            ? 'A footnote cannot go inside a code block, display math or raw HTML. Put the caret in ordinary text first.'
            : 'The footnote could not be added: its note would not be read as one at the end of this post.',
        );
        v.focus();
        return false;
      }
      const { spec, label } = made;
      v.dispatch(spec);
      const ref = getFootnotes(v.state).byKey.get(footnoteKey(label))?.refs[0];
      openNote({ label, pos: ref?.from ?? v.state.selection.main.head, kind: 'ref' }, { focus: true });
      return true;
    }

    const at = v.state.selection.main.from;
    const done = quietly(() => {
      if (id === 'undo') return undo(v);
      if (id === 'redo') return redo(v);
      if (id === 'indent') return shift(v, 1);
      if (id === 'outdent') return shift(v, -1);
      return apply(v, (pureCommands[id] as (s: EditorState, a?: unknown) => CommandResult)(v.state, arg ?? undefined));
    });
    v.focus();
    // A picture that was just put in (picked, pasted, dropped): its panel opens, for the size and the
    // alt text. The keyboard stays in the text; typing on puts the panel away.
    if (done && id === 'image' && (arg as { src?: string } | undefined)?.src && imageAt(v.state, at)?.from === at) openImage(at, { focus: false });
    return done;
  }

  const handle: EditorHandle = {
    exec: exec as EditorHandle['exec'],
    focus: () => view?.focus(),
    getDoc: () => (view ? docText(view.state) : doc),
    setDoc(text, opts) {
      const v = view;
      if (!v) return;
      closeNote({ refocus: false });
      closeImage({ refocus: false });
      if (opts?.keepHistory) {
        v.dispatch({
          changes: { from: 0, to: v.state.doc.length, insert: text },
          effects: lineBreaksOf(v.state, text),
          annotations: programmatic.of(true),
        });
      } else {
        const fresh = mountView(text);
        onChange(docText(fresh.state), { userEvent: false });
        onSelectionChange?.(selectionState(fresh.state));
      }
    },
    insertText(text) {
      const v = view;
      if (!v || readOnly) return;
      const { from, to } = v.state.selection.main;
      quietly(() => v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true, userEvent: 'input' }));
    },
    getSelection: () => {
      const s = view?.state.selection.main;
      return { anchor: s?.anchor ?? 0, head: s?.head ?? 0 };
    },
    setSelection(sel, opts) {
      const v = view;
      if (!v) return;
      const clamp = (n: number) => Math.max(0, Math.min(n, v.state.doc.length));
      quietly(() => v.dispatch({ selection: { anchor: clamp(sel.anchor), head: clamp(sel.head ?? sel.anchor) }, scrollIntoView: opts?.scrollIntoView }));
    },
    getScrollTop: () => view?.scrollDOM.scrollTop ?? 0,
    setScrollTop: (px) => {
      if (view) view.scrollDOM.scrollTop = px;
    },
    getScrollFraction: () => {
      const v = view;
      if (!v || v.state.doc.length === 0 || v.scrollDOM.scrollTop <= 0) return 0;
      return Math.min(1, v.lineBlockAtHeight(v.scrollDOM.scrollTop).from / v.state.doc.length);
    },
  };

  /** ⌘/Ctrl+Enter: open the footnote or the image at the caret, or tick the task on the caret's line. */
  function activateAtCaret(v: EditorView): boolean {
    const { head, empty } = v.state.selection.main;
    if (!empty) return false;
    const notes = getFootnotes(v.state);
    const ref = notes.refs.find((r) => r.to === head) ?? notes.refs.find((r) => r.from === head);
    if (ref) {
      openNote({ label: ref.label, pos: ref.from, kind: 'ref' }, { focus: !readOnly });
      return true;
    }
    const def = notes.defs.find((d) => d.from <= head && d.to >= head);
    if (def) {
      openNote({ label: def.label, pos: def.markFrom, kind: 'def' }, { focus: !readOnly });
      return true;
    }
    const image = imageAt(v.state, head);
    if (image) {
      openImage(image.from, { focus: true });
      return true;
    }
    if (readOnly) return false;
    const line = v.state.doc.lineAt(head);
    const task = /^(?:[ \t]{0,3}>[ \t]?)*[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[([ xX])\](?=[ \t]|$)/.exec(line.text);
    if (!task || !isMarkdownAt(v.state, line.from, 1)) return false;
    const at = line.from + task[0].length - 2;
    v.dispatch({ changes: { from: at, to: at + 1, insert: task[1] === ' ' ? 'x' : ' ' }, userEvent: 'input.task' });
    return true;
  }

  /**
   * The box got shorter while the text has the keyboard — the on-screen keyboard came up over the
   * line that was just tapped. Bring the caret back into view (no movement when it still is).
   */
  function revealCaret() {
    const v = view;
    if (!v) return;
    v.dispatch({ effects: EditorView.scrollIntoView(v.state.selection.main.head, { y: 'nearest', yMargin: 32 }) });
  }

  /**
   * (Re)create the CodeMirror view for a document. A fresh view rather than `view.setState()`:
   * on Chrome for Android CodeMirror edits through an EditContext whose text window `setState`
   * does not reset (@codemirror/view 6.43), after which typing throws "Invalid change range" and
   * is lost. A new view starts every piece of input state clean.
   */
  function mountView(text: string): EditorView {
    const hadFocus = !!view && view.root.activeElement === view.contentDOM;
    view?.scrollDOM.removeEventListener('scroll', onScroll);
    view?.destroy();
    const v = new EditorView({ state: createState(text), parent: host });
    v.scrollDOM.addEventListener('scroll', onScroll, { passive: true });
    view = v;
    if (hadFocus) v.focus();
    return v;
  }

  function onScroll() {
    if (open || pic) placePanel();
  }

  /** A keyboard takes far more than this; a browser toolbar sliding in or out takes less. */
  const SHRINK_REVEAL_PX = 24;

  /** Back to where the writing was scrolled to before a reload (the caret is restored by the state). */
  function restoreScroll() {
    const top = initialScrollTop;
    if (!top || top <= 0) return;
    requestAnimationFrame(() => {
      if (view) view.scrollDOM.scrollTop = top;
    });
  }

  onMount(() => {
    const v = mountView(doc);
    restoreScroll();
    // Math typesets once KaTeX has loaded; fonts settle the layout.
    const offKatex = onKatexReady(() => view?.dispatch({ effects: refreshPreview.of(null) }));
    let lastHeight = root.clientHeight;
    const resize = new ResizeObserver(() => {
      const height = root.clientHeight;
      const shrunk = lastHeight - height;
      lastHeight = height;
      // A shorter box with a note open: re-place the panel and keep its reference in view above it.
      if (open || pic) placePanel(shrunk > 0);
      else if (shrunk >= SHRINK_REVEAL_PX && view && view.root.activeElement === view.contentDOM) revealCaret();
    });
    resize.observe(root);
    // The panel grows with its text: keep it beside its reference and the scroll margin up to date.
    for (const el of [panel?.element(), imagePanel?.element()]) if (el) resize.observe(el);
    void document.fonts?.ready.then(() => view?.requestMeasure());
    onReady?.(handle);
    onSelectionChange?.(selectionState(v.state));
    return () => {
      offKatex();
      resize.disconnect();
      view?.scrollDOM.removeEventListener('scroll', onScroll);
      view?.destroy();
      view = undefined;
    };
  });

  // A different document: fresh state and history. `doc` alone changing is ignored on purpose.
  let mountedKey = untrack(() => docKey);
  $effect(() => {
    const key = docKey;
    if (key === mountedKey || !view) return;
    mountedKey = key;
    untrack(() => {
      closeNote({ refocus: false });
      closeImage({ refocus: false });
      const v = mountView(doc);
      restoreScroll();
      onSelectionChange?.(selectionState(v.state));
    });
  });

  // Tell the shell about the note panel: the toolbar acts on the note while its text has the keyboard.
  $effect(() => {
    const state = open ? { label: open.label, editing: noteEditing, cover: panelMode === 'cover' } : null;
    untrack(() => onNoteChange?.(state));
  });

  $effect(() => {
    const ro = readOnly;
    view?.dispatch({ effects: editable.reconfigure(editableExt(ro)) });
  });

  // A new resolver (another post's images): re-resolve what is on screen.
  $effect(() => {
    void resolveAsset;
    view?.dispatch({ effects: assets.reconfigure(livePreviewConfig.of(untrack(previewConfig))) });
  });

  // Fonts and metrics change with the theme: have CodeMirror re-measure, now and once the faces have loaded.
  $effect(() => {
    void theme;
    view?.requestMeasure();
    void document.fonts?.ready.then(() => view?.requestMeasure());
  });
</script>

<div class="w-editor" bind:this={root} data-write-editor data-note-open={open ? '' : undefined} data-image-open={pic ? '' : undefined}>
  <div class="host" bind:this={host}></div>
  <NotePanel
    bind:this={panel}
    {note}
    mode={open ? panelMode : 'docked'}
    {readOnly}
    error={noteError}
    onEdit={onNoteEdit}
    onRename={onNoteRename}
    onDelete={onNoteDelete}
    onJump={onNoteJump}
    onClose={() => closeNote({ refocus: true })}
    onHistory={onNoteHistory}
    onFocusChange={(editing) => (noteEditing = editing)}
  />
  <ImagePanel
    bind:this={imagePanel}
    image={picture}
    mode={pic ? panelMode : 'docked'}
    {readOnly}
    error={imageError}
    onSize={onImageSize}
    onAlt={onImageAlt}
    onRemove={onImageRemove}
    onClose={() => closeImage({ refocus: true })}
    onHistory={onImageHistory}
  />
</div>

<style>
  /* Contract: fill the parent's box and own the scroller. */
  .w-editor {
    position: relative;
    height: 100%;
    min-height: 0;
    overflow: hidden;
  }
  .host {
    height: 100%;
  }
  .host :global(.cm-editor) {
    height: 100%;
  }
</style>
