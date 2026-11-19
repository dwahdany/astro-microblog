/**
 * Hash routes. The page is one prerendered file, so everything after `#` is
 * ours. Sheets are part of the route: a phone's back button closes the sheet,
 * and a reload brings it back.
 *
 *   #/                        the post list
 *   #/new   #/look  #/account … with the "New post" / "Look" / "Account" sheet open
 *   #/post/<id>               a post open for writing (<id> is URI-encoded, so it contains no `/`)
 *   #/post/<id>/properties    … with a sheet open: properties | review | more | look | account
 */
export const LIST_SHEETS = ['new', 'look', 'account'] as const;
export const POST_SHEETS = ['properties', 'review', 'more', 'look', 'account'] as const;
export type ListSheet = (typeof LIST_SHEETS)[number];
export type PostSheet = (typeof POST_SHEETS)[number];

export type Route =
  | { name: 'list'; sheet: ListSheet | null }
  | { name: 'post'; id: string; sheet: PostSheet | null };

const isOneOf = <T extends string>(list: readonly T[], value: string | undefined): value is T =>
  value !== undefined && (list as readonly string[]).includes(value);

export function parseHash(hash: string): Route {
  const segments = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (segments[0] === 'post' && segments[1]) {
    try {
      const id = decodeURIComponent(segments[1]);
      return { name: 'post', id, sheet: isOneOf(POST_SHEETS, segments[2]) ? segments[2] : null };
    } catch {
      return { name: 'list', sheet: null };
    }
  }
  return { name: 'list', sheet: isOneOf(LIST_SHEETS, segments[0]) ? segments[0] : null };
}

export const postHref = (id: string, sheet?: PostSheet | null): string =>
  `#/post/${encodeURIComponent(id)}${sheet ? `/${sheet}` : ''}`;

export const listHref = (sheet?: ListSheet | null): string => `#/${sheet ?? ''}`;

/** The hash for a route — `parseHash(hrefOf(route))` gives the route back. */
export function hrefOf(route: Route): string {
  return route.name === 'post' ? postHref(route.id, route.sheet) : listHref(route.sheet);
}
