/**
 * Run an async mapper with a hard ceiling on in-flight work.
 *
 * Results keep the input index order. After the first rejection (or abort) no
 * further work is launched, but already-running tasks are awaited before the
 * failure is rethrown so the caller never leaks background requests.
 */
export interface MapWithConcurrencyOptions {
  readonly signal?: AbortSignal;
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>,
  options: MapWithConcurrencyOptions = {},
): Promise<R[]> {
  const size = items.length;
  const results: R[] = [];
  results.length = size;
  if (size === 0) return results;

  const requested = Number.isFinite(limit) ? Math.floor(limit) : 1;
  const width = Math.max(1, Math.min(size, requested));
  const signal = options.signal;
  let next = 0;
  let failed = false;
  let failure: unknown;

  const worker = async (): Promise<void> => {
    while (true) {
      if (failed) return;
      if (signal?.aborted === true) {
        failed = true;
        failure = signal.reason ?? new Error("the operation was aborted");
        return;
      }
      const index = next;
      next += 1;
      if (index >= size) return;
      const item = items[index];
      if (item === undefined) continue;
      try {
        results[index] = await run(item, index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  };

  // Only the worker count is awaited together; items never fan out unbounded.
  await Promise.all(Array.from({ length: width }, () => worker()));
  if (failed) throw failure;
  return results;
}
