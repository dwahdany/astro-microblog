# /write editor

The writing surface: CodeMirror 6 with an Obsidian-style live preview. Entry
point `Editor.svelte`, contract `EditorProps` / `EditorHandle` in
`../contracts.ts`.

The document text is the only state that matters. Rendering is decoration over
the exact text; nothing here rewrites characters the user did not edit.

## Files

| File | What |
| --- | --- |
| `Editor.svelte` | The component: state, keymap, the `EditorHandle`, the note panel wiring. |
| `markdown.ts` | Parser: CommonMark + GFM + footnote references/definitions + `$…$` / `$$…$$` math. |
| `livePreview.ts` | Builds the decorations (what is hidden, restyled, replaced) from the syntax tree and the selection. |
| `widgets.ts` | What the decorations draw: bullets, checkboxes, footnote chips, images, math, rules. |
| `markdownKeys.ts` | Markdown-aware Enter/Backspace (ported from @codemirror/lang-markdown). |
| `commands.ts` | Toolbar commands as pure `(state, arg) → TransactionSpec`, and the toolbar's selection state. |
| `footnotes.ts` | Footnote model: index, next number, where a new reference may go, appending a definition that is really read as one, rename, delete, and mapping note-panel edits onto the definition. |
| `lineBreaks.ts` | Every line break kept as the file has it (CRLF, bare CR, mixed), through edits and undo. `docText(state)` is the document as text. |
| `images.ts` | Image model: the image at a position, its bracket text cut into alt text and `\|size` suffix, and the changes the image panel makes (size, alt text, remove). |
| `ImagePanel.svelte` | Size (Default / Small / Medium / Full), alt text and Remove for one image: docked sheet on a phone, one row of controls above the picture on wide screens. |
| `NotePanel.svelte` | The footnote editor: docked sheet on a phone, floating card on wide and tall screens, covering the writing surface when it is very short. |
| `interaction.ts` | Focus tracking and link behaviour (tap = caret + "Open" tooltip, ⌘/Ctrl-click opens). |
| `theme.ts` | All styling, through `--w-*` tokens only. |
| `katex.ts` | KaTeX, loaded on first use. |
| `tests/write/editor-harness/` | Standalone page + Vite and Playwright configs and the editor's browser tests. Not part of the app. |

## When markup shows

- Inline constructs (emphasis, code, math, links, images): when the selection touches them.
  A link's or image's `(address)` stays folded as `(…)` until the caret is inside the
  parentheses (or the stub is tapped), so a long URL does not re-wrap the paragraph.
- Line prefixes (`## `, `> `, `- `, `[ ]`, `[^1]:`): only when the caret is on the prefix itself.
- Fenced code and display math: when the caret is anywhere in the block. Code keeps its fence
  lines as lines (no jump); display math swaps its rendering for source + preview (this one moves
  the text below it).
