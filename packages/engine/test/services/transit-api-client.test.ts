// 移植元: test/core/services/transit_api_client_test.dart

import { describe, expect, it } from 'vitest';

import { GeoPoint } from '../../src/models/geo-point';
import {
  CancellationToken,
  SearchCanceledException,
} from '../../src/services/cancellation';
import {
  ClientException,
  TimeoutException,
  type HttpClient,
  type HttpResponse,
} from '../../src/services/http-client';
import { RouteException } from '../../src/services/route-service';
import { SearchDeadline } from '../../src/services/search-deadline';
import { TransitApiClient } from '../../src/services/transit-api-client';
import { dateTime, seconds } from '../../src/time';
import { delay } from '../support/delay';
import { expectThrowsA } from '../support/expect';
import { jsonResponse, mockClient } from '../support/mock-client';

const transitBase = 'https://transit.example';
const proxyBase = 'https://proxy.example';

const client = (
  c: HttpClient,
  o: { transitBase?: string; proxy?: string } = {},
) =>
  new TransitApiClient({
    transitClient: c,
    proxyClient: c,
    transitBaseUrl: o.transitBase ?? transitBase,
    proxyBaseUrl: o.proxy ?? proxyBase,
  });

describe('fetchGuidanceAt', () => {
  it('/api/v1/guidance/plan へ from/to/date/time/type/numItineraries を渡す', async () => {
    let captured!: URL;
    const c = client(
      mockClient((url) => {
        captured = url;
        return jsonResponse({ ok: true });
      }),
    );
    const body = await c.fetchGuidanceAt(
      new GeoPoint(35.1, 139.2),
      new GeoPoint(35.3, 139.4),
      dateTime(2026, 6, 27, 9, 5),
    );
    expect(body).toEqual({ ok: true });
    expect(captured.pathname).toEqual('/api/v1/guidance/plan');
    expect(captured.searchParams.get('from')).toEqual('geo:35.1,139.2');
    expect(captured.searchParams.get('to')).toEqual('geo:35.3,139.4');
    expect(captured.searchParams.get('date')).toEqual('20260627');
    expect(captured.searchParams.get('time')).toEqual('09:05');
    expect(captured.searchParams.get('type')).toEqual('departure');
    expect(captured.searchParams.get('numItineraries')).toEqual('5');
    expect(captured.searchParams.get('avoidModes')).toEqual('bus,ferry,air');
  });

  it('allowBus: true では avoidModes からバスを外す (#250)', async () => {
    let captured!: URL;
    const c = client(
      mockClient((url) => {
        captured = url;
        return jsonResponse({ ok: true });
      }),
    );
    await c.fetchGuidanceAt(
      new GeoPoint(35.1, 139.2),
      new GeoPoint(35.3, 139.4),
      dateTime(2026, 6, 27, 9, 5),
      { allowBus: true },
    );
    expect(captured.searchParams.get('avoidModes')).toEqual('ferry,air');
  });

  it('同一リクエストの再発行を guidanceDupCalls に数える（enrich 削減の実測）', async () => {
    const c = client(mockClient(() => jsonResponse({ ok: true })));
    const from = new GeoPoint(35.1, 139.2);
    const to = new GeoPoint(35.3, 139.4);
    const at = dateTime(2026, 6, 27, 9, 5);

    await c.fetchGuidanceAt(from, to, at); // 初回＝ユニーク
    await c.fetchGuidanceAt(from, to, at); // 同一 URI＝重複
    await c.fetchGuidanceAt(from, to, at); // 同一 URI＝重複
    // 目的地違いは別 URI＝重複でない。
    await c.fetchGuidanceAt(from, new GeoPoint(35.9, 139.9), at);
    // モード違い（allowBus）も avoidModes が変わり別 URI。
    await c.fetchGuidanceAt(from, to, at, { allowBus: true });

    expect(c.guidanceCalls).toEqual(5);
    expect(c.guidanceDupCalls).toEqual(2);
  });

  it('非200は RouteException(HTTP <code>)', async () => {
    const c = client(mockClient(() => jsonResponse({}, 503)));
    const e = await expectThrowsA(
      () =>
        c.fetchGuidanceAt(
          new GeoPoint(0, 0),
          new GeoPoint(1, 1),
          dateTime(2026, 1, 1),
        ),
      RouteException,
    );
    expect(e.status).toEqual('HTTP 503');
  });

  it('タイムアウトは RouteException(TIMEOUT) へ変換する', async () => {
    const c = client(
      mockClient(() => {
        throw new TimeoutException('slow');
      }),
    );
    const e = await expectThrowsA(
      () =>
        c.fetchGuidanceAt(
          new GeoPoint(0, 0),
          new GeoPoint(1, 1),
          dateTime(2026, 1, 1),
        ),
      RouteException,
    );
    expect(e.status).toEqual('TIMEOUT');
  });
});

