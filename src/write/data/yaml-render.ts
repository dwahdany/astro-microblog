/**
 * Rendering YAML for the few lines this app writes itself: a changed value, a
 * new key, a scaffolded post.
 *
 * The output style is Sveltia CMS's, because that is what wrote most of the
 * existing files and what `/admin` keeps writing: the `yaml` package with
 * `lineWidth: 0` (never fold), plain scalars where possible, single quotes
 * otherwise (`title: ''`, `link_title: 'DPPL: Differentially…'`), block lists
 * indented by two (`tags:\n  - ai`), `[]` for an empty list, `null` for null.
 * __tests__/patch.test.ts checks this by removing and re-adding keys of the
 * real Sveltia-written files and comparing bytes.
 *
 * Where an existing value is being replaced, its own style wins instead
 * (quote type, flow vs block list, list indentation), and unchanged list
 * items / map entries are re-used as parsed nodes so their quoting, number
 * format (`0.230`) and comments survive.
 */
import { Document, Pair, Scalar, YAMLMap, YAMLSeq, isAlias, isMap, isNode, isScalar, isSeq, type Node } from 'yaml';
import type { FrontmatterValue } from '../contracts';

export interface RenderStyle {
  /** Spaces per nesting level (and of block-list items under their key). Default 2. */
  indent?: number;
  /** `false` renders `tags:\n- a` instead of `tags:\n  - a`. Default true. */
  indentSeq?: boolean;
  /** `[ a, b ]` instead of `[a, b]`. Default false. */
  flowPadding?: boolean;
}

export interface BuildContext {
  /** Keys whose string values are timestamps and stay unquoted (`created`, `taken_at`, `date`). */
  dateKeys: ReadonlySet<string>;
  /** Parsed document the `old` nodes belong to; needed to read their values for re-use. */
  doc?: Document.Parsed;
}

export const DEFAULT_DATE_KEYS: ReadonlySet<string> = new Set(['created', 'taken_at', 'date']);

/**
 * Strings that the `yaml` package (YAML 1.2 core) writes unquoted but that the
 * SITE's parser (js-yaml, used by Astro) would read back as a Date or a
 * number: `2026-01-01`, `2026-04-22T12:00:00+00:00`, `0b11`, `1_000`. A title
 * like that must be quoted or the content schema rejects the post. Date
 * fields are exempt — there the unquoted timestamp is exactly what is wanted.
 */
const YAML11_TIMESTAMP =
  /^\d{4}-\d\d?-\d\d?(?:(?:[Tt]|[ \t]+)\d\d?:\d\d:\d\d(?:\.\d*)?(?:[ \t]*(?:Z|[-+]\d\d?(?::?\d\d)?))?)?$/;
const YAML11_NUMBER =
  /^[-+]?(?:0b[01_]+|0x[0-9a-fA-F_]+|0o?[0-7_]+|[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9_]+(?:[eE][-+]?[0-9]+)?)$/;

export function ambiguousForSiteParser(value: string): boolean {
  return YAML11_TIMESTAMP.test(value) || YAML11_NUMBER.test(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(b, k) &&
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

function jsOf(node: unknown, ctx: BuildContext): unknown {
  if (!isNode(node) || isAlias(node)) return NO_VALUE;
  try {
    return ctx.doc ? node.toJS(ctx.doc) : NO_VALUE;
  } catch {
    return NO_VALUE;
  }
}
const NO_VALUE = Symbol('no value');

function stringScalar(value: string, key: string | undefined, old: unknown, ctx: BuildContext): Scalar {
  const scalar = new Scalar(value);
  const oldType = isScalar(old) ? old.type : undefined;
  const multiline = /[\r\n]/.test(value);
  if (oldType === 'QUOTE_DOUBLE') scalar.type = 'QUOTE_DOUBLE';
  else if (oldType === 'QUOTE_SINGLE' && !multiline) scalar.type = 'QUOTE_SINGLE';
  else if (multiline && (oldType === 'BLOCK_LITERAL' || oldType === 'BLOCK_FOLDED')) scalar.type = 'BLOCK_LITERAL';
  else if (!multiline && ambiguousForSiteParser(value) && !(key !== undefined && ctx.dateKeys.has(key)))
    scalar.type = 'QUOTE_SINGLE';
  return scalar;
}

/**
 * A YAML node for `value`. `old` is the node currently in that position (if
 * any): returned as-is when it already holds the value, otherwise mined for
 * style.
 */
export function buildNode(value: FrontmatterValue, key: string | undefined, old: unknown, ctx: BuildContext): Node {
  if (isNode(old) && !isAlias(old) && deepEqual(jsOf(old, ctx), value)) return old;

  if (value === null) return new Scalar(null);
  if (typeof value === 'string') return stringScalar(value, key, old, ctx);
  if (typeof value === 'number' || typeof value === 'boolean') return new Scalar(value);

  if (Array.isArray(value)) {
    const seq = new YAMLSeq();
    const oldItems = isSeq(old) ? [...old.items] : [];
    if (isSeq(old) && old.flow && old.items.length > 0) seq.flow = true;
    seq.items = value.map((item) => {
      // Re-use the first not-yet-taken old item with this value (keeps its quoting and comments).
      const at = oldItems.findIndex((node) => node !== undefined && deepEqual(jsOf(node, ctx), item));
      if (at >= 0) {
        const node = oldItems[at] as Node;
        oldItems[at] = undefined;
        return node;
      }
      return buildNode(item, key, undefined, ctx);
    });
    return seq;
  }

  const map = new YAMLMap();
  if (isMap(old) && old.flow && old.items.length > 0) map.flow = true;
  const oldPairs = new Map<string, Pair>();
  if (isMap(old)) for (const pair of old.items) if (isScalar(pair.key)) oldPairs.set(String(pair.key.value), pair as Pair);
  // Surviving keys keep their old order; new keys follow in the order given.
  const keys = [
    ...[...oldPairs.keys()].filter((k) => Object.prototype.hasOwnProperty.call(value, k)),
    ...Object.keys(value).filter((k) => !oldPairs.has(k)),
  ];
  for (const k of keys) {
    const oldPair = oldPairs.get(k);
    const child = buildNode(value[k], k, oldPair?.value, ctx);
    map.items.push(new Pair(oldPair ? oldPair.key : new Scalar(k), child));
  }
  return map;
}

/** `key: value\n` (possibly several lines), LF line breaks, no leading indentation. */
export function renderPair(key: string, value: Node, style: RenderStyle = {}): string {
  const map = new YAMLMap();
  map.items.push(new Pair(new Scalar(key), value));
  return new Document(map).toString({
    lineWidth: 0,
    singleQuote: true,
    indent: style.indent ?? 2,
    indentSeq: style.indentSeq ?? true,
    flowCollectionPadding: style.flowPadding ?? false,
  });
}

/** A whole mapping in Sveltia's style, for scaffolding. `entries` order is the key order. */
export function renderMapping(
  entries: readonly (readonly [key: string, value: FrontmatterValue])[],
  ctx: BuildContext = { dateKeys: DEFAULT_DATE_KEYS },
): string {
  return entries.map(([key, value]) => renderPair(key, buildNode(value, key, undefined, ctx))).join('');
}
