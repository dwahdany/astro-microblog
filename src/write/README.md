# /write — the writing app (prototype)

A bespoke replacement for the Sveltia CMS editing experience, served at `/write`.
`/admin` and `public/admin/` are untouched and keep working.

**One rule above all others: the markdown text is the only source of truth.**
The editor renders markdown with decorations over the exact text; properties
patch only the YAML keys that changed; nothing normalises, reformats or
re-serialises text the user did not edit. Opening a post and changing nothing
yields a byte-identical file.

Signed out, the app only reads: Review changes (diff against the original), Copy markdown and
Download .md. Signed in (the GitHub App through the auth worker, or a pasted fine-grained token —
the only way on localhost), Review also offers Publish: one commit with the text and its new
images, plus Delete and moving the file when the slug changed. The working-tree source (dev) is
never written to; `/write/?source=github` swaps in the GitHub source there. Sign-in, the commit
and image handling are described in `data/README.md`; code lifted from Sveltia CMS is listed in
`LIFTED.md` (licence text in `licenses/sveltia-MIT.txt`).

## Layout

| Path | What |
| --- | --- |
| `src/pages/write/index.astro` | The page: prerendered, `noindex`, its own minimal layout, mounts `ui/App.svelte` with `client:only`. |
| `src/pages/write/preview-frame.astro` | The script-less page the preview iframe loads; carries the site's own stylesheet. |
| `src/write/contracts.ts` | Every shared type and constant. Areas talk to each other only through it. |
| `src/write/data/**` | Content sources (working tree in dev, GitHub in production), frontmatter split/parse/patch/scaffold, drafts, review diff. Entry: `index.ts`. See `data/README.md`. |
| `src/write/editor/**` | CodeMirror 6 live preview, footnote panel, image panel, toolbar commands. Entry: `Editor.svelte`. See `editor/README.md`. |
| `src/write/preview/**` | The site's markdown pipeline in the browser and the frame that shows it. Entries: `index.ts`, `Preview.svelte`. |
| `src/write/ui/**` | App shell: list, writing screen, properties, review, look. Entry: `App.svelte`. |
| `src/write/theme/**` | Three token-only themes (Galley, Console, Riso) and their dark sets. |
| `src/write/build/manifest.mjs` | Astro integration (Node, build only): writes `/write/manifest.json`, the post list the app falls back to when GitHub's anonymous API refuses. |
| `tests/write/*.test.ts`, `src/write/**/__tests__/*.test.ts` | Unit tests (vitest), including the real components mounted in jsdom. |
| `tests/write/e2e/*.spec.ts` | Browser tests of the app (Playwright): desktop Chromium, Pixel 7 profile, iPhone profile on WebKit. |
| `tests/write/editor-harness/` | The editor on its own page, with its own Vite and Playwright configs and browser tests. Not part of the app. |
| `src/write/preview/tools/compare-site.ts` | Maintenance tool: compares the preview's HTML with a production build, post by post. |

### The import surface between areas

```
src/write/data/index.ts         contentSource: ContentSource   (list, load, resolveAssetUrl, save, onAuthChange, status, onStatus)
                                auth:          AuthApi         (state, onChange, signInWithGithub, signInWithToken, signOut, verify …)
                                pendingImages: PendingImages   (images of a draft that are not in the repo yet)
                                draftStore:    DraftStore
                                frontmatter:   FrontmatterApi
                                + reviewDiff / inlineDiff, resolveDraft / mergeDraft, composePost / finalBreakOf / newlineOf, fieldDefs, emptyValueFor, formatLike, gitBlobSha …
src/write/editor/Editor.svelte  default export, props: EditorProps
src/write/preview/index.ts      renderMarkdown: RenderMarkdown
src/write/preview/Preview.svelte default export, props: PreviewProps
src/write/theme/index.ts        THEMES, DEFAULT_THEME, getTheme(), setTheme(), getSchemePref(), setSchemePref(), THEME_BOOT_SCRIPT
src/write/theme/index.css       fonts + tokens + the themes + page base
src/write/ui/App.svelte         default export, mounted by the page with client:only
```

Everything else inside an area directory is private to that area.

## How the pieces fit