describe('fetchGuidanceArrivalAt (#376)', () => {
  it('/api/v1/guidance/plan へ type=arrival・departureAt のサービス日基準の time を渡す', async () => {
    let captured!: URL;
    const c = client(
      mockClient((url) => {
        captured = url;
        return jsonResponse({ ok: true });
      }),
    );
    const body = await c.fetchGuidanceArrivalAt(
      new GeoPoint(35.1, 139.2),
      new GeoPoint(35.3, 139.4),
      dateTime(2026, 6, 27, 9, 5),
      95, // 09:05 + 95分 = 10:40
    );
    expect(body).toEqual({ ok: true });
    expect(captured.pathname).toEqual('/api/v1/guidance/plan');
    expect(captured.searchParams.get('from')).toEqual('geo:35.1,139.2');
    expect(captured.searchParams.get('to')).toEqual('geo:35.3,139.4');
    expect(captured.searchParams.get('date')).toEqual('20260627');
    expect(captured.searchParams.get('time')).toEqual('10:40');
    expect(captured.searchParams.get('type')).toEqual('arrival');
    expect(captured.searchParams.get('numItineraries')).toEqual('5');
    expect(captured.searchParams.get('avoidModes')).toEqual('bus,ferry,air');
  });

  it('日をまたぐ予算は date=出発サービス日・time=24時超で表す', async () => {
    let captured!: URL;
    const c = client(
      mockClient((url) => {
        captured = url;
        return jsonResponse({ ok: true });
      }),
    );
    await c.fetchGuidanceArrivalAt(
      new GeoPoint(35.1, 139.2),
      new GeoPoint(35.3, 139.4),
      dateTime(2026, 8, 26, 23, 30),
      90, // 23:30 + 90分 = 翌 01:00 = サービス時刻 25:00
    );
    expect(captured.searchParams.get('date')).toEqual('20260826');
    expect(captured.searchParams.get('time')).toEqual('25:00');
  });

  // 年境界そのものは time の組み立て（departureAt の hour/minute + budgetMin の整数和）に
  // 一切関与しないが、境界固定として日またぎと同じ形を残す。
  it('年境界をまたぐ予算も date=出発サービス日・time=24時超で表す', async () => {
    let captured!: URL;
    const c = client(
      mockClient((url) => {
        captured = url;
        return jsonResponse({ ok: true });
      }),
    );
    await c.fetchGuidanceArrivalAt(
      new GeoPoint(35.1, 139.2),
      new GeoPoint(35.3, 139.4),
      dateTime(2026, 12, 31, 23, 30),
      90, // 23:30 + 90分 = 翌年 01:00 = サービス時刻 25:00
    );
    expect(captured.searchParams.get('date')).toEqual('20261231');
    expect(captured.searchParams.get('time')).toEqual('25:00');
  });

  it('複数日にまたがる予算は time=48時超で表す', async () => {
    let captured!: URL;
    const c = client(
      mockClient((url) => {
        captured = url;
        return jsonResponse({ ok: true });
      }),
    );
    await c.fetchGuidanceArrivalAt(
      new GeoPoint(35.1, 139.2),
      new GeoPoint(35.3, 139.4),
      dateTime(2026, 8, 26, 9, 0),
      2430, // 09:00 + 2430分（1日16.5時間）= サービス時刻 49:30
    );
    expect(captured.searchParams.get('date')).toEqual('20260826');
    expect(captured.searchParams.get('time')).toEqual('49:30');
  });

  it('allowBus: true では avoidModes からバスを外す', async () => {
    let captured!: URL;
    const c = client(
      mockClient((url) => {
        captured = url;
        return jsonResponse({ ok: true });
      }),
    );
    await c.fetchGuidanceArrivalAt(
      new GeoPoint(35.1, 139.2),
      new GeoPoint(35.3, 139.4),
      dateTime(2026, 6, 27, 9, 5),
      95,
      { allowBus: true },
    );
    expect(captured.searchParams.get('avoidModes')).toEqual('ferry,air');
  });

  it('非200は RouteException(HTTP <code>)', async () => {
    const c = client(mockClient(() => jsonResponse({}, 503)));
    const e = await expectThrowsA(
      () =>
        c.fetchGuidanceArrivalAt(
          new GeoPoint(0, 0),
          new GeoPoint(1, 1),
          dateTime(2026, 6, 27, 9, 0),
          60,
        ),
      RouteException,
    );
    expect(e.status).toEqual('HTTP 503');
  });

  it('guidanceCalls を増やす（既存 fetchGuidanceAt と同じカウンタを共有）', async () => {
    const c = client(mockClient(() => jsonResponse({ ok: true })));
    await c.fetchGuidanceArrivalAt(
      new GeoPoint(35.1, 139.2),
      new GeoPoint(35.3, 139.4),
      dateTime(2026, 6, 27, 9, 5),
      95,
    );
    expect(c.guidanceCalls).toEqual(1);
  });
});

