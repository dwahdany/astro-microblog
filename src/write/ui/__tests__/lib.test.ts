import { describe, expect, it } from 'vitest';
import { fromLocalInput, toDateInput, toLocalInput, utcStamp } from '../lib/datetime';
import { diffPost } from '../lib/diff';
import { dayMonth, groupByRecency, recencyBucket, relativeTime } from '../lib/groups';
import { autoSlug, isAutoSlug, slugSeedKey } from '../lib/slug';
import { SaveConflictError, SaveError, ReadOnlyError } from '../../contracts';
import { explainSaveFailure } from '../lib/publish';
import { countWords, formatBytes, readingMinutes, splitHit, wordsLabel } from '../lib/text';
import { emptyValue } from '../lib/values';
import { hrefOf, listHref, parseHash, postHref } from '../routes';

const slugify = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

import { imageSpacing, summariseImages, type AddedImage } from '../lib/images';
import { saidOutsideReview, textLeftAfterPublish } from '../lib/publish';

describe('routes', () => {
  it('parses the list, its sheets and unknown hashes', () => {
    expect(parseHash('')).toEqual({ name: 'list', sheet: null });
    expect(parseHash('#/')).toEqual({ name: 'list', sheet: null });
    expect(parseHash('#/new')).toEqual({ name: 'list', sheet: 'new' });
    expect(parseHash('#/look')).toEqual({ name: 'list', sheet: 'look' });
    expect(parseHash('#/account')).toEqual({ name: 'list', sheet: 'account' });
    expect(parseHash('#/post/a.md/account')).toEqual({ name: 'post', id: 'a.md', sheet: 'account' });
    expect(parseHash('#/nonsense')).toEqual({ name: 'list', sheet: null });
    expect(parseHash('#/post/%E0%A4%A')).toEqual({ name: 'list', sheet: null }); // malformed escape
  });

  it('round-trips post ids that contain slashes and colons', () => {
    for (const id of ['src/content/entries/2026/curation-leaks.md', 'new:notes:3f1c-9a']) {
      expect(parseHash(postHref(id))).toEqual({ name: 'post', id, sheet: null });
      for (const sheet of ['properties', 'review', 'more', 'look'] as const) {
        const route = { name: 'post', id, sheet } as const;
        expect(parseHash(postHref(id, sheet))).toEqual(route);
        expect(parseHash(hrefOf(route))).toEqual(route);
      }
      expect(parseHash(postHref(id) + '/bogus')).toEqual({ name: 'post', id, sheet: null });
    }
    expect(hrefOf({ name: 'list', sheet: 'new' })).toBe(listHref('new'));
  });
});

