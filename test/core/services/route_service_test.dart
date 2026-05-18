import 'dart:convert';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _fakePlan = RoutePlan(
  from: 'A',
  to: 'B',
  totalKm: 1,
  totalMin: 1,
  budgetMin: 1,
  kcal: 1,
  walkKm: 1,
  walkRatio: 1,
  segments: [],
  timelineNodes: [],
);

class _FakeRouteService implements RouteService {
  int calls = 0;

  @override
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
    void Function(RoutePhase)? onProgress,
  }) async {
    calls++;
    return _fakePlan;
  }
}

const _proxyBaseUrl = 'https://proxy.example.com';

// Well-known Google encoded polyline → (38.5,-120.2),(40.7,-120.95),
// (43.252,-126.453).
const _encoded = '_p~iF~ps|U_ulLnnqC_mqNvxq`@';

http.Response _jsonResponse(Object body, int status) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status);

Map<String, dynamic> _walkStep(int meters, int seconds) => {
  'travel_mode': 'WALKING',
  'distance': {'value': meters},
  'duration': {'value': seconds},
  'polyline': {'points': _encoded},
};

Map<String, dynamic> _transitStep(
  int meters,
  int seconds, {
  required String line,
  required String dep,
  required String arr,
  required int stops,
}) => {
  'travel_mode': 'TRANSIT',
  'distance': {'value': meters},
  'duration': {'value': seconds},
  'polyline': {'points': _encoded},
  'transit_details': {
    'line': {'name': line},
    'num_stops': stops,
    'departure_stop': {'name': dep},
    'arrival_stop': {'name': arr},
  },
};

Map<String, dynamic> _route(List<Map<String, dynamic>> steps) => {
  'legs': [
    {'start_address': '出発地', 'end_address': '目的地', 'steps': steps},
  ],
};

Map<String, dynamic> _directions(List<Map<String, dynamic>> routes) => {
  'status': 'OK',
  'routes': routes,
};

