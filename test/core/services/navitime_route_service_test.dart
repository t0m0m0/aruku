import 'dart:convert';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/hybrid_route_selector.dart';
import 'package:aruku/core/services/navitime_route_service.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_polyline_algorithm/google_polyline_algorithm.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _proxyBaseUrl = 'https://proxy.example.com';

http.Response _jsonResponse(Object body, int status) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status);

Map<String, dynamic> _point(String name, {double? lat, double? lon}) => {
  'type': 'point',
  'name': name,
  if (lat != null && lon != null) 'coord': {'lat': lat, 'lon': lon},
};

/// GeoJSON LineString。NAVITIME は coordinates を [lng, lat] 順で返す。
Map<String, dynamic> _shape(List<List<double>> lngLat) => {
  'type': 'LineString',
  'coordinates': lngLat,
};

Map<String, dynamic> _walkSection(
  int meters,
  int minutes, {
  List<List<double>>? shape,
}) => {
  'type': 'move',
  'move': 'walk',
  'distance': meters,
  'time': minutes,
  if (shape != null) 'shape': _shape(shape),
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
  List<List<double>>? shape,
  Map<String, dynamic>? fare,
}) => {
  'type': 'move',
  'move': 'local_train',
  'distance': meters,
  'time': minutes,
  'line_name': line,
  'stop_count': ?stops,
  if (calling != null) 'transport': {'calling_at': calling},
  if (shape != null) 'shape': _shape(shape),
  'fare': ?fare,
};

Map<String, dynamic> _item(List<Map<String, dynamic>> sections) => {
  'sections': sections,
};

Map<String, dynamic> _navi(List<Map<String, dynamic>> items) => {
  'items': items,
};

