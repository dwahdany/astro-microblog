# /write — data layer

Everything the app knows about files: where posts come from, how a file is cut
into slices, how single frontmatter keys are edited without touching the rest,
what a new post looks like, where drafts live, who is signed in, how a save
becomes one commit, and how a pasted image becomes a file in that commit.

The rule this directory exists to protect: **the markdown text is the only
source of truth.** Nothing here parses a file and prints it back. Text is
sliced, spliced and compared; the YAML parser is used to *find* things, never
to *write* the document.

## Import surface

Other areas import only `./index.ts`.

| Export | What |
| --- | --- |
| `contentSource` | `ContentSource` — working tree in dev, public GitHub repo in production; `save()` commits once signed in |
| `draftStore` | `DraftStore` — IndexedDB autosave, pending images included |
| `frontmatter` | `FrontmatterApi` — split, parse, patch, fields, validate, scaffold, pathFor, slugify, describe |
| `auth` | `AuthApi` — sign-in with the GitHub App (popup) or a pasted token; drives `contentSource.canSave` |
| `pendingImages` | `blob:` URLs for images that are not in the repo yet (see "Images") |

Sign-in, publish and images — the whole API is in "The API for the UI" below.

Beyond the contract (see "Proposed contract changes"):

| Export | What |
| --- | --- |
| `reviewDiff(base, current)`, `inlineDiff(a, b)` | line diff for "Review changes", word diff inside a changed line |
| `draftBaseState(draft, upstream)`, `mergeDraft(base, mine, theirs)`, `rebaseDraft(…)` | did the upstream file change since the draft was started, and can the edits be carried over |
| `contentSource.status()`, `contentSource.onStatus(fn)` | is the list live or a cached copy (offline / rate-limited), with a sentence for the UI (part of the contract) |
| `draftPersistence()` | `'indexeddb'` or `'memory'` (drafts will not survive a reload) |
| `fieldDefs(c)`, `fieldDef(c, key)`, `writeOrder(c)`, `scaffoldKeys(c)`, `emptyValueFor(c, key)` | field tables with defaults; the order keys are written in; what "emptied" means per key |
| `formatLike(sample, date)`, `sveltiaTimestamp(date)`, `parseTimestamp(v)` | timestamps in the formats the files use |
| `assetRepoPath(postPath, src)` | repo path an image reference points at |
| `gitBlobSha(text)` | the id `PostRef.sha` / `SaveRequest.baseSha` hold |
| `SourceUnavailableError`, `FrontmatterPatchError`, `DraftStoreError` | typed errors; every message is fit to show |

## Files

| File | Role |
| --- | --- |
| `split.ts` | `split`, `eol` — exact slices |
| `describe.ts` | `parse`, `describe`, `slugify`, `pathFor`, excerpt, list ordering |
| `yaml-patch.ts` | range-based patch of single keys (+ self-verification) |
| `yaml-render.ts` | rendering the few lines the app writes itself, in Sveltia's style |
| `fields.ts` | per-collection field tables, write order, validation |
| `scaffold.ts` | new posts |
| `dates.ts` | timestamp formats |
| `frontmatter.ts` | assembles `FrontmatterApi` |
| `local-source.ts`, `local-files.ts` | dev source (Vite `?raw` glob) |
| `github-source.ts`, `cache.ts`, `git-sha.ts`, `status.ts` | production source, its IndexedDB cache, blob hashing, freshness status |
| `paths.ts` | path helpers and the asset resolution rules shared by both sources |
| `draft-store.ts`, `draft-sync.ts` | drafts in IndexedDB (with their pending images); stale-base detection, 3-way merge, `draftAfterSave` |
| `github/http.ts` | request helper: one retry for transient failures, one token refresh on 401 (lifted) |
| `github/auth.ts` | the sign-in popup and its handshake with the auth worker (lifted) |
| `github/session.ts` | the session: validate, persist, refresh, cross-tab, `AuthApi` |
| `github/client.ts` | REST + GraphQL for the repo with the session's token; failure classification |
| `github/read.ts` | head, tree under `src/content`, blob bytes — with the token (lifted) |
| `github/commit.ts`, `github/commit-split.ts`, `github/concurrency.ts` | `createCommitOnBranch` with size-adaptive splitting, REST Git Data fallback, commit messages (lifted) |
| `github/save.ts` | `SaveRequest` → conflict check → file changes → commit → look again when the branch moved |
| `assets/intake.ts` | paste / drop / picker → `PendingImage` (lifted + new) |
| `assets/sniff.ts`, `assets/animation.ts` | format from content; animated or still (lifted) |
| `assets/transform.ts` | downscale + re-encode = metadata removed |
| `assets/names.ts` | safe unique names, image paths and references, `rewriteImageRefs` |
| `assets/pending.ts` | `blob:` URL registry for pending and just-committed images |
| `../licenses/sveltia-MIT.txt`, `../LIFTED.md` | licence of the lifted code; which file came from where |
| `diff.ts` | review diff |
| `errors.ts` | typed errors |
| `__tests__/` | vitest; `tests/write/e2e/data.spec.ts` is the browser counterpart |

## Guarantees and how each is tested

