import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { THEME_IDS, THEME_TOKENS } from '../../contracts';
import { THEMES, THEME_BOOT_SCRIPT, THEME_VARIANTS, resolveScheme, schemesOf } from '../index';

const read = (file: string) => readFileSync(`src/write/theme/${file}`, 'utf8');
const defined = (css: string, prefix: string) =>
  [...css.matchAll(new RegExp(`^\\s*(${prefix}[a-z0-9-]+):`, 'gm'))].map((m) => m[1]);
const value = (css: string, token: string) => new RegExp(`^\\s*${token}:\\s*([^;]+);`, 'm').exec(css)?.[1].trim();

describe('schemes', () => {
  it('follows the system where a theme has both, and stays put where it has one', () => {
    expect(schemesOf('galley')).toEqual(['light', 'dark']);
    expect(schemesOf('console')).toEqual(['dark']);
    expect(schemesOf('riso')).toEqual(['light', 'dark']);

    expect(resolveScheme('galley', 'auto', false)).toBe('light');
    expect(resolveScheme('galley', 'auto', true)).toBe('dark');
    expect(resolveScheme('riso', 'light', true)).toBe('light');
    expect(resolveScheme('riso', 'dark', false)).toBe('dark');
    expect(resolveScheme('console', 'auto', false)).toBe('dark');
    expect(resolveScheme('console', 'light', false)).toBe('dark');
  });

  it('every theme in the contract is registered, with its native scheme among its variants', () => {
    expect(THEMES.map((t) => t.id)).toEqual([...THEME_IDS]);
    for (const t of THEMES) {
      expect(THEME_VARIANTS[t.id][t.scheme], t.id).toBe(t.themeColor);
    }
  });

  it('theme-color for each variant is that variant’s canvas colour', () => {
    for (const id of THEME_IDS) {
      expect(value(read(`${id}.css`), '--w-bg'), id).toBe(THEME_VARIANTS[id][THEMES.find((t) => t.id === id)!.scheme]);
    }
    expect(value(read('galley.dark.css'), '--w-bg')).toBe(THEME_VARIANTS.galley.dark);
    expect(value(read('riso.dark.css'), '--w-bg')).toBe(THEME_VARIANTS.riso.dark);
  });

  it('the boot script is valid JavaScript that knows every variant', () => {
    expect(() => new Function(THEME_BOOT_SCRIPT)).not.toThrow();
    for (const colour of Object.values(THEME_VARIANTS).flatMap((v) => Object.values(v))) {
      expect(THEME_BOOT_SCRIPT).toContain(colour);
    }
  });

  it('the boot script applies the stored theme and resolves the scheme', () => {
    const run = (store: Record<string, string>, systemDark: boolean): Record<string, string> => {
      const attrs: Record<string, string> = {};
      const meta = { content: '' };
      new Function('document', 'localStorage', 'matchMedia', THEME_BOOT_SCRIPT)(
        {
          documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v) },
          querySelector: () => ({ setAttribute: (_: string, v: string) => (meta.content = v) }),
        },
        { getItem: (k: string) => store[k] ?? null },
        () => ({ matches: systemDark }),
      );
      return { ...attrs, meta: meta.content };
    };
    expect(run({}, false)).toEqual({ 'data-write-theme': 'galley', 'data-write-scheme': 'light', meta: '#f1f3ef' });
    expect(run({}, true)).toEqual({ 'data-write-theme': 'galley', 'data-write-scheme': 'dark', meta: '#14161a' });
    expect(run({ 'write:theme': 'console' }, false)).toEqual({ 'data-write-theme': 'console', 'data-write-scheme': 'dark', meta: '#0f172a' });
    expect(run({ 'write:theme': 'riso', 'write:scheme': 'dark' }, false)).toEqual({ 'data-write-theme': 'riso', 'data-write-scheme': 'dark', meta: '#12183f' });
    expect(run({ 'write:theme': 'riso', 'write:scheme': 'light' }, true)).toEqual({ 'data-write-theme': 'riso', 'data-write-scheme': 'light', meta: '#e7f1e6' });
    expect(run({ 'write:theme': 'bogus' }, false)['data-write-theme']).toBe('galley');
  });
});

describe('token sets', () => {
  it('every theme defines the same shell-private (--wx-*) tokens', () => {
    const sets = THEME_IDS.map((id) => [...new Set(defined(read(`${id}.css`), '--wx-'))].sort());
    expect(sets[0].length).toBeGreaterThan(20);
    for (const set of sets) expect(set).toEqual(sets[0]);
  });

  it('dark schemes override only tokens their theme already defines, and never type, shape or motion', () => {
    for (const id of ['galley', 'riso'] as const) {
      const light = new Set([...defined(read(`${id}.css`), '--w-'), ...defined(read(`${id}.css`), '--wx-')]);
      const dark = [...defined(read(`${id}.dark.css`), '--w-'), ...defined(read(`${id}.dark.css`), '--wx-')];
      expect(new Set(dark).size, `${id}: a token is defined twice`).toBe(dark.length);
      for (const token of dark) {
        expect(light.has(token), `${token} in ${id}.dark.css`).toBe(true);
        expect(token, id).not.toMatch(/--w-(font|prose|h\d|heading|text|ui|display|radius|border|ease|dur|space)/);
      }
      // Every colour of the contract gets a dark value: none may leak through from the light set.
      const colours = THEME_TOKENS.filter((t) =>
        /^--w-(bg|surface|scrim|ink|line|accent|selection|mark|focus|ok|warn|danger|add|del|syn|code)/.test(t),
      );
      for (const token of colours) expect(dark, `${token} missing from ${id}.dark.css`).toContain(token);
    }
  });

  it('theme selectors are not bound to :root, so a specimen can show another theme', () => {
    for (const file of ['galley.css', 'galley.dark.css', 'console.css', 'riso.css', 'riso.dark.css']) {
      expect(read(file), file).not.toMatch(/:root\[data-write-theme/);
    }
  });
});

/**
 * Review finding: the dimmed-syntax colour was 2.4–2.5:1 in three sets, below the 3:1 the tokens
 * promise for anything that has to be read (it is the colour of list markers, fences and marks).
 */
describe('contrast the tokens promise', () => {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  };
  const sets = ['galley.css', 'galley.dark.css', 'console.css', 'riso.css', 'riso.dark.css'];
  const hex = (file: string, token: string) => {
    const v = value(read(file), token);
    expect(v, `${token} in ${file}`).toMatch(/^#[0-9a-f]{6}$/i);
    return v!;
  };

  it.each(sets)('%s: dimmed syntax and tertiary ink are at least 3:1 on the writing surface and the canvas', (file) => {
    for (const token of ['--w-syn-mark', '--w-ink-3']) {
      for (const ground of ['--w-surface', '--w-bg']) {
        expect(ratio(hex(file, token), hex(file, ground)), `${token} on ${ground}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it.each(sets)('%s: secondary ink (addresses being edited, notes) is at least 4.5:1', (file) => {
    for (const ground of ['--w-surface', '--w-bg']) {
      expect(ratio(hex(file, '--w-ink-2'), hex(file, ground)), `--w-ink-2 on ${ground}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