/// Google Routes API computeRoutes の徒歩レスポンス。[shape] は [lat, lng] の
/// 座標列で、encodedPolyline へエンコードして格納する（shape 省略時は polyline
/// を返さず、サービスは origin/dest 直線へ縮退する）。
Map<String, dynamic> _walkResp(
  int minutes,
  int meters, {
  List<List<double>>? shape,
}) => {
  'routes': [
    {
      'distanceMeters': meters,
      'duration': '${minutes * 60}s',
      if (shape != null) 'polyline': {'encodedPolyline': encodePolyline(shape)},
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
  if (req.url.path.contains('googleWalkProxy')) {
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

    Future<RoutePlan> planWithFare(Map<String, dynamic> fare) {
      final client = _mock(
        transit: _navi([
          _item([
            _point('出発地'),
            _walkSection(400, 5),
            _point('品川駅'),
            _trainSection(6000, 7, line: 'JR山手線', stops: 2, fare: fare),
            _point('東京駅'),
          ]),
        ]),
        // 全徒歩も区間徒歩も予算超過させ、標準経路（電車区間つき）を返させる。
        defaultWalk: _walkResp(92, 7000),
      );
      return run(client, arrivalH: 9, arrivalM: 3);
    }

    test('電車区間の fare オブジェクトから IC 運賃(unit_48)を優先して取り出す', () async {
      final plan = await planWithFare({'unit_0': 170, 'unit_48': 165});

      final train = plan.segments.firstWhere(
        (s) => s.type == SegmentType.train,
      );
      expect(train.fare, 165);
    });

    test('IC 運賃(unit_48)が無ければ普通運賃(unit_0)へフォールバックする', () async {
      final plan = await planWithFare({'unit_0': 170});

      final train = plan.segments.firstWhere(
        (s) => s.type == SegmentType.train,
      );
      expect(train.fare, 170);
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
          .where((u) => u.path.contains('googleWalkProxy'))
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

    test('途中停車駅を通る乗車区間の距離は停車駅を結ぶ折れ線長で概算する', () async {
      // X0→X1→X2→X3 を通しで乗車。区間距離は始終点の直線ではなく
      // 各停車駅を結ぶ折れ線長（直線より長い）で求める。
      const x0 = GeoPoint(35.5, 139.5);
      const x1 = GeoPoint(35.55, 139.55);
      const x2 = GeoPoint(35.6, 139.6);
      const x3 = GeoPoint(35.65, 139.65);
      final transit = _navi([
        _item([
          _point('出発地'),
          _walkSection(100, 1),
          _point('X0'),
          _trainSection(
            15000,
            10,
            line: 'L',
            calling: [
              _calling(
                'X0',
                x0.lat,
                x0.lng,
                '2026-05-22T09:05:00',
                '2026-05-22T09:05:00',
              ),
              _calling(
                'X1',
                x1.lat,
                x1.lng,
                '2026-05-22T09:08:00',
                '2026-05-22T09:08:00',
              ),
              _calling(
                'X2',
                x2.lat,
                x2.lng,
                '2026-05-22T09:11:00',
                '2026-05-22T09:11:00',
              ),
              _calling(
                'X3',
                x3.lat,
                x3.lng,
                '2026-05-22T09:15:00',
                '2026-05-22T09:15:00',
              ),
            ],
          ),
          _point('X3'),
          _walkSection(100, 1),
          _point('目的地'),
        ]),
      ]);
      final client = _mock(
        transit: transit,
        walk: {
          '35.49,139.49;35.66,139.66': _walkResp(300, 24000), // 全徒歩（予算超過）
          '35.49,139.49;35.5,139.5': _walkResp(100, 8000), // origin→X0（最大）
          '35.49,139.49;35.55,139.55': _walkResp(10, 800),
          '35.49,139.49;35.6,139.6': _walkResp(5, 400),
          '35.49,139.49;35.65,139.65': _walkResp(5, 400),
          '35.5,139.5;35.66,139.66': _walkResp(5, 400),
          '35.55,139.55;35.66,139.66': _walkResp(5, 400),
          '35.6,139.6;35.66,139.66': _walkResp(5, 400),
          '35.65,139.65;35.66,139.66': _walkResp(80, 6000), // X3→goal
        },
      );

      // 予算200分。origin→X0(100)+X0→X3(乗車10)+X3→goal(80)=190 が徒歩最大。
      final plan = await build(client).plan(
        destination: '目的地',
        destinationLatLng: const GeoPoint(35.66, 139.66),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 12, m: 20),
        origin: const GeoPoint(35.49, 139.49),
      );

      expect(plan.segments, hasLength(3));
      final train = plan.segments[1];
      expect(train.type, SegmentType.train);
      expect(train.fromName, 'X0');
      expect(train.toName, 'X3');
      expect(train.stops, 3);

      final polyline =
          haversineKm(x0, x1) + haversineKm(x1, x2) + haversineKm(x2, x3);
      expect(train.km, closeTo(polyline, 1e-9));
      // 折れ線長は始終点の直線距離より長い。
      expect(train.km, greaterThan(haversineKm(x0, x3)));
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

    test('transit セクションの shape を polyline に格納する', () async {
      final transit = _navi([
        _item([
          _point('出発地'),
          _walkSection(
            400,
            5,
            shape: [
              [139.75, 35.7],
              [139.738, 35.628],
            ],
          ),
          _point('品川駅'),
          _trainSection(
            6000,
            7,
            line: 'JR山手線',
            shape: [
              [139.738, 35.628],
              [139.767, 35.681],
            ],
          ),
          _point('東京駅'),
        ]),
      ]);
      // 全徒歩は予算超過にして標準経路（徒歩+電車）を選ばせる。
      final client = _mock(transit: transit, defaultWalk: _walkResp(92, 7000));

      final plan = await run(client, arrivalH: 9, arrivalM: 3);

      expect(plan.segments, hasLength(2));
      expect(plan.segments[0].polyline, hasLength(2));
      expect(plan.segments[0].polyline.first, const GeoPoint(35.7, 139.75));
      expect(plan.segments[1].polyline, hasLength(2));
      expect(plan.segments[1].polyline.last, const GeoPoint(35.681, 139.767));
    });

    test('全徒歩経路に walk レスポンスの shape を polyline に格納する', () async {
      final client = _mock(
        transit: shinagawaToTokyo(),
        walk: {
          '35.7,139.75;35.681,139.767': _walkResp(
            25,
            2000,
            // Google の encodedPolyline は [lat, lng] 順でデコードされる。
            shape: [
              [35.7, 139.75],
              [35.69, 139.76],
              [35.681, 139.767],
            ],
          ),
        },
      );

      final plan = await run(client);

      expect(plan.segments, hasLength(1));
      expect(plan.segments.first.type, SegmentType.walk);
      expect(plan.segments.first.polyline, hasLength(3));
      expect(plan.segments.first.polyline.first, const GeoPoint(35.7, 139.75));
      expect(
        plan.segments.first.polyline.last,
        const GeoPoint(35.681, 139.767),
      );
    });

    test('transit は shape=true、徒歩は googleWalkProxy に start/goal を送る', () async {
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
      expect(transitUri.queryParameters['shape'], 'true');
      final walkUri = log.firstWhere((u) => u.path.contains('googleWalkProxy'));
      expect(walkUri.queryParameters['start'], '35.7,139.75');
      expect(walkUri.queryParameters['goal'], '35.681,139.767');
    });

    test('shape が無い transit は地点座標から polyline を合成する', () async {
      // NaviTime RapidAPI は shape=true でもジオメトリを返さない。地点座標
      // （point の coord と calling_at）から粗い折れ線を合成するフォールバック。
      final transit = _navi([
        _item([
          _point('出発地', lat: 35.7, lon: 139.75),
          _walkSection(400, 5), // shape なし
          _point('品川駅', lat: 35.628, lon: 139.738),
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
          ), // shape なし
          _point('東京駅', lat: 35.681, lon: 139.767),
        ]),
      ]);
      final client = _mock(transit: transit, defaultWalk: _walkResp(92, 7000));

      final plan = await run(client, arrivalH: 9, arrivalM: 3);

      expect(plan.segments, hasLength(2));
      // 徒歩区間は前後の地点座標を直線で結ぶ。
      expect(plan.segments[0].type, SegmentType.walk);
      expect(plan.segments[0].polyline, const [
        GeoPoint(35.7, 139.75),
        GeoPoint(35.628, 139.738),
      ]);
      // 電車区間は停車駅(calling_at)座標を連結する。
      expect(plan.segments[1].type, SegmentType.train);
      expect(plan.segments[1].polyline, const [
        GeoPoint(35.628, 139.738),
        GeoPoint(35.666, 139.758),
        GeoPoint(35.681, 139.767),
      ]);
    });

    test('shape が無い電車は発着時刻が欠落した停車駅も polyline に含める', () async {
      // _callingCoords は _parseCalling と異なり時刻フィルタを掛けない。
      // 中間駅(新橋)の時刻が欠けても座標があれば線を繋ぐことを検証する。
      final transit = _navi([
        _item([
          _point('出発地', lat: 35.7, lon: 139.75),
          _walkSection(400, 5),
          _point('品川駅', lat: 35.628, lon: 139.738),
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
              // 時刻欠落（座標のみ）→ _parseCalling では除外されるが線には残す。
              {
                'name': '新橋駅',
                'coord': {'lat': 35.666, 'lon': 139.758},
              },
              _calling(
                '東京駅',
                35.681,
                139.767,
                '2026-05-22T09:12:00',
                '2026-05-22T09:12:00',
              ),
            ],
          ),
          _point('東京駅', lat: 35.681, lon: 139.767),
        ]),
      ]);
      final client = _mock(transit: transit, defaultWalk: _walkResp(92, 7000));

      final plan = await run(client, arrivalH: 9, arrivalM: 3);

      expect(plan.segments, hasLength(2));
      expect(plan.segments[1].type, SegmentType.train);
      expect(plan.segments[1].polyline, const [
        GeoPoint(35.628, 139.738),
        GeoPoint(35.666, 139.758),
        GeoPoint(35.681, 139.767),
      ]);
    });

    test('shape が無い全徒歩は origin/dest を結ぶ polyline を持つ', () async {
      final client = _mock(
        transit: shinagawaToTokyo(),
        // shape なし・予算内の全徒歩。
        walk: {'35.7,139.75;35.681,139.767': _walkResp(25, 2000)},
      );

      final plan = await run(client);

      expect(plan.segments, hasLength(1));
      expect(plan.segments.first.type, SegmentType.walk);
      expect(plan.segments.first.polyline, const [
        GeoPoint(35.7, 139.75),
        GeoPoint(35.681, 139.767),
      ]);
    });

    test('shape が無いハイブリッドの各区間に polyline を合成する', () async {
      final client = _mock(
        transit: shinagawaToTokyo(),
        walk: {
          '35.7,139.75;35.681,139.767': _walkResp(92, 7000),
          '35.7,139.75;35.666,139.758': _walkResp(22, 1800),
          '35.681,139.767;35.681,139.767': _walkResp(0, 0),
        },
      );

      final plan = await run(client); // 予算30分 → ハイブリッド

      expect(plan.segments, hasLength(2));
      // 徒歩区間は origin→乗車駅 を直線で結ぶ。
      expect(plan.segments[0].type, SegmentType.walk);
      expect(plan.segments[0].polyline, const [
        GeoPoint(35.7, 139.75),
        GeoPoint(35.666, 139.758),
      ]);
      // 電車区間は停車駅座標(新橋→東京)を連結する。
      expect(plan.segments[1].type, SegmentType.train);
      expect(plan.segments[1].polyline, const [
        GeoPoint(35.666, 139.758),
        GeoPoint(35.681, 139.767),
      ]);
    });

    // 出発地・品川・東京（各地点に座標を持つ）標準経路。徒歩 shape は無い。
    // 標準経路選択時の徒歩ジオメトリ上書きを検証するために用いる。
    Map<String, dynamic> shinagawaWithCoords() => _navi([
      _item([
        _point('出発地', lat: 35.7, lon: 139.75),
        _walkSection(400, 5), // shape なし
        _point('品川駅', lat: 35.628, lon: 139.738),
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
              '東京駅',
              35.681,
              139.767,
              '2026-05-22T09:12:00',
              '2026-05-22T09:12:00',
            ),
          ],
        ),
        _point('東京駅', lat: 35.681, lon: 139.767),
      ]),
    ]);

    test('標準経路の徒歩区間を Google の街路ジオメトリで上書きする', () async {
      // 標準乗換が選ばれると徒歩は NAVITIME 由来（shape 無し→端点直線）になる。
      // 表示する1経路ぶんだけ googleWalkProxy を引き直し、街路追従ジオメトリと
      // Google の所要時間・距離へそろえる。
      final client = _mock(
        transit: shinagawaWithCoords(),
        defaultWalk: _walkResp(92, 7000), // 全徒歩・ハイブリッドは予算超過
        walk: {
          // 確定経路の徒歩（出発地→品川駅）の街路ジオメトリ。
          '35.7,139.75;35.628,139.738': _walkResp(
            6,
            480,
            shape: [
              [35.7, 139.75],
              [35.66, 139.744],
              [35.628, 139.738],
            ],
          ),
        },
      );

      final plan = await run(client, arrivalH: 9, arrivalM: 3); // 予算3分 → 標準

      expect(plan.segments, hasLength(2));
      final walk = plan.segments[0];
      expect(walk.type, SegmentType.walk);
      // 端点直線(2点)ではなく Google の街路折れ線(3点)。
      expect(walk.polyline, hasLength(3));
      expect(walk.polyline[1], const GeoPoint(35.66, 139.744));
      // 所要時間・距離も Google 値へそろう。
      expect(walk.minutes, 6);
      expect(walk.km, closeTo(0.48, 1e-9));
      // 電車区間は従来どおり calling_at 座標。
      expect(plan.segments[1].type, SegmentType.train);
      expect(plan.segments[1].polyline, const [
        GeoPoint(35.628, 139.738),
        GeoPoint(35.681, 139.767),
      ]);
    });

    test('徒歩ジオメトリの Google 取得に失敗したら端点直線を保つ', () async {
      // 確定経路の徒歩取得が失敗しても線を消さず、NAVITIME 由来の端点直線と
      // 所要時間を保つ（サイレントに区間を欠落させない）。
      final client = MockClient((req) async {
        if (req.url.path.contains('googleWalkProxy')) {
          final start = req.url.queryParameters['start'];
          final goal = req.url.queryParameters['goal'];
          // 確定経路の徒歩（出発地→品川駅）だけ失敗させる。
          if (start == '35.7,139.75' && goal == '35.628,139.738') {
            return _jsonResponse(const {}, 500);
          }
          return _jsonResponse(_walkResp(92, 7000), 200); // 他は予算超過
        }
        return _jsonResponse(shinagawaWithCoords(), 200);
      });

      final plan = await run(client, arrivalH: 9, arrivalM: 3);

      final walk = plan.segments[0];
      expect(walk.type, SegmentType.walk);
      expect(walk.polyline, const [
        GeoPoint(35.7, 139.75),
        GeoPoint(35.628, 139.738),
      ]);
      expect(walk.minutes, 5); // NAVITIME 値を保持
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
        if (req.url.path.contains('googleWalkProxy')) {
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
