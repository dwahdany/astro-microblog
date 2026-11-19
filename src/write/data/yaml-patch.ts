/**
 * Range-based frontmatter patching.
 *
 * The YAML block is parsed (with the `yaml` Document API) only to LOCATE
 * things: where each top-level key starts, where its value sits, which lines
 * it owns. The edit itself is a text splice on the original string, so every
 * byte outside the touched key is carried over untouched — order, quoting,
 * comments, blank lines, flow-vs-block lists, indentation, line endings.
 *
 * Three kinds of splice:
 *   - one-line scalar → one-line scalar: only the value's characters are
 *     replaced (`title: "Old"   # note` → `title: "New"   # note`); likewise a
 *     one-line flow list or map that stays one (`tags: [a, b] # note`);
 *   - anything else on an existing key: everything after `key:` up to the end
 *     of the key's last line is re-rendered (in the old value's style);
 *   - a new key: whole line(s) inserted after the nearest preceding key of
 *     `order` that is present (else before the nearest following one, else at
 *     the end); a removed key: its lines deleted.
 *
 * Nothing is trusted blindly: the result is re-parsed and must (1) be valid,
 * (2) hold exactly the old data with the changes applied, (3) keep the other
 * keys in order and (4) keep every untouched key's text byte-identical —
 * otherwise `FrontmatterPatchError` is thrown and the caller keeps the
 * original. There is no "reprint the document" fallback on purpose.
 */
import { isMap, isScalar, isSeq, parseDocument, type Document, type Node } from 'yaml';
import type { FrontmatterPatch, FrontmatterValue } from '../contracts';
import { FrontmatterPatchError } from './errors';
import { DEFAULT_DATE_KEYS, buildNode, deepEqual, renderPair, type BuildContext, type RenderStyle } from './yaml-render';

export interface YamlPatchOptions {
  /** Preferred order of keys, used to place keys that are added (Sveltia's field order). */
  order?: readonly string[];
  /** Keys whose string values are timestamps and must stay unquoted. */
  dateKeys?: ReadonlySet<string>;
  /** Line break for added text when the block has no line break of its own. */
  newline?: '\n' | '\r\n';
}

interface Entry {
  name: string;
  /** Start of the key's first line. */
  ownStart: number;
  /** End of the key's last line, including its line break. */
  ownEnd: number;
  keyStart: number;
  /** Offset of the `:` after the key, or -1 when the pair uses a form we do not splice into. */
  colon: number;
  node: Node | null;
}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function lineStart(src: string, pos: number): number {
  const i = src.lastIndexOf('\n', pos - 1);
  return i < 0 ? 0 : i + 1;
}

/** Offset just past the line break ending the line that contains `pos` (or end of text). */
function lineEnd(src: string, pos: number): number {
  const i = src.indexOf('\n', pos);
  return i < 0 ? src.length : i + 1;
}

/** `end` minus a trailing line break (`\n` or `\r\n`), if there is one. */
function beforeBreak(src: string, end: number): number {
  if (end > 0 && src[end - 1] === '\n') return end > 1 && src[end - 2] === '\r' ? end - 2 : end - 1;
  return end;
}

function firstLine(message: string): string {
  return message.split('\n')[0];
}

function locate(src: string, doc: Document.Parsed): Entry[] {
  const contents = doc.contents;
  if (contents === null) return [];
  if (!isMap(contents) || contents.flow)
    throw new FrontmatterPatchError('The frontmatter is not a list of `key: value` lines, so properties cannot be edited here.', 'shape');

  const entries: Entry[] = [];
  for (const pair of contents.items) {
    const key = pair.key;
    if (!isScalar(key) || !key.range) {
      throw new FrontmatterPatchError('The frontmatter uses a key form this editor cannot edit safely.', 'shape');
    }
    const keyStart = key.range[0];
    const ownStart = lineStart(src, keyStart);
    const node = (pair.value ?? null) as Node | null;

    // `key:` on one line, nothing but indentation before the key (rules out `? key`).
    let colon = -1;
    if (/^[ \t]*$/.test(src.slice(ownStart, keyStart))) {
      let i = key.range[1];
      while (src[i] === ' ' || src[i] === '\t') i++;
      if (src[i] === ':') colon = i;
    }

    let valueEnd = node?.range ? node.range[1] : keyStart;
    if (colon >= 0) valueEnd = Math.max(valueEnd, colon + 1);
    // Block values end just after their last line break; everything else ends mid-line.
    const ownEnd = valueEnd > 0 && src[valueEnd - 1] === '\n' && valueEnd > colon + 1 ? valueEnd : lineEnd(src, valueEnd);
    entries.push({ name: String(key.value), ownStart, ownEnd, keyStart, colon, node });
  }

  for (let i = 1; i < entries.length; i++) {
    if (entries[i].ownStart < entries[i - 1].ownEnd)
      throw new FrontmatterPatchError('The frontmatter puts several keys on one line; edit the YAML directly.', 'shape');
  }
  return entries;
}