void main() {
  group('AppNotifier.startSearch + RouteService', () {
    test('RouteService 経由で plan を取得し state.route へ反映する', () async {
      final service = _FakeRouteService();
      final container = ProviderContainer(
        overrides: [routeServiceProvider.overrideWithValue(service)],
      );
      addTearDown(container.dispose);

      await container.read(appStateProvider.notifier).startSearch();

      final state = container.read(appStateProvider);
      expect(service.calls, 1);
      expect(state.screen, Screen.result);
      expect(state.route, same(_fakePlan));
    });

    test('startSearch 中は loading 画面を経由する', () async {
      final container = ProviderContainer(
        overrides: [
          routeServiceProvider.overrideWithValue(_FakeRouteService()),
        ],
      );
      addTearDown(container.dispose);

      final future = container.read(appStateProvider.notifier).startSearch();
      expect(container.read(appStateProvider).screen, Screen.loading);
      await future;
      expect(container.read(appStateProvider).screen, Screen.result);
    });
  });

  group('decodePolyline', () {
    test('Google の既知サンプルをデコードする', () {
      final points = decodePolyline(_encoded);
      expect(points, hasLength(3));
      expect(points[0].lat, closeTo(38.5, 1e-4));
      expect(points[0].lng, closeTo(-120.2, 1e-4));
      expect(points[2].lat, closeTo(43.252, 1e-4));
      expect(points[2].lng, closeTo(-126.453, 1e-4));
    });

    test('空文字は空リストを返す', () {
      expect(decodePolyline(''), isEmpty);
    });

    test('不正・途中切れ文字列でも例外を投げない', () {
      expect(() => decodePolyline('???'), returnsNormally);
      expect(() => decodePolyline('_p~iF'), returnsNormally);
      expect(decodePolyline('_p~iF'), isA<List<GeoPoint>>());
    });
  });

  group('GoogleRouteService.plan', () {
    GoogleRouteService build(MockClient client) =>
        GoogleRouteService(client: client, proxyBaseUrl: _proxyBaseUrl);

    test('全徒歩が予算内なら 1 リクエストで徒歩100%ルートを返す', () async {
      var calls = 0;
      String? mode;
      final client = MockClient((req) async {
        calls++;
        mode = req.url.queryParameters['mode'];
        expect(
          req.url.toString(),
          startsWith('$_proxyBaseUrl/directionsProxy'),
        );
        expect(req.url.queryParameters['origin'], '35.7,139.7');
        expect(req.url.queryParameters['destination'], '35.65,139.7');
        return _jsonResponse(
          _directions([
            _route([_walkStep(5000, 3600)]),
          ]),
          200,
        );
      });

      final plan = await build(client).plan(
        destination: '渋谷',
        destinationLatLng: const GeoPoint(35.65, 139.7),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 11, m: 0),
        origin: const GeoPoint(35.7, 139.7),
      );

      expect(calls, 1);
      expect(mode, 'walking');
      expect(plan.segments, hasLength(1));
      expect(plan.segments.single.type, SegmentType.walk);
      expect(plan.walkRatio, 1.0);
      expect(plan.walkKm, closeTo(5.0, 1e-9));
      expect(plan.totalKm, closeTo(5.0, 1e-9));
      expect(plan.totalMin, 60);
      expect(plan.budgetMin, 120);
      expect(plan.kcal, (5.0 * 57).round());
      expect(plan.segments.single.polyline, isNotEmpty);
    });

    test('全徒歩が予算超過なら transit&alternatives で予算内かつ徒歩比率最大を選ぶ', () async {
      final responses = <Map<String, dynamic>>[
        // walking: 80 分 → 予算 60 を超過
        _directions([
          _route([_walkStep(6000, 4800)]),
        ]),
        // transit alternatives: A=徒歩比率低, B=徒歩比率高（共に予算内）
        _directions([
          _route([
            _walkStep(1000, 600),
            _transitStep(
              4000,
              1200,
              line: 'JR山手線',
              dep: '原宿',
              arr: '渋谷',
              stops: 2,
            ),
            _walkStep(800, 540),
          ]),
          _route([
            _walkStep(2500, 1500),
            _transitStep(
              2000,
              600,
              line: 'JR山手線',
              dep: '代々木',
              arr: '渋谷',
              stops: 1,
            ),
            _walkStep(1500, 1080),
          ]),
        ]),
      ];
      var i = 0;
      final urls = <Uri>[];
      final client = MockClient((req) async {
        urls.add(req.url);
        return _jsonResponse(responses[i++], 200);
      });

      final plan = await build(client).plan(
        destination: '渋谷',
        destinationLatLng: const GeoPoint(35.65, 139.7),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 10, m: 0),
        origin: const GeoPoint(35.7, 139.7),
      );

      expect(urls, hasLength(2));
      expect(urls[0].queryParameters['mode'], 'walking');
      expect(urls[1].queryParameters['mode'], 'transit');
      expect(urls[1].queryParameters['alternatives'], 'true');
      expect(urls[1].queryParameters['departure_time'], isNotNull);

      // route B: walk 4.0km / total 6.0km, totalMin 25+10+18 = 53 ≤ 60
      expect(
        plan.segments.where((s) => s.type == SegmentType.train),
        hasLength(1),
      );
      expect(plan.totalMin, 53);
      expect(plan.walkKm, closeTo(4.0, 1e-9));
      expect(plan.totalKm, closeTo(6.0, 1e-9));
      expect(plan.walkRatio, closeTo(4.0 / 6.0, 1e-9));
      final train = plan.segments.firstWhere(
        (s) => s.type == SegmentType.train,
      );
      expect(train.line, 'JR山手線');
      expect(train.fromName, '代々木');
      expect(train.toName, '渋谷');
      expect(train.stops, 1);
    });

    test('予算内候補が無ければ最短(totalMin 最小)ルートを返す', () async {
      final responses = <Map<String, dynamic>>[
        _directions([
          _route([_walkStep(6000, 4800)]),
        ]),
        _directions([
          _route([
            _walkStep(1000, 600),
            _transitStep(4000, 1200, line: 'L', dep: 'a', arr: 'b', stops: 2),
            _walkStep(800, 540),
          ]),
          _route([
            _walkStep(2500, 1500),
            _transitStep(2000, 600, line: 'L', dep: 'c', arr: 'b', stops: 1),
            _walkStep(1500, 1080),
          ]),
        ]),
      ];
      var i = 0;
      final client = MockClient(
        (_) async => _jsonResponse(responses[i++], 200),
      );

      final plan = await build(client).plan(
        destination: '渋谷',
        destinationLatLng: const GeoPoint(35.65, 139.7),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 9, m: 30),
        origin: const GeoPoint(35.7, 139.7),
      );

      // route A totalMin = 10+20+9 = 39, route B = 25+10+18 = 53 → A
      expect(plan.totalMin, 39);
      expect(plan.budgetMin, 30);
    });

    test('HTTP エラーで RouteException をスローする', () {
      final client = MockClient((_) async => http.Response('boom', 500));
      expect(
        () => build(client).plan(
          destination: '渋谷',
          destinationLatLng: const GeoPoint(35.65, 139.7),
          departure: const TimeValue(h: 9, m: 0),
          arrival: const TimeValue(h: 11, m: 0),
          origin: const GeoPoint(35.7, 139.7),
        ),
        throwsA(isA<RouteException>()),
      );
    });

    test('status が OK 以外で RouteException をスローする', () {
      final client = MockClient(
        (_) async => _jsonResponse({'status': 'REQUEST_DENIED'}, 200),
      );
      expect(
        () => build(client).plan(
          destination: '渋谷',
          destinationLatLng: const GeoPoint(35.65, 139.7),
          departure: const TimeValue(h: 9, m: 0),
          arrival: const TimeValue(h: 11, m: 0),
          origin: const GeoPoint(35.7, 139.7),
        ),
        throwsA(isA<RouteException>()),
      );
    });

    test('origin が無いと RouteException をスローする', () {
      final client = MockClient((_) async => _jsonResponse({}, 200));
      expect(
        () => build(client).plan(
          destination: '渋谷',
          destinationLatLng: const GeoPoint(35.65, 139.7),
          departure: const TimeValue(h: 9, m: 0),
          arrival: const TimeValue(h: 11, m: 0),
        ),
        throwsA(isA<RouteException>()),
      );
    });

    test('transit が OK でも routes 空なら RouteException をスローする', () {
      final responses = <Map<String, dynamic>>[
        _directions([
          _route([_walkStep(6000, 4800)]),
        ]),
        {'status': 'OK', 'routes': <dynamic>[]},
      ];
      var i = 0;
      final client = MockClient(
        (_) async => _jsonResponse(responses[i++], 200),
      );
      expect(
        () => build(client).plan(
          destination: '渋谷',
          destinationLatLng: const GeoPoint(35.65, 139.7),
          departure: const TimeValue(h: 9, m: 0),
          arrival: const TimeValue(h: 10, m: 0),
          origin: const GeoPoint(35.7, 139.7),
        ),
        throwsA(isA<RouteException>()),
      );
    });

    test('予算内が無く徒歩が transit より短ければ徒歩ルートを返す', () async {
      final responses = <Map<String, dynamic>>[
        // walking 65 分（予算 60 を僅かに超過）
        _directions([
          _route([_walkStep(5000, 3900)]),
        ]),
        // transit 代替は全て徒歩より長い（99分・94分）
        _directions([
          _route([
            _walkStep(1000, 600),
            _transitStep(4000, 4800, line: 'L', dep: 'a', arr: 'b', stops: 2),
            _walkStep(800, 540),
          ]),
          _route([
            _walkStep(500, 300),
            _transitStep(5000, 5100, line: 'L', dep: 'c', arr: 'b', stops: 3),
            _walkStep(300, 240),
          ]),
        ]),
      ];
      var i = 0;
      final client = MockClient(
        (_) async => _jsonResponse(responses[i++], 200),
      );

      final plan = await build(client).plan(
        destination: '渋谷',
        destinationLatLng: const GeoPoint(35.65, 139.7),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 10, m: 0),
        origin: const GeoPoint(35.7, 139.7),
      );

      expect(plan.segments, hasLength(1));
      expect(plan.segments.single.type, SegmentType.walk);
      expect(plan.totalMin, 65);
      expect(plan.walkRatio, 1.0);
    });

    test('dateOffset=0 のとき当日 epoch をそのまま渡す（過去時刻でも自動翌日化しない）', () async {
      final responses = <Map<String, dynamic>>[
        _directions([
          _route([_walkStep(6000, 4800)]),
        ]),
        _directions([
          _route([
            _walkStep(1000, 600),
            _transitStep(4000, 1200, line: 'L', dep: 'a', arr: 'b', stops: 2),
            _walkStep(800, 540),
          ]),
        ]),
      ];
      var i = 0;
      final urls = <Uri>[];
      final client = MockClient((req) async {
        urls.add(req.url);
        return _jsonResponse(responses[i++], 200);
      });
      final now = DateTime(2026, 5, 17, 15, 0);
      final service = GoogleRouteService(
        client: client,
        proxyBaseUrl: _proxyBaseUrl,
        clock: () => now,
      );

      // dateOffset=0（デフォルト）→ clock=15:00 でも当日 09:00 epoch をそのまま渡す
      await service.plan(
        destination: '渋谷',
        destinationLatLng: const GeoPoint(35.65, 139.7),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 10, m: 0),
        origin: const GeoPoint(35.7, 139.7),
      );

      final epoch = int.parse(urls[1].queryParameters['departure_time']!);
      final sent = DateTime.fromMillisecondsSinceEpoch(epoch * 1000);
      expect(sent, DateTime(2026, 5, 17, 9, 0));
    });

    test('現在時刻より後の出発時刻なら当日のまま', () async {
      final responses = <Map<String, dynamic>>[
        _directions([
          _route([_walkStep(6000, 4800)]),
        ]),
        _directions([
          _route([
            _walkStep(1000, 600),
            _transitStep(4000, 1200, line: 'L', dep: 'a', arr: 'b', stops: 2),
            _walkStep(800, 540),
          ]),
        ]),
      ];
      var i = 0;
      final urls = <Uri>[];
      final client = MockClient((req) async {
        urls.add(req.url);
        return _jsonResponse(responses[i++], 200);
      });
      final now = DateTime(2026, 5, 17, 7, 0);
      final service = GoogleRouteService(
        client: client,
        proxyBaseUrl: _proxyBaseUrl,
        clock: () => now,
      );

      await service.plan(
        destination: '渋谷',
        destinationLatLng: const GeoPoint(35.65, 139.7),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 10, m: 0),
        origin: const GeoPoint(35.7, 139.7),
      );

      final epoch = int.parse(urls[1].queryParameters['departure_time']!);
      final sent = DateTime.fromMillisecondsSinceEpoch(epoch * 1000);
      expect(sent, DateTime(2026, 5, 17, 9, 0));
    });
  });

  group('RouteService onProgress', () {
    test('GoogleRouteService 全徒歩経路でも段階を順に通知する', () async {
      final phases = <RoutePhase>[];
      final client = MockClient(
        (_) async => _jsonResponse(
          _directions([
            _route([_walkStep(5000, 3600)]),
          ]),
          200,
        ),
      );
      await GoogleRouteService(
        client: client,
        proxyBaseUrl: _proxyBaseUrl,
      ).plan(
        destination: '渋谷',
        destinationLatLng: const GeoPoint(35.65, 139.7),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 11, m: 0),
        origin: const GeoPoint(35.7, 139.7),
        onProgress: phases.add,
      );
      expect(phases, [
        RoutePhase.routing,
        RoutePhase.walkability,
        RoutePhase.building,
      ]);
    });

    test('GoogleRouteService transit 経路でも段階を順に通知する', () async {
      final responses = <Map<String, dynamic>>[
        _directions([
          _route([_walkStep(6000, 4800)]),
        ]),
        _directions([
          _route([
            _walkStep(1000, 600),
            _transitStep(4000, 1200, line: 'L', dep: 'a', arr: 'b', stops: 2),
            _walkStep(800, 540),
          ]),
        ]),
      ];
      var i = 0;
      final client = MockClient(
        (_) async => _jsonResponse(responses[i++], 200),
      );
      final phases = <RoutePhase>[];
      await GoogleRouteService(
        client: client,
        proxyBaseUrl: _proxyBaseUrl,
      ).plan(
        destination: '渋谷',
        destinationLatLng: const GeoPoint(35.65, 139.7),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 10, m: 0),
        origin: const GeoPoint(35.7, 139.7),
        onProgress: phases.add,
      );
      expect(phases, [
        RoutePhase.routing,
        RoutePhase.walkability,
        RoutePhase.building,
      ]);
    });
  });

  group('GoogleRouteService._departureEpoch（dateOffset）', () {
    // clock を 2024-06-01 09:00:00 に固定
    final fixedNow = DateTime(2024, 6, 1, 9, 0, 0);

    // walking が予算オーバー → transit リクエストを発行させ departure_time を捕捉する
    Future<String?> captureTransitDepartureTime(TimeValue departure) async {
      String? capturedDepartureTime;
      int callCount = 0;

      final client = MockClient((req) async {
        callCount++;
        if (callCount == 1) {
          // 1回目: walking → 予算超過レスポンス
          return _jsonResponse(
            _directions([
              _route([_walkStep(10000, 99999)]),
            ]),
            200,
          );
        }
        // 2回目: transit → departure_time を記録して有効レスポンスを返す
        capturedDepartureTime = req.url.queryParameters['departure_time'];
        return _jsonResponse(
          _directions([
            _route([
              _transitStep(
                5000,
                1200,
                line: '山手線',
                dep: '渋谷',
                arr: '新宿',
                stops: 3,
              ),
            ]),
          ]),
          200,
        );
      });

      await GoogleRouteService(
        client: client,
        proxyBaseUrl: _proxyBaseUrl,
        clock: () => fixedNow,
      ).plan(
        destination: '目的地',
        destinationLatLng: const GeoPoint(35.65, 139.7),
        departure: departure,
        arrival: const TimeValue(h: 23, m: 55),
        origin: const GeoPoint(35.7, 139.7),
      );

      return capturedDepartureTime;
    }

    test('dateOffset=0 のとき当日 epoch を transit に渡す', () async {
      const tv = TimeValue(h: 14, m: 0, dateOffset: 0);
      final expected =
          DateTime(2024, 6, 1, 14, 0).millisecondsSinceEpoch ~/ 1000;
      final actual = await captureTransitDepartureTime(tv);
      expect(actual, expected.toString());
    });

    test('dateOffset=1 のとき翌日 epoch を transit に渡す', () async {
      const tv = TimeValue(h: 14, m: 0, dateOffset: 1);
      final expected =
          DateTime(2024, 6, 2, 14, 0).millisecondsSinceEpoch ~/ 1000;
      final actual = await captureTransitDepartureTime(tv);
      expect(actual, expected.toString());
    });

    test('dateOffset=0 かつ過去時刻（07:00, clock=09:00）でも当日 epoch を渡す', () async {
      // 従来の自動翌日化を行わず、ユーザーが明示した日付を尊重する
      const tv = TimeValue(h: 7, m: 0, dateOffset: 0);
      final expected =
          DateTime(2024, 6, 1, 7, 0).millisecondsSinceEpoch ~/ 1000;
      final actual = await captureTransitDepartureTime(tv);
      expect(actual, expected.toString());
    });

    test('isNow=true のとき dateOffset に関わらず当日 epoch を渡す', () async {
      // isNow=true の場合は dateOffset=0 として扱う
      const tv = TimeValue(h: 14, m: 0, isNow: true, dateOffset: 0);
      final expected =
          DateTime(2024, 6, 1, 14, 0).millisecondsSinceEpoch ~/ 1000;
      final actual = await captureTransitDepartureTime(tv);
      expect(actual, expected.toString());
    });
  });

  group('GoogleRouteService.plan（budgetMin cross-day）', () {
    // 出発 23:00（今日, dateOffset=0）/ 到着 00:30（明日, dateOffset=1）→ 予算 90 分
    test(
      'departure dateOffset=0 / arrival dateOffset=1 のとき budgetMin を正しく計算する',
      () async {
        // 徒歩 60 分のルートが予算内（90 分）に収まることを確認する
        final client = MockClient(
          (req) async => _jsonResponse(
            _directions([
              _route([_walkStep(4000, 3600)]), // 60 分の徒歩
            ]),
            200,
          ),
        );

        final service = GoogleRouteService(
          client: client,
          proxyBaseUrl: _proxyBaseUrl,
          clock: () => DateTime(2024, 6, 1, 22, 0),
        );

        final plan = await service.plan(
          destination: '目的地',
          destinationLatLng: const GeoPoint(35.65, 139.7),
          departure: const TimeValue(h: 23, m: 0, dateOffset: 0),
          arrival: const TimeValue(h: 0, m: 30, dateOffset: 1),
          origin: const GeoPoint(35.7, 139.7),
        );

        // 徒歩のみプランが返れば budgetMin が 90 分と計算されていた証拠
        expect(plan.walkRatio, 1.0);
      },
    );
  });
}
