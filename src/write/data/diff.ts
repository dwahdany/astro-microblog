/**
 * Line diff for "Review changes": the original file against the current text.
 *
 * Built for a byte-honest review, not for patch files:
 *   - lines are compared INCLUDING their line break, so a CRLF→LF change or a
 *     final newline that appeared/disappeared shows up (flagged `invisible`
 *     when a removed/added pair differs only in whitespace or line break);
 *   - `changed` is `base !== current` — when the texts are identical there is
 *     nothing to show, byte for byte, and no hunks;
 *   - a new post (`base === null`) is one hunk of additions.
 */
import { diffArrays, diffWordsWithSpace } from 'diff';
import { split } from './split';

export interface DiffLine {
  kind: 'context' | 'add' | 'del';
  /** The line without its line break. */
  text: string;
  /** The line break that ended it: '\n', '\r\n', '\r', or '' for a last line without one. */
  eol: string;
  /** 1-based line number in the original (context, del). */
  oldLine?: number;
  /** 1-based line number in the current text (context, add). */
  newLine?: number;
  /**
   * For a del/add pair that reads the same on screen: what actually differs.
   * 'eol' = only the line break, 'whitespace' = only spaces/tabs.
   */
  invisible?: 'eol' | 'whitespace';
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface ReviewDiff {
  /** `base !== current`. False ⇔ byte-identical ⇔ no hunks. */
  changed: boolean;
  /** No original: a new post. */
  isNew: boolean;
  added: number;
  removed: number;
  frontmatterChanged: boolean;
  bodyChanged: boolean;
  hunks: DiffHunk[];
}

export interface ReviewDiffOptions {
  /** Unchanged lines shown around each change. Default 2. */
  context?: number;
}

/** Split into lines, each keeping its line break. '' → []. */
export function linesOf(text: string): string[] {
  return text === '' ? [] : (text.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) ?? []);
}

function cut(line: string): { text: string; eol: string } {
  const m = /(\r\n|\n|\r)$/.exec(line);
  return m ? { text: line.slice(0, -m[1].length), eol: m[1] } : { text: line, eol: '' };
}

export function reviewDiff(base: string | null, current: string, options: ReviewDiffOptions = {}): ReviewDiff {
  const context = Math.max(0, options.context ?? 2);
  const before = base ?? '';
  const changed = base === null || before !== current;
  const result: ReviewDiff = {
    changed,
    isNew: base === null,
    added: 0,
    removed: 0,
    frontmatterChanged: false,
    bodyChanged: false,
    hunks: [],
  };
  if (!changed) return result;

  const a = split(before);
  const b = split(current);
  result.bodyChanged = a.body !== b.body;
  result.frontmatterChanged = before.slice(0, before.length - a.body.length) !== current.slice(0, current.length - b.body.length);

  // Flat list of lines with their kind and numbers.
  const all: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;
  for (const part of diffArrays(linesOf(before), linesOf(current))) {
    for (const line of part.value) {
      const { text, eol } = cut(line);
      if (part.added) {
        all.push({ kind: 'add', text, eol, newLine: newLine++ });
        result.added++;
      } else if (part.removed) {
        all.push({ kind: 'del', text, eol, oldLine: oldLine++ });
        result.removed++;
      } else all.push({ kind: 'context', text, eol, oldLine: oldLine++, newLine: newLine++ });
    }
  }

  // Pair up removed/added runs of equal length to flag changes the eye cannot see.
  for (let i = 0; i < all.length; ) {
    if (all[i].kind !== 'del') {
      i++;
      continue;
    }
    let d = i;
    while (d < all.length && all[d].kind === 'del') d++;
    let e = d;
    while (e < all.length && all[e].kind === 'add') e++;
    if (d - i === e - d) {
      for (let k = 0; k < d - i; k++) {
        const del = all[i + k];
        const add = all[d + k];
        if (del.text === add.text) del.invisible = add.invisible = 'eol';
        else if (del.text.replace(/[ \t]+/g, '') === add.text.replace(/[ \t]+/g, '')) del.invisible = add.invisible = 'whitespace';
      }
    }
    i = e;
  }

  // Group into hunks with `context` unchanged lines around changes.
  const keep = new Array<boolean>(all.length).fill(false);
  all.forEach((line, i) => {
    if (line.kind === 'context') return;
    for (let k = Math.max(0, i - context); k <= Math.min(all.length - 1, i + context); k++) keep[k] = true;
  });
  let hunk: DiffHunk | null = null;
  all.forEach((line, i) => {
    if (!keep[i]) {
      hunk = null;
      return;
    }
    if (!hunk) {
      // Start numbers follow unified-diff convention: the first line of the hunk on each side.
      const nextOld = line.oldLine ?? all.slice(i).find((l) => l.oldLine !== undefined)?.oldLine ?? oldLine;
      const nextNew = line.newLine ?? all.slice(i).find((l) => l.newLine !== undefined)?.newLine ?? newLine;
      hunk = { oldStart: nextOld, oldLines: 0, newStart: nextNew, newLines: 0, lines: [] };
      result.hunks.push(hunk);
    }
    hunk.lines.push(line);
    if (line.kind !== 'add') hunk.oldLines++;
    if (line.kind !== 'del') hunk.newLines++;
  });
  return result;
}

export interface InlineSegment {
  kind: 'same' | 'add' | 'del';
  text: string;
}

/** Word-level differences between a removed line and the line that replaced it, for highlighting inside the pair. */
export function inlineDiff(oldText: string, newText: string): InlineSegment[] {
  return diffWordsWithSpace(oldText, newText).map((part) => ({
    kind: part.added ? 'add' : part.removed ? 'del' : 'same',
    text: part.value,
  }));
}
