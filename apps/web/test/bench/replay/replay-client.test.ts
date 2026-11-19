import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GeoPoint } from '@aruku/engine/models/geo-point';
import { ClientException, TimeoutException } from '@aruku/engine/services/http-client';

import {
  isInitialQuery,
  ReplaySession,
  timedOutStatus,
  type ReplayEntry,
} from '../../../src/bench/replay/replay-client';

const transit = 'https://api.transit.ls8h.com';
const proxy = 'https://proxy.invalid';
const origin = new GeoPoint(35.4661, 139.62);
const goal = new GeoPoint(35.5305, 139.7);

const guidance = (from: GeoPoint, to: GeoPoint, avoid = 'bus,ferry,air'): URL => {
  const url = new URL(`${transit}/api/v1/guidance/plan`);
  url.searchParams.set('from', `geo:${from.lat},${from.lng}`);
  url.searchParams.set('to', `geo:${to.lat},${to.lng}`);
  url.searchParams.set('avoidModes', avoid);
  return url;
};

const entry = (text: string, ms: number, status = 200): ReplayEntry => ({
  status,
  body: Buffer.from(text).toString('base64'),
  ms,
});

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString('utf8');

describe('isInitialQuery', () => {
  it('出発地→目的地でバスを避ける照会だけを、初回の照会とみなす', () => {
    expect(isInitialQuery(guidance(origin, goal), origin, goal)).toBe(true);
  });

  it('バスを許す照会（バス last-resort）は初回ではない', () => {
    expect(isInitialQuery(guidance(origin, goal, 'ferry,air'), origin, goal)).toBe(false);
  });

  it('途中の地点から引き直す照会は初回ではない', () => {
    const mid = new GeoPoint(35.5, 139.66);
    expect(isInitialQuery(guidance(mid, goal), origin, goal)).toBe(false);
  });
});

