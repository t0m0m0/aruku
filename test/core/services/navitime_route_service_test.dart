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
/// walk は 'start;goal'（座標）をキーに応答を引く。
http.Client _mock({
  required Map<String, dynamic> transit,
  int transitStatus = 200,
  Map<String, Map<String, dynamic>> walk = const {},
  Map<String, dynamic>? defaultWalk,
  List<Uri>? log,
}) => MockClient((req) async {
  log?.add(req.url);
  if (req.url.path.contains('navitimeWalkProxy')) {
    final start = req.url.queryParameters['start'] ?? '';
    final goal = req.url.queryParameters['goal'] ?? '';
    return _jsonResponse(walk['$start;$goal'] ?? defaultWalk ?? _navi([]), 200);
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
        walk: {'35.7,139.75;35.681,139.767': _walkResp(25, 2000)},
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
        walk: {
          '35.7,139.75;35.681,139.767': _walkResp(92, 7000), // 全徒歩は予算超過
          '35.7,139.75;35.666,139.758': _walkResp(22, 1800), // origin→新橋 22分
          '35.681,139.767;35.681,139.767': _walkResp(0, 0), // 東京で降車（徒歩0）
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
      // 乗車(新橋→東京) = 09:12 - 09:09 = 3 分（時刻表の差）
      expect(plan.segments[1].minutes, 3);
      expect(plan.totalMin, 25);
      expect(plan.timelineNodes.last.sub, contains('制限内'));
    });

    test('電車最短でも予算超過なら最短（標準経路）を返す', () async {
      final client = _mock(
        transit: shinagawaToTokyo(),
        walk: {
          '35.7,139.75;35.681,139.767': _walkResp(92, 7000),
          '35.7,139.75;35.666,139.758': _walkResp(22, 1800),
          '35.681,139.767;35.681,139.767': _walkResp(0, 0),
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
        walk: {'35.7,139.75;35.681,139.767': _walkResp(25, 2000)},
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
      // 全徒歩1回 + キャップ6駅 ×(origin→駅 / 駅→goal) = 1 + 12 = 13
      expect(walkCalls, 13);
    });

    test('乗換で距離の大半が2本目の電車にある場合、乗車を後ろ倒しして徒歩を増やす', () async {
      // 出発地→A→(L1)→B→(乗換)→(L2)→C→D。距離の大半は L2。
      // 全徒歩は予算超過だが、C まで歩いて L2 に乗れば予算内で徒歩を最大化できる。
      final transit = _navi([
        _item([
          _point('出発地'),
          _walkSection(250, 3),
          _point('A'),
          _trainSection(
            2000,
            2,
            line: 'L1',
            calling: [
              _calling(
                'A',
                35.52,
                139.52,
                '2026-05-22T09:03:00',
                '2026-05-22T09:03:00',
              ),
              _calling(
                'B',
                35.55,
                139.55,
                '2026-05-22T09:05:00',
                '2026-05-22T09:05:00',
              ),
            ],
          ),
          _point('B'),
          _trainSection(
            20000,
            33,
            line: 'L2',
            calling: [
              _calling(
                'B',
                35.55,
                139.55,
                '2026-05-22T09:07:00',
                '2026-05-22T09:07:00',
              ),
              _calling(
                'C',
                35.6,
                139.6,
                '2026-05-22T09:20:00',
                '2026-05-22T09:20:00',
              ),
              _calling(
                'D',
                35.65,
                139.65,
                '2026-05-22T09:40:00',
                '2026-05-22T09:40:00',
              ),
            ],
          ),
          _point('D'),
        ]),
      ]);
      final client = _mock(
        transit: transit,
        walk: {
          '35.5,139.5;35.65,139.65': _walkResp(200, 16000), // 全徒歩（予算超過）
          '35.5,139.5;35.52,139.52': _walkResp(40, 3000), // origin→A
          '35.5,139.5;35.55,139.55': _walkResp(60, 5000), // origin→B
          '35.5,139.5;35.6,139.6': _walkResp(95, 8000), // origin→C
          '35.52,139.52;35.65,139.65': _walkResp(170, 14000), // A→goal
          '35.55,139.55;35.65,139.65': _walkResp(130, 11000), // B→goal
          '35.6,139.6;35.65,139.65': _walkResp(30, 2500), // C→goal
          '35.65,139.65;35.65,139.65': _walkResp(0, 0), // D で降車（徒歩0）
        },
      );

      // 予算120分。出発地→C まで歩いて(95分) L2 で D へ(20分) = 115分。
      final plan = await build(client).plan(
        destination: '目的地',
        destinationLatLng: const GeoPoint(35.65, 139.65),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 11, m: 0),
        origin: const GeoPoint(35.5, 139.5),
      );

      expect(plan.segments, hasLength(2));
      expect(plan.segments[0].type, SegmentType.walk);
      expect(plan.segments[0].minutes, 95);
      expect(plan.segments[0].toName, 'C');
      expect(plan.segments[1].type, SegmentType.train);
      expect(plan.segments[1].fromName, 'C');
      expect(plan.segments[1].minutes, 20); // 09:40 - 09:20
      expect(plan.segments[1].line, 'L2');
      expect(plan.totalMin, 115);
    });

    test('乗換をまたぐ乗車区間（L1の駅→L2の駅）を単一電車として候補化しない', () async {
      // 出発地→A→(L1: A,B)→B→(乗換)→(L2: B,C,D)→D→目的地。
      // バグ時は A(L1) で乗り C(L2) で降りる「徒歩最大」候補を 1 本の L1 として
      // 生成し、乗換と運賃を隠した誤経路が選ばれてしまう。修正後は同一乗車区間内
      // （C→D）のみが候補化され、正しい単一乗車のハイブリッドが選ばれる。
      final transit = _navi([
        _item([
          _point('出発地'),
          _walkSection(200, 2),
          _point('A'),
          _trainSection(
            2000,
            5,
            line: 'L1',
            calling: [
              _calling(
                'A',
                35.52,
                139.52,
                '2026-05-22T09:05:00',
                '2026-05-22T09:05:00',
              ),
              _calling(
                'B',
                35.55,
                139.55,
                '2026-05-22T09:10:00',
                '2026-05-22T09:10:00',
              ),
            ],
          ),
          _point('B'),
          _trainSection(
            18000,
            18,
            line: 'L2',
            calling: [
              _calling(
                'B',
                35.55,
                139.55,
                '2026-05-22T09:12:00',
                '2026-05-22T09:12:00',
              ),
              _calling(
                'C',
                35.6,
                139.6,
                '2026-05-22T09:20:00',
                '2026-05-22T09:20:00',
              ),
              _calling(
                'D',
                35.65,
                139.65,
                '2026-05-22T09:30:00',
                '2026-05-22T09:30:00',
              ),
            ],
          ),
          _point('D'),
          _walkSection(200, 2),
          _point('目的地'),
        ]),
      ]);
      final client = _mock(
        transit: transit,
        walk: {
          '35.5,139.5;35.66,139.66': _walkResp(200, 16000), // 全徒歩（予算超過）
          '35.5,139.5;35.52,139.52': _walkResp(90, 7000), // origin→A
          '35.5,139.5;35.55,139.55': _walkResp(10, 800), // origin→B
          '35.5,139.5;35.6,139.6': _walkResp(100, 8000), // origin→C
          '35.5,139.5;35.65,139.65': _walkResp(118, 9500), // origin→D
          '35.52,139.52;35.66,139.66': _walkResp(200, 16000), // A→goal
          '35.55,139.55;35.66,139.66': _walkResp(130, 11000), // B→goal
          '35.6,139.6;35.66,139.66': _walkResp(15, 1200), // C→goal
          '35.65,139.65;35.66,139.66': _walkResp(3, 200), // D→goal
        },
      );

      // 予算120分。バグ時の最大徒歩候補は origin→A(90)+A→C(L1,15)+C→goal(15)=120
      //（無効）。修正後は origin→C(100)+C→D(L2,10)+D→goal(3)=113 が選ばれる。
      final plan = await build(client).plan(
        destination: '目的地',
        destinationLatLng: const GeoPoint(35.66, 139.66),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 11, m: 0),
        origin: const GeoPoint(35.5, 139.5),
      );

      expect(plan.segments, hasLength(3));
      expect(plan.segments[0].type, SegmentType.walk);
      expect(plan.segments[0].minutes, 100);
      expect(plan.segments[1].type, SegmentType.train);
      expect(plan.segments[1].fromName, 'C');
      expect(plan.segments[1].toName, 'D');
      expect(plan.segments[1].line, 'L2'); // L1 と誤表示しない
      expect(plan.segments[1].minutes, 10); // 09:30 - 09:20
      expect(plan.segments[2].type, SegmentType.walk);
      expect(plan.segments[2].minutes, 3);
      expect(plan.totalMin, 113);
    });

    test('手前の駅で降りて目的地まで歩く候補で徒歩を増やす', () async {
      // P→M→N の各停。目的地は N から遠い。M で降りて歩く方が徒歩が増える。
      final transit = _navi([
        _item([
          _point('出発地'),
          _walkSection(400, 5),
          _point('P'),
          _trainSection(
            12000,
            30,
            line: 'L',
            calling: [
              _calling(
                'P',
                35.55,
                139.55,
                '2026-05-22T09:05:00',
                '2026-05-22T09:05:00',
              ),
              _calling(
                'M',
                35.62,
                139.62,
                '2026-05-22T09:20:00',
                '2026-05-22T09:20:00',
              ),
              _calling(
                'N',
                35.68,
                139.68,
                '2026-05-22T09:35:00',
                '2026-05-22T09:35:00',
              ),
            ],
          ),
          _point('N'),
          _walkSection(1200, 15),
          _point('目的地'),
        ]),
      ]);
      final client = _mock(
        transit: transit,
        walk: {
          '35.5,139.5;35.78,139.78': _walkResp(200, 16000), // 全徒歩（予算超過）
          '35.5,139.5;35.55,139.55': _walkResp(8, 600), // origin→P
          '35.5,139.5;35.62,139.62': _walkResp(200, 16000), // origin→M（予算超過）
          '35.5,139.5;35.68,139.68': _walkResp(200, 16000), // origin→N（予算超過）
          '35.55,139.55;35.78,139.78': _walkResp(160, 13000), // P→goal
          '35.62,139.62;35.78,139.78': _walkResp(90, 7000), // M→goal
          '35.68,139.68;35.78,139.78': _walkResp(40, 3000), // N→goal
        },
      );

      // 予算120分。P まで歩き(8分) M で降りて(乗車15分) 目的地まで歩く(90分) = 113分。
      final plan = await build(client).plan(
        destination: '目的地',
        destinationLatLng: const GeoPoint(35.78, 139.78),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 11, m: 0),
        origin: const GeoPoint(35.5, 139.5),
      );

      expect(plan.segments, hasLength(3));
      expect(plan.segments[0].type, SegmentType.walk);
      expect(plan.segments[0].minutes, 8);
      expect(plan.segments[1].type, SegmentType.train);
      expect(plan.segments[1].fromName, 'P');
      expect(plan.segments[1].toName, 'M');
      expect(plan.segments[1].minutes, 15); // 09:20 - 09:05
      expect(plan.segments[2].type, SegmentType.walk);
      expect(plan.segments[2].minutes, 90);
      expect(plan.segments[2].toName, '目的地');
      expect(plan.totalMin, 113);
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
        walk: {'35.7,139.75;35.681,139.767': _walkResp(25, 2000)},
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