describe('grouping by recency', () => {
  const now = new Date(2026, 10, 18, 12, 0).getTime(); // 18 Nov 2026, local
  const at = (y: number, m: number, d: number) => new Date(y, m - 1, d, 9, 0).getTime();

  it('buckets by week, month, month of this year, then year', () => {
    expect(recencyBucket(at(2026, 11, 17), now).label).toBe('This week');
    expect(recencyBucket(at(2026, 11, 12), now).label).toBe('This week');
    expect(recencyBucket(at(2026, 11, 3), now).label).toBe('Earlier this month');
    expect(recencyBucket(at(2026, 10, 30), now).label).toBe('October');
    expect(recencyBucket(at(2026, 1, 2), now).label).toBe('January');
    expect(recencyBucket(at(2025, 11, 17), now).label).toBe('2025');
    expect(recencyBucket(null, now).label).toBe('No date');
    expect(recencyBucket(at(2026, 12, 24), now).label).toBe('Dated in the future');
  });

  it('keeps the incoming order and puts each post in exactly one group', () => {
    const posts = [at(2026, 11, 17), at(2026, 11, 2), at(2026, 10, 9), at(2026, 10, 1), at(2025, 3, 3), null].map((createdMs, i) => ({ id: i, createdMs }));
    const groups = groupByRecency(posts, now);
    expect(groups.map((g) => g.label)).toEqual(['This week', 'Earlier this month', 'October', '2025', 'No date']);
    expect(groups.flatMap((g) => g.items.map((p) => p.id))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('formats dates and relative times', () => {
    expect(dayMonth(at(2026, 11, 3))).toBe('3 Nov');
    expect(dayMonth(null)).toBe('');
    expect(relativeTime(now - 20_000, now)).toBe('just now');
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5 min ago');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(relativeTime(now - 26 * 3_600_000, now)).toBe('yesterday');
    expect(relativeTime(now - 4 * 86_400_000, now)).toBe('4 days ago');
    expect(relativeTime(at(2026, 10, 1), now)).toBe('1 Oct');
    expect(relativeTime(at(2025, 10, 1), now)).toBe('1 Oct 2025');
  });
});

describe('counting words', () => {
  it('counts prose, not link targets, footnote markers or comments', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('Hello world')).toBe(2);
    expect(countWords("It's a well-known fact.")).toBe(4);
    expect(countWords('See [the paper](https://arxiv.org/abs/2603.00811) now')).toBe(4);
    expect(countWords('A claim[^1] here.\n\n[^1]: The note.')).toBe(5);
    expect(countWords('<!-- hidden words here --> shown')).toBe(1);
    expect(countWords('## Heading\n\n- **bold** item')).toBe(3);
    expect(countWords('Größe und naïve façade')).toBe(4);
  });

  it('labels and reading time', () => {
    expect(wordsLabel(1)).toBe('1 word');
    expect(wordsLabel(1204)).toBe('1,204 words');
    expect(readingMinutes(0)).toBe(0);
    expect(readingMinutes(40)).toBe(1);
    expect(readingMinutes(1527)).toBe(7);
  });

  it('splits a title around a search hit, ignoring case', () => {
    expect(splitHit('Curation Leaks', 'leak')).toEqual(['Curation ', 'Leak', 's']);
    expect(splitHit('Curation Leaks', 'zzz')).toEqual(['Curation Leaks', '', '']);
    expect(splitHit('Curation Leaks', '  ')).toEqual(['Curation Leaks', '', '']);
  });
});

describe('timestamps', () => {
  it('writes the site format: UTC with +00:00', () => {
    expect(utcStamp(new Date('2026-11-18T09:30:12Z'))).toBe('2026-11-18T09:30:12+00:00');
  });

  it('round-trips through the local picker value without moving the moment', () => {
    for (const stored of ['2026-04-22T12:00:00+00:00', '2026-01-01T00:00:00+00:00', '2026-07-14T23:59:00+00:00']) {
      const local = toLocalInput(stored);
      expect(local).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
      expect(fromLocalInput(local!)).toBe(stored);
    }
  });

  it('reads other offsets and date-only values, and rejects junk', () => {
    expect(Date.parse(fromLocalInput(toLocalInput('2026-04-22T14:00:00+02:00')!)!)).toBe(Date.parse('2026-04-22T12:00:00Z'));
    expect(toLocalInput('2026-04-22')).not.toBeNull();
    expect(toLocalInput('next tuesday')).toBeNull();
    expect(fromLocalInput('')).toBeNull();
    expect(toDateInput('2026-04-22T12:00:00+00:00')).toBe('2026-04-22');
    expect(toDateInput('soon')).toBeNull();
  });
});

describe('slug follows the title of a new post', () => {
  it('treats empty, placeholder and title-derived slugs as automatic', () => {
    expect(isAutoSlug('', '', slugify)).toBe(true);
    expect(isAutoSlug('untitled-3f1c9a', '', slugify)).toBe(true);
    expect(isAutoSlug('hello-world', 'Hello, World!', slugify)).toBe(true);
    expect(isAutoSlug('my-own-slug', 'Hello, World!', slugify)).toBe(false);
    expect(isAutoSlug('my-own-slug', '', slugify)).toBe(false);
  });

  it('caps the slug at 60 characters without a trailing hyphen', () => {
    const slug = autoSlug('word '.repeat(30), slugify);
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  });

  it('knows which field names a post', () => {
    expect(slugSeedKey('entries')).toBe('title');
    expect(slugSeedKey('blogmarks')).toBe('link_title');
    expect(slugSeedKey('quotations')).toBe('source');
  });
});

describe('clearing a field', () => {
  it('goes back towards the original text', () => {
    expect(emptyValue(null, 'title')).toBe('');
    expect(emptyValue(null, 'tags', true)).toEqual([]);
    expect(emptyValue({ slug: 'a' }, 'title')).toBeUndefined();
    expect(emptyValue({ title: null }, 'title')).toBeNull();
    expect(emptyValue({ title: 'x' }, 'title')).toBe('');
    expect(emptyValue({ tags: ['a'] }, 'tags', true)).toEqual([]);
  });
});

describe('review diff', () => {
  const base = '---\ntitle: Old title\nslug: a\n---\n\nFirst line.\nSecond line.\n';

  it('is empty for identical text', () => {
    expect(diffPost(base, base)).toEqual({ hunks: [], added: 0, removed: 0 });
  });

  it('numbers lines and marks the words that changed in an edited line', () => {
    const diff = diffPost(base, base.replace('Old title', 'New title'));
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    const lines = diff.hunks[0].lines;
    const del = lines.find((l) => l.type === 'del')!;
    const add = lines.find((l) => l.type === 'add')!;
    expect(del.oldNo).toBe(2);
    expect(add.newNo).toBe(2);
    expect(del.segments.filter((s) => s.changed).map((s) => s.text)).toEqual(['Old']);
    expect(add.segments.filter((s) => s.changed).map((s) => s.text)).toEqual(['New']);
    // The segments of a line always spell the line.
    expect(add.segments.map((s) => s.text).join('')).toBe('title: New title');
    expect(del.segments.map((s) => s.text).join('')).toBe('title: Old title');
  });

  it('shows a wholly different line as a plain replace, and a new file as additions', () => {
    const diff = diffPost(base, base.replace('Second line.', 'Zebra crossing ahead'));
    const add = diff.hunks.flatMap((h) => h.lines).find((l) => l.type === 'add')!;
    expect(add.segments).toEqual([{ text: 'Zebra crossing ahead', changed: false }]);

    const fresh = diffPost(null, base);
    expect(fresh.removed).toBe(0);
    expect(fresh.added).toBe(7);
    expect(fresh.hunks[0].lines.every((l) => l.type === 'add')).toBe(true);
  });

  it('notes a missing final line break instead of hiding it', () => {
    const diff = diffPost(base, base + 'Third line');
    expect(diff.hunks.flatMap((h) => h.lines).some((l) => l.type === 'note')).toBe(true);
  });

  it('says so when a change cannot be seen: only a line break, only spaces', () => {
    const notes = (current: string) =>
      diffPost(base, current)
        .hunks.flatMap((h) => h.lines)
        .filter((l) => l.type === 'note')
        .map((l) => l.segments[0].text);
    expect(notes(base.replace('First line.\n', 'First line.\r\n'))).toEqual(['Only the line break of this line changed']);
    expect(notes(base.replace('First line.', 'First  line.'))).toEqual(['Only spaces or tabs changed on this line']);
    // A final line break that went missing is reported once, as that.
    expect(notes(base.slice(0, -1))).toEqual(['No line break at the end of the file']);
  });
});

describe('file sizes', () => {
  it('reads as people say them', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(812)).toBe('812 B');
    expect(formatBytes(1000)).toBe('1 kB');
    expect(formatBytes(412_300)).toBe('412 kB');
    expect(formatBytes(999_700)).toBe('1.0 MB');
    expect(formatBytes(3_440_000)).toBe('3.4 MB');
    expect(formatBytes(24_600_000)).toBe('25 MB');
    expect(formatBytes(Number.NaN)).toBe('');
  });
});

