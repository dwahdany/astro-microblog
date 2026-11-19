/**
 * The router: one reactive `route`, kept in step with `location.hash`.
 * No framework router — the History API is enough for two screens.
 *
 * Opening a sheet pushes a history entry (flagged in `history.state`), so
 * closing it can simply go back; a sheet reached by reload or deep link has
 * no entry of its own underneath, so closing replaces instead.
 */
import { hrefOf, parseHash, type ListSheet, type PostSheet, type Route } from './routes';

const SHEET_STATE = 'writeSheet';

class Router {
  route = $state<Route>(parseHash(typeof location === 'undefined' ? '' : location.hash));

  private sync = () => {
    this.route = parseHash(location.hash);
  };

  /** Start listening; returns a function that stops. */
  start(): () => void {
    this.sync();
    window.addEventListener('popstate', this.sync);
    window.addEventListener('hashchange', this.sync);
    return () => {
      window.removeEventListener('popstate', this.sync);
      window.removeEventListener('hashchange', this.sync);
    };
  }

  /** Navigate to a hash. `replace` swaps the current history entry instead of adding one. */
  go(href: string, opts: { replace?: boolean } = {}): void {
    if (opts.replace) history.replaceState(null, '', href);
    else history.pushState(null, '', href);
    this.sync();
  }

  /** Open a sheet over the current screen (or swap the one that is open). */
  openSheet(sheet: ListSheet | PostSheet): void {
    const current = this.route;
    const next = { ...current, sheet } as Route;
    if (current.sheet === null) history.pushState({ [SHEET_STATE]: true }, '', hrefOf(next));
    else history.replaceState(history.state, '', hrefOf(next));
    this.sync();
  }

  /** Close the open sheet, if any. */
  closeSheet(): void {
    const current = this.route;
    if (current.sheet === null) return;
    if (history.state?.[SHEET_STATE]) {
      history.back(); // popstate re-syncs
      return;
    }
    history.replaceState(null, '', hrefOf({ ...current, sheet: null } as Route));
    this.sync();
  }
}

export const router = new Router();
