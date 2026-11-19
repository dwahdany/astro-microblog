/**
 * Small decisions around taking pictures into the text. Pure, so they can be tested without an
 * editor or a browser.
 */
import { formatBytes } from './text';

/** A line that holds nothing but indentation and list / quote markers counts as empty. */
const ONLY_MARKERS = /^\s*(?:(?:[-*+]|\d+[.)]|>)\s*)*$/;

/**
 * How many line breaks does a picture put at `pos` need before and after it to stand as its own
 * paragraph? Two (a blank line) where the caret's line has text on that side; one where the
 * caret's line is empty there but the line above (below) has text — the empty last line under
 * the final paragraph, where a tap below the text lands; none otherwise.
 * `pos` counts as the editor does: every line break is ONE position, whatever the file uses
 * (CRLF, a bare CR). Without the breaks the picture would become part of the sentence the caret
 * happens to be in — `![](…)First line.` when Image is tapped before the text ever was.
 */
export function imageSpacing(doc: string, pos: number): { before: 0 | 1 | 2; after: 0 | 1 | 2 } {
  const text = doc.replace(/\r\n?/g, '\n');
  const at = Math.max(0, Math.min(pos, text.length));
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const nextBreak = text.indexOf('\n', at);
  const end = nextBreak === -1 ? text.length : nextBreak;
  const head = text.slice(start, at);
  const tail = text.slice(at, end);
  const above = start > 0 ? text.slice(text.lastIndexOf('\n', start - 2) + 1, start - 1) : '';
  const afterNext = end < text.length ? text.indexOf('\n', end + 1) : -1;
  const below = end < text.length ? text.slice(end + 1, afterNext === -1 ? text.length : afterNext) : '';
  return {
    before: !ONLY_MARKERS.test(head) ? 2 : head.trim() === '' && above.trim() !== '' ? 1 : 0,
    after: tail.trim() !== '' ? 2 : below.trim() !== '' ? 1 : 0,
  };
}

/** What `summariseImages` is told about each picture that was added. */
export interface AddedImage {
  name: string;
  size: number;
  originalSize?: number;
  width?: number;
  height?: number;
  /** False: the original file is kept, metadata (location, camera) included. */
  stripped: boolean;
}

const sizes = (before: number, after: number): string => (before !== after ? `${formatBytes(before)} → ${formatBytes(after)}` : formatBytes(after));

/**
 * What to say after pictures were taken in: one sentence per picture for one, a single summary
 * for a batch (six pictures used to fill a quarter of a phone screen with repeats), followed by
 * what was refused. `sticky`: the notice says something the owner must not miss — a file was
 * refused, or a picture went in with its location and camera data — and stays until dismissed.
 */
export function summariseImages(added: readonly AddedImage[], refused: readonly string[]): { message: string; sticky: boolean } {
  const said: string[] = [];
  const kept = added.filter((a) => !a.stripped);
  if (added.length === 1) {
    const [image] = added;
    const pixels = image.width && image.height ? `, ${image.width} × ${image.height}` : '';
    const size = sizes(image.originalSize ?? image.size, image.size);
    said.push(
      image.stripped
        ? `Added ${image.name} (${size}${pixels}). Location and camera data were removed.`
        : `Added ${image.name} (${size}${pixels}) as it is: any location or camera data in the file goes with it.`,
    );
  } else if (added.length > 1) {
    const total = added.reduce((sum, a) => sum + a.size, 0);
    const original = added.reduce((sum, a) => sum + (a.originalSize ?? a.size), 0);
    said.push(`Added ${added.length} pictures: ${added.map((a) => a.name).join(', ')} (${sizes(original, total)}).`);
    if (kept.length === 0) said.push('Location and camera data were removed.');
    else if (kept.length === added.length) said.push('They were added as they are: any location or camera data in the files goes with them.');
    else
      said.push(
        `${kept.map((a) => a.name).join(', ')} ${kept.length === 1 ? 'was added as it is: any location or camera data in the file goes with it' : 'were added as they are: any location or camera data in the files goes with them'}. The others had theirs removed.`,
      );
  }
  said.push(...refused);
  return { message: said.join(' '), sticky: refused.length > 0 || kept.length > 0 };
}