**Split.** `assemblePost(split(raw)) === raw` for every string. Frontmatter is
a `---` line at the very start (after an optional BOM) up to the next line that
is exactly `---`; an unterminated block is all body. Tested over every markdown
file under `src/content`, the same files converted to CRLF / lone CR / with a
BOM / without the final newline, 27 constructed cases and a 5000-string fuzz
(`split.test.ts`).

**Open without change.** A post loaded through `contentSource.load()` is the
bytes on disk, and its slices reassemble to them — every post, in node
(`local-source.test.ts`) and in Chromium (`e2e/data.spec.ts`). The GitHub
source decodes with `TextDecoder({ ignoreBOM: true })`, because
`Response.text()` would drop a byte-order mark.

**Patch.** `frontmatter.patch(parts, changes, collection)`:

- no effective change → the same object (`===`);
- one-line scalar → one-line scalar replaces only the value's characters
  (`title: "Old"   # note` → `title: "New"   # note`): quote style, spacing and
  the trailing comment stay;
- a one-line flow list or map that stays one (`tags: [a, b] # note`) has only
  its brackets and contents replaced: the comment after it stays;
- other values are re-rendered from just after `key:` to the end of the key's
  last line, in the old value's style (flow list stays flow with its padding,
  block list keeps its indentation; unchanged items are re-used as parsed
  nodes, so their quoting, comments and number formats like `0.230` survive);
- an empty list (`tags: []`) that gains items becomes a block list (Sveltia's
  style); a list that loses all items becomes `[]`;
- a new key is inserted after the nearest preceding key of the collection's
  **write order** that is present, else before the nearest following one, else
  appended; a removed key loses exactly its own lines;
- CRLF blocks stay CRLF; a file without frontmatter gets fences in its own
  line ending;
- a block with bare CR line endings (old Mac) is refused with a message: the
  locator works in `\n` lines and would splice in the wrong place (in such
  files the YAML usually does not parse at all, and is then shown as text).

**The text of a post being edited** is `composePost(parts, { isNew, newline, finalBreak })`
(`split.ts`): `assemblePost` plus the line breaks the app itself owes a
file — after a closing `---` that ends the file, once there is body text
(otherwise the first body character would turn the fence into `---X` and the
file would have no frontmatter), at the end of a NEW post, and at the end of an
existing file whose original ended with one (`finalBreak: finalBreakOf(baseRaw)`).
The last one exists because a file that ends with a line break has an empty last
line in the editor, where a tap below the text puts the caret: text typed there, a
picture pasted there or a footnote added from there comes after the final break and
would leave the file without one. A file whose original had no final break is never
given one. `newlineOf(raw)`
is the file's own break: `\n`, `\r\n` or `\r`, in a mixed file the one it
uses most. `eol(raw)` answers `'lf' | 'crlf' | 'cr' | 'mixed'`.

The result is re-parsed before it is returned and must (1) be valid YAML,
(2) hold exactly the old data plus the changes, (3) keep the other keys in
order, (4) keep every untouched key's text byte-identical. If not,
`FrontmatterPatchError` is thrown and nothing changes. There is deliberately
no "reprint the document" fallback. It also throws for YAML that does not
parse and for frontmatter that is not a block mapping — the properties sheet
should show the raw YAML in those cases (`parse().issues` is non-empty for
the first).

Tested by editing **every key of every real post** and checking, with a
line scanner that does not use the YAML parser, that only that key's lines
differ; by removing and re-adding every key; and by ~60 exact-output cases for
quoting, comments, lists, nesting, CRLF, indentation, missing final newline
and refusals (`patch.test.ts`).

**Written YAML means the same to the site.** The site parses frontmatter with
js-yaml, which reads some unquoted scalars differently from the `yaml` package
(`2026-01-01` → Date, `0b11`, `1_000` → number). Strings of that shape are
quoted when written — except in date fields (`created`, `taken_at`, `date`),
where the unquoted timestamp is the point. `site-parser.test.ts` feeds ~100
awkward strings through patch and reads them back with js-yaml.

**Sveltia's format.** Rendering uses the `yaml` package with `lineWidth: 0`
and single quotes, which is what the CMS-written files show (`title: ''`,
`link_title: 'DPPL: …'`, `tags:\n  - ai`, `exif: null`). Checked against the
real files: re-adding a removed key reproduces the original line in every
CMS-styled post, and `scaffold` fed a real post's own values reproduces its
frontmatter byte for byte (`patch.test.ts`, `scaffold.test.ts`).

## Content model facts worth knowing

