import 'dart:async';
import 'dart:convert';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/services/route_service.dart';
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

  group('callCounts', () {
    test('初期値は全て0', () {
      final client = _client(MockClient((_) async => _json(const {})));
      expect(client.callCounts.navitimeCalls, 0);
      expect(client.callCounts.googleWalkCalls, 0);
      expect(client.callCounts.googleMatrixCalls, 0);
    });

    test('fetchGuidanceAt は navitimeCalls を増やす', () async {
      final client = _client(MockClient((_) async => _json({'ok': true})));
      await client.fetchGuidanceAt(
        const GeoPoint(0, 0),
        const GeoPoint(1, 1),
        DateTime(2026),
      );
      await client.fetchGuidanceAt(
        const GeoPoint(0, 0),
        const GeoPoint(1, 1),
        DateTime(2026),
      );
      expect(client.callCounts.navitimeCalls, 2);
      expect(client.callCounts.googleWalkCalls, 0);
      expect(client.callCounts.googleMatrixCalls, 0);
    });

    test('fetchWalkRoute は googleWalkCalls を増やす', () async {
      final client = _client(
        MockClient((_) async => _json({'routes': const []})),
      );
      await client.fetchWalkRoute(const GeoPoint(0, 0), const GeoPoint(1, 1));
      expect(client.callCounts.googleWalkCalls, 1);
      expect(client.callCounts.navitimeCalls, 0);
    });

    test('fetchWalkMatrix は googleMatrixCalls を増やす（失敗時も計上）', () async {
      final client = _client(MockClient((_) async => _json(const [], 500)));
      await client.fetchWalkMatrix(
        const [GeoPoint(0, 0)],
        const [GeoPoint(1, 1)],
      );
      expect(client.callCounts.googleMatrixCalls, 1);
    });

    test('resetCallCounts で0に戻る', () async {
      final client = _client(MockClient((_) async => _json({'ok': true})));
      await client.fetchGuidanceAt(
        const GeoPoint(0, 0),
        const GeoPoint(1, 1),
        DateTime(2026),
      );
      client.resetCallCounts();
      expect(client.callCounts.navitimeCalls, 0);
    });

    // 並行検索（#221・cancelSearch後もHTTPは中断せず走り続ける）で同一クライアントを
    // 共有すると reset は他方の集計中カウントを消してしまう。差分（-）で1検索分だけを
    // 取り出せることを固定する（#238 レビュー指摘対応）。
    test('- はスナップショット間の差分を返す（並行検索での計測用）', () {
      const before = ApiCallCounts(
        navitimeCalls: 1,
        googleWalkCalls: 2,
        googleMatrixCalls: 3,
      );
      const after = ApiCallCounts(
        navitimeCalls: 4,
        googleWalkCalls: 5,
        googleMatrixCalls: 7,
      );
      final delta = after - before;
      expect(delta.navitimeCalls, 3);
      expect(delta.googleWalkCalls, 3);
      expect(delta.googleMatrixCalls, 4);
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
}