describe('ReplaySession', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const session = (
    init: Partial<ConstructorParameters<typeof ReplaySession>[0]> = {},
  ): ReplaySession =>
    new ReplaySession({
      mode: 'replay',
      store: {},
      fetchLive: () => Promise.reject(new Error('上流を叩いてはいけない')),
      proxyOrigin: proxy,
      ...init,
    });

  describe('再生', () => {
    it('録画した本文とステータスを、録画した遅延のあとで返す', async () => {
      const url = guidance(origin, goal);
      const s = session({ store: { [url.href]: entry('{"options":[]}', 1000, 200) } });

      let settled = false;
      const res = s
        .client()
        .get(url)
        .finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const got = await res;
      expect(got.statusCode).toBe(200);
      expect(text(got.bodyBytes)).toBe('{"options":[]}');
    });

    it('録画でタイムアウトだった照会は、同じ遅延のあとで TimeoutException になる', async () => {
      const url = guidance(origin, goal);
      const s = session({ store: { [url.href]: entry('', 35_000, timedOutStatus) } });

      const res = s.client().get(url);
      // oxlint-disable-next-line vitest/valid-expect
      const assertion = expect(res).rejects.toBeInstanceOf(TimeoutException);
      await vi.advanceTimersByTimeAsync(35_000);
      await assertion;
    });

    it('録画に無い照会は上流へ取りに行き、外れとして数え、録画に足す', async () => {
      const url = guidance(origin, goal);
      const live = entry('{"live":true}', 8000);
      const fetchLive = vi.fn(() => Promise.resolve(live));
      const s = session({ fetchLive });

      const got = await s.client().get(url);

      expect(text(got.bodyBytes)).toBe('{"live":true}');
      expect(fetchLive).toHaveBeenCalledOnce();
      expect(s.misses).toBe(1);
      expect(s.store[url.href]).toEqual(live);
    });

    it('同じ照会が同時に外れても、上流へは1本だけ取りに行く', async () => {
      const url = guidance(origin, goal);
      const fetchLive = vi.fn(() => Promise.resolve(entry('{}', 10)));
      const s = session({ fetchLive });

      await Promise.all([s.client().get(url), s.client().get(url)]);

      expect(fetchLive).toHaveBeenCalledOnce();
    });

    it('上流でタイムアウトした外れは TimeoutException になる', async () => {
      const url = guidance(origin, goal);
      const s = session({
        fetchLive: () => Promise.resolve(entry('', 35_000, timedOutStatus)),
      });

      await expect(s.client().get(url)).rejects.toBeInstanceOf(TimeoutException);
    });
  });

  describe('引き直しの上限の模擬', () => {
    const mid = new GeoPoint(35.5, 139.66);

    it('初回以外で録画の遅延が上限を超える照会は、上限の時刻に TimeoutException になる', async () => {
      const url = guidance(mid, goal);
      const s = session({
        store: { [url.href]: entry('{}', 30_000) },
        refetchLimitMs: 20_000,
        isInitial: (u) => isInitialQuery(u, origin, goal),
      });

      let settled = false;
      const res = s.client().get(url);
      res.catch(() => undefined).finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(19_999);
      expect(settled).toBe(false);
      // oxlint-disable-next-line vitest/valid-expect
      const assertion = expect(res).rejects.toBeInstanceOf(TimeoutException);
      await vi.advanceTimersByTimeAsync(1);
      await assertion;
      expect(s.limitHits).toBe(1);
    });

    it('初回の照会には上限を掛けない', async () => {
      const url = guidance(origin, goal);
      const s = session({
        store: { [url.href]: entry('{}', 30_000) },
        refetchLimitMs: 20_000,
        isInitial: (u) => isInitialQuery(u, origin, goal),
      });

      const res = s.client().get(url);
      await vi.advanceTimersByTimeAsync(30_000);

      expect((await res).statusCode).toBe(200);
      expect(s.limitHits).toBe(0);
    });

    it('上限以内に返る照会はそのまま返す', async () => {
      const url = guidance(mid, goal);
      const s = session({
        store: { [url.href]: entry('{}', 20_000) },
        refetchLimitMs: 20_000,
      });

      const res = s.client().get(url);
      await vi.advanceTimersByTimeAsync(20_000);

      expect((await res).statusCode).toBe(200);
    });
  });

  describe('録画', () => {
    it('録画済みでも上流へ取りに行き、取り直した応答で録画を置き換える', async () => {
      const url = guidance(origin, goal);
      const fresh = entry('{"fresh":true}', 9000);
      const s = session({
        mode: 'record',
        store: { [url.href]: entry('{"old":true}', 1) },
        fetchLive: () => Promise.resolve(fresh),
      });

      const got = await s.client().get(url);

      expect(text(got.bodyBytes)).toBe('{"fresh":true}');
      expect(s.store[url.href]).toEqual(fresh);
      expect(s.misses).toBe(0);
    });
  });

  describe('settle', () => {
    it('クライアントを閉じたあとに返った上流の応答も、待って録画に残す', async () => {
      const url = guidance(origin, goal);
      let release!: (e: ReplayEntry) => void;
      const s = session({
        mode: 'record',
        fetchLive: () => new Promise<ReplayEntry>((resolve) => (release = resolve)),
      });
      const client = s.client();
      client.get(url).catch(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      client.close();

      const settled = s.settle();
      release(entry('{}', 40_000));
      await settled;

      expect(s.store[url.href]).toEqual(entry('{}', 40_000));
    });
  });

  describe('徒歩プロキシ', () => {
    it('合成した応答を返し、録画にも上流にも触れない', async () => {
      const fetchLive = vi.fn();
      const s = session({ fetchLive });
      const url = new URL(`${proxy}/googleWalkProxy`);
      url.searchParams.set('start', '35.4661,139.62');
      url.searchParams.set('goal', '35.5305,139.7');

      const res = s.client().get(url);
      await vi.runAllTimersAsync();

      expect((await res).statusCode).toBe(200);
      expect(fetchLive).not.toHaveBeenCalled();
      expect(s.store).toEqual({});
    });

    it('合成できない経路（厳密走査を渡していないときの exactWalkMax など）は 404 を返す', async () => {
      const s = session();
      const res = await s.client().get(new URL(`${proxy}/exactWalkMax`));
      expect(res.statusCode).toBe(404);
    });
  });

  describe('厳密走査（#513）', () => {
    it('exactWalkMax の照会は渡した関数に答えさせ、指定の遅延のあとで返す', async () => {
      const fetchLive = vi.fn();
      const exactWalkMax = vi.fn(async () => ({ status: 200, body: '{"candidates":[]}' }));
      const s = session({ fetchLive, exactWalkMax, exactDelayMs: 900 });
      const url = new URL(`${proxy}/exactWalkMax?origin=1,2`);

      let settled = false;
      const res = s
        .client()
        .get(url)
        .finally(() => (settled = true));
      await vi.advanceTimersByTimeAsync(899);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      const got = await res;
      expect(got.statusCode).toBe(200);
      expect(text(got.bodyBytes)).toBe('{"candidates":[]}');
      expect(exactWalkMax).toHaveBeenCalledWith(url);
      expect(fetchLive).not.toHaveBeenCalled();
      expect(s.store).toEqual({});
    });

    it('本番の失敗（503 の時刻表なしなど）も、そのまま返す', async () => {
      const s = session({
        exactWalkMax: async () => ({ status: 503, body: '{"error":"timetable unavailable"}' }),
        exactDelayMs: 0,
      });
      const res = await s.client().get(new URL(`${proxy}/exactWalkMax`));
      expect(res.statusCode).toBe(503);
    });
  });

  describe('close', () => {
    it('待っている照会を ClientException で中断する', async () => {
      const url = guidance(origin, goal);
      const s = session({ store: { [url.href]: entry('{}', 10_000) } });
      const client = s.client();

      const res = client.get(url);
      // oxlint-disable-next-line vitest/valid-expect
      const assertion = expect(res).rejects.toBeInstanceOf(ClientException);
      client.close();
      await assertion;
    });

    it('閉じたあとの照会は ClientException になる', async () => {
      const client = session().client();
      client.close();
      await expect(client.get(guidance(origin, goal))).rejects.toBeInstanceOf(ClientException);
    });

    it('閉じても同じセッションの別のクライアントは中断しない', async () => {
      const url = guidance(origin, goal);
      const s = session({ store: { [url.href]: entry('{}', 1000) } });
      const a = s.client();
      const b = s.client();

      const res = b.get(url);
      a.close();
      await vi.advanceTimersByTimeAsync(1000);

      expect((await res).statusCode).toBe(200);
    });
  });

  it('発行した Transit の照会を onRequest へ知らせる', async () => {
    const url = guidance(origin, goal);
    const seen: string[] = [];
    const s = session({
      store: { [url.href]: entry('{}', 0) },
      onRequest: (u) => seen.push(u.href),
    });

    await s.client().get(url);

    expect(seen).toEqual([url.href]);
  });
});