function isInlineValue(value: FrontmatterValue): value is string | number | boolean | null {
  if (value === null) return true;
  if (typeof value === 'string') return !/[\r\n]/.test(value);
  return typeof value === 'number' || typeof value === 'boolean';
}

/** The existing value is a single-line scalar (or empty) without tag or anchor. */
function isInlineNode(src: string, node: Node | null): boolean {
  if (node === null) return true;
  if (!isScalar(node) || !node.range) return false;
  if (node.tag !== undefined || node.anchor !== undefined) return false;
  if (node.type !== undefined && node.type !== 'PLAIN' && node.type !== 'QUOTE_SINGLE' && node.type !== 'QUOTE_DOUBLE') return false;
  return !src.slice(node.range[0], node.range[1]).includes('\n');
}

function styleOf(src: string, entry: Entry): RenderStyle {
  const node = entry.node;
  if (!node?.range || !(isSeq(node) || isMap(node)) || node.items.length === 0) return {};
  if (node.flow) return { flowPadding: src[node.range[0] + 1] === ' ' };
  const keyCol = entry.keyStart - entry.ownStart;
  const itemCol = node.range[0] - lineStart(src, node.range[0]);
  if (isSeq(node)) return itemCol > keyCol ? { indent: itemCol - keyCol, indentSeq: true } : { indentSeq: false };
  return itemCol > keyCol ? { indent: itemCol - keyCol } : {};
}

function toData(doc: Document.Parsed, reason: 'syntax' | 'verify'): Record<string, unknown> {
  if (doc.contents === null) return {};
  try {
    return doc.toJS() as Record<string, unknown>;
  } catch (err) {
    // e.g. an alias whose anchor does not exist
    throw new FrontmatterPatchError(`The frontmatter cannot be read: ${firstLine(String((err as Error).message ?? err))}`, reason);
  }
}

interface Edit {
  from: number;
  to: number;
  text: string;
}

