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

/// すべての徒歩リクエストを直線距離 × [detour] の道なり実測で返すモック。
/// 都市の道なり迂回を一様に再現し、「直線推定では予算内・実測で超過」する
/// 徒歩寄り候補が密に並ぶ状況を作る（不具合A・B の再現）。
http.Client _inflatingMock(
  Map<String, dynamic> transit, {
  double detour = 1.4,
}) => MockClient((req) async {
  if (!req.url.path.contains('googleWalkProxy')) {
    return _jsonResponse(transit, 200);
  }
  GeoPoint pt(String? s) {
    final p = (s ?? '').split(',');
    return GeoPoint(double.parse(p[0]), double.parse(p[1]));
  }

  final km = haversineKm(
    pt(req.url.queryParameters['start']),
    pt(req.url.queryParameters['goal']),
  );
  final meters = (km * 1000 * detour).round();
  final minutes = (km * 1000 / walkMetersPerMinute * detour).round();
  return _jsonResponse(_walkResp(minutes, meters), 200);
});

/// 出発側（駅止まりの徒歩）と到着側（プラン目的地で終わる徒歩）で別々の道なり
/// 迂回率を返すモック。origin 周辺と goal 周辺で街路事情が異なる状況を再現し、
/// 側別 α 学習が単一値より実測フロンティア（予算内の徒歩最大）へ当たることを検証する。
/// goal がプラン目的地 [goal] に一致する徒歩を到着側、それ以外を出発側とみなす。
http.Client _sideDetourMock(
  Map<String, dynamic> transit, {
  required GeoPoint goal,
  double originDetour = 1.0,
  double goalDetour = 1.8,
}) => MockClient((req) async {
  if (!req.url.path.contains('googleWalkProxy')) {
    return _jsonResponse(transit, 200);
  }
  GeoPoint pt(String? s) {
    final p = (s ?? '').split(',');
    return GeoPoint(double.parse(p[0]), double.parse(p[1]));
  }

  final start = pt(req.url.queryParameters['start']);
  final dest = pt(req.url.queryParameters['goal']);
  final isGoalSide =
      (dest.lat - goal.lat).abs() < 1e-6 && (dest.lng - goal.lng).abs() < 1e-6;
  final detour = isGoalSide ? goalDetour : originDetour;
  final km = haversineKm(start, dest);
  final meters = (km * 1000 * detour).round();
  final minutes = (km * 1000 / walkMetersPerMinute * detour).round();
  return _jsonResponse(_walkResp(minutes, meters), 200);
});

/// transit を start 座標でルーティングするモック（乗り遅れ再照会の差し替え検証用）。
/// navitimeProxy は 'lat,lng' をキーに transit 応答を引き、無ければ [defaultTransit]。
/// 徒歩は `_mock` 同様 'start;goal' をキーに walk マップ／defaultWalk で応答する。
http.Client _requeryMock({
  required Map<String, Map<String, dynamic>> transitByStart,
  required Map<String, dynamic> defaultTransit,
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
  final start = req.url.queryParameters['start'] ?? '';
  return _jsonResponse(transitByStart[start] ?? defaultTransit, 200);
});