```
PostList ──open──▶ Workspace ── parts.body ──▶ Editor (CodeMirror live preview, note panel)
   │                  │  ▲                       │ onChange(body)
   │ contentSource    │  └───────────────────────┘
   │ .list()          │── frontmatter.patch(parts, changes) ◀── Properties sheet, title field
   │ draftStore       │── Preview (renderMarkdown → script-less iframe with the site's CSS)
   │ .list()          │── Review (diffPost over data.reviewDiff) → Copy markdown / Download .md / (save, later)
   ▼                  └── draftStore.put(raw, baseRaw, baseSha, rev) 250 ms after the text stops changing,
"Kept on this device"      and at once (unchecked) when the page is hidden or closed
```

- A post is held as exact text slices (`PostParts`). The editor only replaces `body`; every frontmatter
  edit goes through `frontmatter.patch`, which splices the lines of the changed key and nothing else.
  `raw === baseRaw` means "No changes", and then no draft is kept.
- `frontmatter.patch` throws `FrontmatterPatchError` rather than rewrite YAML it cannot splice safely.
  The writing screen catches it, says "That change was not made", and leaves the text alone. Frontmatter
  that does not parse is shown as text and is never edited.
- Opening a post that has changes kept on this device compares them with the source as it is now
  (`resolveDraft`): already applied → the draft is dropped; source changed elsewhere in the file → the
  edits are carried over (`mergeDraft`) and a banner says so; same lines changed → a CONFLICT: the kept
  text wins, Review shows it against the new source, and the draft keeps its OLD original as its base
  (`DraftRecord.conflict`), so the warning comes back after every keystroke and reload until the owner
  chooses "Keep mine" or discards — and Publish stays blocked meanwhile. File gone from the source →
  the kept copy still opens, and the list shows it under "Kept on this device".
- The same post in two tabs: each draft write names the write counter it is based on
  (`DraftRecord.rev`); a tab that has fallen behind follows the other one when it has nothing unstored
  of its own and otherwise asks which version to keep. Nothing is overwritten silently.
- The text of the open post is `composePost(parts)`: the slices, plus a final line break for a NEW
  post whose body lacks one (every file in the repo ends with one), plus the line break a closing
  `---` needs when a file that ended there gets body text, plus the final line break of an existing
  file that had one (text added under the last line — typed, a pasted picture, a footnote — lands
  after that break; the file keeps ending with it). A file that never ended with a line break is
  not given one. Existing files are otherwise never touched.
- Line endings are kept as each file has them — CRLF, bare CR, or a mix — through edits and undo
  (`editor/lineBreaks.ts`). Properties of a file with bare-CR frontmatter cannot be edited (refused
  with a message).
- In production the list can be a kept copy (GitHub unreachable or rate-limiting): `contentSource.status()`
  turns `'stale'` and the list says so, with "Try again".
- In production the post list has a second fallback: `/write/manifest.json`, written by the site
  build, for a first visit that GitHub's anonymous API (60 requests per hour per IP) refuses.
- Writing to GitHub needs a sign-in. Until then `contentSource.canSave` is false and `save()` rejects with
  `ReadOnlyError` (always so for the working-tree source). Publish shows when `canSave` turns true
  (`onAuthChange`), is blocked by frontmatter problems, a taken path or an unresolved conflict
  (`ui/lib/publish.ts`), and on success the saved text becomes the base, the draft goes and a new post
  moves to its real address (`Workspace.publish`). A publish that fails is remembered by the writing
  screen (`saveProblem`), so it is said even when the Review sheet was closed meanwhile. The commit
  itself is described in `data/README.md`.

## The contract in one screen

Read `contracts.ts` — it is written to be read top to bottom. The essentials:

- **`PostParts`** `{ bom, open, frontmatter, close, gap, body }` — exact,
  contiguous slices; `assemblePost(parts) === raw` always. The editor only ever
  replaces `body`; the properties sheet only ever calls `frontmatter.patch`.
  `gap` (blank lines after the closing fence) is kept out of `body` so the
  editor does not open on an empty line.
- **`LoadedPost`** `{ ref, raw, parts, eol }`. `raw` is the diff base.
  `raw === baseRaw` ⇔ "No changes" ⇔ no draft is kept.
- **`ContentSource`** `list()`, `load(path)`, `resolveAssetUrl(postPath, src)`
  (sync), `save()` (rejects with `ReadOnlyError` while `canSave` is false: signed out, or the working tree),
  `status()` / `onStatus()` (live or a kept copy). `SaveRequest`/`SaveResult`
  are already shaped for a commit.
- **`FrontmatterApi`** `split`, `eol`, `parse`, `patch(parts, changes)`,
  `fields(collection)`, `validate`, `scaffold(collection)`, `pathFor` (new
  posts only), `slugify`, `describe`. `patch` returns the *same object* when
  nothing changes, may only touch the lines of the keys it was given, and
  throws `FrontmatterPatchError` instead of reprinting YAML it cannot splice.