describe('fetchWalkMatrix', () => {
  it('googleWalkMatrixProxy から配列を返す', async () => {
    const c = client(
      mockClient((url) => {
        expect(url.pathname).toEqual('/googleWalkMatrixProxy');
        expect(url.searchParams.get('origins')).toEqual('35.0,139.0');
        expect(url.searchParams.get('destinations')).toEqual(
          '35.1,139.1;35.2,139.2',
        );
        return jsonResponse([
          { originIndex: 0, destinationIndex: 0, duration: '600s' },
        ]);
      }),
    );
    const rows = await c.fetchWalkMatrix(
      [new GeoPoint(35.0, 139.0)],
      [new GeoPoint(35.1, 139.1), new GeoPoint(35.2, 139.2)],
    );
    expect(rows).not.toBeNull();
    expect(rows!.length).toEqual(1);
  });

  it('非200は null（直線推定へフォールバック）', async () => {
    const c = client(mockClient(() => jsonResponse([], 500)));
    const rows = await c.fetchWalkMatrix(
      [new GeoPoint(0, 0)],
      [new GeoPoint(1, 1)],
    );
    expect(rows).toBeNull();
  });

  it('配列でないレスポンスも null', async () => {
    const c = client(mockClient(() => jsonResponse({ not: 'array' })));
    const rows = await c.fetchWalkMatrix(
      [new GeoPoint(0, 0)],
      [new GeoPoint(1, 1)],
    );
    expect(rows).toBeNull();
  });

  // fetchGuidanceAt は TIMEOUT を再送出するのに対し fetchWalkMatrix は握り潰す、
  // という挙動差が本クラスの要点なので明示的に固定する（回帰防止）。
  it('タイムアウトも null（直線推定へフォールバック）', async () => {
    const c = client(
      mockClient(() => {
        throw new TimeoutException('slow');
      }),
    );
    const rows = await c.fetchWalkMatrix(
      [new GeoPoint(0, 0)],
      [new GeoPoint(1, 1)],
    );
    expect(rows).toBeNull();
  });
});

describe('fetchWalkRoute', () => {
  it('googleWalkProxy へ start/goal を渡し生ボディを返す', async () => {
    const c = client(
      mockClient((url) => {
        expect(url.pathname).toEqual('/googleWalkProxy');
        expect(url.searchParams.get('start')).toEqual('35.0,139.0');
        expect(url.searchParams.get('goal')).toEqual('35.5,139.5');
        return jsonResponse({ routes: [{ duration: '300s' }] });
      }),
    );
    const body = await c.fetchWalkRoute(
      new GeoPoint(35.0, 139.0),
      new GeoPoint(35.5, 139.5),
    );
    expect((body['routes'] as unknown[]).length).toEqual(1);
  });

  it('非200は RouteException', async () => {
    const c = client(mockClient(() => jsonResponse({}, 404)));
    await expectThrowsA(
      () => c.fetchWalkRoute(new GeoPoint(0, 0), new GeoPoint(1, 1)),
      RouteException,
    );
  });
});

