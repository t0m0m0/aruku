import 'dart:convert';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/hybrid_route_selector.dart';
import 'package:aruku/core/services/navitime_route_service.dart';
import 'package:aruku/core/services/route_plan_builder.dart';
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

/// 座標のみで発着時刻を持たない calling_at（プロキシ/RapidAPI のデータ欠落を模す）。
Map<String, dynamic> _callingNoTime(String name, double lat, double lon) => {
  'name': name,
  'coord': {'lat': lat, 'lon': lon},
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
  // 実 API では calling_at も fare も transport 配下に入る。
  if (calling != null || fare != null)
    'transport': {'calling_at': ?calling, 'fare': ?fare},
  if (shape != null) 'shape': _shape(shape),
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
        // 全徒歩の直線距離推定（約33分）は予算40分内。確定後に Google で 25分へ上書き。
        walk: {'35.7,139.75;35.681,139.767': _walkResp(25, 2000)},
      );

      final plan = await run(client, arrivalM: 40);

      expect(plan.segments, hasLength(1));
      expect(plan.segments.first.type, SegmentType.walk);
      expect(plan.totalMin, 25);
      expect(plan.walkRatio, closeTo(1.0, 1e-9));
      expect(plan.timelineNodes.last.sub, contains('制限内'));
    });

    test('全徒歩採用時 Google 呼び出しは確定の1区間のみ（選定では呼ばない）', () async {
      final log = <Uri>[];
      final client = _mock(
        transit: shinagawaToTokyo(),
        // 全徒歩の直線距離推定（約33分）は予算40分内 → 全徒歩を採用。
        walk: {'35.7,139.75;35.681,139.767': _walkResp(25, 2000)},
        log: log,
      );

      await run(client, arrivalM: 40);

      final walkCalls = log
          .where((u) => u.path.contains('googleWalkProxy'))
          .length;
      // 選定は直線距離推定で行い Google を呼ばない。確定した全徒歩1区間ぶんのみ。
      expect(walkCalls, 1);
    });

    test('全徒歩が予算超過なら途中駅まで歩くハイブリッドを返す', () async {
      // 目的地(東京)は遠く全徒歩は直線推定でも予算超過。品川を過ぎて新橋まで
      // 歩き(直線推定83分)、新橋→東京を乗車する候補が予算内で徒歩を最大化する。
      // 各駅は経度固定の直線上に配置し推定徒歩時間を緯度差で素直に比較する。
      final transit = _navi([
        _item([
          _point('出発地'),
          _walkSection(2000, 25),
          _point('品川駅'),
          _trainSection(
            6000,
            7,
            line: 'JR山手線',
            stops: 2,
            calling: [
              _calling(
                '品川駅',
                35.62,
                139.75,
                '2026-05-22T09:05:00',
                '2026-05-22T09:05:00',
              ),
              _calling(
                '新橋駅',
                35.66,
                139.75,
                '2026-05-22T09:09:00',
                '2026-05-22T09:09:00',
              ),
              _calling(
                '東京駅',
                35.74,
                139.75,
                '2026-05-22T09:12:00',
                '2026-05-22T09:12:00',
              ),
            ],
          ),
          _point('東京駅'),
        ]),
      ]);
      final client = _mock(
        transit: transit,
        // 確定経路（出発地→新橋）の徒歩を Google で 22分へ上書き。
        walk: {'35.6,139.75;35.66,139.75': _walkResp(22, 1800)},
      );

      final plan = await build(client).plan(
        destination: '東京',
        destinationLatLng: const GeoPoint(35.74, 139.75),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 11, m: 0), // 予算120分
        origin: const GeoPoint(35.60, 139.75),
      );

      expect(plan.segments, hasLength(2));
      expect(plan.segments[0].type, SegmentType.walk);
      expect(plan.segments[0].minutes, 22);
      expect(plan.segments[1].type, SegmentType.train);
      expect(plan.segments[1].fromName, '新橋駅');
      expect(plan.segments[1].toName, '東京駅');
      // 乗車(新橋→東京) = 09:12 - 09:09 = 3 分（時刻表の差）
      expect(plan.segments[1].minutes, 3);
      expect(plan.totalMin, 25);
      expect(plan.timelineNodes.last.sub, contains('制限内'));
    });

    test('徒歩で駅着後、発車までの待ち時間を到着時刻に反映する（#65）', () async {
      // 出発地→A駅(徒歩・確定後5分=9:05着) → A駅 09:15発/B駅 09:30着。
      // 駅着(9:05)から発車(9:15)まで10分待つため、到着は累積分(9:20)ではなく
      // 時刻表どおり 9:30 になる。
      final transit = _navi([
        _item([
          _point('出発地'),
          _walkSection(1100, 14),
          _point('A駅'),
          _trainSection(
            6000,
            15,
            line: '○○線',
            stops: 1,
            calling: [
              _calling(
                'A駅',
                35.51,
                139.50,
                '2026-05-22T09:15:00',
                '2026-05-22T09:15:00',
              ),
              _calling(
                'B駅',
                35.70,
                139.50,
                '2026-05-22T09:30:00',
                '2026-05-22T09:30:00',
              ),
            ],
          ),
          _point('B駅'),
        ]),
      ]);
      final client = _mock(
        transit: transit,
        // 確定経路（出発地→A駅）の徒歩を Google で 5分へ上書き。
        walk: {'35.5,139.5;35.51,139.5': _walkResp(5, 400)},
      );

      final plan = await build(client).plan(
        destination: 'B駅',
        destinationLatLng: const GeoPoint(35.70, 139.50),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 10, m: 0), // 予算60分
        origin: const GeoPoint(35.50, 139.50),
      );

      final train = plan.segments.firstWhere(
        (s) => s.type == SegmentType.train,
      );
      expect(train.depTime, DateTime(2026, 5, 22, 9, 15));
      expect(train.arrTime, DateTime(2026, 5, 22, 9, 30));
      // 待ち時間込みで 9:30 着・総30分（累積分なら 9:20・20分）。
      expect(plan.timelineNodes.last.time, '9:30');
      expect(plan.totalMin, 30);
    });

    test('calling_at の発着時刻が欠落しても座標からハイブリッドを生成し徒歩を最大化する', () async {
      // プロキシ/RapidAPI 由来データは calling_at の時刻が欠けることがある。時刻が
      // 無くても座標があれば乗車時間を距離から概算してハイブリッドを生成し、予算が
      // 余ったまま徒歩最小の標準乗換へ縮退しないことを検証する（#67 再発防止）。
      // 構成は「全徒歩が予算超過なら…ハイブリッドを返す」と同じで calling_at が時刻なし。
      final transit = _navi([
        _item([
          _point('出発地'),
          _walkSection(2000, 25),
          _point('品川駅'),
          _trainSection(
            6000,
            7,
            line: 'JR山手線',
            stops: 2,
            calling: [
              _callingNoTime('品川駅', 35.62, 139.75),
              _callingNoTime('新橋駅', 35.66, 139.75),
              _callingNoTime('東京駅', 35.74, 139.75),
            ],
          ),
          _point('東京駅'),
        ]),
      ]);
      final client = _mock(
        transit: transit,
        // 確定経路（出発地→新橋）の徒歩を Google で 22分へ上書き。
        walk: {'35.6,139.75;35.66,139.75': _walkResp(22, 1800)},
      );

      final plan = await build(client).plan(
        destination: '東京',
        destinationLatLng: const GeoPoint(35.74, 139.75),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 11, m: 0), // 予算120分
        origin: const GeoPoint(35.60, 139.75),
      );

      // 時刻欠落で base==null → ハイブリッド非生成だと標準乗換（品川乗車・徒歩25分）
      // しか残らず予算が大量に余る。修正後は新橋まで歩いて乗るハイブリッドを選ぶ。
      expect(plan.segments, hasLength(2));
      expect(plan.segments[0].type, SegmentType.walk);
      expect(plan.segments[0].minutes, 22);
      expect(plan.segments[1].type, SegmentType.train);
      expect(plan.segments[1].fromName, '新橋駅'); // 品川（徒歩最小）ではない
      expect(plan.segments[1].toName, '東京駅');
      // 時刻が無い区間の乗車時間は停車駅折れ線長 ÷ trainMetersPerMinute で概算する。
      final expectedRide =
          (haversineKm(
                    const GeoPoint(35.66, 139.75),
                    const GeoPoint(35.74, 139.75),
                  ) *
                  1000 /
                  trainMetersPerMinute)
              .round();
      expect(plan.segments[1].minutes, expectedRide);
      expect(plan.totalMin, 22 + expectedRide);
      expect(plan.timelineNodes.last.sub, contains('制限内'));
    });

    test('逆戻り（目的地と逆方向）の item は直進 item があれば採用しない', () async {
      // 出発地(35.50)→目的地(35.70) は北向き。直進 item は北駅(35.60)経由、
      // 逆戻り item は出発地より南の南駅(35.30＝目的地と逆方向)経由。逆戻りは
      // 徒歩が多く（フィルタ無しなら徒歩最大で選ばれてしまう）が、進行方向の
      // 後方へ戻るため除外され、直進 item が採用されることを検証する。
      // calling_at は付けず（ハイブリッド非生成）、駅は前後 point 座標で表す。
      final transit = _navi([
        _item([
          _point('出発地', lat: 35.50, lon: 139.50),
          _walkSection(800, 10),
          _point('北駅', lat: 35.60, lon: 139.50),
          _trainSection(8000, 8, line: 'L'),
          _point('東京駅', lat: 35.70, lon: 139.50),
        ]),
        _item([
          _point('出発地', lat: 35.50, lon: 139.50),
          _walkSection(16000, 30),
          _point('南駅', lat: 35.30, lon: 139.50),
          _trainSection(30000, 8, line: 'L'),
          _point('東京駅', lat: 35.70, lon: 139.50),
        ]),
      ]);
      // 全徒歩(直線約277分)は予算40分超過。確定経路(出発地→北駅)の徒歩を上書き。
      final client = _mock(transit: transit, defaultWalk: _walkResp(10, 800));

      final plan = await build(client).plan(
        destination: '東京',
        destinationLatLng: const GeoPoint(35.70, 139.50),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 9, m: 40), // 予算40分（両 item とも予算内）
        origin: const GeoPoint(35.50, 139.50),
      );

      expect(plan.segments, hasLength(2));
      expect(plan.segments[1].type, SegmentType.train);
      expect(plan.segments[1].fromName, '北駅'); // 南駅(逆戻り)ではない
      expect(plan.totalMin, 18); // 徒歩10 + 乗車8
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

    test('Google 徒歩呼び出しは採用経路の徒歩区間数ぶんのみ（選定では呼ばない）', () async {
      // 中間駅を8つ持つ経路。候補選定（全徒歩・ハイブリッド）は直線距離ベースの
      // 推定で行い Google を呼ばない。Google computeRoutes は確定経路の徒歩区間
      // だけに対して呼ぶ（案A: 13 → 1〜2 回）。
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
          _point('出発地', lat: 35.50, lon: 139.60),
          _walkSection(400, 5),
          _point('S0', lat: 35.60, lon: 139.70),
          _trainSection(8000, 9, line: 'L', calling: calling),
          _point('東京駅', lat: 35.681, lon: 139.767),
        ]),
      ]);
      final log = <Uri>[];
      final client = _mock(
        transit: transit,
        defaultWalk: _walkResp(50, 4000),
        log: log,
      );

      final plan = await run(client, arrivalH: 9, arrivalM: 2); // 予算2分

      final walkCalls = log
          .where((u) => u.path.contains('googleWalkProxy'))
          .length;
      final walkSegments = plan.segments
          .where((s) => s.type == SegmentType.walk)
          .length;
      // 採用経路の徒歩区間数ぶんだけ（≤2）。旧実装の 13 回から削減。
      expect(walkCalls, walkSegments);
      expect(walkCalls, lessThanOrEqualTo(2));
    });

    test('乗換で距離の大半が2本目の電車にある場合、乗車を後ろ倒しして徒歩を増やす', () async {
      // 出発地→A→(L1)→B→(乗換)→(L2)→C→D。距離の大半は L2（C→D が長い）。
      // 全徒歩は遠すぎ予算超過。C まで歩いて L2 で D（=目的地）へ乗る候補が、より
      // 手前で乗る候補が予算超過になる中で徒歩を最大化する。駅は経度固定の直線上。
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
                139.50,
                '2026-05-22T09:03:00',
                '2026-05-22T09:03:00',
              ),
              _calling(
                'B',
                35.55,
                139.50,
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
                139.50,
                '2026-05-22T09:07:00',
                '2026-05-22T09:07:00',
              ),
              _calling(
                'C',
                35.58,
                139.50,
                '2026-05-22T09:20:00',
                '2026-05-22T09:20:00',
              ),
              _calling(
                'D',
                35.70,
                139.50,
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
        // 確定経路（出発地→C）の徒歩だけ Google で 95分へ上書き。
        walk: {'35.5,139.5;35.58,139.5': _walkResp(95, 8000)},
      );

      // 予算150分。出発地→C まで歩き(確定後95分) L2 で D へ(20分) = 115分。
      final plan = await build(client).plan(
        destination: '目的地',
        destinationLatLng: const GeoPoint(35.70, 139.50),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 11, m: 30),
        origin: const GeoPoint(35.50, 139.50),
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
                139.50,
                '2026-05-22T09:05:00',
                '2026-05-22T09:05:00',
              ),
              _calling(
                'B',
                35.55,
                139.50,
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
                139.50,
                '2026-05-22T09:12:00',
                '2026-05-22T09:12:00',
              ),
              _calling(
                'C',
                35.58,
                139.50,
                '2026-05-22T09:20:00',
                '2026-05-22T09:20:00',
              ),
              _calling(
                'D',
                35.62,
                139.50,
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
        // 確定経路（出発地→C, D→目的地）の徒歩だけ Google で上書き。
        walk: {
          '35.5,139.5;35.58,139.5': _walkResp(100, 8000), // origin→C
          '35.62,139.5;35.64,139.5': _walkResp(3, 200), // D→goal
        },
      );

      // 予算150分。バグ時は A(L1)で乗り C(L2)で降りる候補を 1 本の L1 として誤生成
      //（同一乗車区間でないため除外すべき）。正しくは origin→C(100)+C→D(L2,10)
      // +D→goal(3)=113 が選ばれる。駅は経度固定の直線上。
      final plan = await build(client).plan(
        destination: '目的地',
        destinationLatLng: const GeoPoint(35.64, 139.50),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 11, m: 30),
        origin: const GeoPoint(35.50, 139.50),
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
      // 各停車駅を結ぶ折れ線長（直線より長い）で求める。駅は経度を振った
      // ジグザグ配置にして折れ線長 > 直線距離を成り立たせる。
      const x0 = GeoPoint(35.50, 139.50);
      const x1 = GeoPoint(35.53, 139.54);
      const x2 = GeoPoint(35.56, 139.50);
      const x3 = GeoPoint(35.59, 139.54);
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
      // 確定経路の徒歩（出発地→X0, X3→目的地）の値は問わないため Google 応答は
      // 用意しない（推定値のまま）。検証対象は電車区間の折れ線距離。
      final client = _mock(transit: transit);

      // 予算230分。X0 まで歩き X0→X3 を通しで乗り X3 から目的地へ歩く候補だけが
      // 予算内（手前で降りる候補は目的地まで歩きすぎて予算超過）。
      final plan = await build(client).plan(
        destination: '目的地',
        destinationLatLng: const GeoPoint(35.72, 139.54),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 12, m: 50),
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
      // 終点 N まで乗ると目的地まで歩きすぎて予算超過。駅は経度固定の直線上。
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
                35.52,
                139.50,
                '2026-05-22T09:05:00',
                '2026-05-22T09:05:00',
              ),
              _calling(
                'M',
                35.54,
                139.50,
                '2026-05-22T09:20:00',
                '2026-05-22T09:20:00',
              ),
              _calling(
                'N',
                35.60,
                139.50,
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
        // 確定経路（出発地→P, M→目的地）の徒歩だけ Google で上書き。
        walk: {
          '35.5,139.5;35.52,139.5': _walkResp(8, 600), // origin→P
          '35.54,139.5;35.8,139.5': _walkResp(90, 7000), // M→goal
        },
      );

      // 予算410分。P まで歩き(8分) M で降りて(乗車15分) 目的地まで歩く(90分) = 113分。
      final plan = await build(client).plan(
        destination: '目的地',
        destinationLatLng: const GeoPoint(35.80, 139.50),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 15, m: 50),
        origin: const GeoPoint(35.50, 139.50),
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

      final plan = await run(client, arrivalM: 40);

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

      await run(client, arrivalM: 40); // 全徒歩を採用し確定徒歩を Google で引く

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

      final plan = await run(client, arrivalM: 40);

      expect(plan.segments, hasLength(1));
      expect(plan.segments.first.type, SegmentType.walk);
      expect(plan.segments.first.polyline, const [
        GeoPoint(35.7, 139.75),
        GeoPoint(35.681, 139.767),
      ]);
    });

    test('shape が無いハイブリッドの各区間に polyline を合成する', () async {
      // 目的地(東京)は遠く全徒歩は予算超過。新橋まで歩いて乗車するハイブリッドが
      // 選ばれる。shape が無いため徒歩は端点直線、電車は停車駅座標を連結する。
      final transit = _navi([
        _item([
          _point('出発地'),
          _walkSection(2000, 25),
          _point('品川駅'),
          _trainSection(
            6000,
            7,
            line: 'JR山手線',
            stops: 2,
            calling: [
              _calling(
                '品川駅',
                35.62,
                139.75,
                '2026-05-22T09:05:00',
                '2026-05-22T09:05:00',
              ),
              _calling(
                '新橋駅',
                35.66,
                139.75,
                '2026-05-22T09:09:00',
                '2026-05-22T09:09:00',
              ),
              _calling(
                '東京駅',
                35.74,
                139.75,
                '2026-05-22T09:12:00',
                '2026-05-22T09:12:00',
              ),
            ],
          ),
          _point('東京駅'),
        ]),
      ]);
      // shape 無しの Google 応答 → 確定徒歩は端点直線へ縮退。
      final client = _mock(
        transit: transit,
        walk: {'35.6,139.75;35.66,139.75': _walkResp(22, 1800)},
      );

      final plan = await build(client).plan(
        destination: '東京',
        destinationLatLng: const GeoPoint(35.74, 139.75),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 11, m: 0), // 予算120分 → ハイブリッド
        origin: const GeoPoint(35.60, 139.75),
      );

      expect(plan.segments, hasLength(2));
      // 徒歩区間は origin→乗車駅 を直線で結ぶ。
      expect(plan.segments[0].type, SegmentType.walk);
      expect(plan.segments[0].polyline, const [
        GeoPoint(35.60, 139.75),
        GeoPoint(35.66, 139.75),
      ]);
      // 電車区間は停車駅座標(新橋→東京)を連結する。
      expect(plan.segments[1].type, SegmentType.train);
      expect(plan.segments[1].polyline, const [
        GeoPoint(35.66, 139.75),
        GeoPoint(35.74, 139.75),
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
