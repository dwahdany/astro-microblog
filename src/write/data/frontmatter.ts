/**
 * The `FrontmatterApi` of the contract, assembled from the modules that do the
 * work:
 *
 *   split / eol                 ./split.ts        exact text slices
 *   parse / describe / slugify  ./describe.ts     YAML → data, list entries
 *   patch                       ./yaml-patch.ts   range-based edits of single keys
 *   fields / validate           ./fields.ts       per-collection field tables
 *   scaffold                    ./scaffold.ts     new posts in Sveltia's shape
 *
 * See ./README.md for the guarantees and how they are tested.
 */
import type { CollectionKind, FrontmatterApi, FrontmatterPatch, PostParts } from '../contracts';
import { describe, parse, pathFor, slugify } from './describe';
import { fieldDefs, validate, writeOrder } from './fields';
import { scaffold } from './scaffold';
import { FrontmatterPatchError } from './errors';
import { eol, newlineOf, split } from './split';
import { patchYaml } from './yaml-patch';

/**
 * Apply key changes to the frontmatter slice.
 *
 * Returns the SAME object when nothing effectively changes. Otherwise only
 * `frontmatter` differs — except for a file that had no frontmatter block, for
 * which the fences (and a blank line before an existing body) are created
 * with the file's own line ending.
 *
 * New keys go where Sveltia would write them (`writeOrder(collection)`, the
 * field order of public/admin/config.yml); without a collection, or for keys
 * no collection knows, they are appended.
 *
 * Throws `FrontmatterPatchError` (./errors.ts) when the YAML does not parse
 * or the edit cannot be proven safe; the input is never partially changed.
 */
const LONE_CR = /\r(?!\n)/;

function patch(parts: PostParts, changes: FrontmatterPatch, collection?: CollectionKind): PostParts {
  const hasBlock = parts.open !== '';
  const fileBreak = hasBlock ? (parts.open.endsWith('\r\n') ? '\r\n' : parts.open.endsWith('\r') ? '\r' : '\n') : newlineOf(parts.body);
  // Bare CR line endings (old Mac) in the block: the YAML locator works in `\n` lines and would
  // splice in the wrong place (it once swallowed the CR before the closing fence). Refuse instead.
  const bareCr = fileBreak === '\r' || LONE_CR.test(parts.open + parts.frontmatter + parts.close);
  const refuse = () =>
    new FrontmatterPatchError(
      'This file uses bare CR line endings (old Mac style), which properties cannot be edited with safely. Convert the line endings in the file first.',
      'shape',
    );
  const nl = fileBreak === '\r' ? '\n' : fileBreak;
  let next: string;
  try {
    next = patchYaml(parts.frontmatter, changes, {
      order: collection ? writeOrder(collection) : undefined,
      newline: nl,
    });
  } catch (err) {
    throw bareCr ? refuse() : err;
  }
  if (next === parts.frontmatter) return parts;
  if (bareCr) throw refuse();
  if (hasBlock) return { ...parts, frontmatter: next };
  return {
    ...parts,
    open: '---' + nl,
    frontmatter: next,
    close: '---' + nl,
    gap: parts.body === '' ? '' : nl,
  };
}

export const frontmatter: FrontmatterApi = {
  split,
  eol,
  parse,
  patch,
  fields: fieldDefs,
  validate,
  scaffold,
  pathFor,
  slugify,
  describe,
};
