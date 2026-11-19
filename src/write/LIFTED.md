# Code lifted from Sveltia CMS

Parts of `src/write/data/github/` and `src/write/data/assets/` are adapted copies of modules from
[Sveltia CMS](https://github.com/sveltia/sveltia-cms) (the owner's fork `dwahdany/sveltia-cms`),
taken at commit **`06d5552aa`**. Sveltia CMS is MIT-licensed, "Copyright (c) 2026 Kohei Yoshino";
the full licence text is in [`licenses/sveltia-MIT.txt`](licenses/sveltia-MIT.txt) and must stay
with the app (link it from the settings screen: a minified bundle does not keep header comments).

Every lifted file starts with a comment naming the upstream repo, the commit, the source path, the
copyright line and what was changed. This table is the same information in one place, so upstream
fixes can be found:

```sh
cd ~/git/personal/sveltia-cms
git diff 06d5552aa..upstream/main -- src/lib/services/utils/networking.js   # (any path from the table)
```

Source paths are relative to `src/lib/services/` in the Sveltia repo; target paths to `src/write/`.

| Target | Source (lines at `06d5552aa`) | How close |
| --- | --- | --- |
| `data/github/http.ts` | `utils/networking.js` (whole file) | Near verbatim. TypeScript; `sleep`/`isObject` inlined; injectable `fetch`/wait; typed `RequestError` (same message strings and `cause` shape); the caller's `init` is copied, not mutated; an abort stays an abort; `fetchOK`, `assertResponseOK` dropped. |
| `data/github/auth.ts` | `backends/git/shared/auth.js` (63-84, 136-144, 163-298, 310-339); `backends/git/github/auth.js` (19-38) | Adapted. GitHub only; BroadcastChannel/`state` branch, `_()`, `createRawState`, Gitea check dropped; injectable window; typed `AuthError`; result carries refresh token and lifetimes; synchronous up to `window.open`. |
| `data/github/session.ts` | conventions of `backends/git/shared/user.js` (24-54) and `backends/git/shared/api.js` (49-257) | New code following those conventions: validate with `GET /user`; one shared refresh; Web Lock across tabs; adopt tokens another tab stored. The refresh request itself goes to the auth worker (`POST /refresh`), not to GitHub. |
| `data/github/client.ts` | replaces `backends/git/shared/api.js` (274-379); `isRateLimited` from `backends/git/github/repository.js` (46-49) | New, except `isRateLimited` (lifted). |
| `data/github/concurrency.ts` | `backends/git/shared/concurrency.js` (whole file) | Verbatim plus types. |
| `data/github/read.ts` | `backends/git/github/files.js` (46-126: tree listing with the truncated fallback; 212-233: raw blob) | Adapted: client as argument, one directory, bytes instead of `response.text()`. The head is read with REST `git/ref`, NOT Sveltia's GraphQL query (`github/commits.js` 42-89 was not lifted). The bulk GraphQL text fetch (`files.js` 159-170, `graphql.js` 18-85) was not lifted: post text comes from raw.githubusercontent.com, as before. |
| `data/github/commit-split.ts` | `backends/git/shared/commit-split.js` (whole file) | Verbatim plus types; `data` is `string \| Uint8Array` instead of `string \| Blob`; `toSorted` → copy + sort. |
| `data/github/commit.ts` | `backends/git/github/commits.js` (95-176, 192-258, 272-396); `backends/git/shared/commits.js` (18-25, 58-61, 115-117, 328-337) | GraphQL path adapted: arguments instead of module singletons, progress callback, workflow/fork/sign-off dropped, base64 inlined, typed `BranchMovedError` / `PartialCommitError`. Commit message templates and single-pass `fillTemplate` lifted. **The REST fallback (`commitWithRest`) and `createCommitter` are new.** |
| `data/github/save.ts` | reference only: `backends/save.js` (161-293), `contents/draft/save/assets.js`, `assets/entry-folder.js` (99-101) | New code. |
| `data/assets/sniff.ts` | `utils/media/image/sniff.js` (whole file) | Verbatim plus types. `isSvg` is new. |
| `data/assets/animation.ts` | `utils/media/image/animation.js` (whole file) | Verbatim plus types. |
| `data/assets/transform.ts` | `utils/media/image/resize.js` (`calculateResize`); sequence of `transform.js` (169-218) and `encode.js` | `calculateResize` lifted. The rest is rewritten around an injectable `ImageEnv`: no UNPKG `loadModule`, no jSquash, no HEIC decoder, no SVGO; JPEG/PNG fallback for a type the browser cannot write; output type follows the source. |
| `data/assets/names.ts` | `utils/file.js` (26-45 `encodeFilePath`, 54-84 `renameIfNeeded`); `encodeRFC3986` from `utils/url.js` | Those two lifted, helpers inlined. `sanitizeImageName`, `timestampName`, the path helpers and `rewriteImageRefs` are new. |
| `data/assets/intake.ts` | `contents/fields/rich-text/images.js` (98-208) | `imagesFromPaste` / `imagesFromDrop` adapted: the event is only read (no `clear()`, no `stopPropagation()`); any `image/*` file is passed on; naming moved to the pipeline. `intakeImages` is new. |
| `data/assets/pending.ts` | — | New code. |

Not lifted (the plan listed them as optional or conditional):

- `utils/media/image/validate.js` — its check (decode before accepting) is what `intakeImages` does
  by re-encoding; nothing is accepted undecoded except through the original-quality switch.
- `utils/media/image/svg.js`, `assets/info.js` (inert SVG preview) — SVG is not taken in.
- `utils/file.js` 243-272 (`getGitHash`) — `data/git-sha.ts` already computes git blob ids.
- Row 15 of the plan (drawer, modal, toast, link helper from `sveltia-ui`) — belongs to `ui/` and `editor/`.

Tests: the upstream `*.test.js` files were used as the checklist for
`data/github/__tests__/{http,commit}.test.ts` and `data/assets/__tests__/assets.test.ts`; they were
rewritten against the adapted signatures rather than copied.
