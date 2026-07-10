import 'dart:async';
import 'dart:convert';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/hybrid_route_selector.dart'
    show haversineKm;
import 'package:aruku/core/services/route_plan_builder.dart'
    show walkMetersPerMinute, firstMissedTrain;
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/services/transit_route_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _transitBase = 'https://transit.example.com';
const _proxyBase = 'https://proxy.example.com';

http.Response _json(Object body, [int status = 200]) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status);

GeoPoint _pt(String s) {
  final p = s.split(',');
  return GeoPoint(double.parse(p[0]), double.parse(p[1]));
}

int _walkMin(GeoPoint a, GeoPoint b) =>
    (haversineKm(a, b) * 1000 / walkMetersPerMinute).round();

// ---- guidance/plan レスポンス組み立てヘルパ ----

Map<String, dynamic> _station(String id, String name) => {
  'id': id,
  'name': name,
};

Map<String, dynamic> _railLeg({
  required String route,
  required String fromId,
  required String fromName,
  required String toId,
  required String toName,
  required int dep,
  required int arr,
}) => {
  'kind': 'transit',
  'mode': 'rail',
  'routeName': route,
  'from': _station(fromId, fromName),
  'to': _station(toId, toName),
  'departureSecs': dep,
  'arrivalSecs': arr,
};

List<Map<String, dynamic>> _poly(List<List<double>> latLon) => [
  for (final p in latLon) {'lat': p[0], 'lon': p[1]},
];

Map<String, dynamic> _mapSeg(
  String kind,
  String fromId,
  String toId,
  String geom,
  List<List<double>> coords,
) => {
  'kind': kind,
  'geometrySource': geom,
  'fromPointId': fromId,
  'toPointId': toId,
  'polyline': _poly(coords),
};

/// 単一電車 option（access/egress 徒歩あり）。発着秒は 09:06→09:36 を既定にする。
Map<String, dynamic> _singleTrainOption({
  int dep = 32760, // 09:06
  int arr = 34560, // 09:36
  int access = 300,
  int egress = 300,
}) {
  const stops = [
    [35.6812, 139.7671],
    [35.6916, 139.7706],
    [35.6909, 139.7003],
  ];
  return {
    'journey': {
      'departureSecs': dep,
      'arrivalSecs': arr,
      'durationSecs': arr - dep + access + egress,
      'accessWalkSecs': access,
      'egressWalkSecs': egress,
      'legs': [
        _railLeg(
          route: '中央線快速',
          fromId: 'jr:Tokyo',
          fromName: '東京',
          toId: 'jr:Shinjuku',
          toName: '新宿',
          dep: dep,
          arr: arr,
        ),
      ],
    },
    'map': {
      'points': const [],
      'segments': [
        _mapSeg('walk', 'origin', 'jr:Tokyo', 'osmWalk', [
          [35.6800, 139.7600],
          stops.first,
        ]),
        _mapSeg('transit', 'jr:Tokyo', 'jr:Shinjuku', 'stopOrder', stops),
        _mapSeg('walk', 'jr:Shinjuku', 'destination', 'estimatedWalk', [
          stops.last,
          [35.6900, 139.7000],
        ]),
      ],
    },
  };
}

Map<String, dynamic> _guidance(List<Map<String, dynamic>> options) => {
  'date': '20260627',
  'timezone': 'Asia/Tokyo',
  'from': _station('origin', '地点(出発)'),
  'to': _station('destination', '地点(目的)'),
  'options': options,
};

/// computeRouteMatrix プロキシ応答を直線距離（80m/分）で近似して組む。
http.Response _matrixFor(Uri url) {
  List<GeoPoint> parse(String? raw) =>
      (raw ?? '').split(';').where((s) => s.isNotEmpty).map(_pt).toList();
  final os = parse(url.queryParameters['origins']);
  final ds = parse(url.queryParameters['destinations']);
  final rows = <Map<String, dynamic>>[];
  for (var i = 0; i < os.length; i++) {
    for (var j = 0; j < ds.length; j++) {
      final km = haversineKm(os[i], ds[j]);
      rows.add({
        'originIndex': i,
        'destinationIndex': j,
        'duration': '${_walkMin(os[i], ds[j]) * 60}s',
        'distanceMeters': (km * 1000).round(),
      });
    }
  }
  return _json(rows);
}

/// computeRoutes(WALK) プロキシ応答を直線距離で近似（enrich が選定と整合するように）。
http.Response _walkFor(Uri url) {
  final s = _pt(url.queryParameters['start'] ?? '0,0');
  final g = _pt(url.queryParameters['goal'] ?? '0,0');
  final km = haversineKm(s, g);
  return _json({
    'routes': [
      {
        'distanceMeters': (km * 1000).round(),
        'duration': '${_walkMin(s, g) * 60}s',
      },
    ],
  });
}

/// transit（guidance/plan）と proxy（google walk）をパスで振り分けるモック。
http.Client _mock({required Map<String, dynamic> transit, List<Uri>? log}) =>
    MockClient((req) async {
      log?.add(req.url);
      final path = req.url.path;
      if (path.contains('googleWalkMatrixProxy')) return _matrixFor(req.url);
      if (path.contains('googleWalkProxy')) return _walkFor(req.url);
      if (path.contains('guidance/plan')) return _json(transit);
      return _json(const {}, 404);
    });

TransitRouteService _service(http.Client client) => TransitRouteService(
  transitClient: client,
  proxyClient: client,
  transitBaseUrl: _transitBase,
  proxyBaseUrl: _proxyBase,
  clock: () => DateTime(2026, 6, 27, 9, 0),
);

