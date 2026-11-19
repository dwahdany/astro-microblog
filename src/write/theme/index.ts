/**
 * Theme registry + switching.
 *
 * A theme is purely a token set in ./<id>.css selected by attributes on <html>:
 *
 *   data-write-theme="galley|console|riso"   which direction
 *   data-write-scheme="light|dark"           which of that direction's schemes
 *
 * Galley and Riso have a light and a dark set (./<id>.dark.css overrides the
 * colour tokens only); Console is the published blog's own dark terminal and
 * has no light counterpart. The scheme follows the OS unless the owner pins
 * it (`SchemePref`). Switching touches nothing but those two attributes,
 * <meta theme-color> and localStorage.
 */
import {
  SCHEME_ATTRIBUTE,
  SCHEME_STORAGE_KEY,
  THEME_ATTRIBUTE,
  THEME_IDS,
  THEME_STORAGE_KEY,
  type Scheme,
  type SchemePref,
  type ThemeId,
  type ThemeInfo,
} from '../contracts';

export { SCHEME_ATTRIBUTE, SCHEME_STORAGE_KEY };
export type { Scheme, SchemePref };

/** Canvas colour (`--w-bg`) of every scheme a theme has — also the <meta theme-color>. */
export const THEME_VARIANTS: Readonly<Record<ThemeId, Partial<Record<Scheme, string>>>> = {
  galley: { light: '#f1f3ef', dark: '#14161a' },
  console: { dark: '#0f172a' },
  riso: { light: '#e7f1e6', dark: '#12183f' },
};

export const THEMES: readonly ThemeInfo[] = [
  {
    id: 'galley',
    label: 'Galley',
    description: 'Page proofs on a desk. A book serif, blue and red pencil.',
    scheme: 'light',
    themeColor: '#f1f3ef',
  },
  {
    id: 'console',
    label: 'Console',
    description: 'The blog’s own terminal. Slate, Roboto Mono, a green prompt.',
    scheme: 'dark',
    themeColor: '#0f172a',
  },
  {
    id: 'riso',
    label: 'Riso',
    description: 'A two-ink zine. Blue ink and fluorescent pink on mint paper.',
    scheme: 'light',
    themeColor: '#e7f1e6',
  },
];

export const DEFAULT_THEME: ThemeId = 'galley';

export function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && (THEME_IDS as readonly string[]).includes(value);
}

function isSchemePref(value: unknown): value is SchemePref {
  return value === 'auto' || value === 'light' || value === 'dark';
}

/** The schemes a theme can show, light first. */
export function schemesOf(id: ThemeId): Scheme[] {
  return (['light', 'dark'] as const).filter((s) => THEME_VARIANTS[id][s] !== undefined);
}

/** Pick the scheme to show: the wanted one when the theme has it, else the one it has. */
export function resolveScheme(id: ThemeId, pref: SchemePref, systemDark: boolean): Scheme {
  const wanted: Scheme = pref === 'auto' ? (systemDark ? 'dark' : 'light') : pref;
  const has = schemesOf(id);
  return has.includes(wanted) ? wanted : has[0];
}

const systemDark = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;

/** The theme currently applied to the document (falls back to the default outside a browser). */
export function getTheme(): ThemeId {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  const current = document.documentElement.getAttribute(THEME_ATTRIBUTE);
  return isThemeId(current) ? current : DEFAULT_THEME;
}

/** The remembered scheme preference ('auto' when nothing is stored). */
export function getSchemePref(): SchemePref {
  try {
    const stored = localStorage.getItem(SCHEME_STORAGE_KEY);
    return isSchemePref(stored) ? stored : 'auto';
  } catch {
    return 'auto';
  }
}

/** The scheme currently applied to the document. */
export function getScheme(): Scheme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute(SCHEME_ATTRIBUTE) === 'dark' ? 'dark' : 'light';
}

function apply(id: ThemeId, pref: SchemePref): Scheme {
  const scheme = resolveScheme(id, pref, systemDark());
  const root = document.documentElement;
  root.setAttribute(THEME_ATTRIBUTE, id);
  root.setAttribute(SCHEME_ATTRIBUTE, scheme);
  const colour = THEME_VARIANTS[id][scheme];
  const meta = document.querySelector('meta[name="theme-color"]');
  if (colour && meta) meta.setAttribute('content', colour);
  return scheme;
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode / storage disabled: the choice simply does not persist.
  }
}

/** Apply a theme and remember it. */
export function setTheme(id: ThemeId): void {
  if (typeof document === 'undefined') return;
  apply(id, getSchemePref());
  remember(THEME_STORAGE_KEY, id);
}

/** Pin light or dark, or go back to following the OS. Remembered. */
export function setSchemePref(pref: SchemePref): void {
  if (typeof document === 'undefined') return;
  remember(SCHEME_STORAGE_KEY, pref);
  apply(getTheme(), pref);
}

/**
 * Re-resolve the scheme when the OS flips between light and dark.
 * Returns a function that stops watching.
 */
export function followSystemScheme(onChange: (scheme: Scheme) => void): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const query = matchMedia('(prefers-color-scheme: dark)');
  const listener = () => onChange(apply(getTheme(), getSchemePref()));
  query.addEventListener('change', listener);
  // The OS may have flipped between the boot script and the app starting.
  if (resolveScheme(getTheme(), getSchemePref(), query.matches) !== getScheme()) listener();
  return () => query.removeEventListener('change', listener);
}

/**
 * Inline <head> script source that applies the remembered theme and scheme
 * before first paint (no flash of the default). Kept here so the page and the
 * registry cannot drift apart.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var d=document.documentElement,v=${JSON.stringify(
  THEME_VARIANTS,
)},t=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(!v[t])t=${JSON.stringify(
  DEFAULT_THEME,
)};var p=localStorage.getItem(${JSON.stringify(
  SCHEME_STORAGE_KEY,
)}),w=p==='light'||p==='dark'?p:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light',s=v[t][w]?w:v[t].light?'light':'dark';d.setAttribute(${JSON.stringify(
  THEME_ATTRIBUTE,
)},t);d.setAttribute(${JSON.stringify(
  SCHEME_ATTRIBUTE,
)},s);var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',v[t][s]);}catch(e){}})();`;
