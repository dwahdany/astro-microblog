/**
 * The "Review changes" view model. The diff itself is the data layer's
 * (`reviewDiff`: byte-honest, line breaks included); this turns it into rows
 * to draw — the changed words marked inside lines that were edited rather
 * than replaced, and a plain-language note wherever the change is one the eye
 * cannot see (only a line break, only spaces, no line break at the end).
 */
import { inlineDiff, reviewDiff } from '../../data';

export interface DiffSegment {
  text: string;
  /** This run of characters is what changed on the line. */
  changed: boolean;
  /** In a merged ('edit') line: whether this changed run was taken out or put in. */
  side?: 'del' | 'add';
  /** Unchanged text that was left out here to keep a long line readable. */
  elided?: boolean;
}

export interface DiffLine {
  /**
   * 'edit' is one long line (a paragraph) that was changed in place: shown ONCE, with what was
   * taken out and put in marked inside it and the unchanged stretches shortened, instead of the
   * whole paragraph in red followed by the whole paragraph in green.
   */
  type: 'add' | 'del' | 'context' | 'note' | 'edit';
  /** 1-based line number in the original / in the current text. */
  oldNo: number | null;
  newNo: number | null;
  segments: DiffSegment[];
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface PostDiff {
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

const whole = (text: string): DiffSegment[] => [{ text, changed: false }];
const note = (text: string): DiffLine => ({ type: 'note', oldNo: null, newNo: null, segments: whole(text) });

/** Mark the words that differ between an old and a new version of one line. */
function wordSegments(before: string, after: string): { del: DiffSegment[]; add: DiffSegment[] } {
  const del: DiffSegment[] = [];
  const add: DiffSegment[] = [];
  let common = 0;
  for (const part of inlineDiff(before, after)) {
    if (part.kind === 'add') add.push({ text: part.text, changed: true });
    else if (part.kind === 'del') del.push({ text: part.text, changed: true });
    else {
      common += part.text.trim().length;
      del.push({ text: part.text, changed: false });
      add.push({ text: part.text, changed: false });
    }
  }
  // Lines with almost nothing in common read better as a plain replace.
  if (common < Math.min(before.trim().length, after.trim().length) * 0.3) return { del: whole(before), add: whole(after) };
  return { del, add };
}

/** A line at least this long that was edited (not replaced) is shown as one merged line. */
export const MERGE_FROM_CHARS = 200;
/** Unchanged text kept on each side of a change in a merged line. */
const KEEP_CHARS = 60;

/** `text` cut to about `KEEP_CHARS` at a word boundary: its start (`'head'`) or its end (`'tail'`). */
function clip(text: string, keep: 'head' | 'tail'): string {
  if (text.length <= KEEP_CHARS) return text;
  if (keep === 'head') {
    const cut = text.lastIndexOf(' ', KEEP_CHARS);
    return text.slice(0, cut > KEEP_CHARS / 2 ? cut : KEEP_CHARS);
  }
  const cut = text.indexOf(' ', text.length - KEEP_CHARS);
  return text.slice(cut >= 0 && cut < text.length - KEEP_CHARS / 2 ? cut + 1 : text.length - KEEP_CHARS);
}

/**
 * One long line edited in place, as a single row: removed and added runs side by side, the
 * unchanged text between them shortened to a few words of context. Null when the two versions
 * have too little in common to read as an edit.
 */
function mergedLine(before: string, after: string): DiffSegment[] | null {
  const parts = inlineDiff(before, after);
  let common = 0;
  for (const part of parts) if (part.kind === 'same') common += part.text.trim().length;
  if (common < Math.min(before.trim().length, after.trim().length) * 0.3) return null;

  const out: DiffSegment[] = [];
  const gap = (): DiffSegment => ({ text: ' … ', changed: false, elided: true });
  parts.forEach((part, i) => {
    if (part.kind !== 'same') {
      out.push({ text: part.text, changed: true, side: part.kind });
      return;
    }
    const first = i === 0;
    const last = i === parts.length - 1;
    if (part.text.length <= KEEP_CHARS * (first || last ? 1 : 2) + 8) {
      out.push({ text: part.text, changed: false });
    } else if (first) {
      out.push({ text: '… ', changed: false, elided: true }, { text: clip(part.text, 'tail'), changed: false });
    } else if (last) {
      out.push({ text: clip(part.text, 'head'), changed: false }, { text: ' …', changed: false, elided: true });
    } else {
      out.push({ text: clip(part.text, 'head'), changed: false }, gap(), { text: clip(part.text, 'tail'), changed: false });
    }
  });
  return out;
}

const INVISIBLE = {
  eol: 'Only the line break of this line changed',
  whitespace: 'Only spaces or tabs changed on this line',
} as const;

/** `base` null = a post that is not in the repo yet (everything is an addition). */
export function diffPost(base: string | null, current: string, context = 2): PostDiff {
  const review = reviewDiff(base, current, { context });
  if (!review.changed) return { hunks: [], added: 0, removed: 0 };

  const hunks = review.hunks.map((hunk): DiffHunk => {
    const lines: DiffLine[] = [];
    const source = hunk.lines;
    for (let i = 0; i < source.length; i++) {
      const line = source[i];
      if (line.kind === 'context') {
        lines.push({ type: 'context', oldNo: line.oldLine ?? null, newNo: line.newLine ?? null, segments: whole(line.text) });
        continue;
      }
      // A run of removed lines followed by a run of added lines.
      let dels = i;
      while (dels < source.length && source[dels].kind === 'del') dels++;
      let adds = dels;
      while (adds < source.length && source[adds].kind === 'add') adds++;
      const removed = source.slice(i, dels);
      const added = source.slice(dels, adds);
      const paired = removed.length === added.length;

      const row = (src: (typeof source)[number], segments: DiffSegment[]): DiffLine[] => {
        const out: DiffLine[] = [
          { type: src.kind === 'add' ? 'add' : 'del', oldNo: src.oldLine ?? null, newNo: src.newLine ?? null, segments },
        ];
        // A last line without a line break, where the other side of the change had one (or had no such line).
        if (src.eol === '' && src.kind === 'add') out.push(note('No line break at the end of the file'));
        return out;
      };

      // Long lines (paragraphs are one line each in these posts) that were edited in place.
      const merged = removed.map((del, k) =>
        paired && !del.invisible && !added[k].invisible && del.eol === added[k].eol && Math.min(del.text.length, added[k].text.length) >= MERGE_FROM_CHARS
          ? mergedLine(del.text, added[k].text)
          : null,
      );

      removed.forEach((del, k) => {
        if (merged[k]) return;
        const segs = paired && !del.invisible ? wordSegments(del.text, added[k].text).del : whole(del.text);
        lines.push(...row(del, segs));
      });
      added.forEach((add, k) => {
        const segments = paired ? merged[k] : null;
        if (segments) {
          lines.push({ type: 'edit', oldNo: removed[k].oldLine ?? null, newNo: add.newLine ?? null, segments });
          return;
        }
        const segs = paired && !add.invisible ? wordSegments(removed[k].text, add.text).add : whole(add.text);
        lines.push(...row(add, segs));
        if (add.invisible && !(add.invisible === 'eol' && add.eol === '')) lines.push(note(INVISIBLE[add.invisible]));
      });
      i = adds - 1;
    }
    return { oldStart: hunk.oldStart, newStart: hunk.newStart, lines };
  });

  return { hunks, added: review.added, removed: review.removed };
}