- **Write order** (where new keys go, and the scaffold's key order) is the
  field order of `public/admin/config.yml`, then keys only
  `src/content.config.ts` knows. It is *not* the display order of
  `frontmatter.fields()`, which puts title, slug, created, tags, is_draft
  first. `fields.test.ts` re-reads config.yml and fails if the order drifts.
- **`created`** is written by Sveltia as UTC wall-clock time, seconds zeroed,
  `+00:00` (verified against commit times). Older files use `…Z`; portfolio
  uses a bare date. Frontmatter is parsed with the YAML 1.2 core schema so
  these stay strings exactly as written; use `formatLike(existing, date)` to
  produce a new value in the format the file already uses.
- **Emptied fields.** Sveltia keeps the key with an empty value (`title: ''`,
  `tags: []`, `exif: null`). `emptyValueFor(collection, key)` returns that
  value for CMS-managed keys and `undefined` (remove the key) for the rest.
- **Paths.** `pathFor` gives `src/content/<collection>/<year of created,
  UTC>/<slug>.md` and is meant for **new** posts. An existing post keeps its
  path: one real post (`blogmarks/2026/dppl-…`, created 2024) sits in a folder
  that is not its `created` year, because the CMS files a post under the year
  it was created in and never moves it.
- **New posts** are scaffolded with `is_draft: true` (Sveltia: `false`), as
  the contract requires. The body starts empty; nothing adds a final newline
  to what the user types.
- **Validation** mirrors the zod schemas in `src/content.config.ts` (required
  keys, URL fields, enums, types) plus the slug pattern. No real post has an
  issue.

## Content sources

### Dev: working tree

`import.meta.glob('/src/content/**/*.md', { query: '?raw' })` behind the
literal `import.meta.env.DEV` ternary in `index.ts`, so neither the glob nor
any post text reaches a production bundle (checked by bundling `index.ts` in
production mode and grepping the output). `load()` and `list({ refresh: true })`
fetch the file's current text from the dev server (`/src/content/…md`,
served as `text/markdown`) instead of trusting the cached module. Relative
images resolve to `/src/content/<dir>/<file>`, which Vite serves.

### Production: public GitHub repo (anonymous here; see "Reading while signed in")

