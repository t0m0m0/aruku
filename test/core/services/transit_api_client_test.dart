import 'dart:async';
import 'dart:convert';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/services/cancellation.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/services/search_deadline.dart';
import 'package:aruku/core/services/transit_api_client.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _transitBase = 'https://transit.example';
const _proxyBase = 'https://proxy.example';

http.Response _json(Object body, [int status = 200]) => http.Response(
  jsonEncode(body),
  status,
  headers: {'content-type': 'application/json; charset=utf-8'},
);

TransitApiClient _client(http.Client c, {String? transitBase, String? proxy}) =>
    TransitApiClient(
      transitClient: c,
      proxyClient: c,
      transitBaseUrl: transitBase ?? _transitBase,
      proxyBaseUrl: proxy ?? _proxyBase,
    );

void main() {
  group('fetchGuidanceAt', () {
    test(
      '/api/v1/guidance/plan へ from/to/date/time/type/numItineraries を渡す',
      () async {
        late Uri captured;
        final client = _client(
          MockClient((req) async {
            captured = req.url;
            return _json({'ok': true});
          }),
        );
        final body = await client.fetchGuidanceAt(
          const GeoPoint(35.1, 139.2),
          const GeoPoint(35.3, 139.4),
          DateTime(2026, 6, 27, 9, 5),
        );
        expect(body, {'ok': true});
        expect(captured.path, '/api/v1/guidance/plan');
        expect(captured.queryParameters['from'], 'geo:35.1,139.2');
        expect(captured.queryParameters['to'], 'geo:35.3,139.4');
        expect(captured.queryParameters['date'], '20260627');
        expect(captured.queryParameters['time'], '09:05');
        expect(captured.queryParameters['type'], 'departure');
        expect(captured.queryParameters['numItineraries'], '5');
        expect(captured.queryParameters['avoidModes'], 'bus,ferry,air');
      },
    );

    test('allowBus: true では avoidModes からバスを外す (#250)', () async {
      late Uri captured;
      final client = _client(
        MockClient((req) async {
          captured = req.url;
          return _json({'ok': true});
        }),
      );
      await client.fetchGuidanceAt(
        const GeoPoint(35.1, 139.2),
        const GeoPoint(35.3, 139.4),
        DateTime(2026, 6, 27, 9, 5),
        allowBus: true,
      );
      expect(captured.queryParameters['avoidModes'], 'ferry,air');
    });

    test('非200は RouteException(HTTP <code>)', () async {
      final client = _client(MockClient((req) async => _json(const {}, 503)));
      expect(
        () => client.fetchGuidanceAt(
          const GeoPoint(0, 0),
          const GeoPoint(1, 1),
          DateTime(2026),
        ),
        throwsA(
          isA<RouteException>().having((e) => e.status, 'status', 'HTTP 503'),
        ),
      );
    });

    test('タイムアウトは RouteException(TIMEOUT) へ変換する', () async {
      final client = _client(
        MockClient((req) async => throw TimeoutException('slow')),
      );
      expect(
        () => client.fetchGuidanceAt(
          const GeoPoint(0, 0),
          const GeoPoint(1, 1),
          DateTime(2026),
        ),
        throwsA(
          isA<RouteException>().having((e) => e.status, 'status', 'TIMEOUT'),
        ),
      );
    });
  });

  group('fetchWalkMatrix', () {
    test('googleWalkMatrixProxy から配列を返す', () async {
      final client = _client(
        MockClient((req) async {
          expect(req.url.path, '/googleWalkMatrixProxy');
          expect(req.url.queryParameters['origins'], '35.0,139.0');
          expect(
            req.url.queryParameters['destinations'],
            '35.1,139.1;35.2,139.2',
          );
          return _json([
            {'originIndex': 0, 'destinationIndex': 0, 'duration': '600s'},
          ]);
        }),
      );
      final rows = await client.fetchWalkMatrix(
        const [GeoPoint(35.0, 139.0)],
        const [GeoPoint(35.1, 139.1), GeoPoint(35.2, 139.2)],
      );
      expect(rows, isNotNull);
      expect(rows!.length, 1);
    });

    test('非200は null（直線推定へフォールバック）', () async {
      final client = _client(MockClient((req) async => _json(const [], 500)));
      final rows = await client.fetchWalkMatrix(
        const [GeoPoint(0, 0)],
        const [GeoPoint(1, 1)],
      );
      expect(rows, isNull);
    });

    test('配列でないレスポンスも null', () async {
      final client = _client(
        MockClient((req) async => _json(const {'not': 'array'})),
      );
      final rows = await client.fetchWalkMatrix(
        const [GeoPoint(0, 0)],
        const [GeoPoint(1, 1)],
      );
      expect(rows, isNull);
    });

    // fetchGuidanceAt は TIMEOUT を再送出するのに対し fetchWalkMatrix は握り潰す、
    // という挙動差が本クラスの要点なので明示的に固定する（回帰防止）。
    test('タイムアウトも null（直線推定へフォールバック）', () async {
      final client = _client(
        MockClient((req) async => throw TimeoutException('slow')),
      );
      final rows = await client.fetchWalkMatrix(
        const [GeoPoint(0, 0)],
        const [GeoPoint(1, 1)],
      );
      expect(rows, isNull);
    });
  });

  group('fetchWalkRoute', () {
    test('googleWalkProxy へ start/goal を渡し生ボディを返す', () async {
      final client = _client(
        MockClient((req) async {
          expect(req.url.path, '/googleWalkProxy');
          expect(req.url.queryParameters['start'], '35.0,139.0');
          expect(req.url.queryParameters['goal'], '35.5,139.5');
          return _json({
            'routes': [
              {'duration': '300s'},
            ],
          });
        }),
      );
      final body = await client.fetchWalkRoute(
        const GeoPoint(35.0, 139.0),
        const GeoPoint(35.5, 139.5),
      );
      expect((body['routes'] as List).length, 1);
    });

    test('非200は RouteException', () async {
      final client = _client(MockClient((req) async => _json(const {}, 404)));
      expect(
        () => client.fetchWalkRoute(const GeoPoint(0, 0), const GeoPoint(1, 1)),
        throwsA(isA<RouteException>()),
      );
    });
  });

  group('baseUrl 正規化', () {
    test('transitBaseUrl 末尾スラッシュを除去する', () {
      final client = _client(
        MockClient((_) async => _json(const {})),
        transitBase: 'https://transit.example///',
      );
      expect(client.transitBaseUrl, 'https://transit.example');
      expect(client.hasTransitApi, isTrue);
    });

    test('空の transitBaseUrl は hasTransitApi=false', () {
      final client = _client(
        MockClient((_) async => _json(const {})),
        transitBase: '',
      );
      expect(client.hasTransitApi, isFalse);
    });

    // proxyBaseUrl の末尾スラッシュ正規化は _fetchProxy の URL 組み立てに効く。
    // 実リクエストの path が二重スラッシュにならないことで確認する。
    test('proxyBaseUrl 末尾スラッシュを除去し二重スラッシュを防ぐ', () async {
      late Uri captured;
      final client = _client(
        MockClient((req) async {
          captured = req.url;
          return _json({'routes': const []});
        }),
        proxy: 'https://proxy.example///',
      );
      await client.fetchWalkRoute(
        const GeoPoint(35.0, 139.0),
        const GeoPoint(35.5, 139.5),
      );
      expect(captured.path, '/googleWalkProxy');
    });
  });

  group('キャンセル (#259)', () {
    test('キャンセル済みなら fetchGuidanceAt は HTTP を発行せず投げる', () async {
      var calls = 0;
      final client = TransitApiClient(
        transitClient: MockClient((_) async {
          calls++;
          return _json({'ok': true});
        }),
        transitBaseUrl: _transitBase,
        proxyBaseUrl: _proxyBase,
        cancellation: CancellationToken()..cancel(),
      );

      await expectLater(
        client.fetchGuidanceAt(
          const GeoPoint(35.0, 139.0),
          const GeoPoint(35.5, 139.5),
          DateTime(2026, 6, 27, 9, 5),
        ),
        throwsA(isA<SearchCanceledException>()),
      );
      expect(calls, 0);
    });

    test('キャンセル済みなら fetchWalkRoute は HTTP を発行せず投げる', () async {
      var calls = 0;
      final client = TransitApiClient(
        proxyClient: MockClient((_) async {
          calls++;
          return _json({'routes': const []});
        }),
        transitBaseUrl: _transitBase,
        proxyBaseUrl: _proxyBase,
        cancellation: CancellationToken()..cancel(),
      );

      await expectLater(
        client.fetchWalkRoute(
          const GeoPoint(35.0, 139.0),
          const GeoPoint(35.5, 139.5),
        ),
        throwsA(isA<SearchCanceledException>()),
      );
      expect(calls, 0);
    });

    // fetchWalkMatrix は取得失敗を null（直線推定へ縮退）に握り潰す唯一の口。
    // ここでキャンセルまで null に化けると、呼び出し側は探索を続行してしまう。
    test('fetchWalkMatrix はキャンセルを null へ握り潰さない', () async {
      var calls = 0;
      final client = TransitApiClient(
        proxyClient: MockClient((_) async {
          calls++;
          return _json(const []);
        }),
        transitBaseUrl: _transitBase,
        proxyBaseUrl: _proxyBase,
        cancellation: CancellationToken()..cancel(),
      );

      await expectLater(
        client.fetchWalkMatrix(
          const [GeoPoint(35.0, 139.0)],
          const [GeoPoint(35.5, 139.5)],
        ),
        throwsA(isA<SearchCanceledException>()),
      );
      expect(calls, 0);
    });

    test('探索の途中でキャンセルすると以降の HTTP を発行しない', () async {
      final cancellation = CancellationToken();
      var calls = 0;
      final client = TransitApiClient(
        transitClient: MockClient((_) async {
          calls++;
          return _json({'ok': true});
        }),
        transitBaseUrl: _transitBase,
        proxyBaseUrl: _proxyBase,
        cancellation: cancellation,
      );

      Future<Map<String, dynamic>> fetch() => client.fetchGuidanceAt(
        const GeoPoint(35.0, 139.0),
        const GeoPoint(35.5, 139.5),
        DateTime(2026, 6, 27, 9, 5),
      );

      await fetch();
      expect(calls, 1);

      cancellation.cancel();
      await expectLater(fetch(), throwsA(isA<SearchCanceledException>()));
      expect(calls, 1);
    });

    test('close は transit / proxy 双方のクライアントを閉じる', () {
      final transit = _CountingClient();
      final proxy = _CountingClient();
      TransitApiClient(
        transitClient: transit,
        proxyClient: proxy,
        transitBaseUrl: _transitBase,
        proxyBaseUrl: _proxyBase,
      ).close();

      expect(transit.closed, 1);
      expect(proxy.closed, 1);
    });
  });

  group('締切による残予算クランプ (#300)', () {
    test('上流が残予算より遅ければ残予算で TIMEOUT になる', () async {
      // 1本の上限（TimeoutHttpClient・35s）より締切の残予算の方が短い状況。
      // クランプが無ければ 200ms 待って成功してしまう。
      final client = TransitApiClient(
        transitClient: MockClient((_) async {
          await Future<void>.delayed(const Duration(milliseconds: 200));
          return _json({'ok': true});
        }),
        transitBaseUrl: _transitBase,
        proxyBaseUrl: _proxyBase,
        deadline: SearchDeadline(
          const Duration(seconds: 120),
          elapsed: () => const Duration(seconds: 120) - _remaining,
        ),
      );

      await expectLater(
        client.fetchGuidanceAt(
          const GeoPoint(35.0, 139.0),
          const GeoPoint(35.5, 139.5),
          DateTime(2026, 6, 27, 9, 5),
        ),
        throwsA(
          isA<RouteException>().having((e) => e.status, 'status', 'TIMEOUT'),
        ),
      );
    });

    test('残予算が上流の応答より長ければ透過する', () async {
      final client = TransitApiClient(
        transitClient: MockClient((_) async => _json({'ok': true})),
        transitBaseUrl: _transitBase,
        proxyBaseUrl: _proxyBase,
        deadline: SearchDeadline(
          const Duration(seconds: 120),
          elapsed: () => const Duration(seconds: 30),
        ),
      );

      expect(
        await client.fetchGuidanceAt(
          const GeoPoint(35.0, 139.0),
          const GeoPoint(35.5, 139.5),
          DateTime(2026, 6, 27, 9, 5),
        ),
        {'ok': true},
      );
    });

    test('期限切れ後は HTTP を発行せず即 TIMEOUT にする', () async {
      var calls = 0;
      final client = TransitApiClient(
        transitClient: MockClient((_) async {
          calls++;
          return _json({'ok': true});
        }),
        transitBaseUrl: _transitBase,
        proxyBaseUrl: _proxyBase,
        deadline: SearchDeadline(
          const Duration(seconds: 120),
          elapsed: () => const Duration(seconds: 500),
        ),
      );

      await expectLater(
        client.fetchGuidanceAt(
          const GeoPoint(35.0, 139.0),
          const GeoPoint(35.5, 139.5),
          DateTime(2026, 6, 27, 9, 5),
        ),
        throwsA(
          isA<RouteException>().having((e) => e.status, 'status', 'TIMEOUT'),
        ),
      );
      expect(calls, 0);
    });

    test('締切を渡さなければ残予算でクランプしない', () async {
      final client = TransitApiClient(
        transitClient: MockClient((_) async {
          await Future<void>.delayed(const Duration(milliseconds: 50));
          return _json({'ok': true});
        }),
        transitBaseUrl: _transitBase,
        proxyBaseUrl: _proxyBase,
      );

      expect(
        await client.fetchGuidanceAt(
          const GeoPoint(35.0, 139.0),
          const GeoPoint(35.5, 139.5),
          DateTime(2026, 6, 27, 9, 5),
        ),
        {'ok': true},
      );
    });

    test('徒歩プロキシには締切を適用しない（実測は検証であって改善ではない）', () async {
      // 締切で切ってよいのは「切っても嘘をつかない」呼び出しだけ。徒歩実測は fail-open
      // （_enrichWalkGeometry が失敗時に楽観的な見積りを残す）なので、締切で切ると
      // 予算超過・乗り遅れの経路を「予算内」と偽って確定させる（#254 を破る）。
      var calls = 0;
      final client = TransitApiClient(
        proxyClient: MockClient((_) async {
          calls++;
          await Future<void>.delayed(const Duration(milliseconds: 50));
          return _json({'routes': []});
        }),
        transitBaseUrl: _transitBase,
        proxyBaseUrl: _proxyBase,
        // 使い切り済みの締切。transit なら即 TIMEOUT になる状況。
        deadline: SearchDeadline(
          const Duration(seconds: 120),
          elapsed: () => const Duration(seconds: 500),
        ),
      );

      expect(
        await client.fetchWalkRoute(
          const GeoPoint(35.0, 139.0),
          const GeoPoint(35.5, 139.5),
        ),
        {'routes': []},
      );
      expect(calls, 1);
    });

    test('徒歩マトリクスにも締切を適用しない', () async {
      final client = TransitApiClient(
        proxyClient: MockClient((_) async => _json([])),
        transitBaseUrl: _transitBase,
        proxyBaseUrl: _proxyBase,
        deadline: SearchDeadline(
          const Duration(seconds: 120),
          elapsed: () => const Duration(seconds: 500),
        ),
      );

      // null（＝直線推定へフォールバック）ではなく実測が返ることの反証。
      expect(
        await client.fetchWalkMatrix(
          const [GeoPoint(35.0, 139.0)],
          const [GeoPoint(35.5, 139.5)],
        ),
        isNotNull,
      );
    });
  });
}

/// クランプを観測するための短い残予算。上流 fake の遅延より十分短くとる。
const _remaining = Duration(milliseconds: 20);

/// close 回数だけを数えるクライアント。MockClient の close は no-op で観測できない。
class _CountingClient extends http.BaseClient {
  int closed = 0;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async =>
      throw UnimplementedError();

  @override
  void close() => closed++;
}
