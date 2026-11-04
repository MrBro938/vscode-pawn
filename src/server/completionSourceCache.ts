export interface CompletionSourcesCacheResult<T> {
  value: T;
  cacheHit: boolean;
}

/**
 * Refresh only entries that are ready. Pending entries remain stale so a
 * later request can pick up their completed background analysis.
 */
export function refreshReadyCompletionSources(
  staleUris: Set<string>,
  isReady: (uri: string) => boolean,
  refresh: (uri: string) => void
): number {
  const deferred = new Set<string>();
  staleUris.forEach((uri) => {
    if (!isReady(uri)) {
      deferred.add(uri);
      return;
    }
    refresh(uri);
  });

  staleUris.clear();
  deferred.forEach((uri) => staleUris.add(uri));
  return deferred.size;
}

/**
 * Small LRU cache for prepared completion sources.
 *
 * Call clear() whenever source contents, the include graph, indexed files or
 * the configured search scope changes.
 */
export class CompletionSourcesCache<T> {
  private readonly entries = new Map<string, T>();

  constructor(private readonly capacity = 8) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("Completion sources cache capacity must be a positive integer");
    }
  }

  getOrCreate(key: string, create: () => T): CompletionSourcesCacheResult<T> {
    if (this.entries.has(key)) {
      const value = this.entries.get(key)!;
      this.entries.delete(key);
      this.entries.set(key, value);
      return { value, cacheHit: true };
    }

    const value = create();
    this.entries.set(key, value);
    while (this.entries.size > this.capacity) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }

    return { value, cacheHit: false };
  }

  forEachValue(callback: (value: T) => void): void {
    this.entries.forEach(callback);
  }

  clear(): void {
    this.entries.clear();
  }
}