/// 乗車駅 [bName]→降車駅 [aName] の単一電車だけを持つ再照会用 transit（#115）。
/// 乗車駅からの時刻表再照会レスポンスを模す。発着時刻 [dep]/[arr] で乗車時間が決まる
/// （区間の meters/minutes は概算フォールバック用で時刻が揃うこのケースでは未使用）。
Map<String, dynamic> _requeryTrain({
  required String line,
  required String bName,
  required double bLat,
  required String aName,
  required double aLat,
  required String dep,
  required String arr,
  double lon = 139.75,
}) => _navi([
  _item([
    _point(bName),
    _trainSection(
      1,
      1,
      line: line,
      calling: [
        _calling(bName, bLat, lon, dep, dep),
        _calling(aName, aLat, lon, arr, arr),
      ],
    ),
    _point(aName),
  ]),
]);

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

    test('終電後は翌朝始発の電車より「今夜歩ける」全徒歩を返す（#121 原因②）', () async {
      // 01:00 出発・予算60分（締切 2:00）。NAVITIME は翌朝5:30発の電車ルートを返す。
      final transit = _navi([
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
                '2026-06-14T05:30:00',
                '2026-06-14T05:30:00',
              ),
              _calling(
                '新橋駅',
                35.666,
                139.758,
                '2026-06-14T05:34:00',
                '2026-06-14T05:34:00',
              ),
              _calling(
                '東京駅',
                35.681,
                139.767,
                '2026-06-14T06:00:00',
                '2026-06-14T06:00:00',
              ),
            ],
          ),
          _point('東京駅'),
        ]),
      ]);
      final client = _mock(
        transit: transit,
        // 全徒歩は実測80分で予算超過（best-effort）。だが翌朝電車（乗車待ち265分）より
        // 「今夜歩ける」案として優先すべき。
        walk: {'35.7,139.75;35.681,139.767': _walkResp(80, 6400)},
      );

      final plan = await build(client, clock: () => DateTime(2026, 6, 14, 1, 0))
          .plan(
            destination: '東京',
            destinationLatLng: const GeoPoint(35.681, 139.767),
            departure: const TimeValue(h: 1, m: 0),
            arrival: const TimeValue(h: 2, m: 0),
            origin: const GeoPoint(35.7, 139.75),
          );

      // 翌朝5:30発の電車ではなく、今夜歩ける全徒歩を返す。
      expect(plan.segments.where((s) => s.type == SegmentType.train), isEmpty);
      expect(plan.segments.every((s) => s.type == SegmentType.walk), isTrue);
      // 予算超過の best-effort なので「制限内 ✓」は付かない。
      expect(plan.timelineNodes.last.sub, isNot(contains('制限内')));
    });

    test('出発地・目的地名は NAVITIME の start/goal でなく実名を使う', () async {
      // NAVITIME は座標問い合わせだと地点名を "start"/"goal" で返す。アプリが
      // 持つ実際の出発地・目的地名（originName / destination）で上書きする。
      final transit = _navi([
        _item([
          _point('start'),
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
                '東京駅',
                35.681,
                139.767,
                '2026-05-22T09:12:00',
                '2026-05-22T09:12:00',
              ),
            ],
          ),
          _point('goal'),
        ]),
      ]);
      final client = _mock(transit: transit);

      final plan = await build(client).plan(
        destination: '東京駅',
        destinationLatLng: const GeoPoint(35.681, 139.767),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 9, m: 30),
        origin: const GeoPoint(35.7, 139.75),
        originName: '自宅',
      );

      expect(plan.from, '自宅');
      expect(plan.to, '東京駅');
      expect(plan.timelineNodes.first.place, '自宅');
      expect(plan.timelineNodes.last.place, '東京駅');
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

    test('密な停車駅で全徒歩が推定内・実測超過でも予算内の徒歩最大ルートを返す（不具合A・B）', () async {
      // 実機再現: 直線推定では全徒歩が予算内だが Google 実測（道なり1.4倍）で超過する。
      // 乗降点が密だと「推定内・実測超過」の徒歩寄り候補が試行上限を超えて並び、
      // 旧実装は使い切ると最初の選定＝全徒歩（遅刻）をそのまま返していた。修正後は
      // 実測の迂回率を学習し、予算内で歩けるだけ歩くハイブリッドへ収束する。
      //
      // origin(35.50)→goal(35.70) は直線約22.2km・推定278分。予算345分なら推定では
      // 全徒歩が入るが実測389分で超過。経度固定の直線上に10駅(時刻なし)を並べる。
      final lats = <double>[
        35.52,
        35.54,
        35.56,
        35.58,
        35.60,
        35.62,
        35.64,
        35.66,
        35.68,
        35.695,
      ];
      final transit = _navi([
        _item([
          _point('出発地'),
          _walkSection(2700, 34),
          _point('S0'),
          _trainSection(
            20000,
            25,
            line: 'L',
            calling: [
              for (var i = 0; i < lats.length; i++)
                _callingNoTime('S$i', lats[i], 139.50),
            ],
          ),
          _point('S9'),
          _walkSection(600, 7),
          _point('目的地'),
        ]),
      ]);
      final client = _inflatingMock(transit);

      final plan = await build(client).plan(
        destination: '目的地',
        destinationLatLng: const GeoPoint(35.70, 139.50),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 14, m: 45), // 予算345分
        origin: const GeoPoint(35.50, 139.50),
      );

      // 旧実装は全徒歩(1区間・実測約389分)を返し予算超過。修正後は予算内に収め、
      // 鉄道を挟んで徒歩を最大化する（全徒歩でも徒歩最小の標準乗換でもない）。
      expect(plan.totalMin, lessThanOrEqualTo(345));
      expect(
        plan.segments.where((s) => s.type == SegmentType.train),
        isNotEmpty,
      );
      final walkMin = plan.segments
          .where((s) => s.type == SegmentType.walk)
          .fold<int>(0, (a, s) => a + s.minutes);
      expect(walkMin, greaterThan(150));
      expect(plan.walkRatio, greaterThan(0.5));
      expect(plan.timelineNodes.last.sub, contains('制限内'));
    });

    test('出発側と到着側で迂回率が非対称なら安い出発側を長く歩く候補へ収束する（#117）', () async {
      // origin(35.50)→goal(35.70) の直線上に駅を並べ、出発側の街路は素直（×1.0）・
      // 到着側は迂回が大きい（×1.8）非対称環境を再現する。安い出発側を目一杯歩いて
      // goal 近傍の駅まで行き、到着側はわずかに歩く候補（≒徒歩最大）が予算内に収まる。
      //
      // 単一迂回率だと全徒歩の実測（到着側1.8の影響を全体へ）から学んだ大きな α を
      // 出発側にも掛けてしまい、出発側を長く歩く候補を過小評価して低徒歩へ縮退する。
      // 側別 α なら出発側の安さを保ったまま徒歩最大候補を選べる。
      final lats = <double>[35.52, 35.55, 35.58, 35.61, 35.64, 35.67, 35.695];
      final transit = _navi([
        _item([
          _point('出発地'),
          _walkSection(2200, 28),
          _point('S0'),
          _trainSection(
            19000,
            38,
            line: 'L',
            calling: [
              for (var i = 0; i < lats.length; i++)
                _callingNoTime('S$i', lats[i], 139.50),
            ],
          ),
          _point('S6'),
          _walkSection(600, 7),
          _point('目的地'),
        ]),
      ]);
      const goal = GeoPoint(35.70, 139.50);
      final client = _sideDetourMock(transit, goal: goal);

      final plan = await build(client).plan(
        destination: '目的地',
        destinationLatLng: goal,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 13, m: 40), // 予算280分
        origin: const GeoPoint(35.50, 139.50),
      );

      expect(plan.totalMin, lessThanOrEqualTo(280));
      expect(
        plan.segments.where((s) => s.type == SegmentType.train),
        isNotEmpty,
      );
      // 出発側（安い×1.0）を長く歩く候補。単一迂回率の縮退（徒歩≒145分）では届かない。
      final walkMin = plan.segments
          .where((s) => s.type == SegmentType.walk)
          .fold<int>(0, (a, s) => a + s.minutes);
      expect(walkMin, greaterThan(200));
      expect(plan.timelineNodes.last.sub, contains('制限内'));
    });

    test('到着側の迂回率が異常に大きく（>2.0）てもクランプで選定順が破綻しない（#117）', () async {
      // 到着側の街路が極端に迂回する（×2.5）異常データを再現する。学習する α は
      // [1.0, 2.0] にクランプされ、外れ値が選定順を壊さない。乗車駅を出発地寄りに
      // 固めて「到着側を長く歩く徒歩最大候補」を先に実測させ、クランプ経路を必ず通す。
      // 最終的には到着徒歩の短い予算内候補へ収束する（best-effort へ縮退しない）。
      final transit = _navi([
        _item([
          _point('出発地', lat: 35.50, lon: 139.50),
          _walkSection(2220, 28),
          _point('S0', lat: 35.52, lon: 139.50),
          _trainSection(
            18900,
            38,
            line: 'L',
            calling: [
              _callingNoTime('S0', 35.52, 139.50),
              _callingNoTime('S1', 35.54, 139.50),
              _callingNoTime('S2', 35.69, 139.50),
            ],
          ),
          _point('S2', lat: 35.69, lon: 139.50),
          _walkSection(1110, 14),
          _point('目的地', lat: 35.70, lon: 139.50),
        ]),
      ]);
      const goal = GeoPoint(35.70, 139.50);
      final client = _sideDetourMock(transit, goal: goal, goalDetour: 2.5);

      final plan = await build(client).plan(
        destination: '目的地',
        destinationLatLng: goal,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 14, m: 0), // 予算300分
        origin: const GeoPoint(35.50, 139.50),
      );

      expect(plan.totalMin, lessThanOrEqualTo(300));
      expect(
        plan.segments.where((s) => s.type == SegmentType.train),
        isNotEmpty,
      );
      expect(plan.timelineNodes.last.sub, contains('制限内'));
    });

    test('α補正では超過に見えても実測で予算内なら除外せずその候補を返す（#117）', () async {
      // 不変条件「除外は実測のみ・推定は順序のみ」の検証。出発側の一部レッグが実測で
      // 大きく超過し α を 2.0 まで押し上げるが、別レッグが安い候補は α 補正後の見積もりで
      // 予算超過に見える。それでも pool から外さず、実測（楽観評価）で予算内ならその候補を
      // 返す（偽陰性を作らない）。座標ごとに実測徒歩を固定して挙動を一意にする。
      final transit = _navi([
        _item([
          _point('出発地', lat: 35.50, lon: 139.50),
          _walkSection(5560, 69),
          _point('S0', lat: 35.55, lon: 139.50),
          _trainSection(
            15570,
            31,
            line: 'L',
            calling: [
              _callingNoTime('S0', 35.55, 139.50),
              _callingNoTime('S1', 35.60, 139.50),
              _callingNoTime('S2', 35.65, 139.50),
              _callingNoTime('S3', 35.69, 139.50),
            ],
          ),
          _point('S3', lat: 35.69, lon: 139.50),
          _walkSection(1110, 14),
          _point('目的地', lat: 35.70, lon: 139.50),
        ]),
      ]);
      final client = _mock(
        transit: transit,
        walk: {
          // 出発側 S1 乗車の徒歩は実測で 2.0 倍（×2）に膨らみ α を押し上げる。
          '35.5,139.5;35.6,139.5': _walkResp(278, 22240),
          // 安い出発側 S0 乗車・到着側 S3 降車は実測 ≒ 直線推定（迂回なし）。
          '35.5,139.5;35.55,139.5': _walkResp(69, 5560),
          '35.69,139.5;35.7,139.5': _walkResp(14, 1110),
        },
        // 想定外レッグが来たら過大値で返し、誤って予算内に見えないようにする。
        defaultWalk: _walkResp(999, 80000),
      );

      final plan = await build(client).plan(
        destination: '目的地',
        destinationLatLng: const GeoPoint(35.70, 139.50),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 12, m: 0), // 予算180分
        origin: const GeoPoint(35.50, 139.50),
      );

      // S1 乗車の実測超過で α=2.0 を学習後、S0 乗車・S3 降車候補は補正見積もりで
      // 183分（>180）に見えるが、実測は114分で予算内。除外されず制限内で返る。
      expect(plan.totalMin, lessThanOrEqualTo(180));
      expect(
        plan.segments.where((s) => s.type == SegmentType.train),
        isNotEmpty,
      );
      expect(plan.timelineNodes.last.sub, contains('制限内'));
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
      // 実測徒歩22分で新橋着 09:22 は基準の 09:09 発に乗り遅れる。乗車駅 新橋からの
      // 再照会で 09:22 発・09:25 着の実在列車（乗車3分）が見つかり予算内で確定する（#115）。
      final client = _requeryMock(
        defaultTransit: transit,
        transitByStart: {
          '35.66,139.75': _requeryTrain(
            line: 'JR山手線',
            bName: '新橋駅',
            bLat: 35.66,
            aName: '東京駅',
            aLat: 35.74,
            dep: '2026-05-22T09:22:00',
            arr: '2026-05-22T09:25:00',
          ),
        },
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
      // 乗車(新橋→東京) = 再照会列車 09:25 - 09:22 = 3 分。
      expect(plan.segments[1].minutes, 3);
      expect(plan.totalMin, 25);
      expect(plan.timelineNodes.last.sub, contains('制限内'));
    });

    test('全徒歩が直線推定では予算内でも Google実測で超過するなら予算内の代替を返す', () async {
      // 不具合B: 予算ゲートが直線推定の全徒歩時間で「間に合う」と誤判定し、
      // ハイブリッド/鉄道との比較を打ち切って全徒歩を確定 → 確定後に Google の
      // 道なり実測で膨らみ予算超過、という遅刻ルートを返していた。間に合う鉄道/
      // ハイブリッドが在る限り、徒歩を短くしてでも予算内の候補を返すべき。
      //
      // origin(35.60)→goal(35.70) 直線約11.1km。全徒歩の直線推定は約139分で
      // 予算150分内だが、Google 実測は170分で超過する。経度固定の直線上に駅を
      // 置き、間に合う鉄道（P0 09:08発→P3 09:20着）を用意する。
      final transit = _navi([
        _item([
          _point('出発地'),
          _walkSection(600, 7),
          _point('P0'),
          _trainSection(
            9000,
            12,
            line: 'テスト線',
            stops: 3,
            calling: [
              _calling(
                'P0',
                35.605,
                139.75,
                '2026-05-22T09:08:00',
                '2026-05-22T09:08:00',
              ),
              _calling(
                'P1',
                35.64,
                139.75,
                '2026-05-22T09:12:00',
                '2026-05-22T09:12:00',
              ),
              _calling(
                'P2',
                35.68,
                139.75,
                '2026-05-22T09:16:00',
                '2026-05-22T09:16:00',
              ),
              _calling(
                'P3',
                35.695,
                139.75,
                '2026-05-22T09:20:00',
                '2026-05-22T09:20:00',
              ),
            ],
          ),
          _point('P3'),
          _walkSection(600, 7),
          _point('目的地'),
        ]),
      ]);
      final client = _mock(
        transit: transit,
        // 全徒歩(origin→goal) は直線推定139分に対し Google 実測170分で予算超過。
        walk: {'35.6,139.75;35.7,139.75': _walkResp(170, 13600)},
      );

      final plan = await build(client).plan(
        destination: '目的地',
        destinationLatLng: const GeoPoint(35.70, 139.75),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 11, m: 30), // 予算150分
        origin: const GeoPoint(35.60, 139.75),
      );

      // 全徒歩(170分)で超過させず、予算150分内の候補を返す。
      expect(plan.totalMin, lessThanOrEqualTo(150));
      expect(plan.timelineNodes.last.sub, contains('制限内'));
    });

    // 乗り遅れ再照会（#115）の基準シナリオ。経度固定の直線上に origin→P0→P1→P2 を
    // 置き、徒歩最大化では P1 まで歩いて乗車する候補が選ばれる。基準時刻表では P1 は
    // 09:08 発だが、実測徒歩で 09:30 着＝乗り遅れる。乗車駅 P1 からの時刻表を再照会して
    // 実在列車で再判定する。P2(35.7) は目的地に一致し降車後の徒歩は生じない。
    Map<String, dynamic> missedTrainBase() => _navi([
      _item([
        _point('出発地'),
        _walkSection(800, 10),
        _point('P0'),
        _trainSection(
          18000,
          20,
          line: 'L',
          calling: [
            _calling(
              'P0',
              35.52,
              139.75,
              '2026-05-22T09:05:00',
              '2026-05-22T09:05:00',
            ),
            _calling(
              'P1',
              35.55,
              139.75,
              '2026-05-22T09:08:00',
              '2026-05-22T09:08:00',
            ),
            _calling(
              'P2',
              35.70,
              139.75,
              '2026-05-22T09:25:00',
              '2026-05-22T09:25:00',
            ),
          ],
        ),
        _point('P2'),
      ]),
    ]);

    test('乗り遅れ→再照会した実在列車でも予算内ならその実時刻で確定する（#115）', () async {
      // P1 まで歩いて 09:30 着（基準09:08発に乗り遅れ）。乗車駅 P1 からの再照会で
      // 09:31 発・09:48 着の実在列車が見つかり、予算内なのでその実時刻で確定する。
      final log = <Uri>[];
      final client = _requeryMock(
        transitByStart: {
          // P1(35.55) 乗車駅からの再照会＝09:31発の実在列車。
          '35.55,139.75': _navi([
            _item([
              _point('P1'),
              _trainSection(
                15000,
                17,
                line: 'L',
                calling: [
                  _calling(
                    'P1',
                    35.55,
                    139.75,
                    '2026-05-22T09:31:00',
                    '2026-05-22T09:31:00',
                  ),
                  _calling(
                    'P2',
                    35.70,
                    139.75,
                    '2026-05-22T09:48:00',
                    '2026-05-22T09:48:00',
                  ),
                ],
              ),
              _point('P2'),
            ]),
          ]),
        },
        defaultTransit: missedTrainBase(),
        // P1 まで実測30分（基準09:08発に乗り遅れ）。
        walk: {'35.5,139.75;35.55,139.75': _walkResp(30, 2400)},
        defaultWalk: _walkResp(25, 2000),
        log: log,
      );

      final plan = await build(client).plan(
        destination: 'P2',
        destinationLatLng: const GeoPoint(35.70, 139.75),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 11, m: 0), // 予算120分
        origin: const GeoPoint(35.50, 139.75),
      );

      final train = plan.segments.firstWhere(
        (s) => s.type == SegmentType.train,
      );
      expect(train.fromName, 'P1');
      expect(train.toName, 'P2');
      // 基準の 09:08 でなく再照会した実在列車 09:31 発・09:48 着。
      expect(train.depTime, DateTime(2026, 5, 22, 9, 31));
      expect(train.arrTime, DateTime(2026, 5, 22, 9, 48));
      // 徒歩30分(09:30着)→09:31発→09:48着 = 48分。駅到着前に発車する列車は出さない。
      expect(plan.totalMin, 48);
      expect(plan.timelineNodes.last.sub, contains('制限内'));
    });

    test('乗り遅れ→再照会した次列車が予算超過なら予算内の代替へフォールバックする（#115）', () async {
      // P1 乗車は再照会の次列車が 10:00発・11:30着で予算120分を超過。より歩かない
      // P0 乗車の候補へフォールバックし、P0 からの再照会(09:26発)で予算内に収める。
      final client = _requeryMock(
        transitByStart: {
          // P1 からの次列車は遅く予算超過。
          '35.55,139.75': _navi([
            _item([
              _point('P1'),
              _trainSection(
                15000,
                90,
                line: 'L',
                calling: [
                  _calling(
                    'P1',
                    35.55,
                    139.75,
                    '2026-05-22T10:00:00',
                    '2026-05-22T10:00:00',
                  ),
                  _calling(
                    'P2',
                    35.70,
                    139.75,
                    '2026-05-22T11:30:00',
                    '2026-05-22T11:30:00',
                  ),
                ],
              ),
              _point('P2'),
            ]),
          ]),
          // P0(35.52) からの再照会＝09:26発の実在列車（予算内）。
          '35.52,139.75': _navi([
            _item([
              _point('P0'),
              _trainSection(
                18000,
                20,
                line: 'L',
                calling: [
                  _calling(
                    'P0',
                    35.52,
                    139.75,
                    '2026-05-22T09:26:00',
                    '2026-05-22T09:26:00',
                  ),
                  _calling(
                    'P2',
                    35.70,
                    139.75,
                    '2026-05-22T09:46:00',
                    '2026-05-22T09:46:00',
                  ),
                ],
              ),
              _point('P2'),
            ]),
          ]),
        },
        defaultTransit: missedTrainBase(),
        walk: {
          '35.5,139.75;35.55,139.75': _walkResp(30, 2400), // origin→P1 実測30分
          '35.5,139.75;35.52,139.75': _walkResp(25, 2000), // origin→P0 実測25分
        },
        defaultWalk: _walkResp(25, 2000),
      );

      final plan = await build(client).plan(
        destination: 'P2',
        destinationLatLng: const GeoPoint(35.70, 139.75),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 11, m: 0), // 予算120分
        origin: const GeoPoint(35.50, 139.75),
      );

      final train = plan.segments.firstWhere(
        (s) => s.type == SegmentType.train,
      );
      // 予算超過の P1 乗車でなく、より歩かない P0 乗車へフォールバック。
      expect(train.fromName, 'P0');
      expect(train.depTime, DateTime(2026, 5, 22, 9, 26));
      expect(plan.totalMin, lessThanOrEqualTo(120));
      // 徒歩25分(09:25着)→09:26発→09:46着 = 46分。
      expect(plan.totalMin, 46);
      expect(plan.timelineNodes.last.sub, contains('制限内'));
    });

    test('乗り遅れの無い経路では NAVITIME 再照会が発生しない（#115）', () async {
      // Q まで歩いて 09:30 着、列車は 09:40 発（10分待ち）で乗り遅れない。再照会せず
      // 基準の時刻表のまま確定する。navitimeProxy は初回の1回だけ呼ばれる。
      final log = <Uri>[];
      final client = _requeryMock(
        transitByStart: const {},
        defaultTransit: _navi([
          _item([
            _point('出発地'),
            _walkSection(800, 10),
            _point('Q'),
            _trainSection(
              15000,
              15,
              line: 'L',
              calling: [
                _calling(
                  'Q',
                  35.55,
                  139.75,
                  '2026-05-22T09:40:00',
                  '2026-05-22T09:40:00',
                ),
                _calling(
                  'R',
                  35.70,
                  139.75,
                  '2026-05-22T09:55:00',
                  '2026-05-22T09:55:00',
                ),
              ],
            ),
            _point('R'),
          ]),
        ]),
        walk: {'35.5,139.75;35.55,139.75': _walkResp(30, 2400)}, // Q まで実測30分
        defaultWalk: _walkResp(25, 2000),
        log: log,
      );

      final plan = await build(client).plan(
        destination: 'R',
        destinationLatLng: const GeoPoint(35.70, 139.75),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 10, m: 40), // 予算100分
        origin: const GeoPoint(35.50, 139.75),
      );

      final train = plan.segments.firstWhere(
        (s) => s.type == SegmentType.train,
      );
      expect(train.fromName, 'Q');
      // 09:40発・09:55着（基準のまま）。徒歩30分(09:30着)→10分待ち→09:55着=55分。
      expect(train.depTime, DateTime(2026, 5, 22, 9, 40));
      expect(plan.totalMin, 55);
      final naviCalls = log
          .where((u) => u.path.contains('navitimeProxy'))
          .length;
      expect(naviCalls, 1); // 乗り遅れ無し＝再照会ゼロ
    });

    test('サンプル上限を超える停車駅でも飛ばさず徒歩最大の乗車駅を選ぶ（不具合A-b）', () async {
      // 不具合A-b: ハイブリッドの乗降点が _maxHybridCandidates=6 駅サンプルに
      // 制限され、6駅に入らない停車駅で乗車する徒歩最大候補を取りこぼしていた。
      //
      // 7駅(P0..P6)を、出発地寄りに密集(P0..P3)→急行で長距離ジャンプ(P3→P4)→
      // 目的地寄りに密集(P4..P6) と非一様に配置する。6駅サンプリングは index3(=P3)
      // を飛ばす（{0,1,2,4,5,6} を抽出）。徒歩を最大化するには「急行に乗る直前の
      // P3 まで目一杯歩いて乗車→P4 で降りて目的地まで歩く」のが最適だが、P3 が
      // 候補に無いと一つ手前の P2 までしか歩けず徒歩を取りこぼす。急行区間は徒歩だと
      // 予算超過のため必ず乗る必要があり、乗車駅の選択が徒歩量を直接左右する。
      List<Map<String, dynamic>> calling() => [
        for (final (name, lat, t) in const [
          ('P0', 35.502, '09:05'),
          ('P1', 35.505, '09:06'),
          ('P2', 35.508, '09:07'),
          ('P3', 35.511, '09:08'), // 急行に乗る直前（サンプルで飛ばされる index3）
          ('P4', 35.551, '09:11'), // 急行で一気にジャンプ
          ('P5', 35.554, '09:12'),
          ('P6', 35.557, '09:13'),
        ])
          _calling(name, lat, 139.70, '2026-05-22T$t:00', '2026-05-22T$t:00'),
      ];
      final transit = _navi([
        _item([
          _point('出発地'),
          _walkSection(220, 3),
          _point('P0'),
          _trainSection(6100, 8, line: 'L', calling: calling()),
          _point('P6'),
          _walkSection(330, 4),
          _point('目的地'),
        ]),
      ]);
      // 推定徒歩15分で P3 着 09:15 は基準 09:08 発に乗り遅れ。乗車駅 P3 からの再照会で
      // 実在列車（09:20発・09:25着）に差し替えても予算内（#115）。
      final client = _requeryMock(
        defaultTransit: transit,
        transitByStart: {
          '35.511,139.7': _requeryTrain(
            line: 'L',
            bName: 'P3',
            bLat: 35.511,
            aName: 'P6',
            aLat: 35.557,
            dep: '2026-05-22T09:20:00',
            arr: '2026-05-22T09:25:00',
            lon: 139.70,
          ),
        },
      );

      final plan = await build(client).plan(
        destination: '目的地',
        destinationLatLng: const GeoPoint(35.560, 139.70),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 9, m: 35), // 予算35分
        origin: const GeoPoint(35.500, 139.70),
      );

      // 6駅サンプルでは飛ばされる P3 で乗車する候補を選び、徒歩を最大化する
      // （サンプル上限のままだと一つ手前の P2 乗車になり徒歩を取りこぼす）。
      final train = plan.segments.firstWhere(
        (s) => s.type == SegmentType.train,
      );
      expect(train.fromName, 'P3');
      expect(plan.totalMin, lessThanOrEqualTo(35));
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

    test('ハイブリッド区間の運賃をセクション運賃から乗車距離で按分する', () async {
      // 途中駅(新橋)まで歩いて乗るハイブリッドは、元セクション全体(品川→東京)の
      // 運賃 165 円をそのまま使うと過大になる。乗車距離(新橋→東京)で按分する。
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
            fare: {'unit_48': 165},
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
        walk: {'35.6,139.75;35.66,139.75': _walkResp(22, 1800)},
      );

      final plan = await build(client).plan(
        destination: '東京',
        destinationLatLng: const GeoPoint(35.74, 139.75),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 11, m: 0),
        origin: const GeoPoint(35.60, 139.75),
      );

      expect(plan.segments, hasLength(2));
      final train = plan.segments[1];
      expect(train.type, SegmentType.train);
      expect(train.fromName, '新橋駅'); // 途中駅から乗車
      expect(train.toName, '東京駅');
      // 乗車(新橋→東京)km ÷ セクション全体(品川→新橋→東京)km で 165 円を按分。
      final rideKm = haversineKm(
        const GeoPoint(35.66, 139.75),
        const GeoPoint(35.74, 139.75),
      );
      final fullKm =
          haversineKm(
            const GeoPoint(35.62, 139.75),
            const GeoPoint(35.66, 139.75),
          ) +
          rideKm;
      expect(train.fare, (165 * rideKm / fullKm).round());
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
      // 実測95分で C 着 10:35 は基準 09:20 発に乗り遅れ。乗車駅 C からの再照会で
      // 10:35 発・10:55 着の実在 L2 列車（乗車20分）に差し替えて予算内で確定する（#115）。
      final client = _requeryMock(
        defaultTransit: transit,
        transitByStart: {
          '35.58,139.5': _requeryTrain(
            line: 'L2',
            bName: 'C',
            bLat: 35.58,
            aName: 'D',
            aLat: 35.70,
            dep: '2026-05-22T10:35:00',
            arr: '2026-05-22T10:55:00',
            lon: 139.50,
          ),
        },
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
      // 実測100分で C 着 10:40 は基準 09:20 発に乗り遅れ。乗車駅 C からの再照会で
      // 10:40 発・10:50 着の実在 L2 列車（乗車10分）に差し替える（#115）。
      final client = _requeryMock(
        defaultTransit: transit,
        transitByStart: {
          '35.58,139.5': _requeryTrain(
            line: 'L2',
            bName: 'C',
            bLat: 35.58,
            aName: 'D',
            aLat: 35.62,
            dep: '2026-05-22T10:40:00',
            arr: '2026-05-22T10:50:00',
            lon: 139.50,
          ),
        },
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
      // 用意しない（推定値のまま）。検証対象は電車区間の折れ線距離。推定徒歩18分で
      // X0 着 09:18 は基準 09:05 発に乗り遅れ、乗車駅 X0 からの再照会で実在列車に
      // 差し替える（#115）。差し替えは発着時刻のみで polyline（折れ線距離）は保つ。
      final client = _requeryMock(
        defaultTransit: transit,
        transitByStart: {
          '35.5,139.5': _navi([
            _item([
              _point('X0'),
              _trainSection(
                1,
                1,
                line: 'L',
                calling: [
                  _calling(
                    'X0',
                    x0.lat,
                    x0.lng,
                    '2026-05-22T09:18:00',
                    '2026-05-22T09:18:00',
                  ),
                  _calling(
                    'X3',
                    x3.lat,
                    x3.lng,
                    '2026-05-22T09:28:00',
                    '2026-05-22T09:28:00',
                  ),
                ],
              ),
              _point('X3'),
            ]),
          ]),
        },
      );

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
      // 実測8分で P 着 09:08 は基準 09:05 発に僅かに乗り遅れ。乗車駅 P からの再照会で
      // 09:08 発・09:23 着の実在列車（乗車15分）に差し替える（#115）。
      final client = _requeryMock(
        defaultTransit: transit,
        transitByStart: {
          '35.52,139.5': _requeryTrain(
            line: 'L',
            bName: 'P',
            bLat: 35.52,
            aName: 'M',
            aLat: 35.54,
            dep: '2026-05-22T09:08:00',
            arr: '2026-05-22T09:23:00',
            lon: 139.50,
          ),
        },
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
      // shape 無しの Google 応答 → 確定徒歩は端点直線へ縮退。実測22分で新橋着 09:22 は
      // 基準09:09発に乗り遅れ、乗車駅 新橋からの再照会で実在列車に差し替える（#115）。
      final client = _requeryMock(
        defaultTransit: transit,
        transitByStart: {
          '35.66,139.75': _requeryTrain(
            line: 'JR山手線',
            bName: '新橋駅',
            bLat: 35.66,
            aName: '東京駅',
            aLat: 35.74,
            dep: '2026-05-22T09:22:00',
            arr: '2026-05-22T09:25:00',
          ),
        },
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

    // #116: 徒歩実測をレッグ単位（start/goal 座標ペア）で plan() スコープに
    // キャッシュし、選び直しループの重複コールを排除する。

    // 密な停車駅の直線上経路（出発地→S0..S9→目的地）。再選定を誘発するための共通土台。
    final cacheLats = <double>[
      35.52, 35.54, 35.56, 35.58, 35.60, //
      35.62, 35.64, 35.66, 35.68, 35.695,
    ];
    Map<String, dynamic> cacheTransit() => _navi([
      _item([
        _point('出発地'),
        _walkSection(2700, 34),
        _point('S0'),
        _trainSection(
          20000,
          25,
          line: 'L',
          calling: [
            for (var i = 0; i < cacheLats.length; i++)
              _callingNoTime('S$i', cacheLats[i], 139.50),
          ],
        ),
        _point('S9'),
        _walkSection(600, 7),
        _point('目的地'),
      ]),
    ]);

    /// 非均一 detour（目的地側1.9・出発地側1.1）で実測する徒歩モック。側別の迂回率
    /// 学習（#117）の下で確定が選び直され、隣接候補が片側の徒歩レッグを共有する状況を
    /// 作る。[failPair] に一致する start;goal は失敗（routes 空）を返す。
    /// [log] に全リクエスト URL を記録する。
    http.Client cacheMock({List<Uri>? log, String? failPair}) =>
        MockClient((req) async {
          log?.add(req.url);
          if (!req.url.path.contains('googleWalkProxy')) {
            return _jsonResponse(cacheTransit(), 200);
          }
          final startQ = req.url.queryParameters['start'] ?? '';
          final goalQ = req.url.queryParameters['goal'] ?? '';
          if (failPair != null && '$startQ;$goalQ' == failPair) {
            return _jsonResponse(_navi([]), 200);
          }
          GeoPoint pt(String s) {
            final p = s.split(',');
            return GeoPoint(double.parse(p[0]), double.parse(p[1]));
          }

          final km = haversineKm(pt(startQ), pt(goalQ));
          final isGoalSide = (pt(goalQ).lat - 35.70).abs() < 1e-6;
          final detour = isGoalSide ? 1.9 : 1.1;
          final meters = (km * 1000 * detour).round();
          final minutes = (km * 1000 / walkMetersPerMinute * detour).round();
          return _jsonResponse(_walkResp(minutes, meters), 200);
        });

    List<String> walkPairsOf(List<Uri> log) => log
        .where((u) => u.path.contains('googleWalkProxy'))
        .map(
          (u) => '${u.queryParameters['start']};${u.queryParameters['goal']}',
        )
        .toList();

    test('共有レッグを持つ候補を選び直すとき、徒歩実測はユニークレッグ数だけ呼ぶ（#116）', () async {
      // 選び直しで確定候補（S6乗車・S9降車）と中間候補（より手前乗車・S9降車）が
      // S9→目的地 レッグを共有する。レッグ単位キャッシュ無しでは同レッグを試行ごとに
      // 測り直し 4 コール（うち1重複）になるが、キャッシュでユニーク3レッグまで抑える。
      final log = <Uri>[];
      final plan = await build(cacheMock(log: log)).plan(
        destination: '目的地',
        destinationLatLng: const GeoPoint(35.70, 139.50),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 13, m: 0), // 予算240分
        origin: const GeoPoint(35.50, 139.50),
      );

      final pairs = walkPairsOf(log);
      final unique = pairs.toSet();
      // 重複コールが無い（コール数＝ユニークレッグ数）。
      expect(pairs.length, unique.length);
      // シナリオ固定: キャッシュ無しなら 4 コール（S9→目的地 が2回）になるところ 3。
      expect(pairs.length, 3);
      // 経路自体は予算内のハイブリッドに収束している（共有レッグの再利用が正しい）。
      expect(plan.totalMin, lessThanOrEqualTo(240));
      expect(
        plan.segments.where((s) => s.type == SegmentType.train),
        isNotEmpty,
      );
    });

    test('実測失敗（null）は負キャッシュせず、同一レッグの再要求で再度コールする（#116）', () async {
      // 予算140では出発地→S1 レッグを共有する候補が連続で選び直される。このレッグの
      // 実測を毎回失敗（routes 空）させても、失敗は負キャッシュしないため再要求のたびに
      // 再コールされる（成功レッグはキャッシュされ重複しない）。
      const s1Pair = '35.5,139.5;35.54,139.5';
      final log = <Uri>[];
      await build(cacheMock(log: log, failPair: s1Pair)).plan(
        destination: '目的地',
        destinationLatLng: const GeoPoint(35.70, 139.50),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 11, m: 20), // 予算140分
        origin: const GeoPoint(35.50, 139.50),
      );

      final pairs = walkPairsOf(log);
      final counts = <String, int>{};
      for (final p in pairs) {
        counts[p] = (counts[p] ?? 0) + 1;
      }
      // 失敗レッグは2回要求され、いずれも実コールされる（負キャッシュしない）。
      expect(counts[s1Pair], 2);
      // 成功した他レッグは1回ずつ（負キャッシュではなく正キャッシュは効く）。
      expect(
        counts.entries.where((e) => e.key != s1Pair && e.value > 1),
        isEmpty,
      );
    });

    test('キャッシュヒット時の徒歩区間表示名は候補側の fromName/toName を使う（#116）', () async {
      // 選び直しで S9→目的地 レッグは中間候補が先に実測し、確定候補（S6乗車・S9降車）が
      // キャッシュヒットで再利用する。ヒット時も表示名は候補側（'S9'→'目的地'）で差し替える。
      final plan = await build(cacheMock()).plan(
        destination: '目的地',
        destinationLatLng: const GeoPoint(35.70, 139.50),
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 13, m: 0), // 予算240分
        origin: const GeoPoint(35.50, 139.50),
      );

      final walks = plan.segments
          .where((s) => s.type == SegmentType.walk)
          .toList();
      expect(walks.first.fromName, '出発地');
      expect(walks.last.fromName, 'S9');
      expect(walks.last.toName, '目的地');
    });
  });

  group('NaviTimeRouteService 予算境界帯のマトリクス実測（#118）', () {
    const origin = GeoPoint(35.0, 139.000);
    const goal = GeoPoint(35.0, 139.054);

    // 出発側 O→S3 のレッグだけ道なり迂回が高い（実測が直線推定を大きく上回る）。
    // ここから学習した α を全駅へ一律適用すると、迂回の素直な S2 乗車（実測では予算内・
    // 徒歩最大）が α 補正で予算超過に見え、逐次プローブが取りこぼす状況を作る。
    double sideDetour(GeoPoint start, GeoPoint dest) {
      final fromOrigin = (start.lng - 139.000).abs() < 1e-6;
      final toS3 = (dest.lng - 139.015).abs() < 1e-6;
      return (fromOrigin && toS3) ? 1.9 : 1.0;
    }

    // 出発地→(S1,S1b,S2,S3,S4)→目的地 の標準経路。S1〜S3 は出発地寄りに密集し、S4 だけ
    // 目的地直前へ離す。これにより S4 以外で降りると目的地まで遠く、降車を早める候補は
    // すべて予算超過になり、現実的な降車は S4 に絞られる（乗車駅違いの徒歩量だけが効く）。
    Map<String, dynamic> corridor() => _navi([
      _item([
        _point('出発地', lat: 35.0, lon: 139.000),
        _walkSection(560, 7),
        _point('S1駅', lat: 35.0, lon: 139.006),
        _trainSection(
          4000,
          8,
          line: 'L線',
          calling: [
            _callingNoTime('S1駅', 35.0, 139.006),
            _callingNoTime('S1b駅', 35.0, 139.009),
            _callingNoTime('S2駅', 35.0, 139.012),
            _callingNoTime('S3駅', 35.0, 139.015),
            _callingNoTime('S4駅', 35.0, 139.050),
          ],
        ),
        _point('S4駅', lat: 35.0, lon: 139.050),
        _walkSection(400, 5),
        _point('目的地', lat: 35.0, lon: 139.054),
      ]),
    ]);

    // transit と walk(computeRoutes) と walkMatrix(computeRouteMatrix) を振り分けるモック。
    // walk・matrix とも徒歩分は haversine × [detour] で算出し、両者で完全に一致させる
    // （マトリクス採用後の computeRoutes 取り直しで値がぶれないように）。
    http.Client matrixMock({
      bool matrixFails = false,
      List<Uri>? log,
    }) => MockClient((req) async {
      log?.add(req.url);
      GeoPoint pt(String? s) {
        final p = (s ?? '').split(',');
        return GeoPoint(double.parse(p[0]), double.parse(p[1]));
      }

      int walkMin(GeoPoint a, GeoPoint b) =>
          (haversineKm(a, b) * 1000 / walkMetersPerMinute * sideDetour(a, b))
              .round();
      int walkMeters(GeoPoint a, GeoPoint b) =>
          (haversineKm(a, b) * 1000 * sideDetour(a, b)).round();

      if (req.url.path.contains('googleWalkMatrixProxy')) {
        if (matrixFails) {
          return _jsonResponse({
            'error': {'code': 403},
          }, 502);
        }
        final os = (req.url.queryParameters['origins'] ?? '')
            .split(';')
            .map(pt)
            .toList();
        final ds = (req.url.queryParameters['destinations'] ?? '')
            .split(';')
            .map(pt)
            .toList();
        final rows = <Map<String, dynamic>>[];
        for (var i = 0; i < os.length; i++) {
          for (var j = 0; j < ds.length; j++) {
            rows.add({
              'originIndex': i,
              'destinationIndex': j,
              'duration': '${walkMin(os[i], ds[j]) * 60}s',
              'distanceMeters': walkMeters(os[i], ds[j]),
            });
          }
        }
        return _jsonResponse(rows, 200);
      }
      if (req.url.path.contains('googleWalkProxy')) {
        final s = pt(req.url.queryParameters['start']);
        final g = pt(req.url.queryParameters['goal']);
        return _jsonResponse(_walkResp(walkMin(s, g), walkMeters(s, g)), 200);
      }
      return _jsonResponse(corridor(), 200);
    });

    NaviTimeRouteService svc(http.Client client) => NaviTimeRouteService(
      client: client,
      proxyBaseUrl: _proxyBaseUrl,
      clock: () => DateTime(2026, 5, 22, 8, 0),
    );

    Future<RoutePlan> runCorridor(http.Client client) => svc(client).plan(
      destination: '目的地',
      destinationLatLng: goal,
      departure: const TimeValue(h: 9, m: 0),
      arrival: const TimeValue(h: 9, m: 30), // 予算30分
      origin: origin,
    );

    int walkMinutesOf(RoutePlan p) => p.segments
        .where((s) => s.type == SegmentType.walk)
        .fold(0, (a, s) => a + s.minutes);

    test('帯内を実測すると α では後回しの徒歩最大候補を採用する', () async {
      final matrixLog = <Uri>[];
      final matrixPlan = await runCorridor(matrixMock(log: matrixLog));
      final fallbackPlan = await runCorridor(matrixMock(matrixFails: true));

      // マトリクス実測が実際に呼ばれている。
      expect(
        matrixLog.where((u) => u.path.contains('googleWalkMatrixProxy')),
        isNotEmpty,
      );
      // どちらも予算内（マトリクスは最適化であり遅刻を返さない）。
      expect(matrixPlan.totalMin, lessThanOrEqualTo(30));
      expect(fallbackPlan.totalMin, lessThanOrEqualTo(30));
      // 帯内を実測したマトリクス側の方が、α 一律補正の逐次プローブより多く歩く
      // （取りこぼしていた徒歩最大候補を拾う）。
      expect(
        walkMinutesOf(matrixPlan),
        greaterThan(walkMinutesOf(fallbackPlan)),
      );
    });

    test('マトリクス失敗時は逐次プローブへフォールバックし予算内に収める', () async {
      final plan = await runCorridor(matrixMock(matrixFails: true));
      expect(plan.totalMin, lessThanOrEqualTo(30));
      // 徒歩区間を持ち、電車を含むハイブリッドへ正しく縮退している。
      expect(plan.segments.any((s) => s.type == SegmentType.train), isTrue);
    });

    test('帯内候補が2件以下ならマトリクスをスキップする', () async {
      // 乗車駅候補を S1 のみに絞った単純経路。降車は遠方の S4 固定で、初回採用候補が
      // 実測超過しても帯内に並ぶ候補が2件以下となり、マトリクスは呼ばれない。
      Map<String, dynamic> single() => _navi([
        _item([
          _point('出発地', lat: 35.0, lon: 139.000),
          _walkSection(900, 12),
          _point('S1駅', lat: 35.0, lon: 139.012),
          _trainSection(
            4000,
            7,
            line: 'L線',
            calling: [
              _callingNoTime('S1駅', 35.0, 139.012),
              _callingNoTime('S4駅', 35.0, 139.050),
            ],
          ),
          _point('S4駅', lat: 35.0, lon: 139.050),
          _walkSection(400, 5),
          _point('目的地', lat: 35.0, lon: 139.054),
        ]),
      ]);

      final log = <Uri>[];
      // S1 への出発側徒歩を高迂回にし初回採用候補を実測超過させて α 学習を発火させる。
      final client = MockClient((req) async {
        log.add(req.url);
        GeoPoint pt(String? s) {
          final p = (s ?? '').split(',');
          return GeoPoint(double.parse(p[0]), double.parse(p[1]));
        }

        double detour(GeoPoint s, GeoPoint d) =>
            (s.lng - 139.000).abs() < 1e-6 && (d.lng - 139.012).abs() < 1e-6
            ? 1.9
            : 1.0;
        int wMin(GeoPoint a, GeoPoint b) =>
            (haversineKm(a, b) * 1000 / walkMetersPerMinute * detour(a, b))
                .round();
        int wM(GeoPoint a, GeoPoint b) =>
            (haversineKm(a, b) * 1000 * detour(a, b)).round();
        if (req.url.path.contains('googleWalkMatrixProxy')) {
          return _jsonResponse(<Map<String, dynamic>>[], 200);
        }
        if (req.url.path.contains('googleWalkProxy')) {
          final s = pt(req.url.queryParameters['start']);
          final g = pt(req.url.queryParameters['goal']);
          return _jsonResponse(_walkResp(wMin(s, g), wM(s, g)), 200);
        }
        return _jsonResponse(single(), 200);
      });

      await svc(client).plan(
        destination: '目的地',
        destinationLatLng: goal,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 9, m: 28), // 予算28分
        origin: origin,
      );

      expect(
        log.where((u) => u.path.contains('googleWalkMatrixProxy')),
        isEmpty,
      );
    });
  });
}