describe('why a publish failed', () => {
  const PATH = 'src/content/notes/2026/a.md';

  it('a conflict says nothing was published and what happens next', () => {
    const changed = explainSaveFailure(new SaveConflictError(PATH, 'changed'));
    expect(changed).toMatchObject({ reason: 'conflict:changed', signIn: false });
    expect(changed.message).toMatch(/changed in the repository.*Nothing was published/);
    expect(explainSaveFailure(new SaveConflictError(PATH, 'missing')).message).toMatch(/no longer in the repository/);
    expect(explainSaveFailure(new SaveConflictError(PATH, 'branch-moved')).message).toMatch(/Try again in a moment/);
    expect(explainSaveFailure(new SaveConflictError(PATH, 'exists')).reason).toBe('conflict:exists');
    // Deleting talks about deleting.
    expect(explainSaveFailure(new SaveConflictError(PATH, 'changed'), 'delete').message).toMatch(/Nothing was deleted/);
  });

  it('a lost sign-in asks to sign in again; every failure says the changes are still here', () => {
    const out = explainSaveFailure(new SaveError('The sign-in is no longer valid.', 'signed-out'));
    expect(out).toMatchObject({ reason: 'signed-out', signIn: true });
    expect(out.message).toMatch(/still on this device.*Sign in again/);
    for (const reason of ['offline', 'forbidden', 'rate-limited', 'too-large', 'invalid', 'failed'] as const) {
      const said = explainSaveFailure(new SaveError('GitHub said no.', reason));
      expect(said.signIn, reason).toBe(false);
      expect(said.message, reason).toMatch(/Nothing was published\. Your changes are still on this device\./);
    }
    expect(explainSaveFailure(new SaveError('x', 'offline', { partial: true })).message).toMatch(/sends only what is missing/);
    expect(explainSaveFailure(new ReadOnlyError('Sign in to publish.'))).toEqual({ reason: 'read-only', message: 'Sign in to publish.', signIn: true });
    expect(explainSaveFailure(new Error('boom')).message).toBe('Publishing failed: boom Nothing was published. Your changes are still on this device.');
  });
});

