/**
 * What stands between a post and "Publish", and small decisions around saving.
 * Pure, so the rules can be tested without a browser or a source that can save.
 */
import { SaveConflictError, SaveError, type CollectionKind, type FrontmatterIssue, type ParsedFrontmatter, type PostRef } from '../../contracts';

export interface PublishContext {
  /** `PostRef.id` of the post being edited. */
  id: string;
  isNew: boolean;
  /** Where the post will be written. */
  path: string;
  collection: CollectionKind;
  parsed: ParsedFrontmatter;
  /** `frontmatter.validate(collection, parsed.data)`. */
  issues: readonly FrontmatterIssue[];
  /** The post list as last loaded (to see whether a new post's path is taken). */
  posts: readonly Pick<PostRef, 'id' | 'path'>[];
  /** The draft is in conflict with the source (`DraftRecord.conflict`). */
  conflict: boolean;
  /** The post was changed in another tab and this tab has not caught up. */
  superseded: boolean;
  /** `contentSource.label`, for the messages. */
  sourceLabel: string;
}

/**
 * The sentence for an unresolved conflict. Review says the conflict once, in its own message with
 * the way out next to it, and leaves this one out of the list it shows (`blockersToList`).
 */
export const conflictBlocker = (sourceLabel: string): string =>
  `This post changed in ${sourceLabel} in the same lines you changed. Publishing now would undo that change: keep your version or discard it first.`;

/** The blockers Review lists under Publish: all of them but the conflict, which it says by itself. */
export function blockersToList(blockers: readonly string[], sourceLabel: string): string[] {
  const conflict = conflictBlocker(sourceLabel);
  return blockers.filter((b) => b !== conflict);
}

/**
 * Reasons this post must not be published as it is, each a sentence for the owner. Empty = go.
 * (Whether there is anything to publish at all — changes, a source that can save — is the
 * caller's business.)
 */
export function publishBlockers(context: PublishContext): string[] {
  const out: string[] = [];
  if (context.superseded) out.push('This post was changed in another tab. Choose which version to keep first.');
  if (context.conflict) out.push(conflictBlocker(context.sourceLabel));
  if (context.parsed.issues.length > 0) {
    out.push('The frontmatter is not valid YAML. Fix it in the file first.');
  } else {
    for (const issue of context.issues) out.push(issue.message);
  }
  const taken = takenBy(context);
  if (taken) out.push(`There is already a post at ${context.path}. Change the slug.`);
  return out;
}

/** The listed post whose file a NEW post would overwrite, if any. */
export function takenBy(context: Pick<PublishContext, 'id' | 'isNew' | 'path' | 'posts'>): Pick<PostRef, 'id' | 'path'> | undefined {
  if (!context.isNew) return undefined;
  return context.posts.find((p) => p.path === context.path && p.id !== context.id);
}

/** What the owner chose in the Review sheet for this publish. */
export interface PublishOptions {
  /** The commit message as shown in the sheet. */
  message?: string;
  /** Also move the file to the address its changed slug gives it. */
  move?: boolean;
}

/** A failed publish or delete, as the Review sheet says it. */
export interface SaveProblem {
  /** `SaveError.reason`, `'conflict:<reason>'`, `'read-only'` or `'failed'` — for tests and styling. */
  reason: string;
  /** What happened and what to do next. */
  message: string;
  /** Signing in (again) is the way forward. */
  signIn: boolean;
}

/**
 * Say why a save did not happen. The data layer's messages are already written to be shown; this
 * adds the next step where there is one, and makes sure nothing ever reads as lost work.
 */
export function explainSaveFailure(err: unknown, kind: 'publish' | 'delete' = 'publish'): SaveProblem {
  const what = kind === 'delete' ? 'Nothing was deleted.' : 'Nothing was published.';
  const kept = kind === 'delete' ? '' : ' Your changes are still on this device.';
  if (err instanceof SaveConflictError) {
    const message: Record<SaveConflictError['reason'], string> = {
      changed:
        kind === 'delete'
          ? `This post changed in the repository since you opened it. ${what} Look at it as it is now, then delete it if you still want to.`
          : `This post changed in the repository since you started. ${what} It was read again: check what is flagged above, then publish.`,
      missing: `This post is no longer in the repository: it was deleted or moved. ${what}${kind === 'delete' ? '' : ' What you see is your copy; publishing it again creates the file anew.'}`,
      exists: `${err.message} ${what}`,
      'branch-moved': `The repository kept changing while this was being sent. ${what} Try again in a moment.`,
    };
    return { reason: `conflict:${err.reason}`, message: message[err.reason], signIn: false };
  }
  if (err instanceof SaveError) {
    const partial = err.partial ? ' Some images were already uploaded; publishing again sends only what is missing.' : '';
    switch (err.reason) {
      case 'signed-out':
        return { reason: err.reason, message: `You are no longer signed in. ${what}${kept} Sign in again, then publish.`, signIn: true };
      case 'offline':
        return { reason: err.reason, message: `GitHub cannot be reached. This device seems to be offline. ${what}${kept}${partial} Try again when you are back online.`, signIn: false };
      case 'forbidden':
        return { reason: err.reason, message: `${err.message} ${what}${kept}`, signIn: false };
      default:
        return { reason: err.reason, message: `${err.message} ${what}${kept}${partial}`, signIn: false };
    }
  }
  const code = (err as { code?: unknown } | null)?.code;
  const text = err instanceof Error ? err.message : String(err);
  if (code === 'READ_ONLY') return { reason: 'read-only', message: text, signIn: true };
  return { reason: 'failed', message: `${kind === 'delete' ? 'Deleting' : 'Publishing'} failed: ${text} ${what}${kept}`, signIn: false };
}

/**
 * The text to keep as a draft after a publish went through. Usually nothing was typed meanwhile
 * (`now === sent`) and what remains is the committed text itself. When the owner kept typing
 * while the commit was under way, their newer text is kept — but a publish that MOVED the file
 * rewrote the image references to the new folder, and the newer text still has the old ones: it
 * gets the same rewrite (`rewrite`), or publishing it later would point at images that moved away.
 */
export function textLeftAfterPublish(now: string, sent: string, committed: string, rewrite: (text: string) => string): string {
  return now === sent ? committed : rewrite(now);
}

/** A save problem the writing screen itself has to say, because Review is not open to say it. */
export function saidOutsideReview(problem: SaveProblem | null, sheet: string | null): boolean {
  // A post that changed or went away is re-read, and that has banners of its own.
  return problem !== null && sheet !== 'review' && problem.reason !== 'conflict:changed' && problem.reason !== 'conflict:missing';
}