- **`DraftStore`** `get/put/delete/list/subscribe` over `DraftRecord`
  (stores full `raw` + `baseRaw`, not slices). `put`/`delete` take
  `{ expectedRev }` and reject with `DraftConflictError` when another tab wrote
  first; events say whether this tab or another made the change.
- **Editor** is *uncontrolled*: `doc` is read on mount and when `docKey`
  changes. `onChange` fires only for real document changes. The component
  fills its parent's box and owns its scroller. The parent gets an
  `EditorHandle` through `onReady` (`exec(command)`, `focus`, `getDoc`,
  `setDoc`, selection and scroll accessors). Commands are listed in
  `EditorCommandArgs`; toolbar state arrives via `onSelectionChange`, the
  note panel's state via `onNoteChange`, and the reason a command did nothing
  via `onNotice`.
- **Preview** `renderMarkdown(markdown, ctx) → { html, warnings }` plus a
  `Preview.svelte` taking `{ markdown, ctx }`.
- **Theme** `<html data-write-theme="galley|console|riso" data-write-scheme="light|dark">`;
  components use only the `--w-*` custom properties named in `THEME_TOKENS`
  (`--wx-*` properties are private to the shell in `ui/`).

## Design direction

Three token sets, each a different idea rather than a recolouring. Token
meanings are documented at the top of `theme/tokens.css`; each theme file opens
with its brief.

| Theme | Idea | Type | Shape and motion |
| --- | --- | --- | --- |
| **Galley** (light, default) | Page proofs on a desk. Colour only from a proofreader's tools: blue pencil (accent, links), red pencil (footnote marks, deletions), yellow highlighter (marks, draft flags). | Literata (prose, titles) + Instrument Sans (chrome) | 2–10px radii, 1px rules, near-flat, calm easing |
| **Console** (dark) | The published blog's own terminal identity turned into a tool, so a draft already looks like the site. | Roboto Mono throughout; hierarchy by weight and colour, not size | 2–8px radii, slate borders, no soft shadows, quick |
| **Riso** (light) | A two-ink zine: mint paper, text in blue ink, fluorescent pink second drum that overprints, yellow third ink. | Bricolage Grotesque alone — condensed/heavy for titles, open/regular for reading | 6–24px radii, 2px ink outlines, hard offset shadows, springy |

Galley and Riso also have a dark set (`galley.dark.css`, `riso.dark.css`); Console is dark only. The
scheme follows the OS unless pinned in the Look sheet. A visitor with no stored choice gets Galley, in
the scheme the OS prefers.

Fonts are self-hosted — no font CDN. Literata, Instrument Sans and Bricolage
Grotesque come from `@fontsource-variable/*` (OFL) and are bundled by Vite;
Roboto Mono reuses `public/fonts/` from the site (upright only: italics in
Console are synthesised, as on the blog). Only faces actually used on screen are
downloaded.

Rules the tokens encode, worth keeping when refining:

- Editable text is never below 16px (`--w-prose-size`, form fields): iOS zooms
  the page when a smaller editable is focused.
- Text tokens meet WCAG AA on the surfaces they are meant for (`--w-ink` 7:1,
  `--w-ink-2` / `--w-accent-text` / status colours 4.5:1, `--w-ink-3` 3:1).
- Touch targets are `--w-tap` (44px).
- Dimmed markup (`--w-syn-mark`) and tertiary ink are at least 3:1 on the writing surface and the
  canvas in every set; an address being typed is secondary ink, not the dim one (`theme.test.ts`
  computes the ratios).
- `prefers-reduced-motion` zeroes the duration tokens.

## Running it

```sh
bun install
bun run dev --port 4310      # http://localhost:4310/write/   (posts from the working tree)
bun run build                # full site build; /write is prerendered to dist/client/write/
bun run preview --port 4325  # the production build under workerd; /write reads the public GitHub repo
```

## Tests

```sh
bun run check:write          # svelte-check over src/write + tests/write
bun run test:write           # vitest: unit tests (node env; a file opts into jsdom with a docblock) — about a minute
bun run test:write:e2e       # Playwright against `astro dev`: the app, on desktop + Pixel 7 + iPhone (WebKit)
bun run test:write:e2e:prod  # Playwright against `astro preview` of the build (run `bun run build` first)
bun run test:write:editor    # Playwright against the standalone editor harness (editor behaviour in depth)
```