describe('pictures taken into the text (review findings)', () => {
  it('a picture gets a paragraph of its own: breaks are added where the caret sits in a sentence', () => {
    // caret never placed: position 0, in front of the first sentence
    expect(imageSpacing('First line.\n\nSecond line.\n', 0)).toEqual({ before: 0, after: 2 });
    // at the end of a sentence
    expect(imageSpacing('First line.\n\nMore words.', 24)).toEqual({ before: 2, after: 0 });
    // in the middle of one
    expect(imageSpacing('First line.', 5)).toEqual({ before: 2, after: 2 });
    // on an empty line set apart by a blank one, and in an empty document: nothing to add
    expect(imageSpacing('First line.\n\n', 13)).toEqual({ before: 0, after: 0 });
    expect(imageSpacing('', 0)).toEqual({ before: 0, after: 0 });
    // right after a list or quote marker the picture belongs to that item
    expect(imageSpacing('- ', 2)).toEqual({ before: 0, after: 0 });
    expect(imageSpacing('> 1. ', 5)).toEqual({ before: 0, after: 0 });
  });

  it('on an empty line right under (or over) text, one line break sets the picture apart (review finding)', () => {
    // the empty last line after the final line break: where a tap below the text lands
    expect(imageSpacing('First line.\n\nSecond line.\n', 26)).toEqual({ before: 1, after: 0 });
    // an empty line squeezed between two lines of text
    expect(imageSpacing('One\n\nTwo', 4)).toEqual({ before: 1, after: 1 });
    expect(imageSpacing('One\n\n\nTwo', 4)).toEqual({ before: 1, after: 0 });
    expect(imageSpacing('One\n\n\nTwo', 5)).toEqual({ before: 0, after: 1 });
    // at the start of a line of text that follows another
    expect(imageSpacing('One\nTwo', 4)).toEqual({ before: 1, after: 2 });
    // at the end of a line with text right below
    expect(imageSpacing('One\nTwo', 3)).toEqual({ before: 2, after: 1 });
  });

  it('positions count a line break as one, whatever the file uses', () => {
    // the editor's position 3 is the start of line 2 in a CRLF file ("ab\r\ncd")
    expect(imageSpacing('ab\r\ncd', 3)).toEqual({ before: 1, after: 2 });
    expect(imageSpacing('ab\r\n\r\ncd', 3)).toEqual({ before: 1, after: 1 });
    expect(imageSpacing('ab\r\n\r\n\r\ncd', 4)).toEqual({ before: 0, after: 1 });
    expect(imageSpacing('ab\rcd', 5)).toEqual({ before: 2, after: 0 });
  });

  const image = (name: string, over: Partial<AddedImage> = {}): AddedImage => ({ name, size: 11_000, originalSize: 220_000, width: 800, height: 600, stripped: true, ...over });

  it('one picture is described in full, and goes away by itself', () => {
    expect(summariseImages([image('a.png')], [])).toEqual({ message: 'Added a.png (220 kB → 11 kB, 800 × 600). Location and camera data were removed.', sticky: false });
  });

  it('a batch is ONE sentence, not one per picture', () => {
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => image(`${n}.png`));
    const { message, sticky } = summariseImages(six, []);
    expect(message).toBe('Added 6 pictures: a.png, b.png, c.png, d.png, e.png, f.png (1.3 MB → 66 kB). Location and camera data were removed.');
    expect(message.match(/Location and camera data/g)).toHaveLength(1);
    expect(sticky).toBe(false);
  });

  it('a refusal, or a picture that kept its location data, stays until dismissed', () => {
    expect(summariseImages([], ['notes.txt is not a JPEG, PNG, WebP, GIF or AVIF picture.'])).toEqual({ message: 'notes.txt is not a JPEG, PNG, WebP, GIF or AVIF picture.', sticky: true });
    const kept = summariseImages([image('anim.gif', { stripped: false, originalSize: 11_000 })], []);
    expect(kept.sticky).toBe(true);
    expect(kept.message).toContain('as it is: any location or camera data in the file goes with it');
    const mixed = summariseImages([image('a.png'), image('anim.gif', { stripped: false })], ['x.txt was refused.']);
    expect(mixed.sticky).toBe(true);
    expect(mixed.message).toContain('anim.gif was added as it is');
    expect(mixed.message).toContain('x.txt was refused.');
    expect(summariseImages([], [])).toEqual({ message: '', sticky: false });
  });
});