export function patchYaml(src: string, changes: FrontmatterPatch, options: YamlPatchOptions = {}): string {
  const doc = parseDocument(src);
  if (doc.errors.length > 0) {
    throw new FrontmatterPatchError(
      `The frontmatter has a YAML error, so properties cannot be edited safely: ${firstLine(doc.errors[0].message)}`,
      'syntax',
    );
  }
  const entries = locate(src, doc);
  const data = toData(doc, 'syntax');

  const effective = Object.entries(changes).filter(([key, value]) =>
    value === undefined ? own(data, key) : !own(data, key) || !deepEqual(data[key], value),
  );
  if (effective.length === 0) return src;

  const nl = src.includes('\r\n') ? '\r\n' : src.includes('\n') ? '\n' : (options.newline ?? '\n');
  const indent = entries.length > 0 ? src.slice(entries[0].ownStart, entries[0].keyStart) : '';
  const order = options.order ?? [];
  const ctx: BuildContext = { dateKeys: options.dateKeys ?? DEFAULT_DATE_KEYS, doc };
  const byName = new Map(entries.map((e) => [e.name, e]));
  const removed = new Set(effective.filter(([, v]) => v === undefined).map(([k]) => k));
  const rankOf = (key: string) => {
    const i = order.indexOf(key);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };

  /** `as` is the key printed; `key` is the real one (it decides date handling). */
  const render = (as: string, key: string, value: FrontmatterValue, old: Node | null, style: RenderStyle): string => {
    try {
      return renderPair(as, buildNode(value, key, old, ctx), style);
    } catch (err) {
      throw new FrontmatterPatchError(`Could not write “${key}”: ${firstLine(String((err as Error).message ?? err))}`, 'verify', key);
    }
  };
  /** Indent continuation lines (and optionally the first) when the mapping itself is indented. */
  const indented = (text: string, firstToo: boolean) =>
    indent === '' ? text : text.replace(firstToo ? /^(?=[^\n])/gm : /\n(?=[^\n])/g, firstToo ? indent : '\n' + indent);

  const edits: Edit[] = [];
  /** Whole lines to insert, by offset. */
  const inserts = new Map<number, { rank: number; text: string }[]>();
  /** Where each key added in this patch went, so later additions can follow it. */
  const placed = new Map<string, number>();

  // Additions are placed in `order`, so a key can anchor on one added just before it.
  const sorted = [...effective].sort((a, b) => rankOf(a[0]) - rankOf(b[0]));

  for (const [key, value] of sorted) {
    const entry = byName.get(key);

    if (value === undefined) {
      if (entry) edits.push({ from: entry.ownStart, to: entry.ownEnd, text: '' });
      continue;
    }

    if (entry) {
      if (entry.colon < 0)
        throw new FrontmatterPatchError(`“${key}” is written in a form this editor cannot edit safely.`, 'shape', key);

      if (isInlineValue(value) && isInlineNode(src, entry.node)) {
        const line = render('k', key, value, entry.node, {});
        const text = line.slice(3, -1); // strip "k: " and the final "\n"
        if (line.startsWith('k: ') && !text.includes('\n')) {
          const range = entry.node?.range;
          if (range && range[1] > range[0]) edits.push({ from: range[0], to: range[1], text });
          else edits.push({ from: entry.colon + 1, to: entry.colon + 1, text: ' ' + text });
          continue;
        }
      }

      const rendered = render('k', key, value, entry.node, styleOf(src, entry));
      const rest = rendered.slice(2).replace(/\n$/, ''); // after "k:", without the final break

      // A flow collection written on one line (`tags: [a, b] # note`) that stays one: replace the
      // brackets and what is in them, nothing after — a comment on the line is not the value's.
      const node = entry.node;
      if (node?.range && (isSeq(node) || isMap(node)) && node.flow && node.tag === undefined && node.anchor === undefined) {
        const [from, to] = node.range;
        const flowText = rest.startsWith(' ') ? rest.slice(1) : rest;
        if (to > from && !src.slice(from, to).includes('\n') && !flowText.includes('\n') && /^[[{]/.test(flowText)) {
          edits.push({ from, to, text: flowText });
          continue;
        }
      }
      edits.push({ from: entry.colon + 1, to: beforeBreak(src, entry.ownEnd), text: indented(rest, false) });
      continue;
    }

    // A new key.
    const text = indented(render(key, key, value, null, {}), true);
    const rank = rankOf(key);
    let at = src.length;
    if (rank !== Number.MAX_SAFE_INTEGER) {
      let found = false;
      for (let i = rank - 1; i >= 0 && !found; i--) {
        const before = order[i];
        const anchor = byName.get(before);
        if (anchor && !removed.has(before)) {
          at = anchor.ownEnd;
          found = true;
        } else if (placed.has(before)) {
          at = placed.get(before)!;
          found = true;
        }
      }
      for (let i = rank + 1; i < order.length && !found; i++) {
        const after = byName.get(order[i]);
        if (after && !removed.has(order[i])) {
          at = after.ownStart;
          found = true;
        }
      }
    }
    placed.set(key, at);
    const group = inserts.get(at) ?? [];
    group.push({ rank, text });
    inserts.set(at, group);
  }

  // Lines inserted at the same offset go in as one block, in `order`.
  for (const [at, group] of inserts) {
    let text = group
      .sort((a, b) => a.rank - b.rank)
      .map((g) => g.text)
      .join('');
    // After an unterminated last line, break the line first.
    if (at > 0 && src[at - 1] !== '\n') text = '\n' + text;
    edits.push({ from: at, to: at, text });
  }

  // Apply back to front so earlier offsets stay valid. At a shared offset the
  // replacement/deletion (to > from) is applied before the insert lands in front of it.
  edits.sort((a, b) => b.from - a.from || b.to - a.to);
  let out = src;
  for (const edit of edits) {
    const text = nl === '\n' ? edit.text : edit.text.replace(/\n/g, nl);
    out = out.slice(0, edit.from) + text + out.slice(edit.to);
  }

  verify(src, out, entries, data, effective);
  return out;
}

function verify(
  src: string,
  out: string,
  before: Entry[],
  data: Record<string, unknown>,
  effective: [string, FrontmatterValue | undefined][],
): void {
  const fail = (why: string): never => {
    throw new FrontmatterPatchError(`The change could not be applied safely (${why}). Nothing was changed.`, 'verify');
  };
  const doc = parseDocument(out);
  if (doc.errors.length > 0) fail(firstLine(doc.errors[0].message));

  const expected: Record<string, unknown> = { ...data };
  const touched = new Set<string>();
  for (const [key, value] of effective) {
    touched.add(key);
    if (value === undefined) delete expected[key];
    else expected[key] = value;
  }
  let actual: Record<string, unknown>;
  try {
    actual = toData(doc, 'verify');
  } catch (err) {
    actual = fail(firstLine((err as Error).message));
  }
  if (!deepEqual(actual, expected)) fail('the result does not hold the expected values');

  const after = locate(out, doc);
  const untouchedBefore = before.filter((e) => !touched.has(e.name));
  const untouchedAfter = after.filter((e) => !touched.has(e.name));
  if (untouchedBefore.length !== untouchedAfter.length) fail('other keys were affected');
  for (let i = 0; i < untouchedBefore.length; i++) {
    const a = untouchedBefore[i];
    const b = untouchedAfter[i];
    if (a.name !== b.name) fail('key order changed');
    if (src.slice(a.ownStart, beforeBreak(src, a.ownEnd)) !== out.slice(b.ownStart, beforeBreak(out, b.ownEnd)))
      fail(`“${a.name}” would have been rewritten`);
  }
}
