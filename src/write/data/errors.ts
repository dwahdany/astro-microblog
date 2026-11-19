/**
 * Typed errors of the data layer. The classes live in the shared contract
 * (src/write/contracts.ts) so every area can `instanceof` them; this module
 * re-exports them for the files in this directory. Every message is written
 * to be shown to the owner as-is.
 */
export { DraftStoreError, FrontmatterPatchError, SourceUnavailableError } from '../contracts';
export type { UnavailableReason } from '../contracts';

export function isAbortError(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { name?: unknown }).name === 'AbortError';
}
