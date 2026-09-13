// 移植元: lib/core/services/places_service.dart と
// test/core/services/places_service_test.dart。
//
// 空の proxyBaseUrl を「候補なし」へ縮退させる移植元の分岐は運んでいない。理由は
// places-service.ts の注記。ここではその**拒否**を反証している。

import { describe, expect, it, vi } from 'vitest';

import { GeoPoint } from '@aruku/engine/models/geo-point';
import {
  TimeoutException,
  type HttpClient,
  type HttpResponse,
} from '@aruku/engine/services/http-client';

import {
  GooglePlacesService,
  PlacesException,
} from '../../src/places/places-service';

const base = 'https://proxy.example';

/// 応答を JSON で返す偽クライアント。呼ばれた URL を記録する。
function stubClient(
  respond: (url: URL) => HttpResponse | Promise<HttpResponse>,
): HttpClient & { calls: URL[] } {
  const calls: URL[] = [];
  return {
    calls,
    async get(url: URL) {
      calls.push(url);
      return respond(url);
    },
    close() {},
  };
}

function json(body: unknown, statusCode = 200): HttpResponse {
  return {
    statusCode,
    bodyBytes: new TextEncoder().encode(JSON.stringify(body)),
  };
}

function okPredictions(predictions: unknown[]): HttpResponse {
  return json({ status: 'OK', predictions });
}

function service(
  respond: (url: URL) => HttpResponse | Promise<HttpResponse>,
  proxyBaseUrl = base,
) {
  const client = stubClient(respond);
  return { client, places: new GooglePlacesService({ client, proxyBaseUrl }) };
}

describe('autocomplete のリクエスト', () => {
  it('placesProxy を autocomplete として叩く', async () => {
    const { client, places } = service(() => okPredictions([]));

    await places.autocomplete('渋谷');

    const url = client.calls[0]!;
    expect(url.pathname).toBe('/placesProxy');
    expect(url.searchParams.get('action')).toBe('autocomplete');
    expect(url.searchParams.get('input')).toBe('渋谷');
  });

  it('日本語・日本国内に絞る', async () => {
    const { client, places } = service(() => okPredictions([]));

    await places.autocomplete('渋谷');

    const url = client.calls[0]!;
    expect(url.searchParams.get('language')).toBe('ja');
    expect(url.searchParams.get('components')).toBe('country:jp');
  });

  // proxy 側が locationBias（円）と origin を組み立てる材料（#144 / #146）。
  it('現在地が分かるときだけ位置バイアスを渡す', async () => {
    const { client, places } = service(() => okPredictions([]));

    await places.autocomplete('渋谷', new GeoPoint(35.6, 139.7));
    await places.autocomplete('渋谷');

    const withBias = client.calls[0]!;
    expect(withBias.searchParams.get('lat')).toBe('35.6');
    expect(withBias.searchParams.get('lon')).toBe('139.7');

    const without = client.calls[1]!;
    expect(without.searchParams.has('lat')).toBe(false);
    expect(without.searchParams.has('lon')).toBe(false);
  });

  it('ベース URL の末尾スラッシュを重ねない', async () => {
    const { client, places } = service(() => okPredictions([]), `${base}///`);

    await places.autocomplete('渋谷');

    expect(client.calls[0]!.pathname).toBe('/placesProxy');
  });
});

