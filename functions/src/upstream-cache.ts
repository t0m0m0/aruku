export const UPSTREAM_CACHE_TTL_MS = 30_000;

export const MAX_CACHE_ENTRIES = 500;

interface ResolvedEntry<T> {
  value: T;
  expiresAt: number;
}

export interface UpstreamCache<T> {
  dedupe(
    key: string,
    producer: () => Promise<T>,
    isCacheable: (value: T) => boolean,
    ttlMs?: number,
  ): Promise<T>;
  reset(): void;
  size(): number;
}

export function createUpstreamCache<T>(): UpstreamCache<T> {
  const inflight = new Map<string, Promise<T>>();
  const resolved = new Map<string, ResolvedEntry<T>>();

  const pruneExpired = (now: number): void => {
    for (const [k, entry] of resolved) {
      if (now >= entry.expiresAt) resolved.delete(k);
    }
  };

  const evictForInsert = (now: number): void => {
    if (resolved.size < MAX_CACHE_ENTRIES) return;
    pruneExpired(now);
    while (resolved.size >= MAX_CACHE_ENTRIES) {
      const oldest = resolved.keys().next().value;
      if (oldest === undefined) break;
      resolved.delete(oldest);
    }
  };

  return {
    dedupe(key, producer, isCacheable, ttlMs = UPSTREAM_CACHE_TTL_MS) {
      const now = Date.now();

      const cached = resolved.get(key);
      if (cached) {
        if (now < cached.expiresAt) return Promise.resolve(cached.value);
        resolved.delete(key);
      }

      const pending = inflight.get(key);
      if (pending) return pending;

      const promise = producer()
        .then((value) => {
          if (isCacheable(value)) {
            evictForInsert(Date.now());
            resolved.set(key, { value, expiresAt: Date.now() + ttlMs });
          }
          return value;
        })
        .finally(() => {
          inflight.delete(key);
        });

      inflight.set(key, promise);
      return promise;
    },
    reset() {
      inflight.clear();
      resolved.clear();
    },
    size() {
      return resolved.size;
    },
  };
}
