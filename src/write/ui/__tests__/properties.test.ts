// @vitest-environment jsdom
/**
 * The properties sheet mounted for real. Pins down:
 *   - a new blogmark must not open in a red error state
 *   - a long title can be read in full (a wrapping field that still holds ONE line)
 *   - a changed timestamp is written the way the file already writes it (`…Z` stays `…Z`)
 *   - a new post is told when its path is already taken
 */
import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FrontmatterPatch, PostParts } from '../../contracts';
import { frontmatter } from '../../data/frontmatter';
import Properties from '../Properties.svelte';

let target: HTMLElement;
let app: Record<string, unknown> | undefined;
let patches: FrontmatterPatch[];
let parts: PostParts;

const q = <T extends Element = HTMLElement>(selector: string) => target.querySelector<T>(selector);
const all = (selector: string) => [...target.querySelectorAll<HTMLElement>(selector)];

function show(raw: string, props: Record<string, unknown>) {
  patches = [];
  parts = frontmatter.split(raw);
  app = mount(Properties, {
    target,
    props: {
      parts,
      collection: 'notes',
      path: 'src/content/notes/2026/a.md',
      isNew: false,
      baseData: frontmatter.parse(parts.frontmatter).data,
      tagSuggestions: [],
      onPatch: (changes: FrontmatterPatch) => patches.push(changes),
      ...props,
    },
  });
  flushSync();
}

beforeEach(() => {
  target = document.createElement('div');
  document.body.append(target);
});
afterEach(async () => {
  if (app) await unmount(app);
  app = undefined;
  target.remove();
});

describe('a new blogmark', () => {
  const scaffold = () => frontmatter.scaffold('blogmarks', { now: new Date('2026-11-18T10:00:00Z') });

  it('opens without a red summary, red fields or red messages; required fields say "required"', () => {
    const post = scaffold();
    show(post.raw, { collection: 'blogmarks', path: post.ref.path, isNew: true, baseData: null });
    // There ARE things to fill in…
    expect(frontmatter.validate('blogmarks', frontmatter.parse(post.parts.frontmatter).data).length).toBeGreaterThanOrEqual(2);
    // …but nothing is shouted about before anything was typed.
    expect(q('[data-issues]')).toBeNull();
    expect(all('.note.bad')).toEqual([]);
    expect(all('[aria-invalid="true"]')).toEqual([]);
    expect(q('[data-field="link_url"] [data-required]')?.textContent).toBe('required');
    expect(q('[data-field="link_title"] [data-required]')?.textContent).toBe('required');
  });

  it('a required field that was visited and left empty then says so — only that one', () => {
    const post = scaffold();
    show(post.raw, { collection: 'blogmarks', path: post.ref.path, isNew: true, baseData: null });
    const url = q<HTMLInputElement>('#prop-link_url')!;
    url.focus();
    url.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    flushSync();
    expect(q('[data-field="link_url"] .note.bad')).not.toBeNull();
    expect(q('[data-field="link_title"] .note.bad')).toBeNull();
    expect(q('[data-issues]')?.getAttribute('data-issues')).toBe('1');
  });

  it('a value that is wrong is said at once', () => {
    const post = frontmatter.scaffold('blogmarks', { values: { link_url: 'not a url' } });
    show(post.raw, { collection: 'blogmarks', path: post.ref.path, isNew: true, baseData: null });
    expect(q('[data-field="link_url"] .note.bad')).not.toBeNull();
  });

  it('an existing post shows every problem straight away', () => {
    show('---\nslug: Not A Slug\ncreated: 2026-11-18T10:00:00+00:00\ntags: []\nis_draft: false\n---\n\nBody\n', {});
    expect(q('[data-issues]')).not.toBeNull();
    expect(q('[data-field="slug"] .note.bad')).not.toBeNull();
  });
});

describe('the title field', () => {
  const long = 'Can Agents Utilize Humans to Beat Other Agents at Their Own Game, and What Follows';
  const raw = `---\nslug: a\ntitle: ${long}\ncreated: 2026-11-18T10:00:00+00:00\ntags: []\nis_draft: false\n---\n\nBody\n`;

  it('wraps (a textarea) and shows the whole title', () => {
    show(raw, { collection: 'entries', path: 'src/content/entries/2026/a.md' });
    const title = q<HTMLTextAreaElement>('#prop-title')!;
    expect(title.tagName).toBe('TEXTAREA');
    expect(title.value).toBe(long);
    expect(title.classList.contains('is-wrap')).toBe(true);
  });

  it('never holds a line break: Enter is swallowed, pasted breaks become spaces', () => {
    show(raw, { collection: 'entries', path: 'src/content/entries/2026/a.md' });
    const title = q<HTMLTextAreaElement>('#prop-title')!;
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    title.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    title.value = 'Two\nlines\r\npasted';
    title.dispatchEvent(new Event('input', { bubbles: true }));
    expect(patches).toEqual([{ title: 'Two lines pasted' }]);
    expect(title.value).toBe('Two lines pasted');
  });
});

describe('timestamps keep the format the file uses', () => {
  const change = (value: string) => {
    const input = q<HTMLInputElement>('#prop-created')!;
    input.value = value;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const local = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  it('a file written with `Z` gets `Z` back (it used to be rewritten as +00:00)', () => {
    show('---\nslug: a\ncreated: 2025-12-11T11:13:00Z\ntags: []\nis_draft: false\n---\n\nBody\n', {});
    change(local('2025-12-12T08:30:00Z'));
    expect(patches).toEqual([{ created: '2025-12-12T08:30:00Z' }]);
    q<HTMLButtonElement>('[data-action="now"]')!.click();
    expect(String(patches.at(-1)!.created)).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  });

  it('a file in Sveltia’s format keeps that', () => {
    show('---\nslug: a\ncreated: 2026-02-26T12:35:00+00:00\ntags: []\nis_draft: false\n---\n\nBody\n', {});
    change(local('2026-03-01T09:00:00Z'));
    expect(patches).toEqual([{ created: '2026-03-01T09:00:00+00:00' }]);
  });

  it('choosing the moment that is already there writes nothing', () => {
    show('---\nslug: a\ncreated: 2025-12-11T11:13:00Z\ntags: []\nis_draft: false\n---\n\nBody\n', {});
    change(local('2025-12-11T11:13:00Z'));
    expect(patches).toEqual([]);
  });
});

describe('a new post whose path is taken', () => {
  it('is told so under the slug, instead of "Will be saved as"', () => {
    const post = frontmatter.scaffold('notes', { values: { slug: 'human-entropy' }, now: new Date('2026-11-18T10:00:00Z') });
    const path = 'src/content/notes/2026/human-entropy.md';
    show(post.raw, { path, isNew: true, baseData: null, postId: post.ref.id, posts: [{ id: path, path }] });
    expect(q('[data-path-taken]')?.textContent).toContain('There is already a post at');
    expect(target.textContent).not.toContain('Will be saved as');
  });

  it('a free path says where it will go', () => {
    const post = frontmatter.scaffold('notes', { values: { slug: 'brand-new' }, now: new Date('2026-11-18T10:00:00Z') });
    show(post.raw, { path: post.ref.path, isNew: true, baseData: null, postId: post.ref.id, posts: [] });
    expect(q('[data-path-taken]')).toBeNull();
    expect(target.textContent).toContain('Will be saved as');
  });
});