- Several vitest files mount the REAL components in jsdom: `ui/__tests__/workspace.test.ts` (the writing
  screen: conflicts, two tabs, the save path), `postlist.test.ts`, `properties.test.ts`,
  `editor/__tests__/editor-component.test.ts`, and `tests/write/app-invariant.test.ts`, which opens every
  post under `src/content` in the writing screen (real editor, real source, real draft store) and
  compares what Download hands back with the file, byte for byte — plus a set of adversarial files
  (mixed and CR line endings, BOM, no final newline …). jsdom has no layout and no real key events:
  anything about geometry, the on-screen keyboard or real typing is only in the Playwright suites.
- `tests/write/e2e/review-fixes.spec.ts` and the "review findings" block of the editor harness spec are
  the browser side of the pre-release review's regression tests.
- The iPhone project appears only when Playwright's WebKit is installed (`bunx playwright install webkit`).
  All three projects are emulation: touch events and a phone viewport, never an on-screen keyboard.
- `WRITE_PORT=<port>` points the e2e tests at a server that is already running (default 4310 for dev,
  4325 for prod), otherwise they start their own. A dev server started by hand should get its own Vite
  cache: `WRITE_VITE_CACHE_DIR=node_modules/.vite-write-<port> bun run dev --port <port>`.
- `tests/write/e2e/journey.spec.ts` is the whole app on one real post; `invariant.spec.ts` opens real
  posts without editing them and compares what the app hands back with the file, byte for byte (every
  post on desktop in dev; 24 across all collections elsewhere; `WRITE_INVARIANT_ALL=1` for all everywhere).
  Both run against dev and prod. `prod.spec.ts` covers the GitHub source in the built app.
- The production run talks to the real GitHub API anonymously (60 requests/hour per IP); each fresh
  browser context costs one request.
- After changing Astro, the markdown config or the site's rehype plugins, check the preview still matches:
  `TZ=UTC bunx astro build --outDir node_modules/.cache/write-build-x` and then
  `bun src/write/preview/tools/compare-site.ts node_modules/.cache/write-build-x/client`.
- `bun run build` writes `dist/`; to build without touching it use
  `bunx astro build --outDir node_modules/.cache/write-build-<name>` (the directory must be inside the repo).

## Gotchas

**Astro + Cloudflare adapter**

- The site is `output: 'server'`. `/write` and the preview frame set
  `export const prerender = true`; every new page under `src/pages/write/` must
  too, or it becomes a Worker route.
- Mount Svelte with `client:only="svelte"` only. Any server-rendered Svelte
  component pulls Svelte's server runtime into the Worker, which imports
  `node:async_hooks`; `wrangler.jsonc` does not enable `nodejs_compat`. The
  build already warns about this import for the *prerender* environment
  (`Unexpected Node.js imports …`); that warning is expected and the deployed
  worker bundle does not contain it.
- `window`, `document`, `indexedDB`, `localStorage` are safe at module top level
  inside the app because nothing is server-rendered — but keep modules that
  tests import (data, preview) free of top-level browser access.
- The sitemap filters out `/write`; the page is `noindex`.

**Vite**

