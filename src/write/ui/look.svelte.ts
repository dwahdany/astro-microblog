/** The current look (theme + scheme), reactive, for every screen that shows or switches it. */
import type { ThemeId } from '../contracts';
import {
  followSystemScheme,
  getScheme,
  getSchemePref,
  getTheme,
  setSchemePref,
  setTheme,
  type Scheme,
  type SchemePref,
} from '../theme';

export const look = $state<{ theme: ThemeId; pref: SchemePref; scheme: Scheme }>({
  theme: getTheme(),
  pref: getSchemePref(),
  scheme: getScheme(),
});

export function chooseTheme(id: ThemeId): void {
  setTheme(id);
  look.theme = id;
  look.scheme = getScheme();
}

export function chooseScheme(pref: SchemePref): void {
  setSchemePref(pref);
  look.pref = pref;
  look.scheme = getScheme();
}

/** Keep `look.scheme` right when the OS switches between light and dark. */
export function followSystem(): () => void {
  return followSystemScheme((scheme) => (look.scheme = scheme));
}