| Request | Count | Rate-limited |
| --- | --- | --- |
| `api.github.com/…/git/trees/main:src/content?recursive=1` (~75 kB: every file's path + blob sha) | 1 per visit, 0 on a reload within 60 s | yes: 60/hour per IP |
| `raw.githubusercontent.com/…/<path>` | 1 per post **whose blob sha is not cached** | no |
| `api.github.com/…/git/blobs/<sha>` | only when raw's CDN lags behind the tree (see below) | yes |

Caching, in IndexedDB database `write-source-cache`:

- `blob:<sha>` → text. A sha names content, so entries never go stale. A warm
  visit downloads no post text. Entries no file refers to any more are deleted
  after each successful listing.
- `listing:<repo>` → the tree. Reused as-is for 60 s; otherwise the fallback
  when GitHub cannot be reached.

Every downloaded file is hashed (`gitBlobSha`). raw.githubusercontent.com can
serve a revision up to five minutes old; if the bytes do not hash to the sha
the tree promised (or the file 404s), the exact blob is fetched by sha from the
API. A text is only ever cached under the sha it really has, and `PostRef.sha`
always describes the text that was actually loaded.

Degradation:

| Situation | With a cache | Without |
| --- | --- | --- |
| offline | cached list and posts; `contentSource.status()` = `{ state: 'stale', reason: 'offline', message }` | the build manifest lists the posts, but no text can be fetched → `SourceUnavailableError` (reason `'offline'`) |
| rate-limited (403/429) | same, with `retryAt` (or the build manifest, when that is newer than the cached listing) | **the list comes from the build manifest** (`/write/manifest.json`), texts from raw (not limited); status is `'stale'` and says "as of the last site build" |
| some files fail | the rest is listed, status says how many are missing | error if none could be read |

**The build manifest.** The anonymous API allows 60 requests per hour per IP,
and a phone behind carrier NAT shares that with everyone on the same address,
so a first visit can be refused. `astro build` therefore writes
`/write/manifest.json` (`src/write/build/manifest.mjs`, an Astro integration
that runs in Node at build time): path, git blob sha and size of every
markdown file under `src/content` as of that build, in the same shape the
source keeps its own listing in. `loadListing` asks GitHub first and falls
back to whichever is newer, the listing cached on the device or the manifest.
A post that changed after the build is still shown as it is now: its text is
hashed on arrival and kept under the sha it really has.

Measured against the real repo in Chromium (82 posts): cold 2.4 s (1 API + 82
raw requests), reload 13 ms with no requests, later visit 1 API request and no
raw requests.

### Asset URLs (`resolveAssetUrl(postPath, src)`, both sources)

| `src` | Result |
| --- | --- |
| `https:`, `data:`, `blob:`, `mailto:`, `//host/x` | unchanged |
| `#anchor` | unchanged |
| `/x.png` (site-absolute, `public/`) | dev: unchanged · GitHub: `https://blog.wahdany.eu/x.png` |
| `pic.png`, `./slug/pic.png`, `../x/pic.png` | relative to the **directory** of the post → dev: `/src/content/…` · GitHub: `https://raw.githubusercontent.com/<repo>/main/src/content/…` |
| `''`, `?query`, anything climbing out of the repo | `null` |

Path segments are percent-encoded once (already-encoded input is not
double-encoded); `?query` and `#fragment` are kept.

## Drafts

IndexedDB database `write-drafts`, version 3: `drafts` (id → `DraftRecord`),
`index` (id → `DraftSummary`) and `assets` (`t:<id>` → tags, `b:<id>` → the bytes
of the draft's pending images), written in one transaction. Version 1 was the Foundation stub's
(records only), version 2 added the index; each upgrade keeps what is there, so
existing drafts carry over. One record per post id — the repo path for an
existing post, `new:<collection>:<uuid>` for an unsaved one. `put` stores a
plain copy of the contract's fields (a Svelte `$state` proxy cannot be
structured-cloned).

Failures are not swallowed: `put` rejects with a `DraftStoreError`
(`reason: 'quota' | 'unavailable' | 'failed'`) whose message tells the owner to
copy or download. The record that could not be persisted stays readable for
the rest of the session. Reads never reject.

A draft remembers `baseRaw` and `baseSha`. On opening a post that has a draft
the writing screen asks `resolveDraft(draft, { raw, sha })` (`draft-sync.ts`):

| Answer | Meaning | What is opened | Base stored with the draft |
| --- | --- | --- | --- |
| `drop` | the source already says what the draft says | the source | (the draft is deleted) |
| `current` | the source is still the draft's original | the draft | unchanged |
| `merged` | the source changed elsewhere in the file | the edits carried over onto it (`mergeDraft`) | the new source |
| `conflict` | the source changed in the same lines | the draft, as it was kept | **the draft's own OLD original**, plus `DraftRecord.conflict = { sha: <new upstream> }` |

A conflict is judged from the draft's own original every time, so it survives
any number of keystrokes and reloads: the record never claims to be based on
the new upstream until the owner says so ("Keep mine", which makes the new
source the base, or Discard). Until then the UI warns and Publish is blocked,
because a save naming the new sha would pass its concurrency check and
silently revert the upstream change. A file that is gone from the source
(`PostNotFoundError`) still opens from the draft.

**Two tabs on one post.** Every record carries a write counter, `rev`.
`put(record, { expectedRev })` and `delete(id, { expectedRev })` check it
inside the same transaction and reject with `DraftConflictError` when another
tab wrote in between; `put` resolves with the new `rev`. Changes are also
announced on a BroadcastChannel (`DraftEvent.origin: 'local' | 'remote'`).
The writing screen follows the other tab when it has nothing unstored of its
own and otherwise asks which version to keep; it never overwrites silently.

**Closing the tab.** Once the database is open, `put` issues its request
before it returns (it is not an `async` function), so the unchecked write the
writing screen makes from `pagehide` / `visibilitychange` is with IndexedDB
before the page goes. The checked write needs a read first and is not used
while unloading.

## Sign-in

Two ways in, one session (`github/session.ts`, exported as `auth`):

| | GitHub App (`'app'`) | Pasted token (`'token'`) |
| --- | --- | --- |
| How | popup → the auth worker (`AUTH_WORKER_ORIGIN`, the owner's fork of sveltia-cms-auth) → GitHub → back | a fine-grained personal access token with *Contents: read and write* on the repo |
| Where | any host the worker allows; **not localhost** (`auth.popupSupported === false`) | everywhere; the only way on localhost |
| Lifetime | access token 8 h, single-use refresh token ≈ 6 months; refreshed by the data layer | until the owner deletes it; never refreshed |
| Checked before it is stored | `GET /user` | `GET /user`, then `GET /repos/<repo>` must say `permissions.push` |

**The popup.** `auth.signInWithGithub()` opens
`<worker>/auth?provider=github&site_id=<hostname>&origin=<origin>` **synchronously** — call it straight
from the tap handler, nothing awaited before it, or the browser blocks the window. (No `scope`: the
forked worker reads only `provider`, `site_id` and `origin`, and takes the scope from its own
`GITHUB_SCOPE`.) Handshake (Decap's): the popup posts `authorizing:github` **to the one allow-listed
origin (`origin` when it was sent, as this app does, else `https://<site_id>`), never `*`**; the opener echoes it **addressed to the worker's origin**; the
popup posts `authorization:github:success:{…}` or `…:error:{…}`, once. A message is accepted only when
`event.source` is the popup window, `event.origin` is the worker's origin and the data is a string.
The success object is `{ token, refresh_token?, expires_in?, refresh_token_expires_in? }` (seconds;
camelCase is accepted too). Closing the popup, or `auth.cancelSignIn()`, rejects with reason
`'cancelled'`; every exit path detaches the listener and stops the closed-poll.

What the worker does **not** post: a refusal it decides before it trusts an origin — this site is not
on its `ALLOWED_ORIGINS` (`UNSUPPORTED_DOMAIN`), an unknown provider, a missing or forged state
cookie. It only shows those in its window. The app then hears nothing until the window is closed, so
a closed window is reported as `'cancelled'` with the message "…If it showed an error, sign in with
an access token instead", and the waiting state says the same. `'unsupported-domain'` is therefore
never produced by this worker; the mapping is kept for one that posts it.

**The session** is ONE `localStorage` entry, `write:auth` (`AUTH_STORAGE_KEY`), /write's own —
`/admin` keeps `sveltia-cms.user` and the two never touch. It holds
`{ v: 1, method, token, refreshToken?, expiresAt?, refreshExpiresAt?, user, savedAt }`. Every tab reads
it before handing out a token and on `storage` events, so sign-in, sign-out and refresh in one tab
reach the others. Where storage is blocked the session lives in the tab.

**Refresh** is `POST <worker>/refresh` with JSON `{ "refresh_token": "…" }`, answered with
`{ token, refresh_token?, expires_in?, refresh_token_expires_in? }`:

- before a request when the token expires within 5 minutes; and once after a 401;
- callers that arrive meanwhile share the one refresh;
- across tabs it runs under a Web Lock (`write:auth:refresh`), and inside the lock the storage is
  read again first: if another tab already refreshed, its tokens are used and the single-use refresh
  token is not spent twice. Without Web Locks, a refused refresh is followed by one more look at the
  storage before the session is ended;
- **only** the worker's verdict on the refresh token ends the session (`state().ended.reason ===
  'expired'`): `401` (`bad_refresh_token`, as the fork answers), a `400` carrying that same error, or
  a `200` without a token. Everything else leaves the session — and the six-month refresh token —
  alone and the old token is tried: offline, 5xx, `404`/`405` (a worker build without `/refresh`),
  `400 invalid_request`, `403` (a refused origin; in a browser that one arrives as a network error,
  because the worker sends no CORS grant with it).

**401.** Every API request goes through `github/client.ts`: a 401 gets one refreshed retry; if that
fails the session has been cleared, `auth.onChange` listeners have been told, and
`contentSource.onAuthChange` fires because `canSave` flipped. A stored session is also checked once
in the background when the app loads (`auth.verify()`).

**What the push check can and cannot tell.** `permissions.push` describes the *account* the token
acts for. A fine-grained token (or an App installation) that does not cover the repo still shows the
owner's `push: true` on a public repo; the first commit is what finds out (`SaveError`, reason
`'forbidden'`). `auth.signOut()` forgets the session on this device; it does not revoke the token at
GitHub.

## Reading while signed in

The listing (`…/git/trees/main:src/content?recursive=1`) and the exact-blob fallback
(`…/git/blobs/<sha>`) carry `Authorization: token …` — 5000 requests an hour for the account instead
of 60 per IP — and a tree GitHub cuts short is listed directory by directory, so it is complete.
Post text still comes from raw.githubusercontent.com (not rate limited, verified against the blob
sha). If the token turns out to be dead the anonymous request is tried in the same call.
`github/read.ts` has the three reads a save uses: `fetchHead` (`…/git/ref/heads/main`),
`fetchContentTree(head)`, `fetchBlobBytes(sha)`.

## Save

`contentSource.save(req)` — one method for create, update, rename and delete (`SaveRequest`):

| Kind | Request | Conflicts (`SaveConflictError.reason`) |
| --- | --- | --- |
| create | `{ path, raw }` (no `baseSha`) | path taken → `'exists'` |
| update | `{ path, raw, baseSha }` | file gone → `'missing'`; another blob there → `'changed'` (`currentSha`) |
| rename | `{ path, previousPath, raw, baseSha }` | as update at the old path; new path taken → `'exists'` |
| delete | `{ path, raw: '', delete: true, baseSha }` (+ `keepImages`) | `'missing'` / `'changed'` |
| + images | `assets: pendingAssetsFor(path, draft.assets, raw)` | an image path holding other bytes → `'exists'` |

What happens (`github/save.ts`):

1. `GET git/ref/heads/main` → head `H`; `GET git/trees/H:src/content?recursive=1` → every file's blob sha.
2. The conflict check above, against that tree. Nothing has been written when it rejects.
3. **One commit** on top of `H`: GraphQL `createCommitOnBranch` with `expectedHeadOid: H`, the post
   and images as base64 `additions` (a string is encoded as UTF-8, so BOM and line endings land
   exactly), removed paths as `deletions`. A rename is an addition plus a deletion; the files of the
   old image folder `<old dir>/<old stem>/` are read and re-added under `<dir>/<stem>/` in the same
   commit. A delete removes the post and its image folder.
4. If GitHub says the branch is no longer at `H` (a typed `BranchMovedError` — the head is looked up,
   the wording of the error is not relied on): back to 1, at most 3 times. The conflict check runs
   again, so a change to *this* post is a conflict while the price-cache bot's commit just means
   committing on top of it. Still moving after 3 looks → `SaveConflictError` with reason
   `'branch-moved'`. **Nothing is ever forced.**
5. On success the source's caches are made to say what the commit made true — the listing (the tree
   from step 1, plus what was written, minus what was removed), the committed text under its new
   blob sha, and the committed images in the `pendingImages` overlay (raw's CDN lags for minutes) —
   so `list()` and `load()` show the post as saved **without a request**. The old address of a rename
   and a deleted post answer `PostNotFoundError` even while raw still serves them.

That is 3 requests for a plain save, against 5000 an hour.

**Idempotent.** When the tree already holds exactly what the request asks for (the commit landed but
its answer was lost), nothing is committed and the save succeeds with `commits: 0`. Images that are
already in the repo with the same bytes are not sent again, but are still listed in
`SaveResult.assets` — they are accounted for by this save, and `draftAfterSave` drops them from the
draft by that list. A **delete** whose commit landed while its answer was lost (the retried mutation
is then refused as "branch moved") finds the post already gone on the second look and reports
`{ deleted: true, commits: 0 }` instead of a conflict.

**What a save refuses outright** (`SaveError`, reason `'invalid'`, before anything is sent): a path
outside `src/content`; an image anywhere but directly in the post's own image folder
(`imageFolder(path)`) or without an image extension (jpg, png, webp, gif, avif); text containing an
unpaired surrogate (half an emoji), which UTF-8 cannot carry — the repo would get U+FFFD where the
screen shows something else.

**Other tabs.** `load()` first takes over a stored listing that is newer than this tab's (a save in
another tab stores one), so a post opened here after another tab published is the published text,
without a request.

**Large images.** A save whose base64 payload exceeds what one request can carry is split, as
Sveltia does: the first commit carries up to 2 MB, later ones are sized toward 5 seconds of upload
(256 KB – 16 MB); images go first, the post and the deletions in the LAST commit, so a post is never
live without its images; an upload that times out is retried with half the files. Every commit of a
split save carries the same message and each triggers a site build. If a later commit fails,
`SaveError.partial` is true: the post was not published, and publishing again sends only what is
missing. `onSaveProgress((done, total) => …)` reports the commits.

**REST fallback.** If GitHub refuses the mutation for the token ("Resource not accessible by
integration / personal access token", GraphQL `FORBIDDEN`), the same changes go through the Git Data
API — `POST git/blobs` per file, `GET git/commits/H` → base tree, `POST git/trees` (`sha: null`
removes a path), `POST git/commits` with `H` as the only parent, `PATCH git/refs/heads/main` with
`force: false` (a moved branch answers 422 "not a fast forward" → `BranchMovedError`) — and REST is
used for the rest of the session. Always one commit. A REST commit is authored by the token's user
but, unlike a `createCommitOnBranch` commit, is not signed by GitHub. `SaveResult.via` says which
API made the commit.

**Commit message** when `message` is omitted — Sveltia's wording, so history stays uniform:
`Create Note “2026/my-slug”`, `Update Entry “2025/my-slug”`, `Delete Blogmark “2026/x”` (curly quotes;
the "slug" is the path inside the collection folder without `.md`), plus ` +N` for N further files
changed (`commitMessage(action, collection, path, n)`).

**Errors.** `ReadOnlyError` (not signed in / working-tree source) · `SaveConflictError` (above) ·
`SaveError` with `reason: 'forbidden' | 'signed-out' | 'offline' | 'rate-limited' | 'too-large' |
'invalid' | 'failed'` and `partial`. Every message is fit to show. An aborted `signal` rejects with
the AbortError.

**In dev** the working-tree source stays read-only. `…/write/?source=github` (remembered for the tab;
`?source=local` undoes it) swaps in the GitHub source on localhost, where sign-in is by token.

## Images

**Where.** For a post at `src/content/<collection>/<year>/<stem>.md` an image lives at
`src/content/<collection>/<year>/<stem>/<name>` and is written in the text as `<stem>/<name>` — no
`./`, no leading slash. `<stem>` is the post's file name without `.md`. For every post this app
creates it equals the slug; for an older post whose `slug` key differs from its file name the folder
follows the FILE name, because that is the address a relative reference resolves to. Series are flat
and normally own no folder.

**Intake** (`intakeImages(files, { postPath, taken })`), for a paste, a drop or the file picker:

1. The format is read from the **content** (`sniff.ts`): JPEG, PNG, WebP, GIF, AVIF, HEIC. A text
   file called `.png` is rejected; a PNG called `.jpg` is named `.png`; SVG is not taken (markup).
2. **By default the picture is decoded and encoded anew** — longest side at most 2000 px, quality 85
   — and that is what removes EXIF, GPS and every other embedded metadata: no byte of the original
   container survives. The EXIF orientation is applied to the pixels first. JPEG stays JPEG, PNG
   stays PNG, WebP stays WebP where the browser can write it (else JPEG, or PNG when the picture has
   transparency), a still GIF becomes PNG, AVIF becomes WebP, HEIC becomes JPEG where the browser can
   decode it (Safari) and is rejected elsewhere.
3. `originalQuality: true` is the explicit switch: the file is kept **byte for byte, metadata
   included**, and the result says so (`PendingImage.stripped === false`). An animation (GIF, APNG,
   animated WebP) is also kept as it is — re-encoding would freeze it — and also marked `stripped:
   false`. A picture that cannot be re-encoded is **rejected** (`'cannot-strip'`), never silently
   kept with its metadata.
4. The name is narrowed to `[a-z0-9.-]` (`Façade Photo (1).JPEG` → `facade-photo-1.jpg`), a
   meaningless one (`image.png`) becomes a UTC timestamp, and a name the folder already has — in the
   repo, in the draft, or earlier in the same batch, compared case-insensitively — is numbered
   (`pic-1.png`).
5. The git blob id of the final bytes is recorded (`PendingImage.sha`).

Bad files never throw; they come back in `rejected` with a sentence for the owner.

**With the draft.** `DraftRecord.assets: PendingImage[]`. The draft store keeps the facts in the
record and the bytes in a store of their own (`assets`, database version 3), rewritten only when the
set of images changes — an autosave after a keystroke writes no image bytes. The bytes are stored
as ArrayBuffers, not Blobs: WebKit refuses to store a Blob in IndexedDB in a private or ephemeral
session (seen in Playwright's WebKit: the whole draft write failed), an ArrayBuffer is stored
everywhere. `get` builds the Blobs again. A write carrying images the tab has seen before still
starts in the caller's own turn (usable from `pagehide`); only the first write of a brand-new Blob
that did not come from `intakeImages` reads it first. Images survive a reload and are deleted with
the draft. A draft with images is `dirty` even when its text is unchanged, and
`resolveDraft` does not drop it.

**Showing them.** Until the commit an image has no URL: `pendingImages.sync(draft.id, draft.path,
draft.assets)` registers `blob:` URLs, which `contentSource.resolveAssetUrl` (both sources) returns
before anything else. Call it when a draft opens, when an image is added or removed, and when the
post's path changes. Images a save has just committed stay in the overlay for the session.

**Renaming a post.** Images follow the post: a pending image stores only its `name`, and a save
with `previousPath` moves the committed folder. The references in the text are the caller's:
`rewriteImageRefs(raw, oldPath, newPath, names)` turns `<old stem>/<name>` into `<new stem>/<name>`
and touches nothing else.

## The API for the UI

Everything below is exported from `./index.ts` (types from `../contracts`).

```ts
// ── sign-in ────────────────────────────────────────────────────────────────
export const auth: AuthApi;
interface AuthApi {
  state(): AuthState;
  onChange(listener: (state: AuthState) => void): () => void;
  readonly popupSupported: boolean;            // false on localhost: offer only the token field
  signInWithGithub(): Promise<AuthState>;      // call directly in the tap handler; rejects with AuthError
  cancelSignIn(): void;
  signInWithToken(token: string): Promise<AuthState>;   // rejects with AuthError
  signOut(): void;
  verify(): Promise<AuthState>;
  readonly tokenHelpUrl: string;               // GitHub's "new fine-grained token" page, prefilled
}
interface AuthState {
  status: 'signed-out' | 'signing-in' | 'signed-in';
  user?: { login: string; name?: string; avatarUrl?: string; id?: number };
  method?: 'app' | 'token';
  verified?: boolean;
  expiresAt?: number;
  ended?: { reason: 'expired' | 'revoked'; message: string };
}
class AuthError extends Error {
  reason: 'cancelled' | 'popup-blocked' | 'unsupported-domain' | 'rejected' | 'invalid-token'
        | 'no-push' | 'no-access' | 'offline' | 'rate-limited' | 'failed';
}

// ── publish ────────────────────────────────────────────────────────────────
contentSource.canSave                          // true while signed in (GitHub source)
contentSource.onAuthChange(listener)           // fires when canSave flips or the account changes
contentSource.save(req: SaveRequest): Promise<SaveResult>
interface SaveRequest {
  path: string; raw: string; baseSha?: string; previousPath?: string; message?: string;
  assets?: PendingAsset[]; delete?: boolean; keepImages?: boolean; signal?: AbortSignal;
}
interface SaveResult {
  path: string; sha: string; commitSha?: string; commitUrl?: string; deleted?: boolean;
  commits?: number; assets?: { path: string; sha?: string }[]; removed?: string[]; via?: 'graphql' | 'rest';
}
class SaveConflictError extends Error { path: string; reason: 'changed' | 'exists' | 'missing' | 'branch-moved'; currentSha?: string }
class SaveError extends Error { reason: SaveFailure; partial: boolean; details: { status?; partial?; retryAt?; cause? } }
export function onSaveProgress(listener: (done: number, total: number) => void): () => void;
export function commitMessage(action: 'create' | 'update' | 'delete', collection: CollectionKind, path: string, otherFiles?: number): string;
export function draftAfterSave(draft: DraftRecord, saved: { raw: string; result: SaveResult }, now?: number): DraftRecord | null;

// ── images ─────────────────────────────────────────────────────────────────
interface PendingImage {
  name: string; data: Blob; type: string; size: number; sha?: string; width?: number; height?: number;
  originalName?: string; alt?: string; stripped: boolean; addedAt: number;
}
export const IMAGE_ACCEPT: string;                                     // for <input type="file" accept>
export function hasImages(event: ClipboardEvent | DragEvent): boolean; // sync: decide about preventDefault()
export function imagesFromPaste(event: ClipboardEvent): Promise<ImageEntry[]>;   // call inside the handler
export function imagesFromDrop(event: DragEvent): Promise<ImageEntry[]>;         // call inside the handler
export function intakeImages(input: readonly (File | Blob | ImageEntry)[], options: IntakeOptions): Promise<IntakeResult>;
interface ImageEntry { file?: File | Blob; src?: string; alt?: string; name?: string }
interface IntakeOptions {
  postPath: string; taken?: Iterable<string>; originalQuality?: boolean; maxDimension?: number;
  quality?: number; maxBytes?: number; now?: () => number; env?: ImageEnv | null;
}
interface IntakeResult {
  images: PendingImage[];                       // append to DraftRecord.assets
  inserts: { src: string; alt?: string }[];     // editor.exec('image', insert) for each
  rejected: { name: string; reason: 'not-an-image' | 'unsupported' | 'unreadable' | 'too-large' | 'cannot-strip'; message: string }[];
}
export const pendingImages: {
  sync(draftId: string, postPath: string, images: readonly PendingImage[] | undefined): void;
  keep(repoPath: string, data: Blob): void;
  url(repoPath: string): string | null;
  names(draftId: string): string[];
  clear(draftId?: string): void;
};
export function committedImageNames(postPath: string): string[];       // names in the repo folder (GitHub source, after list())
export function imageFolder(postPath: string): string;                 // src/content/notes/2026/x
export function imagePath(postPath: string, name: string): string;     // src/content/notes/2026/x/pic.png
export function imageRef(postPath: string, name: string): string;      // x/pic.png
export function isImageReferenced(raw: string, postPath: string, name: string): boolean;
export function pendingAssetsFor(postPath: string, images: readonly PendingImage[] | undefined, raw?: string): PendingAsset[];
export function rewriteImageRefs(raw: string, fromPostPath: string, toPostPath: string, names?: Iterable<string>): string;
```

The flows, as the UI would write them:

```ts
// Sign in — in the click handler itself, nothing awaited before the call:
button.onclick = () => auth.signInWithGithub().catch((e: AuthError) => e.reason === 'cancelled' || show(e.message));

// Take images in (paste):
function onPaste(event: ClipboardEvent) {
  if (!hasImages(event)) return;
  event.preventDefault();
  void imagesFromPaste(event).then(async (entries) => {
    const taken = [...committedImageNames(draft.path), ...(draft.assets ?? []).map((a) => a.name)];
    const { images, inserts, rejected } = await intakeImages(entries, { postPath: draft.path, taken });
    draft.assets = [...(draft.assets ?? []), ...images];
    pendingImages.sync(draft.id, draft.path, draft.assets);
    for (const insert of inserts) editor.exec('image', insert);
    rejected.forEach((r) => show(r.message));
  });
}

// Publish:
const raw = composePost(parts, { isNew, newline, finalBreak: finalBreakOf(baseRaw) });
const result = await contentSource.save({
  path, raw, baseSha: isNew ? undefined : draftBase.sha, previousPath: moved ? oldPath : undefined,
  assets: pendingAssetsFor(path, draft.assets, raw),
});
const left = draftAfterSave(draft, { raw, result });      // null: delete the draft; else store it
```

## Contract changes

Made at integration (now in `contracts.ts`): `ContentSource.status()` /
`onStatus()` and `SourceStatus`; `SourceUnavailableError`,
`FrontmatterPatchError` and `DraftStoreError` (this directory's `errors.ts`
re-exports them); `patch` documented as throwing and as placing new keys in
Sveltia's write order; `pathFor` documented as for new posts only;
`FieldSpec.default`. The Review screen now consumes `reviewDiff` /
`inlineDiff` from here (through `ui/lib/diff.ts`).

Made after the pre-release review: `SaveConflictError`,
`ContentSource.onAuthChange`, `DraftRecord.conflict` and `.rev`,
`DraftConflictError`, `DraftWriteOptions` (`expectedRev`), `DraftEvent.origin`,
`put` resolving with the new `rev`; `Eol` gained `'cr'`. New helpers exported
from `index.ts`: `resolveDraft`, `composePost`, `finalBreakOf`, `newlineOf`.

Made with sign-in, publish and images:

- **New:** `AUTH_WORKER_ORIGIN`, `AUTH_STORAGE_KEY`; the auth contract (`AuthApi`, `AuthState`,
  `AuthUser`, `AuthMethod`, `AuthError`, `AuthFailure`); `PendingImage`; `SaveError` / `SaveFailure`.
- **`SaveRequest`** gained `delete`, `keepImages`, `signal`; its doc now says how a save is made
  (`createCommitOnBranch`, REST Git Data fallback — the earlier text said "contents API", which makes
  one commit per file and cannot carry images with a post). **`SaveResult`** gained `deleted`,
  `commits`, `assets`, `removed`, `via`.
- **`SaveConflictError.reason`** gained `'branch-moved'`.
- **`DraftRecord.assets?: PendingImage[]`**; `DraftSummary.images?`, and `dirty` is also true while
  images wait.
- **`ContentSource`**: no new members (existing test doubles keep compiling). `canSave`, `save`,
  `onAuthChange` and `resolveAssetUrl` are re-documented; deleting goes through `save`.
- **`pathFor`**: the year stays the UTC year of `created`. For a post written here that IS the moment
  of first save, which is what Sveltia uses; the two differ only for a back-dated new post, and then
  the folder follows the date the post shows. Never applied to an existing post.
- **`ReadOnlyError`** now means "this source cannot write right now" (signed out, or the working
  tree), not "v0".

## Running the tests

```sh
bunx vitest run src/write/data            # unit tests (node; fake-indexeddb for drafts; github/__tests__/fake-github.ts is a pretend GitHub)
bunx vitest run src/write/data --silent=false   # same, printing the counts
WRITE_PORT=4310 bunx playwright test tests/write/e2e/data.spec.ts   # browser tests against the dev server
```
