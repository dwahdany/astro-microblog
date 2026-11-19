/** How a cleared field is written back, so the text lands as close to the original as it can. */
import type { FrontmatterValue } from '../../contracts';

/**
 * The value to patch when a field is emptied.
 *   - a new post (no original): '' (or [] for a list), as the scaffold writes empty values
 *   - a key the original file did not have: undefined → the key is removed again
 *   - a key the original wrote as `key:` (null): null
 *   - otherwise '' (or [])
 */
export function emptyValue(
  baseData: Record<string, unknown> | null,
  key: string,
  list = false,
): FrontmatterValue | undefined {
  if (baseData === null) return list ? [] : '';
  if (!(key in baseData)) return undefined;
  if (baseData[key] === null) return null;
  return list ? [] : '';
}
