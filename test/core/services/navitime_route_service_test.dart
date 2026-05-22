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

Map<String, dynamic> _calling(
  String name,
  double lat,
  double lon,
  String fromTime,
  String toTime,
) => {
  'name': name,
  'coord': {'lat': lat, 'lon': lon},
  'from_time': fromTime,
  'to_time': toTime,
};

Map<String, dynamic> _trainSection(
  int meters,
  int minutes, {
  required String line,
  int? stops,
  List<Map<String, dynamic>>? calling,
}) => {
  'type': 'move',
  'move': 'local_train',
  'distance': meters,
  'time': minutes,
  'line_name': line,
  'stop_count': ?stops,
  if (calling != null) 'transport': {'calling_at': calling},
};

Map<String, dynamic> _item(List<Map<String, dynamic>> sections) => {
  'sections': sections,
};

Map<String, dynamic> _navi(List<Map<String, dynamic>> items) => {
  'items': items,
};

Map<String, dynamic> _walkResp(int minutes, int meters) => {
  'items': [
    {
      'summary': {
        'move': {'time': minutes, 'distance': meters},
      },
    },
  ],
};

/// transit と walk をパスで振り分けるモッククライアント。
http.Client _mock({
  required Map<String, dynamic> transit,
  int transitStatus = 200,
  Map<String, Map<String, dynamic>> walkByGoal = const {},
  Map<String, dynamic>? defaultWalk,
  List<Uri>? log,
}) => MockClient((req) async {
  log?.add(req.url);
  if (req.url.path.contains('navitimeWalkProxy')) {
    final goal = req.url.queryParameters['goal'] ?? '';
    return _jsonResponse(walkByGoal[goal] ?? defaultWalk ?? _navi([]), 200);
  }
  return _jsonResponse(transit, transitStatus);
});