describe('上流 HTTP 往復本数の計測 (#309)', () => {
  it('初期値はすべて 0', () => {
    const c = client(mockClient(() => jsonResponse({})));
    expect(c.guidanceCalls).toEqual(0);
    expect(c.walkCalls).toEqual(0);
    expect(c.matrixCalls).toEqual(0);
  });

  it('種別ごとに本数を数える', async () => {
    const c = client(
      mockClient((url) => {
        if (url.pathname === '/googleWalkMatrixProxy') {
          return jsonResponse([
            { originIndex: 0, destinationIndex: 0, duration: '60s' },
          ]);
        }
        if (url.pathname === '/googleWalkProxy') {
          return jsonResponse({ routes: [{ duration: '300s' }] });
        }
        return jsonResponse({ ok: true });
      }),
    );
    await c.fetchGuidanceAt(
      new GeoPoint(35.0, 139.0),
      new GeoPoint(35.5, 139.5),
      dateTime(2026, 6, 27, 9, 0),
    );
    await c.fetchGuidanceAt(
      new GeoPoint(35.0, 139.0),
      new GeoPoint(35.6, 139.6),
      dateTime(2026, 6, 27, 9, 5),
    );
    await c.fetchWalkRoute(
      new GeoPoint(35.0, 139.0),
      new GeoPoint(35.5, 139.5),
    );
    await c.fetchWalkMatrix(
      [new GeoPoint(35.0, 139.0)],
      [new GeoPoint(35.1, 139.1)],
    );

    expect(c.guidanceCalls).toEqual(2);
    expect(c.walkCalls).toEqual(1);
    expect(c.matrixCalls).toEqual(1);
  });

  // マトリクスは失敗を null へ握り潰す口だが、HTTP は実際に往復しているので計上する
  // （本数は「叩いた回数」であって「成功回数」ではない）。
  it('マトリクスが非200で null 縮退しても往復本数は数える', async () => {
    const c = client(mockClient(() => jsonResponse([], 500)));
    const rows = await c.fetchWalkMatrix(
      [new GeoPoint(0, 0)],
      [new GeoPoint(1, 1)],
    );
    expect(rows).toBeNull();
    expect(c.matrixCalls).toEqual(1);
  });
});

describe('baseUrl 正規化', () => {
  it('transitBaseUrl 末尾スラッシュを除去する', () => {
    const c = client(mockClient(() => jsonResponse({})), {
      transitBase: 'https://transit.example///',
    });
    expect(c.transitBaseUrl).toEqual('https://transit.example');
    expect(c.hasTransitApi).toBe(true);
  });

  it('空の transitBaseUrl は hasTransitApi=false', () => {
    const c = client(mockClient(() => jsonResponse({})), { transitBase: '' });
    expect(c.hasTransitApi).toBe(false);
  });

  // proxyBaseUrl の末尾スラッシュ正規化は fetchProxy の URL 組み立てに効く。
  // 実リクエストの path が二重スラッシュにならないことで確認する。
  it('proxyBaseUrl 末尾スラッシュを除去し二重スラッシュを防ぐ', async () => {
    let captured!: URL;
    const c = client(
      mockClient((url) => {
        captured = url;
        return jsonResponse({ routes: [] });
      }),
      { proxy: 'https://proxy.example///' },
    );
    await c.fetchWalkRoute(
      new GeoPoint(35.0, 139.0),
      new GeoPoint(35.5, 139.5),
    );
    expect(captured.pathname).toEqual('/googleWalkProxy');
  });
});