void main() {
  const origin = GeoPoint(35.6800, 139.7600);
  const goal = GeoPoint(35.6900, 139.7000);

  group('plan: 入力ガード', () {
    test('origin が無ければ NO_ORIGIN', () {
      final svc = _service(_mock(transit: _guidance([_singleTrainOption()])));
      expect(
        () => svc.plan(
          destination: '新宿',
          destinationLatLng: goal,
          departure: const TimeValue(h: 9, m: 0),
          arrival: const TimeValue(h: 12, m: 0),
        ),
        throwsA(
          isA<RouteException>().having((e) => e.status, 'status', 'NO_ORIGIN'),
        ),
      );
    });

    test('目的地座標が無ければ NO_DESTINATION', () {
      final svc = _service(_mock(transit: _guidance([_singleTrainOption()])));
      expect(
        () => svc.plan(
          destination: '新宿',
          destinationLatLng: null,
          departure: const TimeValue(h: 9, m: 0),
          arrival: const TimeValue(h: 12, m: 0),
          origin: origin,
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

    test('options が空なら ZERO_RESULTS', () {
      final svc = _service(_mock(transit: _guidance(const [])));
      expect(
        () => svc.plan(
          destination: '新宿',
          destinationLatLng: goal,
          departure: const TimeValue(h: 9, m: 0),
          arrival: const TimeValue(h: 12, m: 0),
          origin: origin,
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
  });

  group('plan: タイムアウト (#156)', () {
    test('本命 guidance 取得がタイムアウトすると RouteException(TIMEOUT) へ変換', () {
      final client = MockClient(
        (_) async => throw TimeoutException('no response'),
      );
      final svc = _service(client);
      expect(
        () => svc.plan(
          destination: '新宿',
          destinationLatLng: goal,
          departure: const TimeValue(h: 9, m: 0),
          arrival: const TimeValue(h: 12, m: 0),
          origin: origin,
        ),
        throwsA(
          isA<RouteException>().having((e) => e.status, 'status', 'TIMEOUT'),
        ),
      );
    });
  });

  group('plan: 標準乗換', () {
    test('予算が小さいと電車を含む経路を返し、表示名はアプリ指定で上書き', () async {
      // 全徒歩は origin→goal 直線 ≒70分で予算超過。電車を含む候補が選ばれる。
      final svc = _service(_mock(transit: _guidance([_singleTrainOption()])));
      final plan = await svc.plan(
        destination: '新宿駅',
        destinationLatLng: goal,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 9, m: 50),
        origin: origin,
        originName: '東京駅',
      );
      expect(plan.from, '東京駅');
      expect(plan.to, '新宿駅');
      final train = plan.segments.firstWhere(
        (s) => s.type == SegmentType.train,
      );
      expect(train.line, '中央線快速');
      // 運賃は Transit API では取得不可（§5）。
      expect(train.fare, isNull);
      // 予算内に収まっている。
      expect(plan.totalMin, lessThanOrEqualTo(plan.budgetMin));
    });

    test('guidance/plan に geo from/to・date/time・type=departure を送る', () async {
      final log = <Uri>[];
      final svc = _service(
        _mock(transit: _guidance([_singleTrainOption()]), log: log),
      );
      await svc.plan(
        destination: '新宿',
        destinationLatLng: goal,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 12, m: 0),
        origin: origin,
      );
      final g = log.firstWhere((u) => u.path.contains('guidance/plan'));
      expect(g.queryParameters['from'], 'geo:35.68,139.76');
      expect(g.queryParameters['to'], 'geo:35.69,139.7');
      expect(g.queryParameters['date'], '20260627');
      expect(g.queryParameters['time'], '09:00');
      expect(g.queryParameters['type'], 'departure');
    });
  });

  group('plan: 徒歩最大化', () {
    test('予算が大きいと標準乗換（access+egress のみ）より歩く候補を選ぶ', () async {
      // 標準乗換の徒歩は access+egress=10分。予算を広く取れば、コリドー上の駅まで
      // 歩いて乗る・降りて歩くハイブリッド／全徒歩で徒歩が増える。
      final svc = _service(_mock(transit: _guidance([_singleTrainOption()])));
      final plan = await svc.plan(
        destination: '新宿',
        destinationLatLng: goal,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 13, m: 0),
        origin: origin,
        originName: '出発',
      );
      final walkMin = plan.segments
          .where((s) => s.type == SegmentType.walk)
          .fold<int>(0, (a, s) => a + s.minutes);
      expect(walkMin, greaterThan(10));
      expect(plan.totalMin, lessThanOrEqualTo(plan.budgetMin));
    });
  });

  group('plan: 崩壊判定の測定基準（#137 指摘2）', () {
    // 標準乗換の徒歩(access+egress)を guidance は小さく見積もるが、Google 実街路は
    // 大きく出る（街路は直線の下限を上回る）。崩壊判定（_isCollapse）が enrich 後の
    // 「実街路で膨らんだ徒歩」を基準にすると、予算余り・徒歩マージンの両条件が実測値で
    // 潰れて乗車駅探索（board search）が起動せず、徒歩最大化が silent に不達になる。
    // 判定は enrich 前（guidance 見積り）基準で行うべき。
    //
    // origin→goal は全徒歩が予算外、電車で高速、コリドーは3点。ハイブリッドは乗車時間が
    // 長く予算外 → 予算内候補は短徒歩の標準乗換のみ＝崩壊状況。実街路を直線の3倍で返す。
    const origin2 = GeoPoint(35.0, 139.0);
    const goal2 = GeoPoint(35.0, 139.5);

    Map<String, dynamic> collapseGuidance() {
      const stops = [
        [35.0, 139.01],
        [35.0, 139.25],
        [35.0, 139.49],
      ];
      return _guidance([
        {
          'journey': {
            'departureSecs': 32760, // 09:06
            'arrivalSecs': 33660, // 09:21（乗車15分）
            'durationSecs': 1500,
            'accessWalkSecs': 300, // guidance 見積り 5分
            'egressWalkSecs': 300, // guidance 見積り 5分
            'legs': [
              _railLeg(
                route: '快速',
                fromId: 'jr:board',
                fromName: '乗車駅',
                toId: 'jr:alight',
                toName: '降車駅',
                dep: 32760,
                arr: 33660,
              ),
            ],
          },
          'map': {
            'points': const [],
            'segments': [
              _mapSeg('walk', 'origin', 'jr:board', 'osmWalk', const [
                [35.0, 139.0],
                [35.0, 139.01],
              ]),
              _mapSeg('transit', 'jr:board', 'jr:alight', 'stopOrder', stops),
              _mapSeg(
                'walk',
                'jr:alight',
                'destination',
                'estimatedWalk',
                const [
                  [35.0, 139.49],
                  [35.0, 139.5],
                ],
              ),
            ],
          },
        },
      ]);
    }

    // 徒歩を直線の3倍で返すモック（実街路の迂回を模す）。guidance 呼び出しを記録する。
    http.Client inflatedMock(List<Uri> guidanceCalls) {
      List<GeoPoint> parse(String? raw) =>
          (raw ?? '').split(';').where((s) => s.isNotEmpty).map(_pt).toList();
      http.Response matrix(Uri url) {
        final os = parse(url.queryParameters['origins']);
        final ds = parse(url.queryParameters['destinations']);
        return _json([
          for (var i = 0; i < os.length; i++)
            for (var j = 0; j < ds.length; j++)
              {
                'originIndex': i,
                'destinationIndex': j,
                'duration': '${_walkMin(os[i], ds[j]) * 3 * 60}s',
                'distanceMeters': (haversineKm(os[i], ds[j]) * 1000).round(),
              },
        ]);
      }

      http.Response walk(Uri url) {
        final s = _pt(url.queryParameters['start'] ?? '0,0');
        final g = _pt(url.queryParameters['goal'] ?? '0,0');
        return _json({
          'routes': [
            {
              'distanceMeters': (haversineKm(s, g) * 1000).round(),
              'duration': '${_walkMin(s, g) * 3 * 60}s',
            },
          ],
        });
      }

      final transit = collapseGuidance();
      return MockClient((req) async {
        final path = req.url.path;
        if (path.contains('googleWalkMatrixProxy')) return matrix(req.url);
        if (path.contains('googleWalkProxy')) return walk(req.url);
        if (path.contains('guidance/plan')) {
          guidanceCalls.add(req.url);
          return _json(transit);
        }
        return _json(const {}, 404);
      });
    }

    test('実街路で膨らんだ徒歩で崩壊判定を潰さず乗車駅探索を起動する', () async {
      final guidanceCalls = <Uri>[];
      final svc = _service(inflatedMock(guidanceCalls));
      await svc.plan(
        destination: '降車駅',
        destinationLatLng: goal2,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 10, m: 0), // 予算60分
        origin: origin2,
        originName: '出発',
      );
      // 崩壊判定が enrich 前（guidance 見積り）基準で成立 → 乗車駅探索が引き直し
      // （guidance を複数回）する。enrich 後の膨らんだ徒歩を使うと崩壊判定が潰れ、
      // 初回 guidance 1回だけで終わってしまう（指摘2の回帰）。
      expect(guidanceCalls.length, greaterThan(1));
    });

    test('コリドー由来の確定経路でも乗降駅名を復元しタイムラインに出す', () async {
      final svc = _service(inflatedMock(<Uri>[]));
      final plan = await svc.plan(
        destination: '降車駅',
        destinationLatLng: goal2,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 10, m: 0),
        origin: origin2,
        originName: '出発',
      );

      // 電車区間に乗降駅名が入る（コリドー候補は座標のみで駅名を持たないため、
      // 確定後に乗車座標→降車座標で1回引き直して leg の実駅名を復元する）。
      final train = plan.segments.firstWhere(
        (s) => s.type == SegmentType.train,
      );
      expect(train.fromName, '乗車駅');
      expect(train.toName, '降車駅');

      // 乗車駅ノード（電車カード直上）の place に駅名が出る。タイムラインの place は
      // 直前・直後の徒歩区間の端点を使うため、駅名が伝播していることを確かめる。
      final places = plan.timelineNodes.map((n) => n.place);
      expect(places, contains('乗車駅'));
    });
  });

  group('plan: 乗車駅探索の実測駆動（#137 主因）', () {
    // 直線推定は実街路に対し大きく楽観に倒れることがある（実機で -36分/25%）。乗車駅探索の
    // 二分探索を直線推定で駆動すると、目的地寄りの遠い乗車駅へ収束し、実街路では全部予算
    // 超過 → 固定段数の後退では真の境界（ずっと手前）に届かず null → 徒歩最小の標準乗換へ
    // 崩落して大量に余る。二分探索を実測（Google walk）で駆動すれば、予算内・徒歩最大の
    // 中庸な乗車駅を取りこぼさない。
    const origin3 = GeoPoint(35.0, 139.0);
    const goal3 = GeoPoint(35.0, 139.05);
    const transfer = 139.025; // 乗換駅 T（コリドー中央）
    const inflate = 6; // Google 実街路 = 直線 ×6（遠いほど直線が楽観に倒れるのを模す）

    // 基準経路は2区間（origin→T→goal）。乗車駅探索のハイブリッドは「同一区間内 b→a」しか
    // 張れないため、区間1で降りると egress(T→goal) が ×6 で予算超過、区間2で乗ると前半徒歩
    // (origin→区間2) が予算超過 → どの中庸ハイブリッドも作れない。引き直し（board-search）
    // だけが多区間を1本に繋いで中庸の乗車駅を出せる、という構造をつくる。
    List<List<double>> leg1() => [
      for (var i = 0; i < 30; i++)
        [35.0, 139.001 + (transfer - 139.001) * i / 29],
    ];
    List<List<double>> leg2() => [
      for (var i = 0; i < 30; i++)
        [35.0, transfer + (139.05 - transfer) * i / 29],
    ];

    // 基準（標準）経路：2区間を速い1本で走る。access/egress 0 で徒歩最小・大量に余る＝
    // 崩壊状況をつくる。区間A着 [aArr]・区間B着 [bArr] で所要を変えられる（既定は計20分）。
    Map<String, dynamic> baseGuidance({int aArr = 33000, int bArr = 33600}) =>
        _guidance([
          {
            'journey': {
              'departureSecs': 32400, // 09:00
              'arrivalSecs': bArr,
              'durationSecs': bArr - 32400,
              'accessWalkSecs': 0,
              'egressWalkSecs': 0,
              'legs': [
                _railLeg(
                  route: '基準線A',
                  fromId: 's0',
                  fromName: '始発駅',
                  toId: 'sT',
                  toName: '乗換駅',
                  dep: 32400,
                  arr: aArr,
                ),
                _railLeg(
                  route: '基準線B',
                  fromId: 'sT',
                  fromName: '乗換駅',
                  toId: 'sN',
                  toName: '終着駅',
                  dep: aArr,
                  arr: bArr,
                ),
              ],
            },
            'map': {
              'points': const [],
              'segments': [
                _mapSeg('transit', 's0', 'sT', 'stopOrder', leg1()),
                _mapSeg('transit', 'sT', 'sN', 'stopOrder', leg2()),
              ],
            },
          },
        ]);

    int secsOf(String hhmm) {
      final p = hhmm.split(':');
      return int.parse(p[0]) * 3600 + int.parse(p[1]) * 60;
    }

    // 乗車駅 X からの引き直し便：乗車待ち0（dep=照会時刻）、goal までを残距離から概算した
    // 1本の電車で繋ぐ自己整合な実在便。X が goal に近いほど前半徒歩は伸びるが乗車は短い。
    Map<String, dynamic> reentry(double lng, String time) {
      final dep = secsOf(time);
      final remainMin = (haversineKm(GeoPoint(35.0, lng), goal3) * 1000 / 500)
          .round();
      final arr = dep + remainMin * 60;
      return _guidance([
        {
          'journey': {
            'departureSecs': dep,
            'arrivalSecs': arr,
            'durationSecs': arr - dep,
            'accessWalkSecs': 0,
            'egressWalkSecs': 0,
            'legs': [
              _railLeg(
                route: '快速',
                fromId: 'bx',
                fromName: '乗車駅',
                toId: 'gx',
                toName: '目的駅',
                dep: dep,
                arr: arr,
              ),
            ],
          },
          'map': {
            'points': const [],
            'segments': [
              _mapSeg('transit', 'bx', 'gx', 'stopOrder', [
                [35.0, lng],
                [35.0, 139.05],
              ]),
            ],
          },
        },
      ]);
    }

    http.Client inflatedFromMock({
      int aArr = 33000,
      int bArr = 33600,
      List<Uri>? guidanceCalls,
    }) {
      List<GeoPoint> parse(String? raw) =>
          (raw ?? '').split(';').where((s) => s.isNotEmpty).map(_pt).toList();
      http.Response matrix(Uri url) {
        final os = parse(url.queryParameters['origins']);
        final ds = parse(url.queryParameters['destinations']);
        return _json([
          for (var i = 0; i < os.length; i++)
            for (var j = 0; j < ds.length; j++)
              {
                'originIndex': i,
                'destinationIndex': j,
                'duration': '${_walkMin(os[i], ds[j]) * inflate * 60}s',
                'distanceMeters': (haversineKm(os[i], ds[j]) * 1000).round(),
              },
        ]);
      }

      http.Response walk(Uri url) {
        final s = _pt(url.queryParameters['start'] ?? '0,0');
        final g = _pt(url.queryParameters['goal'] ?? '0,0');
        return _json({
          'routes': [
            {
              'distanceMeters': (haversineKm(s, g) * 1000).round(),
              'duration': '${_walkMin(s, g) * inflate * 60}s',
            },
          ],
        });
      }

      return MockClient((req) async {
        final path = req.url.path;
        if (path.contains('googleWalkMatrixProxy')) return matrix(req.url);
        if (path.contains('googleWalkProxy')) return walk(req.url);
        if (path.contains('guidance/plan')) {
          guidanceCalls?.add(req.url);
          final from = req.url.queryParameters['from'] ?? '';
          final lng = double.parse(from.replaceFirst('geo:', '').split(',')[1]);
          final time = req.url.queryParameters['time'] ?? '09:00';
          if ((lng - 139.0).abs() < 1e-6) {
            return _json(baseGuidance(aArr: aArr, bArr: bArr));
          }
          return _json(reentry(lng, time));
        }
        return _json(const {}, 404);
      });
    }

    int walkMinutesOf(RoutePlan plan) => plan.segments
        .where((s) => s.type == SegmentType.walk)
        .fold(0, (a, s) => a + s.minutes);

    test('楽観推定で遠い駅へ収束せず、実測で予算内・徒歩最大の乗車駅を選ぶ', () async {
      final svc = _service(inflatedFromMock());
      final plan = await svc.plan(
        destination: '目的駅',
        destinationLatLng: goal3,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 10, m: 30), // 予算90分
        origin: origin3,
        originName: '出発',
      );
      // 乗車駅探索が実測で中庸の乗車駅を見つけ、徒歩最小の標準乗換（徒歩~0・余り~80分）へ
      // 崩落しない。直線推定駆動だと遠い駅へ収束→実街路全滅→null→標準へ崩落し徒歩~0。
      expect(walkMinutesOf(plan), greaterThan(50));
      expect(plan.totalMin, lessThanOrEqualTo(90));
    });

    test('絶対値の余りが大きければ相対閾値未満でも崩壊として乗車駅探索を起動する', () async {
      // 標準乗換が予算100分で着き余り50分。予算150分なので相対閾値（0.4×150=60分）には
      // 届かないが、50分は絶対的に大きく歩ける余地がある（実機の下北沢ケース 147/97/50 相当）。
      // 相対閾値だけだと崩壊判定が起動せず徒歩~0・大余りのまま。絶対値条件で起動させる。
      final calls = <Uri>[];
      final plan =
          await _service(
            inflatedFromMock(
              aArr: 35400, // 区間A着 09:50
              bArr: 38400, // 区間B着 10:40（標準は約100分で着く）
              guidanceCalls: calls,
            ),
          ).plan(
            destination: '目的駅',
            destinationLatLng: goal3,
            departure: const TimeValue(h: 9, m: 0),
            arrival: const TimeValue(h: 11, m: 30), // 予算150分
            origin: origin3,
            originName: '出発',
          );
      // 崩壊判定が絶対値の余りで成立 → board-search が複数回 guidance を引く。相対閾値のみだと
      // 初回 guidance 1回で終わり徒歩~0のまま（回帰）。
      expect(calls.length, greaterThan(1));
      expect(walkMinutesOf(plan), greaterThan(50));
      expect(plan.totalMin, lessThanOrEqualTo(150));
    });
  });

  group('plan: enrich後の乗り遅れ再検証（#137 副次）', () {
    // 標準乗換のアクセス徒歩は guidance 見積りで選定されるが、enrich で Google 実街路
    // （直線の数倍）に差し替わると徒歩が伸び、予定の先頭電車に乗り遅れる（駅着が発車後）
    // ことがある。予算内のままでも実際には乗れない経路なので、enrich 後に乗り遅れたら
    // 除外して乗れる次善へ選び直す。コリドーは1点（base=null）でハイブリッド／乗車駅探索が
    // 走らない純粋な標準乗換どうしの比較にする。
    const origin4 = GeoPoint(35.0, 139.0);
    const goal4 = GeoPoint(35.0, 139.02);
    const inflate = 2; // enrich の Google 実街路 = 直線 ×2

    // A: アクセス徒歩 5分（見積り）で 09:06 発に間に合うが、×2 で 9分に伸び乗り遅れる。
    //    徒歩見積りは B より大きいので素の選定では A が先に選ばれる。
    // B: アクセス徒歩 0（出発地で乗車）。enrich でも乗り遅れない＝乗れる次善。
    Map<String, dynamic> twoOptions() => _guidance([
      {
        'journey': {
          'departureSecs': 32400,
          'arrivalSecs': 33660,
          'durationSecs': 1260,
          'accessWalkSecs': 300, // 見積り5分
          'egressWalkSecs': 60,
          'legs': [
            _railLeg(
              route: '快速A',
              fromId: 'aBoard',
              fromName: '乗車A',
              toId: 'aAlight',
              toName: '降車A',
              dep: 32760, // 09:06
              arr: 33600, // 09:20
            ),
          ],
        },
        'map': {
          'points': const [],
          'segments': [
            _mapSeg('walk', 'origin', 'aBoard', 'osmWalk', const [
              [35.0, 139.0],
              [35.0, 139.004],
            ]),
            // 1点コリドー → base=null（ハイブリッド・乗車駅探索を起こさない）。
            _mapSeg('transit', 'aBoard', 'aAlight', 'stopOrder', const [
              [35.0, 139.0095],
            ]),
            _mapSeg('walk', 'aAlight', 'destination', 'estimatedWalk', const [
              [35.0, 139.019],
              [35.0, 139.02],
            ]),
          ],
        },
      },
      {
        'journey': {
          'departureSecs': 32400,
          'arrivalSecs': 33840,
          'durationSecs': 1440,
          'accessWalkSecs': 0,
          'egressWalkSecs': 60,
          'legs': [
            _railLeg(
              route: '快速B',
              fromId: 'bBoard',
              fromName: '乗車B',
              toId: 'bAlight',
              toName: '降車B',
              dep: 32880, // 09:08
              arr: 33780, // 09:23
            ),
          ],
        },
        'map': {
          'points': const [],
          'segments': [
            _mapSeg('transit', 'bBoard', 'bAlight', 'stopOrder', const [
              [35.0, 139.0099],
            ]),
            _mapSeg('walk', 'bAlight', 'destination', 'estimatedWalk', const [
              [35.0, 139.019],
              [35.0, 139.02],
            ]),
          ],
        },
      },
    ]);

    http.Client mock() {
      http.Response walk(Uri url) {
        final s = _pt(url.queryParameters['start'] ?? '0,0');
        final g = _pt(url.queryParameters['goal'] ?? '0,0');
        return _json({
          'routes': [
            {
              'distanceMeters': (haversineKm(s, g) * 1000).round(),
              'duration': '${_walkMin(s, g) * inflate * 60}s',
            },
          ],
        });
      }

      http.Response matrix(Uri url) {
        List<GeoPoint> parse(String? raw) =>
            (raw ?? '').split(';').where((s) => s.isNotEmpty).map(_pt).toList();
        final os = parse(url.queryParameters['origins']);
        final ds = parse(url.queryParameters['destinations']);
        return _json([
          for (var i = 0; i < os.length; i++)
            for (var j = 0; j < ds.length; j++)
              {
                'originIndex': i,
                'destinationIndex': j,
                'duration': '${_walkMin(os[i], ds[j]) * inflate * 60}s',
                'distanceMeters': (haversineKm(os[i], ds[j]) * 1000).round(),
              },
        ]);
      }

      return MockClient((req) async {
        final path = req.url.path;
        if (path.contains('googleWalkMatrixProxy')) return matrix(req.url);
        if (path.contains('googleWalkProxy')) return walk(req.url);
        if (path.contains('guidance/plan')) return _json(twoOptions());
        return _json(const {}, 404);
      });
    }

    test('enrich で先頭電車に乗り遅れる標準乗換は除外し、乗れる次善を返す', () async {
      final plan = await _service(mock()).plan(
        destination: '目的地',
        destinationLatLng: goal4,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 9, m: 35), // 予算35分（全徒歩は45分で予算外）
        origin: origin4,
        originName: '出発',
      );
      // 確定経路は実街路徒歩でも乗り遅れない。A を返すと駅着が発車後で実際には乗れない。
      final departureAt = DateTime(2026, 6, 27, 9, 0);
      expect(firstMissedTrain(plan.segments, departureAt), isNull);
      // 電車を含む（全徒歩は予算外なので縮退していない）＝乗れる B 系へ切り替わっている。
      expect(plan.segments.any((s) => s.type == SegmentType.train), isTrue);
      expect(plan.totalMin, lessThanOrEqualTo(35));
    });
  });

  group('plan: 乗車駅探索は非単調コリドーでも徒歩最大を返す（#137）', () {
    // 乗車駅探索の二分探索は「到着が index 単調増」を仮定して予算内の最大 index を境界に
    // するが、実街路の徒歩は非単調になり得る（後方の停車駅の方が origin に近い等）。境界
    // index だけを採ると、二分探索が途中で評価した「より手前で徒歩の多い予算内点」を取り
    // こぼす。境界ではなく評価済みの中で予算内・徒歩最大を返せば、特定ケースに依存せず
    // どの非単調コリドーでも取りこぼしを減らせる。
    const origin5 = GeoPoint(35.0, 139.0);
    const goal5 = GeoPoint(35.0, 139.20);

    // 2区間。区間1は origin→T の乗車候補列で、idx5 が idx6 より遠い「谷」を作る（前半徒歩が
    // 非単調）。区間1で降りると目的地まで遠く egress 予算外、区間2で乗ると前半徒歩 91分超で
    // 予算外 → ハイブリッドは作れず、乗車駅探索だけが解ける。
    const leg1Lng = [
      139.01,
      139.02,
      139.03,
      139.04,
      139.05,
      139.07, // idx5: 遠い（前半徒歩 大）
      139.06, // idx6: idx5 より origin に近い（谷）
      139.08, // idx7: 区間1終点 T
    ];
    const leg2Lng = [139.08, 139.12, 139.16, 139.20];

    List<List<double>> legCoords(List<double> lngs) => [
      for (final l in lngs) [35.0, l],
    ];

    Map<String, dynamic> baseGuidance() => _guidance([
      {
        'journey': {
          'departureSecs': 32400, // 09:00
          'arrivalSecs': 33600, // 09:20（標準は速い1本・徒歩最小で大量に余る）
          'durationSecs': 1200,
          'accessWalkSecs': 0,
          'egressWalkSecs': 0,
          'legs': [
            _railLeg(
              route: '基準線A',
              fromId: 's0',
              fromName: '始発駅',
              toId: 'sT',
              toName: '乗換駅',
              dep: 32400,
              arr: 33000,
            ),
            _railLeg(
              route: '基準線B',
              fromId: 'sT',
              fromName: '乗換駅',
              toId: 'sN',
              toName: '終着駅',
              dep: 33000,
              arr: 33600,
            ),
          ],
        },
        'map': {
          'points': const [],
          'segments': [
            _mapSeg('transit', 's0', 'sT', 'stopOrder', legCoords(leg1Lng)),
            _mapSeg('transit', 'sT', 'sN', 'stopOrder', legCoords(leg2Lng)),
          ],
        },
      },
    ]);

    int secsOf(String hhmm) {
      final p = hhmm.split(':');
      return int.parse(p[0]) * 3600 + int.parse(p[1]) * 60;
    }

    // 乗車駅 X からの引き直し便：乗車待ち0、goal まで残距離を 500m/分 で概算した1本。
    Map<String, dynamic> reentry(double lng, String time) {
      final dep = secsOf(time);
      final t = (haversineKm(GeoPoint(35.0, lng), goal5) * 1000 / 500).round();
      final arr = dep + t * 60;
      return _guidance([
        {
          'journey': {
            'departureSecs': dep,
            'arrivalSecs': arr,
            'durationSecs': arr - dep,
            'accessWalkSecs': 0,
            'egressWalkSecs': 0,
            'legs': [
              _railLeg(
                route: '快速',
                fromId: 'bx',
                fromName: '乗車駅',
                toId: 'gx',
                toName: '目的駅',
                dep: dep,
                arr: arr,
              ),
            ],
          },
          'map': {
            'points': const [],
            'segments': [
              _mapSeg('transit', 'bx', 'gx', 'stopOrder', [
                [35.0, lng],
                [35.0, 139.20],
              ]),
            ],
          },
        },
      ]);
    }

    http.Client mock() => MockClient((req) async {
      final path = req.url.path;
      if (path.contains('googleWalkMatrixProxy')) return _matrixFor(req.url);
      if (path.contains('googleWalkProxy')) return _walkFor(req.url);
      if (path.contains('guidance/plan')) {
        final from = req.url.queryParameters['from'] ?? '';
        final lng = double.parse(from.replaceFirst('geo:', '').split(',')[1]);
        final time = req.url.queryParameters['time'] ?? '09:00';
        if ((lng - 139.0).abs() < 1e-6) return _json(baseGuidance());
        return _json(reentry(lng, time));
      }
      return _json(const {}, 404);
    });

    int walkMinutesOf(RoutePlan plan) => plan.segments
        .where((s) => s.type == SegmentType.walk)
        .fold(0, (a, s) => a + s.minutes);

    test('二分探索の境界(谷)ではなく評価済みの徒歩最大点を採る', () async {
      // idx6(谷・前半徒歩~68分) が境界になるが、idx5(前半徒歩~80分) も予算内で徒歩が多い。
      // 境界だけ採ると徒歩68分、評価済み最大なら徒歩80分。
      final plan = await _service(mock()).plan(
        destination: '目的駅',
        destinationLatLng: goal5,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 10, m: 50), // 予算110分
        origin: origin5,
        originName: '出発',
      );
      expect(walkMinutesOf(plan), greaterThan(74));
      expect(plan.totalMin, lessThanOrEqualTo(110));
    });
  });

  group('plan: 時刻なしハイブリッドの実発車時刻検証（approach A・深夜の幽霊便対策）', () {
    // ハイブリッド電車区間はコリドー座標を距離で割った概算 minutes だけを持ち depTime を
    // 欠く。すると _advance が乗車待ちを 0 にし、運行時間外（終電後・始発前）でも「待ち0で
    // 今すぐ乗れる」と評価され、走っていない電車が予算内へ化ける（#137 実機・深夜02:41）。
    // approach A：採用候補の時刻なし電車区間を、実 boardAt で guidance 引き直しして実発着
    // 時刻を当て、乗車待ち（始発までの長い待ち）を到着へ反映する。
    const origin6 = GeoPoint(35.0, 139.0);
    const goal6 = GeoPoint(35.0, 139.30); // 全徒歩は約340分で予算外

    // 始発 firstTrainSecs（05:00）固定。照会時刻が始発前なら始発に張り付き、以降なら
    // 照会時刻以降の最初の便を返す（実機の NAVITIME/Transit API と同じ正直な挙動）。
    http.Client nightMock({int firstTrainSecs = 18000, int rideSecs = 1800}) {
      Map<String, dynamic> optionFor(int reqSecs) {
        final dep = reqSecs > firstTrainSecs ? reqSecs : firstTrainSecs;
        final arr = dep + rideSecs;
        const stops = [
          [35.0, 139.0],
          [35.0, 139.075],
          [35.0, 139.15],
          [35.0, 139.225],
          [35.0, 139.30],
        ];
        return {
          'journey': {
            'departureSecs': dep,
            'arrivalSecs': arr,
            'durationSecs': arr - dep + 120,
            'accessWalkSecs': 60,
            'egressWalkSecs': 60,
            'legs': [
              _railLeg(
                route: '夜行線',
                fromId: 's0',
                fromName: '始発駅',
                toId: 's1',
                toName: '終着駅',
                dep: dep,
                arr: arr,
              ),
            ],
          },
          'map': {
            'points': const [],
            'segments': [
              _mapSeg('walk', 'origin', 's0', 'osmWalk', const [
                [35.0, 139.0],
                [35.0, 139.0],
              ]),
              _mapSeg('transit', 's0', 's1', 'stopOrder', stops),
              _mapSeg('walk', 's1', 'destination', 'estimatedWalk', const [
                [35.0, 139.30],
                [35.0, 139.30],
              ]),
            ],
          },
        };
      }

      return MockClient((req) async {
        final path = req.url.path;
        if (path.contains('googleWalkMatrixProxy')) return _matrixFor(req.url);
        if (path.contains('googleWalkProxy')) return _walkFor(req.url);
        if (path.contains('guidance/plan')) {
          final time = req.url.queryParameters['time'] ?? '00:00';
          final hm = time.split(':');
          final secs = int.parse(hm[0]) * 3600 + int.parse(hm[1]) * 60;
          final body = _guidance([optionFor(secs)]);
          body['date'] = req.url.queryParameters['date'];
          return _json(body);
        }
        return _json(const {}, 404);
      });
    }

    TransitRouteService nightService(http.Client client) => TransitRouteService(
      transitClient: client,
      proxyClient: client,
      transitBaseUrl: _transitBase,
      proxyBaseUrl: _proxyBase,
      clock: () => DateTime(2026, 6, 27, 2, 0),
    );

    test('深夜のハイブリッドは始発05:00の実発車時刻が当たり乗車待ちが到着へ入る', () async {
      final plan = await nightService(nightMock()).plan(
        destination: '終着駅',
        destinationLatLng: goal6,
        departure: const TimeValue(h: 2, m: 0),
        arrival: const TimeValue(h: 7, m: 0), // 予算300分
        origin: origin6,
        originName: '出発',
      );
      final train = plan.segments.firstWhere(
        (s) => s.type == SegmentType.train,
      );
      // 時刻なし距離概算のままだと depTime は null。approach A で実時刻が当たる。
      expect(train.depTime, isNotNull, reason: '実発車時刻が当たるべき');
      expect(train.depTime!.hour, 5, reason: '02:00出発でも始発05:00より前には乗れない');
      // 02:00出発で05:00乗車＝最低180分の乗車待ちが到着に反映される。
      expect(plan.totalMin, greaterThanOrEqualTo(180));
    });

    test('予算外で best-effort へ落ちても始発前の幻バス便を提示しない', () async {
      // 予算50分では何も予算内に収まらず best-effort 縮退。時刻なしハイブリッドは
      // maxBoardingWait=0 で「今夜乗れる」と誤判定され、始発前（02:00乗車）の幻便を
      // best-effort が拾っていた（実機の洗足→新代田 森91 02:27）。approach A を
      // best-effort にも通せば、実発車時刻=05:00（待ち180分>予算）で除外され、
      // 走っていない電車を含まない全徒歩へ正しく縮退する。
      final plan = await nightService(nightMock()).plan(
        destination: '終着駅',
        destinationLatLng: goal6,
        departure: const TimeValue(h: 2, m: 0),
        arrival: const TimeValue(h: 2, m: 50), // 予算50分（何も予算内に入らない）
        origin: origin6,
        originName: '出発',
      );
      // 提示する電車区間は必ず実発車時刻を持つ（時刻なしの幻便を出さない）。
      final ghostTrains = plan.segments.where(
        (s) => s.type == SegmentType.train && s.depTime == null,
      );
      expect(ghostTrains, isEmpty, reason: '時刻なしの幻電車を提示してはならない');
    });

    // コリドー座標から短いバス区間を引き直すと、API が all-walk だけ返して電車便を
    // 返さないことがある（実機の都立大学→学芸大学 森91 01:08）。このとき実時刻を当てられず
    // depTime=null のまま maxBoardingWait=0 で best-effort を素通りしていた。実時刻を確認
    // できない時刻なし電車を含む候補は best-effort から除外する。
    // over-budget だが乗車・降車の各徒歩は予算内（frontier が乗降点を採れる）幾何。
    // origin(139.0)→乗車139.027(徒歩~31分)→降車139.10→goal139.127(徒歩~31分)、
    // 計徒歩~62分>予算50分。乗車点は origin と別 lng なので引き直しは all-walk＝ep null。
    const localOrigin = GeoPoint(35.0, 139.0);
    const localGoal = GeoPoint(35.0, 139.127);

    http.Client nightMockNoReentryTrain({int firstTrainSecs = 18000}) {
      const stops = [
        [35.0, 139.027],
        [35.0, 139.05],
        [35.0, 139.075],
        [35.0, 139.10],
      ];
      Map<String, dynamic> trainBase(int reqSecs) {
        final dep = reqSecs > firstTrainSecs ? reqSecs : firstTrainSecs;
        final arr = dep + 1800;
        return {
          'journey': {
            'departureSecs': dep,
            'arrivalSecs': arr,
            'durationSecs': arr - dep + 120,
            'accessWalkSecs': 60,
            'egressWalkSecs': 60,
            'legs': [
              _railLeg(
                route: '夜行線',
                fromId: 's0',
                fromName: '始発駅',
                toId: 's1',
                toName: '終着駅',
                dep: dep,
                arr: arr,
              ),
            ],
          },
          'map': {
            'points': const [],
            'segments': [
              _mapSeg('walk', 'origin', 's0', 'osmWalk', const [
                [35.0, 139.0],
                [35.0, 139.027],
              ]),
              _mapSeg('transit', 's0', 's1', 'stopOrder', stops),
              _mapSeg('walk', 's1', 'destination', 'estimatedWalk', const [
                [35.0, 139.10],
                [35.0, 139.127],
              ]),
            ],
          },
        };
      }

      // コリドー点からの引き直しは all-walk のみ（電車便を返さない）。
      Map<String, dynamic> walkOnly() => {
        'journey': {
          'departureSecs': 0,
          'arrivalSecs': 600,
          'durationSecs': 600,
          'legs': const [
            {'kind': 'walk', 'departureSecs': 0, 'arrivalSecs': 600},
          ],
        },
        'map': {
          'points': const [],
          'segments': [
            _mapSeg('walk', 'a', 'b', 'osmWalk', const [
              [35.0, 139.1],
              [35.0, 139.2],
            ]),
          ],
        },
      };

      return MockClient((req) async {
        final path = req.url.path;
        if (path.contains('googleWalkMatrixProxy')) return _matrixFor(req.url);
        if (path.contains('googleWalkProxy')) return _walkFor(req.url);
        if (path.contains('guidance/plan')) {
          final from = req.url.queryParameters['from'] ?? '';
          final lng = double.parse(from.replaceFirst('geo:', '').split(',')[1]);
          final time = req.url.queryParameters['time'] ?? '00:00';
          final hm = time.split(':');
          final secs = int.parse(hm[0]) * 3600 + int.parse(hm[1]) * 60;
          // origin(139.0)からは電車基準経路、コリドー点からは all-walk のみ。
          final body = (lng - 139.0).abs() < 1e-6
              ? _guidance([trainBase(secs)])
              : _guidance([walkOnly()]);
          body['date'] = req.url.queryParameters['date'];
          return _json(body);
        }
        return _json(const {}, 404);
      });
    }

    test('引き直しで電車便を確認できない時刻なし電車は best-effort に出さない', () async {
      final plan = await nightService(nightMockNoReentryTrain()).plan(
        destination: '終着駅',
        destinationLatLng: localGoal,
        departure: const TimeValue(h: 2, m: 0),
        arrival: const TimeValue(h: 2, m: 50), // 予算50分（best-effort へ）
        origin: localOrigin,
        originName: '出発',
      );
      final ghostTrains = plan.segments.where(
        (s) => s.type == SegmentType.train && s.depTime == null,
      );
      expect(ghostTrains, isEmpty, reason: '実時刻を確認できない時刻なし電車を提示してはならない');
    });

    test('予算内に見えても引き直しで便を確認できない時刻なし電車は確定しない', () async {
      // 予算を広く取り、時刻なしハイブリッド（楽観arr）が予算内に見えるケース。引き直しで
      // all-walk しか返らない＝その時間に便が無いなら、予算内に見えても確定させない。
      final plan = await nightService(nightMockNoReentryTrain()).plan(
        destination: '終着駅',
        destinationLatLng: localGoal,
        departure: const TimeValue(h: 2, m: 0),
        arrival: const TimeValue(h: 4, m: 30), // 予算150分（ハイブリッドは楽観で予算内）
        origin: localOrigin,
        originName: '出発',
      );
      final ghostTrains = plan.segments.where(
        (s) => s.type == SegmentType.train && s.depTime == null,
      );
      expect(ghostTrains, isEmpty, reason: '予算内でも未確認の時刻なし電車を確定してはならない');
    });
  });

  // バスは last-resort（#250）。電車＋徒歩が予算内に収まるあいだはバスを照会しない。
  // 収まらないときだけ avoidModes からバスを外して再照会し、候補プールへ足して選び直す。
  group('plan: バス last-resort 再照会 (#250)', () {
    // origin→goal は直線 ~11.6km（全徒歩 ~145分）。乗車点は origin・降車点は goal に
    // 重ね、アクセス徒歩ゼロのバス便にする（enrich で徒歩が伸びて乗り遅れる余地を消す）。
    const busOrigin = GeoPoint(35.0, 139.0);
    const busGoal = GeoPoint(35.0, 139.127);

    /// 電車のみの主照会が返す option。列車は 09:50 発 10:20 着で、予算60分（10:00 着）に
    /// 間に合わない。コリドー点からの引き直しは all-walk のみ＝ハイブリッドも確定しない。
    Map<String, dynamic> slowTrainOption() {
      const stops = [
        [35.0, 139.027],
        [35.0, 139.05],
        [35.0, 139.075],
        [35.0, 139.10],
      ];
      return {
        'journey': {
          'departureSecs': 35400, // 09:50
          'arrivalSecs': 37200, // 10:20
          'durationSecs': 1920,
          'accessWalkSecs': 60,
          'egressWalkSecs': 60,
          'legs': [
            _railLeg(
              route: '各停線',
              fromId: 's0',
              fromName: '始発駅',
              toId: 's1',
              toName: '終着駅',
              dep: 35400,
              arr: 37200,
            ),
          ],
        },
        'map': {
          'points': const [],
          'segments': [
            _mapSeg('walk', 'origin', 's0', 'osmWalk', const [
              [35.0, 139.0],
              [35.0, 139.027],
            ]),
            _mapSeg('transit', 's0', 's1', 'stopOrder', stops),
            _mapSeg('walk', 's1', 'destination', 'estimatedWalk', const [
              [35.0, 139.10],
              [35.0, 139.127],
            ]),
          ],
        },
      };
    }

    /// バス許容照会が返す door-to-door option。[dep]/[arr] を null にすると
    /// `departureSecs`/`arrivalSecs` を欠く「時刻の無いバス便」＝幽霊バスになる。
    Map<String, dynamic> busOption({int? dep = 32700, int? arr = 34500}) => {
      'journey': {
        'departureSecs': dep ?? 0,
        'arrivalSecs': arr ?? 0,
        'durationSecs': 1800,
        'accessWalkSecs': 0,
        'egressWalkSecs': 0,
        'legs': [
          {
            'kind': 'transit',
            'mode': 'bus',
            'routeName': '渋谷01',
            'from': _station('bs:0', 'A停留所'),
            'to': _station('bs:1', 'B停留所'),
            'departureSecs': ?dep,
            'arrivalSecs': ?arr,
          },
        ],
      },
      'map': {
        'points': const [],
        'segments': [
          _mapSeg('transit', 'bs:0', 'bs:1', 'gtfsShape', const [
            [35.0, 139.0],
            [35.0, 139.127],
          ]),
        ],
      },
    };

    /// all-walk のみを返す option（コリドー点からの引き直し用）。
    Map<String, dynamic> walkOnlyOption() => {
      'journey': {
        'departureSecs': 0,
        'arrivalSecs': 600,
        'durationSecs': 600,
        'legs': const [
          {'kind': 'walk', 'departureSecs': 0, 'arrivalSecs': 600},
        ],
      },
      'map': {
        'points': const [],
        'segments': [
          _mapSeg('walk', 'a', 'b', 'osmWalk', const [
            [35.0, 139.1],
            [35.0, 139.2],
          ]),
        ],
      },
    };

    /// avoidModes でバス許容照会を判別するモック。バス許容なら [busOption] を、
    /// 電車のみなら origin 起点は低速電車・コリドー点起点は all-walk を返す。
    http.Client busMock({
      required Map<String, dynamic> busOption,
      List<Uri>? log,
    }) => MockClient((req) async {
      log?.add(req.url);
      final path = req.url.path;
      if (path.contains('googleWalkMatrixProxy')) return _matrixFor(req.url);
      if (path.contains('googleWalkProxy')) return _walkFor(req.url);
      if (path.contains('guidance/plan')) {
        final allowsBus = !(req.url.queryParameters['avoidModes'] ?? '')
            .contains('bus');
        final from = req.url.queryParameters['from'] ?? '';
        final lng = double.parse(from.replaceFirst('geo:', '').split(',')[1]);
        final fromOrigin = (lng - 139.0).abs() < 1e-6;
        final body = allowsBus
            ? _guidance([busOption])
            : _guidance([fromOrigin ? slowTrainOption() : walkOnlyOption()]);
        body['date'] = req.url.queryParameters['date'];
        return _json(body);
      }
      return _json(const {}, 404);
    });

    test('電車が予算内なら バス許容照会は一度も発行しない（速度不変）', () async {
      final log = <Uri>[];
      final svc = _service(
        _mock(transit: _guidance([_singleTrainOption()]), log: log),
      );
      final plan = await svc.plan(
        destination: '新宿',
        destinationLatLng: goal,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 9, m: 50),
        origin: origin,
      );
      expect(plan.totalMin, lessThanOrEqualTo(plan.budgetMin));
      final busQueries = log.where(
        (u) =>
            u.path.contains('guidance/plan') &&
            !(u.queryParameters['avoidModes'] ?? '').contains('bus'),
      );
      expect(busQueries, isEmpty, reason: '予算内なら再照会してはならない');
    });

    test('電車が予算外でもバスなら間に合うとき、バス候補を提示する', () async {
      final svc = _service(busMock(busOption: busOption()));
      final plan = await svc.plan(
        destination: '目的地',
        destinationLatLng: busGoal,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 10, m: 0), // 予算60分（電車も全徒歩も届かない）
        origin: busOrigin,
      );
      final bus = plan.segments.firstWhere((s) => s.type == SegmentType.bus);
      expect(bus.line, '渋谷01');
      expect(bus.depTime, DateTime(2026, 6, 27, 9, 5));
      expect(plan.totalMin, lessThanOrEqualTo(plan.budgetMin));
    });

    test('時刻を持たないバス便は幽霊バスとして提示しない', () async {
      // 時刻なしバスは所要0分＝予算内に見えるが、引き直しでも実発車時刻を確認できない。
      // 電車と同じ基準（unverified transit）で確定させず、全徒歩へ縮退する。
      final svc = _service(busMock(busOption: busOption(dep: null, arr: null)));
      final plan = await svc.plan(
        destination: '目的地',
        destinationLatLng: busGoal,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 10, m: 0),
        origin: busOrigin,
      );
      final ghostBuses = plan.segments.where(
        (s) => s.type == SegmentType.bus && s.depTime == null,
      );
      expect(ghostBuses, isEmpty, reason: '時刻なしの幽霊バスを提示してはならない');
    });

    test('乗車待ちが予算を超えるバスは best-effort でも選ばれない', () async {
      // 09:00 出発・予算60分に対しバスは 10:05 発 10:15 着＝乗車待ち65分（>予算）・到着75分。
      // best-effort は「今夜乗れる候補の最早到着」を選ぶため、検証済みの標準乗換（到着81分）
      // より早いこのバスが勝ってしまう。maxBoardingWait がバスの待ちを数えて初めて
      // 「今は乗れない便」として reachableWithinBudget から外れ、電車へ縮退する
      // （#250。数えないと待ち0に見えてこのバスが提示される＝#121 と同型の退行）。
      final svc = _service(
        busMock(busOption: busOption(dep: 36300, arr: 36900)),
      );
      final plan = await svc.plan(
        destination: '目的地',
        destinationLatLng: busGoal,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 10, m: 0),
        origin: busOrigin,
      );
      expect(
        plan.segments.where((s) => s.type == SegmentType.bus),
        isEmpty,
        reason: '今夜（今日）乗れないバスを提示してはならない',
      );
    });
  });
}
