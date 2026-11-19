/**
 * How fresh the content source's answers are, so the UI can say "showing the
 * copy from 14:02 — GitHub is rate-limiting". The shape (`SourceStatus`) and
 * the two methods on `ContentSource` are part of the shared contract.
 */
import type { ContentSource, SourceStatus } from '../contracts';

export type { SourceStatus } from '../contracts';

export type StatusReporter = Pick<ContentSource, 'status' | 'onStatus'>;

export function createStatus(initial: SourceStatus = { state: 'idle' }) {
  let current = initial;
  const listeners = new Set<(status: SourceStatus) => void>();
  return {
    get: () => current,
    set(next: SourceStatus) {
      current = next;
      listeners.forEach((l) => l(current));
    },
    subscribe(listener: (status: SourceStatus) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}