describe('キャンセル (#259)', () => {
  it('キャンセル済みなら fetchGuidanceAt は HTTP を発行せず投げる', async () => {
    let calls = 0;
    const cancellation = new CancellationToken();
    cancellation.cancel();
    const c = new TransitApiClient({
      transitClient: mockClient(() => {
        calls++;
        return jsonResponse({ ok: true });
      }),
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      cancellation,
    });

    await expectThrowsA(
      () =>
        c.fetchGuidanceAt(
          new GeoPoint(35.0, 139.0),
          new GeoPoint(35.5, 139.5),
          dateTime(2026, 6, 27, 9, 5),
        ),
      SearchCanceledException,
    );
    expect(calls).toEqual(0);
  });

  it('キャンセル済みなら fetchWalkRoute は HTTP を発行せず投げる', async () => {
    let calls = 0;
    const cancellation = new CancellationToken();
    cancellation.cancel();
    const c = new TransitApiClient({
      proxyClient: mockClient(() => {
        calls++;
        return jsonResponse({ routes: [] });
      }),
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      cancellation,
    });

    await expectThrowsA(
      () =>
        c.fetchWalkRoute(new GeoPoint(35.0, 139.0), new GeoPoint(35.5, 139.5)),
      SearchCanceledException,
    );
    expect(calls).toEqual(0);
  });

  // fetchWalkMatrix は取得失敗を null（直線推定へ縮退）に握り潰す唯一の口。
  // ここでキャンセルまで null に化けると、呼び出し側は探索を続行してしまう。
  it('fetchWalkMatrix はキャンセルを null へ握り潰さない', async () => {
    let calls = 0;
    const cancellation = new CancellationToken();
    cancellation.cancel();
    const c = new TransitApiClient({
      proxyClient: mockClient(() => {
        calls++;
        return jsonResponse([]);
      }),
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      cancellation,
    });

    await expectThrowsA(
      () =>
        c.fetchWalkMatrix(
          [new GeoPoint(35.0, 139.0)],
          [new GeoPoint(35.5, 139.5)],
        ),
      SearchCanceledException,
    );
    expect(calls).toEqual(0);
  });

  it('探索の途中でキャンセルすると以降の HTTP を発行しない', async () => {
    const cancellation = new CancellationToken();
    let calls = 0;
    const c = new TransitApiClient({
      transitClient: mockClient(() => {
        calls++;
        return jsonResponse({ ok: true });
      }),
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      cancellation,
    });

    const fetch = () =>
      c.fetchGuidanceAt(
        new GeoPoint(35.0, 139.0),
        new GeoPoint(35.5, 139.5),
        dateTime(2026, 6, 27, 9, 5),
      );

    await fetch();
    expect(calls).toEqual(1);

    cancellation.cancel();
    await expectThrowsA(() => fetch(), SearchCanceledException);
    expect(calls).toEqual(1);
  });

  it('発行後にキャンセルで閉じられた in-flight の client エラーはキャンセルへ昇格', async () => {
    // throwIfCanceled は発行**前**ガード。発行後にユーザーが離脱すると scoped client が
    // 閉じられ、in-flight は SearchCanceledException ではなく素の client エラーで倒れる。
    // これを昇格させないと上位の縮退 catch（候補ドロップ）に握り潰される（#316）。
    const cancellation = new CancellationToken();
    const c = new TransitApiClient({
      transitClient: mockClient(() => {
        cancellation.cancel(); // 発行直後の離脱＝scoped client close 相当
        throw new ClientException('Client is already closed');
      }),
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      cancellation,
    });

    await expectThrowsA(
      () =>
        c.fetchGuidanceAt(
          new GeoPoint(35.0, 139.0),
          new GeoPoint(35.5, 139.5),
          dateTime(2026, 6, 27, 9, 5),
        ),
      SearchCanceledException,
    );
  });

  it('close は transit / proxy 双方のクライアントを閉じる', () => {
    const transit = new CountingClient();
    const proxy = new CountingClient();
    new TransitApiClient({
      transitClient: transit,
      proxyClient: proxy,
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
    }).close();

    expect(transit.closed).toEqual(1);
    expect(proxy.closed).toEqual(1);
  });
});

