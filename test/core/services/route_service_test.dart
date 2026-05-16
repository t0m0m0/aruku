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

  group('DummyRouteService', () {
    test('遅延 0 指定で妥当な RoutePlan を返す', () async {
      final service = DummyRouteService(latency: Duration.zero);
      final plan = await service.plan(
        destination: '渋谷ヒカリエ',
        destinationLatLng: null,
        departure: const TimeValue(h: 9, m: 32),
        arrival: const TimeValue(h: 10, m: 50),
      );

      expect(plan.segments, isNotEmpty);
      for (final seg in plan.segments) {
        expect(seg.polyline, isNotEmpty);
      }
      for (var i = 0; i < plan.segments.length - 1; i++) {
        expect(
          plan.segments[i].polyline.last,
          plan.segments[i + 1].polyline.first,
        );
      }
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
  });
}
