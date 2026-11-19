/**
 * Bounded concurrency for API requests.
 *
 * Lifted from Sveltia CMS — https://github.com/sveltia/sveltia-cms (fork dwahdany/sveltia-cms)
 * at commit 06d5552aa, `src/lib/services/backends/git/shared/concurrency.js`.
 * Copyright (c) 2026 Kohei Yoshino. MIT License: see src/write/licenses/sveltia-MIT.txt.
 * Changes: TypeScript types only.
 */

/**
 * Maximum number of API requests to have in flight at the same time. GitHub's secondary rate limit
 * rejects more than 100 concurrent requests, and other services throttle bursts as well, so keep
 * well below that. Anything under this number is unaffected, because the whole list starts at once.
 * @see https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits
 */
export const MAX_CONCURRENT_REQUESTS = 10;

/**
 * Run the given task for each item, keeping at most a certain number of them in flight, so a long
 * list doesn't trigger a Too Many Requests error. Unlike a chunked loop, a worker picks up the next
 * item as soon as it's free, so one slow task doesn't stall the others.
 */
export const runConcurrently = async <T>(
  items: T[],
  task: (item: T) => Promise<void>,
  { concurrency = MAX_CONCURRENT_REQUESTS }: { concurrency?: number } = {},
): Promise<void> => {
  let cursor = 0;

  /** Take items off the list until it's exhausted. */
  const work = async () => {
    while (cursor < items.length) {
      const item = items[cursor];

      cursor += 1;
      await task(item);
    }
  };

  await Promise.all(
    Array(Math.min(concurrency, items.length))
      .fill(undefined)
      .map(() => work()),
  );
};

/**
 * Run the given task for each item with {@link runConcurrently}, and collect the results.
 * @returns Results, in the same order as the given items.
 */
export const mapConcurrently = async <T, R>(items: T[], task: (item: T) => Promise<R>, options?: { concurrency?: number }): Promise<R[]> => {
  const results: R[] = Array(items.length);

  // Store the results by index so they come out in the same order as the items
  await runConcurrently(
    [...items.keys()],
    async (index) => {
      results[index] = await task(items[index]);
    },
    options,
  );

  return results;
};
