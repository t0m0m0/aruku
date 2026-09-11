// 移植元: lib/core/services/route_service.dart の `routeServiceProvider`。
//
// Phase 2 は「あれは DI の配線であってエンジンの仕様ではない」として移していない
// （packages/engine/src/services/route-service.ts の冒頭）。ここがその置き換え。
// SearchScopedRouteService 自体の振る舞いはエンジン側に在る
// （packages/engine/test/services/search-scoped-route-service.test.ts）ので、
// ここで見るのは**この配線が決めていること**だけ。

import { describe, expect, it, vi } from 'vitest';

import { TimeoutException } from '@aruku/engine/services/http-client';
import {
  proxyRequestTimeout,
  transitRequestTimeout,
} from '@aruku/engine/services/route-service';
import { CancellationToken } from '@aruku/engine/services/cancellation';
import { GeoPoint } from '@aruku/engine/models/geo-point';
import { TimeValue } from '@aruku/engine/models/time-value';

import type { Fetch } from '../../src/http/fetch-http-client';
import {
  createProxyClient,
  createRouteService,
  createTransitClient,
} from '../../src/search/route-service';

const headerName = 'X-Firebase-AppCheck';

function okFetch(): Fetch {
  return async () => new Response('{}', { status: 200 });
}

const appCheck = {
  tokenProvider: async () => 'standard_token',
  limitedUseTokenProvider: async () => 'limited_use_token',
};

describe('クライアントの組み立て', () => {
  it('Transit 直叩きには App Check を通さない', async () => {
    const fetch = vi.fn<Fetch>(okFetch());

    await createTransitClient({ fetch }).get(
      new URL('https://api.transit.example/guidance/plan'),
    );

    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.has(headerName)).toBe(false);
  });

  it('プロキシには App Check を通す', async () => {
    const fetch = vi.fn<Fetch>(okFetch());

    await createProxyClient({ appCheck, fetch }).get(
      new URL('https://proxy.example/googleWalkProxy'),
    );

    const headers = new Headers(fetch.mock.calls[0]?.[1]?.headers);
    expect(headers.get(headerName)).toBe('standard_token');
  });

  it('Transit とプロキシで別のタイムアウトを張る (#300)', () => {
    // 直叩きは上流の裾が長い。プロキシの無応答は本当に異常なので早く縮退させる。
    expect(createTransitClient({ fetch: okFetch() }).timeout).toBe(
      transitRequestTimeout,
    );
    expect(createProxyClient({ appCheck, fetch: okFetch() }).timeout).toBe(
      proxyRequestTimeout,
    );
  });

  it('プロキシでは App Check をタイムアウトの内側に置く (#156)', async () => {
    const client = createProxyClient({
      appCheck: {
        tokenProvider: () => new Promise(() => {}),
        limitedUseTokenProvider: () => new Promise(() => {}),
      },
      fetch: okFetch(),
      timeout: 20,
    });

    await expect(
      client.get(new URL('https://proxy.example/googleWalkProxy')),
    ).rejects.toThrow(TimeoutException);
  });
});

describe('ベース URL の検証', () => {
  // 空の base で組み立てると、エンジンが徒歩実測の URL を作る瞬間に
  // `new URL('/googleWalkMatrixProxy')` が TypeError で倒れる（Dart の Uri.parse は
  // 相対 URI を作れたので移植元では起きない）。縮退で吸収されないため、成功する
  // はずだった検索がまるごと落ちる（PR #391 レビュー）。
  //
  // RouteException にしないのはエンジンの先例に倣う——配線漏れを RouteException に
  // すると縮退パスに握り潰され、「徒歩が長い経路」として静かに出る
  // （transit-api-client.ts の 'no HTTP client was injected'）。
  const valid = {
    transitBaseUrl: 'https://api.transit.example',
    proxyBaseUrl: 'https://proxy.example',
    appCheck,
    fetch: okFetch(),
  };

  it('プロキシのベース URL が空なら組み立てを拒む', () => {
    expect(() => createRouteService({ ...valid, proxyBaseUrl: '' })).toThrow(
      /VITE_PROXY_BASE_URL/,
    );
  });

  it('Transit のベース URL が空なら組み立てを拒む', () => {
    expect(() => createRouteService({ ...valid, transitBaseUrl: '' })).toThrow(
      /VITE_TRANSIT_API_BASE_URL/,
    );
  });

  it('絶対 URL でないベースも拒む', () => {
    expect(() =>
      createRouteService({ ...valid, proxyBaseUrl: '/api' }),
    ).toThrow(/VITE_PROXY_BASE_URL/);
  });

  it('両方そろっていれば組み立てられる', () => {
    expect(() => createRouteService(valid)).not.toThrow();
  });
});

describe('createRouteService', () => {
  const planArgs = {
    destination: '東京駅',
    destinationLatLng: new GeoPoint(35.681, 139.767),
    origin: new GeoPoint(35.658, 139.701),
    departure: new TimeValue({ h: 9, m: 0 }),
    arrival: new TimeValue({ h: 10, m: 0 }),
  };

  function build(fetch: Fetch) {
    return createRouteService({
      transitBaseUrl: 'https://api.transit.example',
      proxyBaseUrl: 'https://proxy.example',
      appCheck,
      fetch,
    });
  }

  it('検索ごとに新しいクライアントを組み立てる (#259)', async () => {
    // 検索をまたいでクライアントを共有すると、片方のキャンセルが他方の
    // in-flight を巻き添えで切る。所有が検索1回ぶんであることを、発行された
    // リクエストの AbortSignal が検索ごとに別物であることで見る。
    const signals: (AbortSignal | null | undefined)[] = [];
    const service = build(async (_url, init) => {
      signals.push(init?.signal);
      throw new TypeError('Failed to fetch');
    });

    await service.plan(planArgs).catch(() => {});
    await service.plan(planArgs).catch(() => {});

    expect(signals.length).toBeGreaterThanOrEqual(2);
    expect(signals[0]).not.toBe(signals.at(-1));
  });

  it('キャンセルで in-flight のリクエストが中断される (#259)', async () => {
    let aborted = false;
    const service = build(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );

    const cancellation = new CancellationToken();
    const pending = service.plan({ ...planArgs, cancellation });
    // 発行が始まってから倒す。発行前ガードではなく in-flight の中断を見たい。
    await Promise.resolve();
    cancellation.cancel();

    await pending.catch(() => {});
    expect(aborted).toBe(true);
  });
});
