import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createUpstreamCache, MAX_CACHE_ENTRIES } from '../src/upstream-cache';

function deferredProducer<T>(): {
  producer: () => Promise<T>;
  calls: () => number;
  resolveAll: (value: T) => void;
  rejectAll: (err: Error) => void;
} {
  let calls = 0;
  const resolvers: Array<(v: T) => void> = [];
  const rejecters: Array<(e: Error) => void> = [];
  return {
    producer: () => {
      calls++;
      return new Promise<T>((resolve, reject) => {
        resolvers.push(resolve);
        rejecters.push(reject);
      });
    },
    calls: () => calls,
    resolveAll: (value) => resolvers.splice(0).forEach((r) => r(value)),
    rejectAll: (err) => rejecters.splice(0).forEach((r) => r(err)),
  };
}

const cacheable = () => true;

describe('createUpstreamCache().dedupe', () => {
  let cache = createUpstreamCache<string>();

  beforeEach(() => {
    cache = createUpstreamCache<string>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('同一キーの並行リクエストは producer を1回だけ呼び全員へ同じ結果を配る（single-flight）', async () => {
    const d = deferredProducer<string>();
    const p1 = cache.dedupe('k', d.producer, cacheable);
    const p2 = cache.dedupe('k', d.producer, cacheable);

    expect(d.calls()).toBe(1);

    d.resolveAll('R');
    expect(await p1).toBe('R');
    expect(await p2).toBe('R');
    expect(d.calls()).toBe(1);
  });

  it('解決後 TTL 内の同一キーは producer を呼ばずキャッシュ値を返す', async () => {
    const d = deferredProducer<string>();
    const p1 = cache.dedupe('k', d.producer, cacheable, 1000);
    d.resolveAll('R');
    expect(await p1).toBe('R');

    const p2 = cache.dedupe('k', d.producer, cacheable, 1000);
    expect(await p2).toBe('R');
    expect(d.calls()).toBe(1);
  });

  it('TTL 失効後の同一キーは producer を再度呼ぶ', async () => {
    vi.useFakeTimers();
    const d = deferredProducer<string>();
    const p1 = cache.dedupe('k', d.producer, cacheable, 1000);
    d.resolveAll('R1');
    expect(await p1).toBe('R1');

    vi.advanceTimersByTime(1001);

    const p2 = cache.dedupe('k', d.producer, cacheable, 1000);
    expect(d.calls()).toBe(2);
    d.resolveAll('R2');
    expect(await p2).toBe('R2');
  });

  it('異なるキーは別々に producer を呼ぶ', async () => {
    const d = deferredProducer<string>();
    const p1 = cache.dedupe('a', d.producer, cacheable);
    const p2 = cache.dedupe('b', d.producer, cacheable);
    expect(d.calls()).toBe(2);
    d.resolveAll('R');
    await Promise.all([p1, p2]);
  });

  it('isCacheable が偽の結果は保持せず、次の同一キーで再取得する', async () => {
    const d = deferredProducer<string>();
    const notCacheable = () => false;
    const p1 = cache.dedupe('k', d.producer, notCacheable);
    d.resolveAll('R1');
    expect(await p1).toBe('R1');

    const p2 = cache.dedupe('k', d.producer, notCacheable);
    expect(d.calls()).toBe(2);
    d.resolveAll('R2');
    expect(await p2).toBe('R2');
  });

  it('producer が reject した場合はキャッシュせず、各 caller へ同じ拒否を伝える', async () => {
    const d = deferredProducer<string>();
    const p1 = cache.dedupe('k', d.producer, cacheable);
    const p2 = cache.dedupe('k', d.producer, cacheable);
    expect(d.calls()).toBe(1);

    d.rejectAll(new Error('boom'));
    await expect(p1).rejects.toThrow('boom');
    await expect(p2).rejects.toThrow('boom');

    const p3 = cache.dedupe('k', d.producer, cacheable);
    expect(d.calls()).toBe(2);
    d.resolveAll('R');
    expect(await p3).toBe('R');
  });

  it('TTL 内で上限超過の成功が続いてもキャッシュは上限を超えない（最古を退避）', async () => {
    const extra = 50;
    const single =
      <T>(v: T) =>
      async () =>
        v;
    for (let i = 0; i < MAX_CACHE_ENTRIES + extra; i++) {
      await cache.dedupe(`k-${i}`, single(`v${i}`), cacheable, 10000);
    }
    expect(cache.size()).toBe(MAX_CACHE_ENTRIES);

    const oldest = deferredProducer<string>();
    const pOld = cache.dedupe('k-0', oldest.producer, cacheable, 10000);
    expect(oldest.calls()).toBe(1);
    oldest.resolveAll('re');
    await pOld;

    const recent = deferredProducer<string>();
    const pRecent = cache.dedupe(
      `k-${MAX_CACHE_ENTRIES + extra - 1}`,
      recent.producer,
      cacheable,
      10000,
    );
    expect(recent.calls()).toBe(0);
    expect(await pRecent).toBe(`v${MAX_CACHE_ENTRIES + extra - 1}`);
  });

  it('reset は保持済みキャッシュを消す', async () => {
    const d = deferredProducer<string>();
    const p1 = cache.dedupe('k', d.producer, cacheable, 10000);
    d.resolveAll('R');
    await p1;

    cache.reset();

    const p2 = cache.dedupe('k', d.producer, cacheable, 10000);
    expect(d.calls()).toBe(2);
    d.resolveAll('R2');
    expect(await p2).toBe('R2');
  });
});
