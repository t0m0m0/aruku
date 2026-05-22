import 'dart:convert';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/navitime_route_service.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _proxyBaseUrl = 'https://proxy.example.com';

http.Response _jsonResponse(Object body, int status) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status);

Map<String, dynamic> _point(String name) => {'type': 'point', 'name': name};

Map<String, dynamic> _walkSection(int meters, int minutes) => {
  'type': 'move',
  'move': 'walk',
  'distance': meters,
  'time': minutes,
};

Map<String, dynamic> _trainSection(
  int meters,
  int minutes, {
  required String line,
  int? stops,
}) => {
  'type': 'move',
  'move': 'local_train',
  'distance': meters,
  'time': minutes,
  'line_name': line,
  'stop_count': ?stops,
};

Map<String, dynamic> _item(List<Map<String, dynamic>> sections) => {
  'sections': sections,
};

Map<String, dynamic> _navi(List<Map<String, dynamic>> items) => {
  'items': items,
};

void main() {
  group('NaviTimeRouteService.plan', () {
    NaviTimeRouteService build(
      MockClient client, {
      DateTime Function()? clock,
    }) => NaviTimeRouteService(
      client: client,
      proxyBaseUrl: _proxyBaseUrl,
      clock: clock ?? () => DateTime(2026, 5, 22, 8, 0),
    );

    test('徒歩+電車+徒歩を区間へ変換し RoutePlan を構築する', () async {
      final client = MockClient((req) async {
        expect(req.url.toString(), startsWith('$_proxyBaseUrl/navitimeProxy'));
        expect(req.url.queryParameters['start'], '35.7,139.7');
        expect(req.url.queryParameters['goal'], '35.65,139.7');
        expect(req.url.queryParameters['start_time'], '2026-05-22T09:00:00');
        return _jsonResponse(
          _navi([
            _item([
              _point('出発地'),
              _walkSection(500, 6),
              _point('新宿駅'),
              _trainSection(2000, 4, line: 'JR山手線', stops: 1),
              _point('渋谷駅'),
              _walkSection(700, 9),
              _point('目的地'),
            ]),
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

      expect(plan.from, '出発地');
      expect(plan.to, '目的地');
      expect(plan.segments, hasLength(3));
      expect(plan.segments[0].type, SegmentType.walk);
      expect(plan.segments[1].type, SegmentType.train);
      expect(plan.segments[1].line, 'JR山手線');
      expect(plan.segments[1].stops, 1);
      expect(plan.segments[1].fromName, '新宿駅');
      expect(plan.segments[1].toName, '渋谷駅');
      expect(plan.totalMin, 19);
      expect(plan.walkKm, closeTo(1.2, 1e-9));
      expect(plan.totalKm, closeTo(3.2, 1e-9));
      expect(plan.walkRatio, closeTo(1.2 / 3.2, 1e-9));
      expect(plan.kcal, 69); // round(0.5*57)+round(0.7*57)=29+40
      expect(plan.budgetMin, 120);
      expect(plan.timelineNodes.first.time, '9:00');
      expect(plan.timelineNodes.last.time, '9:19');
      expect(plan.timelineNodes.last.sub, contains('制限内'));
    });

    test('予算内の複数候補から徒歩比率最大を選ぶ', () async {
      final client = MockClient((req) async {
        return _jsonResponse(
          _navi([
            // 候補A: 電車多め（徒歩比率低）
            _item([
              _point('A'),
              _walkSection(200, 3),
              _point('駅1'),
              _trainSection(5000, 10, line: 'L1'),
              _point('B'),
            ]),
            // 候補B: 徒歩多め（徒歩比率高）
            _item([
              _point('A'),
              _walkSection(3000, 36),
              _point('駅2'),
              _trainSection(1000, 5, line: 'L2'),
              _point('B'),
            ]),
          ]),
          200,
        );
      });

      final plan = await build(client).plan(
        destination: 'B',
        destinationLatLng: const GeoPoint(35.65, 139.7),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 11, m: 0),
        origin: const GeoPoint(35.7, 139.7),
      );

      // 候補B（徒歩 3.0km / 計 4.0km）が選ばれる
      expect(plan.walkKm, closeTo(3.0, 1e-9));
      expect(plan.segments.first.toName, '駅2');
    });

    test('予算内候補が無ければ最短を選ぶ', () async {
      final client = MockClient((req) async {
        return _jsonResponse(
          _navi([
            // 計 200分（予算超過・長い）
            _item([
              _point('A'),
              _trainSection(5000, 200, line: 'L1'),
              _point('B'),
            ]),
            // 計 130分（予算超過だが最短）
            _item([
              _point('A'),
              _trainSection(5000, 130, line: 'L2'),
              _point('B'),
            ]),
          ]),
          200,
        );
      });

      final plan = await build(client).plan(
        destination: 'B',
        destinationLatLng: const GeoPoint(35.65, 139.7),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 11, m: 0), // 予算 120 分
        origin: const GeoPoint(35.7, 139.7),
      );

      expect(plan.totalMin, 130);
      expect(plan.segments.first.line, 'L2');
    });

    test('items が空なら ZERO_RESULTS', () async {
      final client = MockClient((req) async => _jsonResponse(_navi([]), 200));
      await expectLater(
        () => build(client).plan(
          destination: 'B',
          destinationLatLng: const GeoPoint(35.65, 139.7),
          departure: const TimeValue(h: 9, m: 0),
          arrival: const TimeValue(h: 11, m: 0),
          origin: const GeoPoint(35.7, 139.7),
        ),
        throwsA(
          isA<RouteException>().having(
            (e) => e.status,
            'status',
            'ZERO_RESULTS',
          ),
        ),
      );
    });

    test('HTTP 非200 は例外', () async {
      final client = MockClient((req) async => _jsonResponse({}, 500));
      await expectLater(
        () => build(client).plan(
          destination: 'B',
          destinationLatLng: const GeoPoint(35.65, 139.7),
          departure: const TimeValue(h: 9, m: 0),
          arrival: const TimeValue(h: 11, m: 0),
          origin: const GeoPoint(35.7, 139.7),
        ),
        throwsA(isA<RouteException>()),
      );
    });

    test('目的地座標が無ければ NO_DESTINATION', () async {
      final client = MockClient((req) async => _jsonResponse(_navi([]), 200));
      await expectLater(
        () => build(client).plan(
          destination: '渋谷',
          destinationLatLng: null,
          departure: const TimeValue(h: 9, m: 0),
          arrival: const TimeValue(h: 11, m: 0),
          origin: const GeoPoint(35.7, 139.7),
        ),
        throwsA(
          isA<RouteException>().having(
            (e) => e.status,
            'status',
            'NO_DESTINATION',
          ),
        ),
      );
    });

    test('proxyBaseUrl が空なら NO_PROXY', () async {
      final client = MockClient((req) async => _jsonResponse(_navi([]), 200));
      final service = NaviTimeRouteService(client: client, proxyBaseUrl: '');
      await expectLater(
        () => service.plan(
          destination: 'B',
          destinationLatLng: const GeoPoint(35.65, 139.7),
          departure: const TimeValue(h: 9, m: 0),
          arrival: const TimeValue(h: 11, m: 0),
          origin: const GeoPoint(35.7, 139.7),
        ),
        throwsA(
          isA<RouteException>().having((e) => e.status, 'status', 'NO_PROXY'),
        ),
      );
    });

    test('過去時刻の出発は翌日扱いで start_time を送る', () async {
      String? sentStartTime;
      final client = MockClient((req) async {
        sentStartTime = req.url.queryParameters['start_time'];
        return _jsonResponse(
          _navi([
            _item([_point('A'), _walkSection(500, 6), _point('B')]),
          ]),
          200,
        );
      });

      // clock=10:00, departure=9:00（過去）→ 翌日 5/23
      await build(client, clock: () => DateTime(2026, 5, 22, 10, 0)).plan(
        destination: 'B',
        destinationLatLng: const GeoPoint(35.65, 139.7),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 11, m: 0),
        origin: const GeoPoint(35.7, 139.7),
      );

      expect(sentStartTime, '2026-05-23T09:00:00');
    });
  });
}
