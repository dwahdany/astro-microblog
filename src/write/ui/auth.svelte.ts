/**
 * Who is signed in, as reactive state for the shell. The session itself (storage, refresh, the
 * popup) is the data layer's (`auth` in ../data); this only mirrors `auth.state()` and remembers
 * how the last attempt to sign in went, so the message survives the sheet being closed.
 */
import { AuthError, type AuthFailure, type AuthState } from '../contracts';
import { auth, contentSource } from '../data';

export const account = $state<{
  state: AuthState;
  /** Why the last sign-in attempt did not work, as a sentence. Cleared by the next attempt. */
  problem: { reason: AuthFailure; message: string } | null;
}>({ state: auth.state(), problem: null });

auth.onChange((next) => {
  account.state = next;
  if (next.status === 'signed-in') account.problem = null;
});

/** Whether signing in leads anywhere: the working-tree source (dev) has nothing to publish to. */
export const canPublishHere = contentSource.kind === 'github';

/** Each way a sign-in can fail, said so that the next step is obvious. */
function explain(err: unknown): { reason: AuthFailure; message: string } {
  if (!(err instanceof AuthError)) return { reason: 'failed', message: 'Sign-in did not work. Try again.' };
  const message: Partial<Record<AuthFailure, string>> = {
    // The data layer tells a Cancel from a window that was closed (which may have shown an error).
    cancelled: `${err.message} Nothing changed.`,
    'invalid-token': 'GitHub does not accept this token. Check that it was copied in full and has not expired or been deleted.',
    'popup-blocked': 'The browser blocked the sign-in window. Allow pop-ups for this site and try again, or use a token.',
    offline: 'GitHub cannot be reached. This device seems to be offline. Your drafts are safe; sign in when you are back online.',
  };
  return { reason: err.reason, message: message[err.reason] ?? err.message };
}

const attempt = (work: Promise<unknown>): Promise<boolean> =>
  work.then(
    () => true,
    (err) => {
      account.problem = explain(err);
      return false;
    },
  );

/**
 * Open the GitHub sign-in window. Call it DIRECTLY from the tap handler: the window is opened
 * before anything is awaited, or the browser blocks it.
 */
export function signInWithGithub(): Promise<boolean> {
  account.problem = null;
  return attempt(auth.signInWithGithub());
}

export function signInWithToken(token: string): Promise<boolean> {
  account.problem = null;
  return attempt(auth.signInWithToken(token.trim()));
}

export const cancelSignIn = (): void => auth.cancelSignIn();

export function signOut(): void {
  account.problem = null;
  auth.signOut();
}

export const popupSupported = auth.popupSupported;
export const tokenHelpUrl = auth.tokenHelpUrl;