- `import.meta.env.DEV` in `data/index.ts` must stay a literal ternary: it is
  what keeps `data/local-files.ts` (every post's text) out of the production
  bundle. `tests/write/e2e/prod.spec.ts` and a grep of the build check this; re-check after changing it
  (`grep -rl "<a sentence from a post>" dist/client/_astro`).
- `import.meta.glob('/src/content/**/*.md', { query: '?raw', import: 'default' })`
  returns the bytes on disk (asserted in `foundation.test.ts`) — Astro's
  markdown plugin does not intercept `?raw`.
- In dev, files under `src/content/` are served at their root-relative path
  (`/src/content/entries/2025/simple-ideas/2025-02-image.png`), which is how
  relative images resolve locally. In production they resolve to
  `raw.githubusercontent.com`.
- The app's main chunk is about 700 kB (230 kB gzipped). KaTeX, the preview
  pipeline, Shiki and its languages are separate chunks fetched on first use
  (Shiki's languages and themes account for most of the ~430 files in
  `dist/client/_astro`). Keep heavy, optional pieces behind `import()`.
- Nothing may import `@codemirror/lang-markdown`: it drags the HTML, CSS and
  JS language packages into the main chunk (`editor/markdownKeys.ts` carries
  the two commands that were needed from it).
- The public site's Tailwind must not scan this app: `src/styles/global.css`
  has `@source not` lines for `src/write`, `src/pages/write` and `tests`.
  Without them, words in these files become utilities in the public CSS.
- Astro's dev toolbar floats over the bottom-centre of the page and swallows
  taps there (it broke the phone test run). `theme/base.css` hides it on
  `/write`; keep that rule.
- The preview frame is sandboxed without `allow-scripts`, so in dev the browser
  logs "Blocked script execution" for the scripts Astro's dev server injects
  into it. Harmless; the production frame ships no script.

**Editing**

- CodeMirror forgets what separated its lines. The editor therefore never sets
  `EditorState.lineSeparator` and keeps the file's own breaks itself
  (`editor/lineBreaks.ts`); read the text with `handle.getDoc()`. No file in
  the repo uses anything but LF today.
- Toolbar buttons must cancel `pointerdown` so they never take focus from the
  editor (that would dismiss the phone keyboard). See `ui/Toolbar.svelte`.
- The app root is sized to `visualViewport` (`ui/viewport.svelte.ts` →
  `--w-vv-height`, `--w-vv-offset`, `--w-kb-inset`) so the toolbar stays above
  the on-screen keyboard. This has only been exercised in desktop Chromium and
  phone emulation, where no keyboard appears — it needs a real iPhone and
  Android pass.
- The desktop layout needs height as well as width (900 × 480): a phone on its
  side keeps the phone layout. It is switched by `data-write-wide` on `<html>`
  (set from the tallest the window has been at its width, so an on-screen
  keyboard cannot flip a tablet to the phone layout while typing), NOT by a
  media query — style the desktop layout with
  `:global(html[data-write-wide]) .thing`, and read `media.wide` in script.
- Enter in a one-line field that hands focus on must cancel the key press
  first (`ui/lib/keys.ts`), or the same press lands in the editor as a line
  break — on a phone, "type the title, tap Done" edited the post.
- The phone toolbar's order is its own (`ui/lib/toolbar.ts`): what a phone
  keyboard cannot type easily comes first. Commands that cannot do anything
  right now are disabled (`commandAvailable`).
- Never call `view.setState()` on the editor's CodeMirror view: it breaks
  typing on Chrome for Android. A new document gets a new view (`docKey`).
- In the editor, CodeMirror's zero-width widget buffers are taken out of the
  flow and footnote chips are inline (`editor/theme.ts`), so punctuation after
  a link, code span or chip cannot be wrapped onto the next line.

**Content facts**

- Portfolio files starting with `_` (e.g. `_README.md`) are ignored by the site
  loader and by `list()`.
- `src/content/series/` does not exist yet; the collection is defined but empty.
- Frontmatter styles vary between files (`tags: [a, b]` vs block lists, quoted
  vs plain scalars, `# comments` in portfolio legs) — the reason `patch` must
  work on text ranges, not reprint the document.
- Images are referenced relative to the markdown file's directory, with or
  without `./` (`new-blog/IMG_6328.jpeg`, `./curation-leaks/hero.png`), and the
  site's `![alt|small](src)` suffix selects a size class (`small`, `medium`, `full`; set from the
  editor's image panel, see `editor/README.md`).
- New posts are scaffolded with `is_draft: true` (Sveltia's default is `false`);
  a deliberate choice for a tool that will later commit straight to `main`.

## Dependencies

No dependency was added for the review fixes.

Runtime: `svelte`, `@astrojs/svelte`, `@codemirror/{state,view,commands,language,language-data}`,
`@lezer/{markdown,common,highlight}`, `yaml`, `unified`, `remark-parse`,
`remark-gfm`, `remark-math`, `remark-smartypants`, `remark-rehype`,
`rehype-raw`, `rehype-katex`, `rehype-stringify`, `katex`, `shiki`,
`@astrojs/markdown-remark` (for its Shiki highlighter), `github-slugger`,
`unist-util-visit`, `diff`, `idb-keyval`, `@lucide/svelte`,
`@fontsource-variable/{literata,instrument-sans,bricolage-grotesque}`.

Dev: `vitest`, `@playwright/test`, `jsdom`, `fake-indexeddb`,
`@sveltejs/vite-plugin-svelte`, `svelte-check`, `typescript`,
`@types/{hast,mdast,node}`.

`shiki`, `remark-smartypants` and `@astrojs/markdown-remark` are pinned to the
exact versions Astro's own markdown pipeline uses, so the preview highlights and
curls quotes identically and the packages are not duplicated; bump them together
with Astro. Import icons per file (`@lucide/svelte/icons/bold`), not from the
package root.
