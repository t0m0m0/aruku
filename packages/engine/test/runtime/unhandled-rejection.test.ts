// 移植元を持たない、**JavaScript ランタイム固有**の回帰テスト（#385 / PR #390 レビュー P1）。
//
// Dart と JavaScript で「同じコードの形」が違う結末になる箇所を止める。移植したテストは
// Dart 側の仕様をそのまま運ぶので、この差は原理的にどのテストにも現れない——だから
// `check:port` の1対1照合の対象外（`test/runtime/` はそのための場所）。
//
// ここで見ているのは**未処理の拒否**。並行して起こした2本の Promise を片方ずつ await すると、
// 先に待つ側が倒れた時点で関数を抜け、もう一方の拒否を誰も観測しないまま残る。Dart は
// 未処理の非同期エラーをゾーンへ報告するだけだが、Node はプロセスを落とし、ブラウザは
// `unhandledrejection` を上げる。vitest も未処理の拒否があれば非ゼロで終わるので、
// 逐次 await へ戻すとこのファイルが落ちる。

import { expect, it } from 'vitest';

import { GeoPoint } from '../../src/models/geo-point';
import { TimeValue } from '../../src/models/time-value';
import {
  CancellationToken,
  SearchCanceledException,
} from '../../src/services/cancellation';
import type { HttpClient, HttpResponse } from '../../src/services/http-client';
import { TransitRouteService } from '../../src/services/transit-route-service';
import { dateTime } from '../../src/time';

/// コリドーを2点以上持つ最小の door-to-door 応答。フロンティア絞り込みが乗車側・降車側
/// 双方のマトリクスを起こす（＝2本が同時に in-flight になる）ところまで進めるための素材。
const guidance = {
  date: '20260627',
  from: { id: 'o', name: '出発' },
  to: { id: 'd', name: '目的' },
  options: [
    {
      journey: {
        departureSecs: 33000,
        arrivalSecs: 36600,
        durationSecs: 4200,
        accessWalkSecs: 400,
        egressWalkSecs: 500,
        legs: [
          {
            kind: 'transit',
            mode: 'rail',
            routeName: 'L',
            from: { id: 'a', name: 'A' },
            to: { id: 'b', name: 'B' },
            departureSecs: 33000,
            arrivalSecs: 36600,
          },
        ],
      },
      map: {
        segments: [
          {
            kind: 'walk',
            fromPointId: 'o',
            toPointId: 'a',
            geometrySource: 'osmWalk',
            polyline: [
              { lat: 35.0, lon: 139.0 },
              { lat: 35.002, lon: 139.002 },
            ],
          },
          {
            kind: 'transit',
            fromPointId: 'a',
            toPointId: 'b',
            geometrySource: 'stopOrder',
            polyline: [
              { lat: 35.002, lon: 139.002 },
              { lat: 35.004, lon: 139.01 },
              { lat: 35.006, lon: 139.02 },
            ],
          },
          {
            kind: 'walk',
            fromPointId: 'b',
            toPointId: 'd',
            geometrySource: 'osmWalk',
            polyline: [
              { lat: 35.006, lon: 139.02 },
              { lat: 35.008, lon: 139.022 },
            ],
          },
        ],
      },
    },
  ],
};

it('アクセス徒歩マトリクス2本の in-flight 中にキャンセルしても未処理の拒否を残さない', async () => {
  const cancellation = new CancellationToken();
  const client: HttpClient = {
    get: async (url: URL): Promise<HttpResponse> => {
      await Promise.resolve();
      if (url.pathname.includes('MatrixProxy')) {
        // 1本目の発行を見た時点で離脱する＝検索スコープのクライアントが閉じられる状況。
        // 2本目は発行前ガード（throwIfCanceled）で倒れるので、両方が拒否になる。
        cancellation.cancel();
        throw new SearchCanceledException();
      }
      return {
        statusCode: 200,
        bodyBytes: new TextEncoder().encode(JSON.stringify(guidance)),
      };
    },
    close: () => {},
  };
  const service = new TransitRouteService({
    transitClient: client,
    proxyClient: client,
    transitBaseUrl: 'https://transit.example',
    proxyBaseUrl: 'https://proxy.example',
    clock: () => dateTime(2026, 6, 27, 9, 0),
    cancellation,
  });

  await expect(
    service.plan({
      destination: '目的',
      destinationLatLng: new GeoPoint(35.008, 139.022),
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 30 }),
      origin: new GeoPoint(35.0, 139.0),
      originName: '出発',
    }),
  ).rejects.toBeInstanceOf(SearchCanceledException);

  // 未処理の拒否は plan が抜けた**後**に届く。ここで待たないと、vitest がファイルを
  // 閉じた後に上がって別のテストの失敗として現れる（＝原因が読めなくなる）。
  await new Promise((resolve) => setTimeout(resolve, 50));
});
