import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dedupeUpstream, resetUpstreamCache } from "../src/upstream-cache";

// テスト用の遅延つき producer。呼び出し回数を数え、resolve/reject を外から制御する。
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

describe("dedupeUpstream", () => {
  beforeEach(() => {
    resetUpstreamCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    resetUpstreamCache();
  });

  it("同一キーの並行リクエストは producer を1回だけ呼び全員へ同じ結果を配る（single-flight）", async () => {
    const d = deferredProducer<string>();
    const p1 = dedupeUpstream("k", d.producer, cacheable);
    const p2 = dedupeUpstream("k", d.producer, cacheable);

    // まだ解決していない段階で2つとも同じ in-flight を共有している。
    expect(d.calls()).toBe(1);

    d.resolveAll("R");
    expect(await p1).toBe("R");
    expect(await p2).toBe("R");
    expect(d.calls()).toBe(1);
  });

  it("解決後 TTL 内の同一キーは producer を呼ばずキャッシュ値を返す", async () => {
    const d = deferredProducer<string>();
    const p1 = dedupeUpstream("k", d.producer, cacheable, 1000);
    d.resolveAll("R");
    expect(await p1).toBe("R");

    const p2 = dedupeUpstream("k", d.producer, cacheable, 1000);
    expect(await p2).toBe("R");
    expect(d.calls()).toBe(1);
  });

  it("TTL 失効後の同一キーは producer を再度呼ぶ", async () => {
    vi.useFakeTimers();
    const d = deferredProducer<string>();
    const p1 = dedupeUpstream("k", d.producer, cacheable, 1000);
    d.resolveAll("R1");
    expect(await p1).toBe("R1");

    vi.advanceTimersByTime(1001);

    const p2 = dedupeUpstream("k", d.producer, cacheable, 1000);
    expect(d.calls()).toBe(2);
    d.resolveAll("R2");
    expect(await p2).toBe("R2");
  });

  it("異なるキーは別々に producer を呼ぶ", async () => {
    const d = deferredProducer<string>();
    const p1 = dedupeUpstream("a", d.producer, cacheable);
    const p2 = dedupeUpstream("b", d.producer, cacheable);
    expect(d.calls()).toBe(2);
    d.resolveAll("R");
    await Promise.all([p1, p2]);
  });

  it("isCacheable が偽の結果は保持せず、次の同一キーで再取得する", async () => {
    const d = deferredProducer<string>();
    const notCacheable = () => false;
    const p1 = dedupeUpstream("k", d.producer, notCacheable);
    d.resolveAll("R1");
    expect(await p1).toBe("R1");

    // 保持していないので2回目は新たに producer を呼ぶ。
    const p2 = dedupeUpstream("k", d.producer, notCacheable);
    expect(d.calls()).toBe(2);
    d.resolveAll("R2");
    expect(await p2).toBe("R2");
  });

  it("producer が reject した場合はキャッシュせず、各 caller へ同じ拒否を伝える", async () => {
    const d = deferredProducer<string>();
    const p1 = dedupeUpstream("k", d.producer, cacheable);
    const p2 = dedupeUpstream("k", d.producer, cacheable);
    expect(d.calls()).toBe(1);

    d.rejectAll(new Error("boom"));
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).rejects.toThrow("boom");

    // 失敗は保持されない。次の同一キーは producer を呼び直す。
    const p3 = dedupeUpstream("k", d.producer, cacheable);
    expect(d.calls()).toBe(2);
    d.resolveAll("R");
    expect(await p3).toBe("R");
  });

  it("resetUpstreamCache は保持済みキャッシュを消す", async () => {
    const d = deferredProducer<string>();
    const p1 = dedupeUpstream("k", d.producer, cacheable, 10000);
    d.resolveAll("R");
    await p1;

    resetUpstreamCache();

    const p2 = dedupeUpstream("k", d.producer, cacheable, 10000);
    expect(d.calls()).toBe(2);
    d.resolveAll("R2");
    expect(await p2).toBe("R2");
  });
});