describe('autocomplete の応答', () => {
  it('terms の先頭を名称、description のカンマ以降を住所にする', async () => {
    const { places } = service(() =>
      okPredictions([
        {
          place_id: 'p1',
          description: 'ハチ公前, 日本、東京都渋谷区',
          terms: [{ value: 'ハチ公前' }, { value: '東京都渋谷区' }],
        },
      ]),
    );

    const [p] = await places.autocomplete('ハチ');

    expect(p!.placeId).toBe('p1');
    expect(p!.name).toBe('ハチ公前');
    expect(p!.address).toBe('日本、東京都渋谷区');
  });

  it('terms が無ければ description を名称にする', async () => {
    const { places } = service(() =>
      okPredictions([{ place_id: 'p1', description: '渋谷駅' }]),
    );

    const [p] = await places.autocomplete('渋谷');

    expect(p!.name).toBe('渋谷駅');
  });

  it('カンマが無い description は丸ごと住所にする', async () => {
    const { places } = service(() =>
      okPredictions([{ place_id: 'p1', description: '渋谷駅' }]),
    );

    const [p] = await places.autocomplete('渋谷');

    expect(p!.address).toBe('渋谷駅');
  });

  // 移植元が indexOf+1 で切っている理由。末尾カンマで範囲外にしない。
  it('カンマが末尾でも落ちず、住所は空になる', async () => {
    const { places } = service(() =>
      okPredictions([{ place_id: 'p1', description: '渋谷駅,' }]),
    );

    const [p] = await places.autocomplete('渋谷');

    expect(p!.address).toBe('');
  });

  it('カンマ直後の空白の有無に依らず住所を切り出す', async () => {
    const { places } = service(() =>
      okPredictions([
        { place_id: 'p1', description: 'A,東京都' },
        { place_id: 'p2', description: 'B,   東京都' },
      ]),
    );

    const list = await places.autocomplete('x');

    expect(list.map((p) => p.address)).toEqual(['東京都', '東京都']);
  });

  it('distance_meters を距離として取り込む', async () => {
    const { places } = service(() =>
      okPredictions([
        { place_id: 'p1', description: 'A,東京', distance_meters: 320.7 },
        { place_id: 'p2', description: 'B,東京' },
      ]),
    );

    const list = await places.autocomplete('x');

    expect(list[0]!.distanceMeters).toBe(320);
    expect(list[1]!.distanceMeters).toBeNull();
  });

  it('ZERO_RESULTS は候補なしであって失敗ではない', async () => {
    const { places } = service(() => json({ status: 'ZERO_RESULTS' }));

    await expect(places.autocomplete('xyzzy')).resolves.toEqual([]);
  });

  it('OK でも ZERO_RESULTS でもないステータスは例外にする', async () => {
    const { places } = service(() => json({ status: 'REQUEST_DENIED' }));

    await expect(places.autocomplete('渋谷')).rejects.toThrow(
      new PlacesException('REQUEST_DENIED'),
    );
  });

  it('HTTP が 200 でなければ例外にする', async () => {
    const { places } = service(() => json({ status: 'OK' }, 503));

    await expect(places.autocomplete('渋谷')).rejects.toThrow(
      new PlacesException('HTTP 503'),
    );
  });

  // タイムアウトは TimeoutHttpClient が投げる（#156）。UI は生ステータスを
  // そのまま出すので、他の失敗と同じ語彙へ寄せる。
  it('タイムアウトを TIMEOUT として畳む', async () => {
    const { places } = service(() => {
      throw new TimeoutException('header timeout');
    });

    await expect(places.autocomplete('渋谷')).rejects.toThrow(
      new PlacesException('TIMEOUT'),
    );
  });

  it('マルチバイトの応答を UTF-8 として読む', async () => {
    const { places } = service(() =>
      okPredictions([
        {
          place_id: 'p1',
          description: '代々木公園, 東京都渋谷区',
          terms: [{ value: '代々木公園' }],
        },
      ]),
    );

    const [p] = await places.autocomplete('代々木');

    expect(p!.name).toBe('代々木公園');
    expect(p!.address).toBe('東京都渋谷区');
  });
});

describe('fetchLatLng', () => {
  it('placesProxy を details として叩く', async () => {
    const { client, places } = service(() =>
      json({
        status: 'OK',
        result: { geometry: { location: { lat: 35.6, lng: 139.7 } } },
      }),
    );

    await places.fetchLatLng('p1');

    const url = client.calls[0]!;
    expect(url.searchParams.get('action')).toBe('details');
    expect(url.searchParams.get('place_id')).toBe('p1');
  });

  it('座標を返す', async () => {
    const { places } = service(() =>
      json({
        status: 'OK',
        result: { geometry: { location: { lat: 35.6, lng: 139.7 } } },
      }),
    );

    await expect(places.fetchLatLng('p1')).resolves.toEqual(
      new GeoPoint(35.6, 139.7),
    );
  });

  it('OK 以外は座標なしとして null にする', async () => {
    const { places } = service(() => json({ status: 'NOT_FOUND' }));

    await expect(places.fetchLatLng('p1')).resolves.toBeNull();
  });

  it('OK でも座標が欠けていれば null にする', async () => {
    const { places } = service(() => json({ status: 'OK', result: {} }));

    await expect(places.fetchLatLng('p1')).resolves.toBeNull();
  });

  it('HTTP が 200 でなければ例外にする', async () => {
    const { places } = service(() => json({ status: 'OK' }, 500));

    await expect(places.fetchLatLng('p1')).rejects.toThrow(
      new PlacesException('HTTP 500'),
    );
  });

  it('タイムアウトを TIMEOUT として畳む', async () => {
    const { places } = service(() => {
      throw new TimeoutException('header timeout');
    });

    await expect(places.fetchLatLng('p1')).rejects.toThrow(
      new PlacesException('TIMEOUT'),
    );
  });
});

// 移植元は空ベースを「候補なし」へ縮退させていた。設定漏れが「検索しても何も出ない」
// として静かに出るため、組み立てで落とす（route-service.ts と同じ判断）。
describe('ベース URL の検査', () => {
  it('空のベース URL では組み立てを拒む', () => {
    expect(
      () =>
        new GooglePlacesService({
          client: stubClient(() => json({})),
          proxyBaseUrl: '',
        }),
    ).toThrow(/VITE_PROXY_BASE_URL/);
  });

  it('連結するとパスが消えるベース URL を拒む', () => {
    expect(
      () =>
        new GooglePlacesService({
          client: stubClient(() => json({})),
          proxyBaseUrl: 'https://proxy.example?tenant=a',
        }),
    ).toThrow(/VITE_PROXY_BASE_URL/);
  });

  it('拒んだ時点では通信しない', () => {
    const client = stubClient(() => json({}));

    expect(
      () => new GooglePlacesService({ client, proxyBaseUrl: '' }),
    ).toThrow();
    expect(client.calls).toEqual([]);
  });
});

describe('close', () => {
  it('内側のクライアントを閉じる', () => {
    const close = vi.fn();
    const places = new GooglePlacesService({
      client: { async get() { return json({}); }, close },
      proxyBaseUrl: base,
    });

    places.close();

    expect(close).toHaveBeenCalledOnce();
  });
});
