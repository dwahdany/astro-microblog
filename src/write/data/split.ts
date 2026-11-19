/**
 * Cutting a post file into exact text slices (`PostParts`).
 *
 * `assemblePost(split(raw)) === raw` for EVERY string: nothing is trimmed,
 * decoded or re-encoded, the slices are plain `slice()`s of the input. Tested
 * against every file under src/content plus constructed edge cases
 * (__tests__/split.test.ts).
 *
 * What counts as frontmatter matches what Astro (gray-matter style) accepts:
 * a `---` line at the very start of the file (after an optional BOM) and the
 * next line that is exactly `---` (trailing spaces/tabs tolerated). A file
 * with an opening fence but no closing one has no frontmatter: all body.
 */
import type { Eol, PostParts } from '../contracts';

const BOM = '﻿';
const OPEN = /^(﻿?)(---[ \t]*(?:\r\n|\n|\r))/;
const FENCE_LINE = /^---[ \t]*(?:\r\n|\n|\r)?$/;
const LINE_BREAK = /\r\n|\n|\r/g;
const GAP = /^(?:[ \t]*(?:\r\n|\n|\r))*/;

/** The line starting at `at`, including its line break ('' at end of file). */
function lineAt(raw: string, at: number): string {
  LINE_BREAK.lastIndex = at;
  const br = LINE_BREAK.exec(raw);
  return br ? raw.slice(at, br.index + br[0].length) : raw.slice(at);
}

export function split(raw: string): PostParts {
  const m = OPEN.exec(raw);
  if (m) {
    const bom = m[1];
    const open = m[2];
    const start = bom.length + open.length;
    let lineStart = start;
    for (;;) {
      const line = lineAt(raw, lineStart);
      if (FENCE_LINE.test(line)) {
        const afterClose = lineStart + line.length;
        const gap = GAP.exec(raw.slice(afterClose))![0];
        return {
          bom,
          open,
          frontmatter: raw.slice(start, lineStart),
          close: line,
          gap,
          body: raw.slice(afterClose + gap.length),
        };
      }
      if (line.length === 0) break; // end of file, no closing fence
      lineStart += line.length;
    }
  }
  const bom = raw.startsWith(BOM) ? BOM : '';
  return { bom, open: '', frontmatter: '', close: '', gap: '', body: raw.slice(bom.length) };
}

export function eol(raw: string): Eol {
  let crlf = 0;
  let cr = 0;
  let all = 0;
  LINE_BREAK.lastIndex = 0;
  for (let m = LINE_BREAK.exec(raw); m; m = LINE_BREAK.exec(raw)) {
    all++;
    if (m[0] === '\r\n') crlf++;
    else if (m[0] === '\r') cr++;
  }
  if (crlf === 0 && cr === 0) return 'lf';
  if (crlf === all) return 'crlf';
  return cr === all ? 'cr' : 'mixed';
}

/**
 * The line break to use for text this app adds to a file: the kind the file
 * uses throughout, or — in a file that mixes them — the one it uses most
 * (`\n` when it has none, and on a tie).
 */
export function newlineOf(raw: string): '\n' | '\r\n' | '\r' {
  const counts = { '\n': 0, '\r\n': 0, '\r': 0 };
  LINE_BREAK.lastIndex = 0;
  for (let m = LINE_BREAK.exec(raw); m; m = LINE_BREAK.exec(raw)) counts[m[0] as keyof typeof counts]++;
  if (counts['\r\n'] > counts['\n'] && counts['\r\n'] >= counts['\r']) return '\r\n';
  if (counts['\r'] > counts['\n'] && counts['\r'] > counts['\r\n']) return '\r';
  return '\n';
}

/** The line break a text ends with, '' when its last line has none. */
export function finalBreakOf(raw: string | null | undefined): '' | '\n' | '\r\n' | '\r' {
  if (!raw) return '';
  return raw.endsWith('\r\n') ? '\r\n' : raw.endsWith('\n') ? '\n' : raw.endsWith('\r') ? '\r' : '';
}

/**
 * The file text for a post being edited: `assemblePost(parts)`, plus the
 * line breaks the app itself is responsible for.
 *
 *  - A file that ends AT its closing `---` (no line break after it) and then
 *    gets body text: the fence needs its line break, or the first body
 *    character would turn `---` into `---X` and the file would have no
 *    frontmatter at all. It is added only while there is body text; with the
 *    body empty again the file is byte-identical to the original.
 *  - A NEW post whose body does not end with a line break gets one (every
 *    file in the repo ends with one).
 *  - An existing file that ENDED WITH a line break keeps ending with one
 *    (`finalBreak`: the break the original ends with, see `finalBreakOf`).
 *    The editor shows such a file with an empty last line, and that is where
 *    a tap below the text puts the caret: whatever is typed, pasted or added
 *    there (a picture, a footnote's note) comes AFTER the final break and
 *    would otherwise be the new, unterminated end of the file. The same holds
 *    when the final break is deleted. A file whose original had no final
 *    break (`finalBreak` '' or absent) is never given one: there the writer
 *    decides.
 *
 * The first two use the file's own line break (`newline`), the third the
 * very break the original ended with.
 */
export function composePost(
  parts: PostParts,
  options: { isNew: boolean; newline: '\n' | '\r\n' | '\r'; finalBreak?: '' | '\n' | '\r\n' | '\r' },
): string {
  const rest = parts.gap + parts.body;
  const fenceBreak = parts.close !== '' && !/[\r\n]$/.test(parts.close) && rest !== '' ? options.newline : '';
  const text = parts.bom + parts.open + parts.frontmatter + parts.close + fenceBreak + rest;
  if (text === '' || /[\r\n]$/.test(text)) return text;
  if (options.isNew) return parts.body !== '' ? text + options.newline : text;
  return options.finalBreak ? text + options.finalBreak : text;
}