void main() {
  group('NaviTimeRouteService.plan', () {
    NaviTimeRouteService build(
      http.Client client, {
      DateTime Function()? clock,
    }) => NaviTimeRouteService(
      client: client,
      proxyBaseUrl: _proxyBaseUrl,
      clock: clock ?? () => DateTime(2026, 5, 22, 8, 0),
    );

    Future<RoutePlan> run(
      http.Client client, {
      int arrivalH = 9,
      int arrivalM = 30,
    }) => build(client).plan(
      destination: '東京',
      destinationLatLng: const GeoPoint(35.681, 139.767),
      departure: const TimeValue(h: 9, m: 0),
      arrival: TimeValue(h: arrivalH, m: arrivalM),
      origin: const GeoPoint(35.7, 139.75),
    );

    // 品川→東京相当の標準経路: 徒歩5分→品川→(新橋)→東京 計12分。
    Map<String, dynamic> shinagawaToTokyo() => _navi([
      _item([
        _point('出発地'),
        _walkSection(400, 5),
        _point('品川駅'),
        _trainSection(
          6000,
          7,
          line: 'JR山手線',
          stops: 2,
          calling: [
            _calling(
              '品川駅',
              35.628,
              139.738,
              '2026-05-22T09:05:00',
              '2026-05-22T09:05:00',
            ),
            _calling(
              '新橋駅',
              35.666,
              139.758,
              '2026-05-22T09:09:00',
              '2026-05-22T09:09:00',
            ),
            _calling(
              '東京駅',
              35.681,
              139.767,
              '2026-05-22T09:12:00',
              '2026-05-22T09:12:00',
            ),
          ],
        ),
        _point('東京駅'),
      ]),
    ]);

    test('全徒歩が予算内なら全徒歩を返す', () async {
      final client = _mock(
        transit: shinagawaToTokyo(),
        // 全徒歩 25分（予算30分内）。
        walkByGoal: {'35.681,139.767': _walkResp(25, 2000)},
      );

      final plan = await run(client);

      expect(plan.segments, hasLength(1));
      expect(plan.segments.first.type, SegmentType.walk);
      expect(plan.totalMin, 25);
      expect(plan.walkRatio, closeTo(1.0, 1e-9));
      expect(plan.timelineNodes.last.sub, contains('制限内'));
    });

    test('全徒歩が予算超過なら途中駅まで歩くハイブリッドを返す', () async {
      final log = <Uri>[];
      final client = _mock(
        transit: shinagawaToTokyo(),
        walkByGoal: {
          '35.681,139.767': _walkResp(92, 7000), // 全徒歩は予算超過
          '35.666,139.758': _walkResp(22, 1800), // origin→新橋 22分
        },
        log: log,
      );

      final plan = await run(client); // 予算30分

      expect(plan.segments, hasLength(2));
      expect(plan.segments[0].type, SegmentType.walk);
      expect(plan.segments[0].minutes, 22);
      expect(plan.segments[0].minutes, greaterThan(20));
      expect(plan.segments[1].type, SegmentType.train);
      expect(plan.segments[1].fromName, '新橋駅');
      expect(plan.segments[1].toName, '東京駅');
      // transit(新橋→東京) = 12 - 5 - (09:09-09:05=4) = 3
      expect(plan.segments[1].minutes, 3);
      expect(plan.totalMin, 25);
      expect(plan.timelineNodes.last.sub, contains('制限内'));
    });

    test('電車最短でも予算超過なら最短（標準経路）を返す', () async {
      final client = _mock(
        transit: shinagawaToTokyo(),
        walkByGoal: {
          '35.681,139.767': _walkResp(92, 7000),
          '35.666,139.758': _walkResp(22, 1800),
        },
      );

      final plan = await run(client, arrivalH: 9, arrivalM: 3); // 予算3分

      // 全徒歩92・ハイブリッド25・標準12 のいずれも予算超過 → 最短=標準12
      expect(plan.totalMin, 12);
      expect(plan.segments, hasLength(2));
      expect(plan.segments[1].line, 'JR山手線');
    });

    test('transit には options=railway_calling_at を付与する', () async {
      final log = <Uri>[];
      final client = _mock(
        transit: shinagawaToTokyo(),
        walkByGoal: {'35.681,139.767': _walkResp(25, 2000)},
        log: log,
      );

      await run(client);

      final transitUri = log.firstWhere(
        (u) => u.path.contains('navitimeProxy'),
      );
      expect(transitUri.queryParameters['options'], 'railway_calling_at');
    });

    test('ハイブリッド候補の評価は上限（6駅）を超えない', () async {
      // 中間駅を8つ持つ経路。予算2分で全て不成立 → 徒歩呼び出しはキャップに従う。
      final calling = <Map<String, dynamic>>[
        _calling(
          'S0',
          35.60,
          139.70,
          '2026-05-22T09:05:00',
          '2026-05-22T09:05:00',
        ),
        for (var i = 1; i <= 8; i++)
          _calling(
            'S$i',
            35.60 + 0.01 * i,
            139.70 + 0.01 * i,
            '2026-05-22T09:${(5 + i).toString().padLeft(2, '0')}:00',
            '2026-05-22T09:${(5 + i).toString().padLeft(2, '0')}:00',
          ),
        _calling(
          '東京駅',
          35.681,
          139.767,
          '2026-05-22T09:14:00',
          '2026-05-22T09:14:00',
        ),
      ];
      final transit = _navi([
        _item([
          _point('出発地'),
          _walkSection(400, 5),
          _point('S0'),
          _trainSection(8000, 9, line: 'L', calling: calling),
          _point('東京駅'),
        ]),
      ]);
      final log = <Uri>[];
      final client = _mock(
        transit: transit,
        defaultWalk: _walkResp(50, 4000), // どの徒歩も予算超過
        log: log,
      );

      await run(client, arrivalH: 9, arrivalM: 2); // 予算2分

      final walkCalls = log
          .where((u) => u.path.contains('navitimeWalkProxy'))
          .length;
      // 全徒歩1回 + ハイブリッド候補キャップ6回 = 7
      expect(walkCalls, 7);
    });

    test('items が空なら ZERO_RESULTS', () async {
      final client = _mock(transit: _navi([]));
      await expectLater(
        () => run(client),
        throwsA(
          isA<RouteException>().having(
            (e) => e.status,
            'status',
            'ZERO_RESULTS',
          ),
        ),
      );
    });

    test('transit が HTTP 非200 は例外', () async {
      final client = _mock(transit: const {}, transitStatus: 500);
      await expectLater(() => run(client), throwsA(isA<RouteException>()));
    });

    test('徒歩 API が落ちても標準経路で継続する', () async {
      // walk は常に 500 を返す → _tryWalk は null。標準経路へ縮退。
      final client = MockClient((req) async {
        if (req.url.path.contains('navitimeWalkProxy')) {
          return _jsonResponse(const {}, 500);
        }
        return _jsonResponse(shinagawaToTokyo(), 200);
      });

      final plan = await run(client);

      expect(plan.totalMin, 12); // 標準経路
      expect(plan.segments, hasLength(2));
    });

    test('目的地座標が無ければ NO_DESTINATION', () async {
      final client = _mock(transit: _navi([]));
      await expectLater(
        () => build(client).plan(
          destination: '東京',
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
      final client = _mock(transit: _navi([]));
      final service = NaviTimeRouteService(client: client, proxyBaseUrl: '');
      await expectLater(
        () => service.plan(
          destination: '東京',
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

    test('dateOffset=1 の出発は翌日の start_time を送る', () async {
      final log = <Uri>[];
      final client = _mock(
        transit: shinagawaToTokyo(),
        walkByGoal: {'35.681,139.767': _walkResp(25, 2000)},
        log: log,
      );

      await build(client).plan(
        destination: '東京',
        destinationLatLng: const GeoPoint(35.681, 139.767),
        departure: const TimeValue(h: 9, m: 0, dateOffset: 1),
        arrival: const TimeValue(h: 11, m: 0, dateOffset: 1),
        origin: const GeoPoint(35.7, 139.75),
      );

      final transitUri = log.firstWhere(
        (u) => u.path.contains('navitimeProxy'),
      );
      expect(transitUri.queryParameters['start_time'], '2026-05-23T09:00:00');
    });
  });
}
