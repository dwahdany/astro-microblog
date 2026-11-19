/**
 * Regression tests for the shell findings of the pre-release review that can be pinned down
 * without a browser: the rules and decisions live in ui/lib and are tested here; what needs a real
 * layout or a real key press is in tests/write/e2e/review-fixes.spec.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { NOTE_COMMANDS, type EditorCommandId, type EditorSelectionState, type ParsedFrontmatter } from '../../contracts';
import { frontmatter } from '../../data/frontmatter';
import { MERGE_FROM_CHARS, diffPost } from '../lib/diff';
import { enterMovesOn } from '../lib/keys';
import { blockersToList, conflictBlocker, publishBlockers, takenBy, type PublishContext } from '../lib/publish';
import { DESKTOP_GROUPS, PHONE_FIRST_SCREEN, PHONE_GROUPS, commandAvailable } from '../lib/toolbar';
import { SPLIT_MIN_WIDTH, WIDE_MIN_HEIGHT, WIDE_MIN_WIDTH, layoutFor } from '../viewport.svelte';

describe('Enter / Done in the title field (it used to add a blank line to the post)', () => {
  const press = (over: Partial<{ key: string; isComposing: boolean; keyCode: number }> = {}) => {
    const event = { key: 'Enter', isComposing: false, keyCode: 13, preventDefault: vi.fn(), ...over };
    const next = vi.fn();
    const handled = enterMovesOn(event, next);
    return { event, next, handled };
  };

  it('cancels the key press BEFORE focus moves on, so the press cannot land in the editor', () => {
    const order: string[] = [];
    const event = { key: 'Enter', isComposing: false, preventDefault: () => void order.push('cancel') };
    enterMovesOn(event, () => void order.push('focus'));
    expect(order).toEqual(['cancel', 'focus']);
  });

  it('leaves other keys alone', () => {
    const { event, next, handled } = press({ key: 'a' });
    expect(handled).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('leaves Enter to the IME while it is composing', () => {
    for (const over of [{ isComposing: true }, { keyCode: 229 }]) {
      const { event, next, handled } = press(over);
      expect(handled).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
    }
  });
});

describe('The phone toolbar with the keyboard up (lists, quote and image were swipes away)', () => {
  const all = (groups: readonly (readonly EditorCommandId[])[]) => groups.flat();

  it('opens with what a phone keyboard cannot type easily', () => {
    expect(all(PHONE_GROUPS).slice(0, PHONE_FIRST_SCREEN)).toEqual(['link', 'bulletList', 'quote', 'image']);
    // Heading, bold and italic follow directly; nothing a phone needs sits behind the rarely used ones.
    expect(all(PHONE_GROUPS).slice(PHONE_FIRST_SCREEN, PHONE_FIRST_SCREEN + 3)).toEqual(['heading', 'bold', 'italic']);
  });

  it('that many full 44px buttons fit beside the pinned ones at 360px with the keyboard up', () => {
    // Footnote (44 + 4 + 6 margins), Undo and Hide keyboard (44 each) + 4px padding; strip padding 2 × 4px.
    const strip = (width: number) => width - (44 + 4 + 6) - (44 + 44 + 4) - 2 * 4;
    expect(Math.floor(strip(360) / 44)).toBe(PHONE_FIRST_SCREEN);
    // The measured layout this replaces showed bold, italic, heading and a sliver of link there.
    expect(Math.floor(strip(390) / 44)).toBe(PHONE_FIRST_SCREEN + 1);
  });

  it('both layouts offer exactly the same commands, each once', () => {
    expect([...all(PHONE_GROUPS)].sort()).toEqual([...all(DESKTOP_GROUPS)].sort());
    expect(new Set(all(PHONE_GROUPS)).size).toBe(all(PHONE_GROUPS).length);
    for (const pinned of ['footnote', 'undo', 'redo'] as const) expect(all(PHONE_GROUPS)).not.toContain(pinned);
  });
});

describe('Toolbar buttons that would do nothing are disabled', () => {
  const selection = (over: Partial<EditorSelectionState> = {}): EditorSelectionState => ({
    bold: false,
    italic: false,
    strike: false,
    code: false,
    link: false,
    heading: 0,
    list: null,
    quote: false,
    codeBlock: false,
    literal: false,
    empty: true,
    canUndo: true,
    canRedo: false,
    anchor: 0,
    head: 0,
    ...over,
  });
  const everything: EditorCommandId[] = ['footnote', 'undo', 'redo', ...DESKTOP_GROUPS.flat()];

  it('while a footnote’s text is being edited only the note commands apply — Footnote itself does not', () => {
    const context = { note: { label: '1', editing: true, cover: false }, selection: selection({ canRedo: true }) };
    const enabled = everything.filter((id) => commandAvailable(id, context));
    expect(enabled.sort()).toEqual([...NOTE_COMMANDS].sort());
    expect(commandAvailable('footnote', context)).toBe(false);
    expect(commandAvailable('bulletList', context)).toBe(false);
    expect(commandAvailable('image', context)).toBe(false);
  });

  it('a note that is open but not being typed in does not disable anything', () => {
    const context = { note: { label: '1', editing: false, cover: false }, selection: selection() };
    expect(everything.filter((id) => !commandAvailable(id, context))).toEqual(['redo']);
  });

  it('in a code block, display math or raw HTML there is no footnote and no divider', () => {
    const context = { note: null, selection: selection({ literal: true, codeBlock: true }) };
    expect(commandAvailable('footnote', context)).toBe(false);
    expect(commandAvailable('rule', context)).toBe(false);
    expect(commandAvailable('codeBlock', context)).toBe(true);
    expect(commandAvailable('indent', context)).toBe(true);
  });

  it('undo and redo follow the history', () => {
    expect(commandAvailable('undo', { note: null, selection: selection({ canUndo: false }) })).toBe(false);
    expect(commandAvailable('redo', { note: null, selection: selection({ canRedo: true }) })).toBe(true);
  });
});

describe('A phone on its side does not get the desktop layout', () => {
  it('wide needs height as well as width', () => {
    expect(layoutFor(1280, 800)).toEqual({ wide: true, split: true });
    expect(layoutFor(1000, 700)).toEqual({ wide: true, split: false });
    // Pixel 7 (915×412) and iPhone 14 (844×390) in landscape: the phone layout.
    expect(layoutFor(915, 412)).toEqual({ wide: false, split: false });
    expect(layoutFor(844, 390)).toEqual({ wide: false, split: false });
    expect(layoutFor(390, 844)).toEqual({ wide: false, split: false });
    expect(layoutFor(WIDE_MIN_WIDTH, WIDE_MIN_HEIGHT).wide).toBe(true);
    expect(layoutFor(SPLIT_MIN_WIDTH, WIDE_MIN_HEIGHT - 1).split).toBe(false);
  });

  it('is judged on the tallest the window has been, so a keyboard cannot flip a tablet to the phone layout', () => {
    // A 1280×800 tablet whose keyboard leaves 430px: still `tallest` = 800.
    expect(layoutFor(1280, 800).wide).toBe(true);
  });
});

describe('Publish is gated (validation, a taken path, an unresolved conflict)', () => {
  const parsed = (yaml: string): ParsedFrontmatter => frontmatter.parse(yaml);
  const context = (over: Partial<PublishContext> = {}): PublishContext => {
    const p = over.parsed ?? parsed("slug: a-note\ntitle: A note\ncreated: 2026-11-18T10:00:00+00:00\ntags: []\nis_draft: true\n");
    const collection = over.collection ?? 'notes';
    return {
      id: 'new:notes:1',
      isNew: true,
      path: 'src/content/notes/2026/a-note.md',
      collection,
      parsed: p,
      issues: frontmatter.validate(collection, p.data),
      posts: [{ id: 'src/content/notes/2026/human-entropy.md', path: 'src/content/notes/2026/human-entropy.md' }],
      conflict: false,
      superseded: false,
      sourceLabel: 'the repo',
      ...over,
    };
  };

  it('a valid post with a free path has nothing in its way', () => {
    expect(publishBlockers(context())).toEqual([]);
  });

  it('a NEW post whose path is an existing post is blocked (the reviewer’s `human-entropy`)', () => {
    const taken = context({ path: 'src/content/notes/2026/human-entropy.md' });
    expect(takenBy(taken)?.id).toBe('src/content/notes/2026/human-entropy.md');
    expect(publishBlockers(taken)).toEqual(['There is already a post at src/content/notes/2026/human-entropy.md. Change the slug.']);
    // An existing post is of course allowed to be at its own path.
    expect(takenBy({ ...taken, isNew: false, id: taken.path })).toBeUndefined();
  });

  it('frontmatter problems block it, each named', () => {
    const p = parsed('slug: Not A Slug\ncreated: 2026-11-18T10:00:00+00:00\ntags: []\nis_draft: true\nlink_url: nope\nlink_title: ""\n');
    const blocked = publishBlockers(context({ collection: 'blogmarks', parsed: p, issues: frontmatter.validate('blogmarks', p.data) }));
    expect(blocked.length).toBeGreaterThanOrEqual(2);
    expect(blocked.join(' ')).toMatch(/slug/i);
  });

  it('YAML that does not parse blocks it', () => {
    const p = parsed('title: "unclosed\nslug: a\n');
    expect(p.issues.length).toBeGreaterThan(0);
    expect(publishBlockers(context({ parsed: p, issues: [] }))).toEqual(['The frontmatter is not valid YAML. Fix it in the file first.']);
  });

  it('an unresolved conflict and a tab that fell behind block it', () => {
    expect(publishBlockers(context({ conflict: true }))[0]).toMatch(/would undo that change/);
    expect(publishBlockers(context({ superseded: true }))[0]).toMatch(/another tab/);
    // Review says the conflict in a message of its own (with "Keep my version" next to it): the list
    // under Publish gets every blocker but that one.
    const both = publishBlockers(context({ conflict: true, superseded: true }));
    expect(both).toHaveLength(2);
    const label = context().sourceLabel;
    expect(both).toContain(conflictBlocker(label));
    expect(blockersToList(both, label)).toEqual([both[0]]);
    expect(blockersToList(both, label)[0]).toMatch(/another tab/);
    expect(blockersToList(publishBlockers(context({ conflict: true })), label)).toEqual([]);
  });
});

describe('Review: a one-word edit in a long paragraph is one merged line, not two paragraphs', () => {
  const paragraph =
    'It is instructive to compare how the two systems fail, because the failure modes tell you what each one is actually optimising for, ' +
    'and that in turn tells you which of the published numbers deserve to be believed and which were produced by a pipeline that leaked ' +
    'information from the evaluation set into the training data in ways that are hard to spot from the outside.';
  const base = `---\nslug: a\n---\n\n${paragraph}\n\nShort line.\n`;

  it('shows the change once, with a few words of context on each side', () => {
    expect(paragraph.length).toBeGreaterThan(MERGE_FROM_CHARS);
    const diff = diffPost(base, base.replace('deserve to be believed', 'really deserve to be believed'));
    const lines = diff.hunks.flatMap((h) => h.lines).filter((l) => l.type !== 'context');
    expect(lines.map((l) => l.type)).toEqual(['edit']);
    const [edit] = lines;
    expect(edit.segments.filter((s) => s.changed)).toEqual([{ text: 'really ', changed: true, side: 'add' }]);
    // The unchanged stretches are cut down: the row is a fraction of the paragraph.
    const shown = edit.segments.map((s) => s.text).join('');
    expect(shown.length).toBeLessThan(paragraph.length / 2);
    expect(shown).toContain('published numbers really deserve to be believed');
    expect(edit.segments.some((s) => s.elided)).toBe(true);
    // The counts still say one line changed.
    expect(diff).toMatchObject({ added: 1, removed: 1 });
  });

  it('a replaced word shows what went and what came', () => {
    const diff = diffPost(base, base.replace('instructive', 'useful'));
    const [edit] = diff.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'edit');
    expect(edit.segments.filter((s) => s.changed).map((s) => [s.side, s.text])).toEqual([
      ['del', 'instructive'],
      ['add', 'useful'],
    ]);
  });

  it('short lines and rewritten paragraphs are shown as before', () => {
    const short = diffPost(base, base.replace('Short line.', 'Short line, edited.'));
    expect(short.hunks.flatMap((h) => h.lines).filter((l) => l.type !== 'context').map((l) => l.type)).toEqual(['del', 'add']);
    const rewritten = diffPost(base, base.replace(paragraph, 'Zebra crossings ahead. '.repeat(12).trim()));
    expect(rewritten.hunks.flatMap((h) => h.lines).filter((l) => l.type !== 'context').map((l) => l.type)).toEqual(['del', 'add']);
  });

  it('an invisible change in a long line is still said in words', () => {
    const diff = diffPost(base, base.replace(`${paragraph}\n`, `${paragraph}  \n`));
    const types = diff.hunks.flatMap((h) => h.lines).map((l) => l.type);
    expect(types).toContain('note');
    expect(types).not.toContain('edit');
  });
});