- Footnote references are always chips, and atomic: edit them through the note panel (tap the
  chip, or ⌘/Ctrl+Enter with the caret next to it; the same key ticks a task on the caret's line).
- An unfocused editor reveals nothing.

## The image panel

Tapping a picture (or ⌘/Ctrl+Enter with the caret in an image) opens the image panel; a picture
put in with `exec('image', { src })` — the app's Image button, a paste, a drop — opens it too,
without taking the keyboard from the text. Typing on, or putting the caret elsewhere, puts it
away; so do Done, Escape and Enter in the alt field. Tapping the one-line chip above a picture
still goes into the source, which is where the address is edited.

- The site's convention is `![alt text|size](src)`, size one of `small`, `medium`, `full`
  (`src/plugins/rehype-image-size.ts`). The bracket text is alt text only; no caption is shown.
- The panel edits ONLY the bracket text of that one image: a size replaces the `|size` suffix, a
  keystroke in the alt field rewrites the part of the alt text that was edited. What stands before
  and after the edit keeps its bytes (unescaped brackets, a link or a code span inside the alt text).
- Alt text: `[`, `]` and a backslash that would escape something are written `\[` `\]` `\\` and shown
  without the backslash (in a table `|` is written `\|`, and so is the pipe of the size); a code
  span is written as typed; line breaks become a space. Every change is checked against the parser
  before it is made (still this image, exactly that bracket text) and refused otherwise. Alt text
  that runs over several lines is not edited in the panel.
- A collapsed or shortcut reference (`![logo][]`, `![logo]`) has no alt text of its own — the
  bracket text is the label that finds the definition — so the panel shows it with size and alt
  text locked and says why. A full reference (`![alt][logo]`) is edited like any image.
- An unknown suffix (`|large`) is alt text: the panel shows Default, and a size picked goes after
  it (`a|large|small`). Alt text ENDING in `|small`, `|medium` or `|full` is a size, here as on
  the site; that ending cannot be written as plain alt text.
- Each size change and Remove is one undo step (`isolateHistory`); a run of keystrokes in the alt
  field is one step, like typing. ⌘Z in the alt field undoes in the document's history.
- Remove takes the image out; a link, emphasis or strikethrough that held only the image goes with
  it, and an image alone on its line takes the line and one of the blank lines around it.
- Full looks like Default in the writing column (there is no room to be wider), so the picture
  carries the words "Full width" (`theme.ts`).
- Tab order is sizes, alt text, Remove, Done in every layout (the buttons come last in the DOM and
  are drawn top right when docked). A put-away panel is `display: none` whatever mode it had.
- A size or alt change keeps the picture's element (`ImageWidget.updateDOM`): no reload.

## What the commands will not do

- **Footnote** puts the reference right after a link, image, code span or inline math when the
  caret is inside one, and does not apply inside a code block, display math or raw HTML
  (`exec` returns false and `onNotice` says why). A reference there is plain text on the site.
- When the document ends in a code or math block that was never closed, Footnote closes it
  first (its own fence, on its own line): the new `[^n]:` line would otherwise be part of the
  block. Whatever the document looks like, a definition is only appended when the result is read
  as a footnote, and never twice for the same label.
- **Rename** refuses labels with whitespace, brackets or a backslash, or longer than 999
  characters; the parser reads labels the way the site's (micromark) does, escapes included.
- **Math** with a caret between two prices (`$5 and $6`) does nothing; with a selection it does
  as asked. **Link** with the caret in a bare address uses the whole address as the target.
- **Divider** does not apply inside literal text.
- **Enter** in a numbered list numbers the new item and leaves the lines below as written (the
  one deliberate difference from @codemirror/lang-markdown, which renumbers them).
- An image is not fetched while its address is being typed: it loads when the caret leaves
  the `(…)`.

## Line endings

The state is created WITHOUT `EditorState.lineSeparator`, so every `\r\n`, `\r` and `\n` — in the
file and in anything pasted — is one line break. `lineBreaks.ts` keeps a mark on each break that is
not the document's usual one, maps the marks through every change, restores them on undo
(`invertedEffects`) and writes each break back as it was. New lines get the kind the document
uses most (`EditorProps.lineSeparator` only decides for a text without any break). Always read the
document with `docText(state)` / `handle.getDoc()`, never `state.sliceDoc()` for the whole text.

## Running it alone

```sh
bunx vite --config tests/write/editor-harness/vite.config.ts      # http://127.0.0.1:4331/
```

Query parameters: `?look=galley|galley-dark|console|riso|riso-dark`, `?file=src/content/…md`,
`?empty`, `?readonly`, `?sel=12-20`. `window.__write` exposes the handle and helpers (see
`tests/write/editor-harness/Harness.svelte`).

## Tests

```sh
bunx vitest run src/write/editor                                         # parser, commands, footnotes, decorations, invariant
bun run test:write:editor                                                # behaviour: desktop, Pixel 7, iPhone (WebKit, if installed)
WRITE_PORT=4310 bunx playwright test tests/write/e2e/editor.spec.ts      # wiring inside the real app
```

The invariant (load → read back identical; type → undo identical) runs over every file in
`src/content` at state level (`__tests__/invariant.test.ts`), through the mounted writing screen
with the real editor component in jsdom (`tests/write/app-invariant.test.ts`), and in real
browsers (`tests/write/editor-harness/editor.spec.ts`, `tests/write/e2e/invariant.spec.ts`).

`__tests__/editor-component.test.ts` mounts `Editor.svelte` itself in jsdom
(`tests/write/support/jsdom-editor.ts` supplies the few DOM APIs CodeMirror measures with). jsdom
has no layout: what depends on geometry (the caret staying above the keyboard, where the note
panel sits) is only in the Playwright suites.

## Things to know

- Never call `view.setState()`. On Chrome for Android CodeMirror types through an EditContext
  that `setState` leaves stale (typing then throws "Invalid change range" and is lost). A new
  document gets a new `EditorView` (`mountView` in `Editor.svelte`).
- CodeMirror only draws lines near the viewport. Tests that look for a widget must scroll to it.
- `view.requestMeasure()` does NOT make CodeMirror re-read line and widget heights unless the
  height of `.cm-content` changed — and that element is at least as tall as the scroller. In a post
  shorter than the screen a block widget can change height unseen; the height map goes stale and
  clicks resolve to the wrong line (CodeMirror finds the line under the pointer through that map).
  A widget whose height changes after it was drawn must become a different (non-`eq`) widget, so
  the change counts as a redraw: `ImageWidget` does this with `settled` and the `imageSettled`
  effect when its picture loads or fails; the math widgets do it with `ready`.
- On iOS and Android CodeMirror holds Enter/Backspace back for a moment to see what the virtual
  keyboard does; tests poll for the resulting text instead of reading it immediately.
- Text built by commands uses `\n`; `state.lineBreak` is always `\n` here and the file's own
  line breaks are restored on output (see "Line endings"). Offsets count every break as one.
- When the box the editor fills gets shorter while the text has focus (the on-screen keyboard
  coming up), the caret is scrolled back into view; with a note open the panel is re-placed and
  its reference kept visible. Below 250px of height the note panel covers the whole surface and
  reports `cover` through `onNoteChange`, so the shell can fold its header away.
- Nothing is imported from `@codemirror/lang-markdown`: a static import of that package puts
  the HTML, CSS and JavaScript language packages in the main bundle (measured on the harness build: 684 → 503 kB, 234 → 165 kB gzipped). Its
  Enter/Backspace commands are ported in `markdownKeys.ts` (MIT, attribution in the file).