describe('after a publish (review findings)', () => {
  it('text typed while a MOVE was being committed gets the same image-folder rewrite as the committed text', () => {
    const rewrite = (text: string) => text.replaceAll('old-slug/', 'new-slug/');
    const sent = '![a](old-slug/a.png)\n';
    const committed = rewrite(sent);
    expect(textLeftAfterPublish(sent, sent, committed, rewrite)).toBe(committed);
    expect(textLeftAfterPublish(sent + 'typed meanwhile\n', sent, committed, rewrite)).toBe('![a](new-slug/a.png)\ntyped meanwhile\n');
  });

  it('a failure is said on the writing screen only while Review is not open, and not for a post that was re-read', () => {
    const problem = (reason: string) => ({ reason, message: 'm', signIn: false });
    expect(saidOutsideReview(problem('offline'), null)).toBe(true);
    expect(saidOutsideReview(problem('offline'), 'more')).toBe(true);
    expect(saidOutsideReview(problem('offline'), 'review')).toBe(false);
    expect(saidOutsideReview(problem('conflict:changed'), null)).toBe(false);
    expect(saidOutsideReview(problem('conflict:missing'), null)).toBe(false);
    expect(saidOutsideReview(problem('conflict:exists'), null)).toBe(true);
    expect(saidOutsideReview(null, null)).toBe(false);
  });
});