describe('締切による残予算クランプ (#300)', () => {
  it('上流が残予算より遅ければ残予算で TIMEOUT になる', async () => {
    // 1本の上限（35s）より締切の残予算の方が短い状況。
    // クランプが無ければ 200ms 待って成功してしまう。
    const c = new TransitApiClient({
      transitClient: mockClient(async () => {
        await delay(200);
        return jsonResponse({ ok: true });
      }),
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      deadline: new SearchDeadline(seconds(120), {
        elapsed: () => seconds(120) - remaining,
      }),
    });

    const e = await expectThrowsA(
      () =>
        c.fetchGuidanceAt(
          new GeoPoint(35.0, 139.0),
          new GeoPoint(35.5, 139.5),
          dateTime(2026, 6, 27, 9, 5),
        ),
      RouteException,
    );
    expect(e.status).toEqual('TIMEOUT');
  });

  it('残予算が上流の応答より長ければ透過する', async () => {
    const c = new TransitApiClient({
      transitClient: mockClient(() => jsonResponse({ ok: true })),
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      deadline: new SearchDeadline(seconds(120), {
        elapsed: () => seconds(30),
      }),
    });

    expect(
      await c.fetchGuidanceAt(
        new GeoPoint(35.0, 139.0),
        new GeoPoint(35.5, 139.5),
        dateTime(2026, 6, 27, 9, 5),
      ),
    ).toEqual({ ok: true });
  });

  it('期限切れ後は HTTP を発行せず即 TIMEOUT にする', async () => {
    let calls = 0;
    const c = new TransitApiClient({
      transitClient: mockClient(() => {
        calls++;
        return jsonResponse({ ok: true });
      }),
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      deadline: new SearchDeadline(seconds(120), {
        elapsed: () => seconds(500),
      }),
    });

    const e = await expectThrowsA(
      () =>
        c.fetchGuidanceAt(
          new GeoPoint(35.0, 139.0),
          new GeoPoint(35.5, 139.5),
          dateTime(2026, 6, 27, 9, 5),
        ),
      RouteException,
    );
    expect(e.status).toEqual('TIMEOUT');
    expect(calls).toEqual(0);
  });

  it('締切を渡さなければ残予算でクランプしない', async () => {
    const c = new TransitApiClient({
      transitClient: mockClient(async () => {
        await delay(50);
        return jsonResponse({ ok: true });
      }),
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
    });

    expect(
      await c.fetchGuidanceAt(
        new GeoPoint(35.0, 139.0),
        new GeoPoint(35.5, 139.5),
        dateTime(2026, 6, 27, 9, 5),
      ),
    ).toEqual({ ok: true });
  });

  it('徒歩プロキシには締切を適用しない（実測は検証であって改善ではない）', async () => {
    // 締切で切ってよいのは「切っても嘘をつかない」呼び出しだけ。徒歩実測は fail-open
    // （enrichWalkGeometry が失敗時に楽観的な見積りを残す）なので、締切で切ると
    // 予算超過・乗り遅れの経路を「予算内」と偽って確定させる（#254 を破る）。
    let calls = 0;
    const c = new TransitApiClient({
      proxyClient: mockClient(async () => {
        calls++;
        await delay(50);
        return jsonResponse({ routes: [] });
      }),
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      // 使い切り済みの締切。transit なら即 TIMEOUT になる状況。
      deadline: new SearchDeadline(seconds(120), {
        elapsed: () => seconds(500),
      }),
    });

    expect(
      await c.fetchWalkRoute(
        new GeoPoint(35.0, 139.0),
        new GeoPoint(35.5, 139.5),
      ),
    ).toEqual({ routes: [] });
    expect(calls).toEqual(1);
  });

  it('徒歩マトリクスにも締切を適用しない', async () => {
    const c = new TransitApiClient({
      proxyClient: mockClient(() => jsonResponse([])),
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      deadline: new SearchDeadline(seconds(120), {
        elapsed: () => seconds(500),
      }),
    });

    // null（＝直線推定へフォールバック）ではなく実測が返ることの反証。
    expect(
      await c.fetchWalkMatrix(
        [new GeoPoint(35.0, 139.0)],
        [new GeoPoint(35.5, 139.5)],
      ),
    ).not.toBeNull();
  });
});

/// クランプを観測するための短い残予算。上流 fake の遅延より十分短くとる。
const remaining = 20;

/// close 回数だけを数えるクライアント。mockClient の close は no-op で観測できない。
class CountingClient implements HttpClient {
  closed = 0;

  get(url: URL): Promise<HttpResponse> {
    throw new Error(`UnimplementedError: ${url.href}`);
  }

  close(): void {
    this.closed++;
  }
}
