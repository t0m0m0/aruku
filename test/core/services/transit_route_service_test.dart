import 'dart:async';
import 'dart:convert';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/hybrid_route_selector.dart'
    show RouteCandidate, haversineKm;
import 'package:aruku/core/services/route_plan_builder.dart'
    show walkMetersPerMinute, trainMetersPerMinute, firstMissedTransit;
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/services/transit_plan_parser.dart';
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
/// [factor] を上げると「Google 実街路は直線見積りより長い」現実の条件を再現できる
/// （enrich で徒歩が伸び、選定時は予算内だった候補が超過・乗り遅れへ転じる）。
http.Response _walkFor(Uri url, {double factor = 1.0}) {
  final s = _pt(url.queryParameters['start'] ?? '0,0');
  final g = _pt(url.queryParameters['goal'] ?? '0,0');
  final km = haversineKm(s, g);
  return _json({
    'routes': [
      {
        'distanceMeters': (km * 1000 * factor).round(),
        'duration': '${(_walkMin(s, g) * factor).round() * 60}s',
      },
    ],
  });
}

/// transit（guidance/plan）と proxy（google walk）をパスで振り分けるモック。
/// [walkFactor] は enrich（computeRoutes WALK）にのみ効き、候補構築の見積り
/// （matrix / guidance）は据え置く。
http.Client _mock({
  required Map<String, dynamic> transit,
  List<Uri>? log,
  double walkFactor = 1.0,
}) => MockClient((req) async {
  log?.add(req.url);
  final path = req.url.path;
  if (path.contains('googleWalkMatrixProxy')) return _matrixFor(req.url);
  if (path.contains('googleWalkProxy')) {
    return _walkFor(req.url, factor: walkFactor);
  }
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
      // 09:15 発にして「実測徒歩8分で駅着 → 7分待って乗車」と実際に乗れる電車にする。既定の
      // 09:06 発では実測徒歩が見積り5分から8分へ伸びて発車後に駅着＝乗り遅れとなり、確定境界の
      // 再判定（#254）で全徒歩へ縮退する＝「電車を含む経路を返す」前提が崩れる。
      final svc = _service(
        _mock(transit: _guidance([_singleTrainOption(dep: 33300, arr: 35100)])),
      );
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

  group('plan: 複数ファミリ base のハイブリッド生成 (#292)', () {
    // 1回の guidance/plan レスポンスに路線ファミリを2種入れる。
    // ・ファミリA「特急線」= 総所要最小の単一 base。コリドー2点[近origin, 近goal]で
    //   途中乗車の余地がなく、生成できるハイブリッドの徒歩は access+egress の ~4分止まり。
    // ・ファミリB「各停線」= やや遅い。コリドー3点[近origin, 中間, 近goal]。中間で降りて
    //   goal まで歩くと徒歩82分・実到着 ~88分（予算100分内）。
    // 単一最速 base（=A）だけを土台にすると B のコリドー由来ハイブリッドは原理的に
    // 生成されず、徒歩は A の ~4分へ縮退する。複数 base に拡張して初めて B の徒歩82分
    // 候補がプールに入り選定対象になる。全徒歩(114分)は予算外なので勝てない。
    const o = GeoPoint(35.0, 139.000);
    const g = GeoPoint(35.0, 139.100);

    // 09:03発。勝者(B0→B1)の乗車座標到達は 09:02（前半徒歩2分）なので、実発車時刻検証
    // （approach A）で dep >= boardAt を満たし、時刻なし電車の幽霊便除外に掛からない。
    Map<String, dynamic> familyA() => {
      'journey': {
        'departureSecs': 32580, // 09:03
        'arrivalSecs': 32880, // 09:08
        'durationSecs': 32880 - 32580 + 240,
        'accessWalkSecs': 120, // origin->139.002 ≒ 2分
        'egressWalkSecs': 120, // 139.098->goal ≒ 2分
        'legs': [
          _railLeg(
            route: '特急線',
            fromId: 'a:board',
            fromName: 'A乗車',
            toId: 'a:alight',
            toName: 'A降車',
            dep: 32580,
            arr: 32880,
          ),
        ],
      },
      'map': {
        'points': const [],
        'segments': [
          _mapSeg('walk', 'origin', 'a:board', 'osmWalk', const [
            [35.0, 139.000],
            [35.0, 139.002],
          ]),
          _mapSeg('transit', 'a:board', 'a:alight', 'stopOrder', const [
            [35.0, 139.002],
            [35.0, 139.098],
          ]),
          _mapSeg('walk', 'a:alight', 'destination', 'estimatedWalk', const [
            [35.0, 139.098],
            [35.0, 139.100],
          ]),
        ],
      },
    };

    Map<String, dynamic> familyB() => {
      'journey': {
        'departureSecs': 32580, // 09:03
        'arrivalSecs': 33480, // 09:18（Aより遅い＝base 順は A→B）
        'durationSecs': 33480 - 32580 + 240,
        'accessWalkSecs': 120,
        'egressWalkSecs': 120,
        'legs': [
          _railLeg(
            route: '各停線',
            fromId: 'b:board',
            fromName: 'B乗車',
            toId: 'b:alight',
            toName: 'B降車',
            dep: 32580,
            arr: 33480,
          ),
        ],
      },
      'map': {
        'points': const [],
        'segments': [
          _mapSeg('walk', 'origin', 'b:board', 'osmWalk', const [
            [35.0, 139.000],
            [35.0, 139.002],
          ]),
          _mapSeg('transit', 'b:board', 'b:alight', 'stopOrder', const [
            [35.0, 139.002],
            [35.0, 139.030],
            [35.0, 139.098],
          ]),
          _mapSeg('walk', 'b:alight', 'destination', 'estimatedWalk', const [
            [35.0, 139.098],
            [35.0, 139.100],
          ]),
        ],
      },
    };

    test('別路線ファミリのコリドー由来の徒歩多め候補が選ばれる', () async {
      final svc = _service(_mock(transit: _guidance([familyA(), familyB()])));
      final plan = await svc.plan(
        destination: '目的地',
        destinationLatLng: g,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 10, m: 40), // 予算100分
        origin: o,
        originName: '出発',
      );
      final walkMin = plan.segments
          .where((s) => s.type == SegmentType.walk)
          .fold<int>(0, (a, s) => a + s.minutes);
      // ファミリA単独では ~4分が上限。B のコリドーを土台にして初めて到達できる徒歩量。
      expect(walkMin, greaterThan(40));
      expect(plan.totalMin, lessThanOrEqualTo(plan.budgetMin));
      // 勝者の電車区間がファミリB由来（各停線）であること＝B のコリドーから生成された証拠。
      expect(
        plan.segments.any(
          (s) => s.type == SegmentType.train && s.line == '各停線',
        ),
        isTrue,
      );
    });

    test('複数 base に広げても guidance/plan 照会は増えない（増分APIコストゼロ）', () async {
      // base 拡張とハイブリッド生成は取得済み options と Google マトリクスだけで完結し、
      // 新規 transit 照会を発行しない。素朴に base ごと door-to-door を再照会する実装なら
      // origin 発の照会が base 数分（2回以上）になる。#290 で代替案の実発車時刻検証
      // （乗車座標発・最大3件）が加わったため、総数ではなく origin 発の本命照会数で
      // base 比例の退行を検出し、総数は「本命1＋勝者検証1＋代替案検証≤3」で抑える。
      final log = <Uri>[];
      final svc = _service(
        _mock(transit: _guidance([familyA(), familyB()]), log: log),
      );
      await svc.plan(
        destination: '目的地',
        destinationLatLng: g,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 10, m: 40),
        origin: o,
        originName: '出発',
      );
      final mainCalls = log
          .where(
            (u) =>
                u.path.contains('guidance/plan') &&
                u.queryParameters['from'] == 'geo:35.0,139.0',
          )
          .length;
      expect(mainCalls, 1);
      final guidanceCalls = log
          .where((u) => u.path.contains('guidance/plan'))
          .length;
      expect(guidanceCalls, lessThanOrEqualTo(5));
    });

    test('路線名を欠く別コリドーも別ファミリとして徒歩多め候補を生む', () async {
      // routeName を持たない leg 2種（急行=2点コリドー / 各停=3点コリドー、端点は共有）。
      // 空文字で畳むと同一ファミリ扱いで最速1本へ退行するが、コリドー形状で区別すれば
      // 各停コリドー由来の徒歩多め候補（徒歩82分）が生成される（Codex 指摘の反証）。
      Map<String, dynamic> unnamed(List<List<double>> stops, int arr) => {
        'journey': {
          'departureSecs': 32580, // 09:03
          'arrivalSecs': arr,
          'durationSecs': arr - 32580 + 240,
          'accessWalkSecs': 120,
          'egressWalkSecs': 120,
          'legs': [
            {
              'kind': 'transit',
              'mode': 'rail', // routeName なし＝RouteSegment.line は null
              'from': _station('u:board', '乗車'),
              'to': _station('u:alight', '降車'),
              'departureSecs': 32580,
              'arrivalSecs': arr,
            },
          ],
        },
        'map': {
          'points': const [],
          'segments': [
            _mapSeg('walk', 'origin', 'u:board', 'osmWalk', [
              [35.0, 139.000],
              stops.first,
            ]),
            _mapSeg('transit', 'u:board', 'u:alight', 'stopOrder', stops),
            _mapSeg('walk', 'u:alight', 'destination', 'estimatedWalk', [
              stops.last,
              [35.0, 139.100],
            ]),
          ],
        },
      };
      final svc = _service(
        _mock(
          transit: _guidance([
            unnamed(const [
              [35.0, 139.002],
              [35.0, 139.098],
            ], 32880), // 急行 09:08
            unnamed(const [
              [35.0, 139.002],
              [35.0, 139.030],
              [35.0, 139.098],
            ], 33480), // 各停 09:18
          ]),
        ),
      );
      final plan = await svc.plan(
        destination: '目的地',
        destinationLatLng: g,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 10, m: 40),
        origin: o,
        originName: '出発',
      );
      final walkMin = plan.segments
          .where((s) => s.type == SegmentType.walk)
          .fold<int>(0, (a, s) => a + s.minutes);
      expect(walkMin, greaterThan(40));
      expect(plan.totalMin, lessThanOrEqualTo(plan.budgetMin));
    });
  });

  group('basesForHybrid: 路線ファミリ別 base 選定 (#292)', () {
    // 電車1本＋2点コリドーの最小 option。line がファミリ、minutes が総所要を決める。
    TransitOption opt(String line, int minutes) {
      const coords = [GeoPoint(35.0, 139.0), GeoPoint(35.0, 139.01)];
      return TransitOption(
        from: '出発',
        to: '目的',
        segments: [
          RouteSegment(
            type: SegmentType.train,
            fromName: '',
            toName: '',
            minutes: minutes,
            line: line,
            polyline: coords,
          ),
        ],
        corridors: const [
          TransitCorridor(
            legIndex: 0,
            geometrySource: 'stopOrder',
            coords: coords,
          ),
        ],
      );
    }

    List<String?> lines(List<TransitOption> os) =>
        os.map((o) => o.segments.first.line).toList();

    test('同所要のタイブレークは代表(最短)option の出現順に従う', () {
      final svc = _service(_mock(transit: _guidance(const [])));
      // A(20分), B(10分), A(10分)。_baseForHybrid は最短10分の初出=B を採る。
      // 素朴に「ファミリ初出位置」でタイブレークすると A(初出index0) が先に来てしまう。
      // 代表(最短)option の位置で比べれば B(index1) < A の代表(index2) で B が先。
      final bases = svc.basesForHybrid([
        opt('A', 20),
        opt('B', 10),
        opt('A', 10),
      ]);
      expect(lines(bases), ['B', 'A']);
      // ファミリ A の代表は 20分の初出ではなく 10分の option。
      expect(bases[1].segments.first.minutes, 10);
    });

    test('先頭は総所要最小のファミリ（単一ファミリ時は1本）', () {
      final svc = _service(_mock(transit: _guidance(const [])));
      expect(lines(svc.basesForHybrid([opt('A', 30), opt('B', 12)])), [
        'B',
        'A',
      ]);
      expect(lines(svc.basesForHybrid([opt('A', 30), opt('A', 12)])), ['A']);
    });

    test('ファミリ数が上限を超えたら総所要の小さい代表から選ぶ', () {
      final svc = _service(_mock(transit: _guidance(const [])));
      final bases = svc.basesForHybrid([
        opt('A', 40),
        opt('B', 10),
        opt('C', 20),
        opt('D', 30),
      ]);
      // 上限3本。総所要昇順で B(10),C(20),D(30) を採り A(40) は落とす。
      expect(lines(bases), ['B', 'C', 'D']);
    });

    // 電車1本 option（コリドー座標を指定）。空/欠落 routeName の区別検証用。
    TransitOption optAt(String? line, int minutes, List<GeoPoint> coords) =>
        TransitOption(
          from: '出発',
          to: '目的',
          segments: [
            RouteSegment(
              type: SegmentType.train,
              fromName: '',
              toName: '',
              minutes: minutes,
              line: line,
              polyline: coords,
            ),
          ],
          corridors: [
            TransitCorridor(
              legIndex: 0,
              geometrySource: 'stopOrder',
              coords: coords,
            ),
          ],
        );

    test('空文字/欠落の routeName もコリドー形状で別ファミリに分ける', () {
      final svc = _service(_mock(transit: _guidance(const [])));
      const corridorA = [GeoPoint(35.0, 139.0), GeoPoint(35.0, 139.02)];
      const corridorB = [
        GeoPoint(35.0, 139.0),
        GeoPoint(35.0, 139.01),
        GeoPoint(35.0, 139.02),
      ];
      // 空文字を素朴に畳むと同一ファミリ化して1本へ退行する（Codex 指摘）。null も空文字も
      // 「無名」としてコリドー形状で区別すれば、別コリドーは別 base として残る。
      expect(
        svc.basesForHybrid([
          optAt('', 10, corridorA),
          optAt('', 20, corridorB),
        ]),
        hasLength(2),
      );
      expect(
        svc.basesForHybrid([
          optAt(null, 10, corridorA),
          optAt(null, 20, corridorB),
        ]),
        hasLength(2),
      );
    });
  });

  group('mergeHybrids: 予算内優先の上限マージ (#292)', () {
    // 徒歩 [walkMin] 分の単一区間候補（polyline を [tag] で一意化し dedup キーを分ける）。
    RouteCandidate cand(int walkMin, double tag) => RouteCandidate(
      from: '出発',
      to: '目的',
      segments: [
        RouteSegment(
          type: SegmentType.walk,
          fromName: '',
          toName: '',
          minutes: walkMin,
          polyline: [GeoPoint(35.0, tag), GeoPoint(35.0, tag + 0.001)],
        ),
      ],
    );

    test('予算外の徒歩多め候補は予算内候補を締め出さない（予算内が先）', () {
      final svc = _service(_mock(transit: _guidance(const [])));
      // base0: 予算外(徒歩80) と 予算内(徒歩50)。base1: 予算内(徒歩40)。
      final over = cand(80, 139.1);
      final within1 = cand(50, 139.2);
      final within2 = cand(40, 139.3);
      final merged = svc.mergeHybrids(
        [
          [over, within1],
          [within2],
        ],
        (h) => h != over, // over のみ予算外
      );
      // 3件すべて残るが、予算内(within1/within2)が予算外(over)より前に並ぶ。
      expect(merged, hasLength(3));
      expect(merged.indexOf(over), greaterThan(merged.indexOf(within1)));
      expect(merged.indexOf(over), greaterThan(merged.indexOf(within2)));
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

    // 乗車駅は origin から直線3分（実街路3倍で9分）。09:10 発なので実測徒歩でも間に合う。
    // 乗車駅を遠く（直線11分＝実測33分）に置くと、09:10 発には物理的に乗れない経路になり、
    // 確定境界の乗り遅れ再判定（#254）で全徒歩へ縮退して崩壊判定まで到達しない。
    Map<String, dynamic> collapseGuidance() {
      const stops = [
        [35.0, 139.003],
        [35.0, 139.25],
        [35.0, 139.49],
      ];
      return _guidance([
        {
          'journey': {
            'departureSecs': 33000, // 09:10
            'arrivalSecs': 33900, // 09:25（乗車15分）
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
                dep: 33000,
                arr: 33900,
              ),
            ],
          },
          'map': {
            'points': const [],
            'segments': [
              _mapSeg('walk', 'origin', 'jr:board', 'osmWalk', const [
                [35.0, 139.0],
                [35.0, 139.003],
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
      expect(firstMissedTransit(plan.segments, departureAt), isNull);
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

    /// コリドー点 [lng] → goal を返す電車 option（board-search の引き直し用）。
    /// 09:10 発なので、前半徒歩31分（09:31 に乗車駅着）では乗り遅れる。到着だけ見れば
    /// 予算内（31+10=41分）なので board-search は候補として返し、enrich の乗り遅れ除外で
    /// 落ちる——「board-search が候補を返したのに全滅する」状況を作る。
    Map<String, dynamic> corridorTrainOption(double lng) => {
      'journey': {
        'departureSecs': 33000, // 09:10
        'arrivalSecs': 33600, // 09:20
        'durationSecs': 600,
        'accessWalkSecs': 0,
        'egressWalkSecs': 0,
        'legs': [
          _railLeg(
            route: '各停線',
            fromId: 'c0',
            fromName: '途中駅',
            toId: 'c1',
            toName: '終着駅',
            dep: 33000,
            arr: 33600,
          ),
        ],
      },
      'map': {
        'points': const [],
        'segments': [
          _mapSeg('transit', 'c0', 'c1', 'stopOrder', [
            [35.0, lng],
            [35.0, 139.127],
          ]),
        ],
      },
    };

    /// 見積り徒歩1分・実測徒歩31分の標準乗換（`accessWalkSecs` が所要分を決め、polyline が
    /// enrich 後の実測を決める parser の性質を使う）。09:20 発なので見積り（09:01 駅着）では
    /// 乗れるが、実測（09:31 駅着）では乗り遅れる。それでも到着は 31+10=41分で予算内に
    /// 収まるため、`giveUp` が到着だけで判定すると「乗れない経路」を予算内と誤認する。
    Map<String, dynamic> missedTrainOption() => {
      'journey': {
        'departureSecs': 33600, // 09:20
        'arrivalSecs': 34200, // 09:30
        'durationSecs': 660,
        'accessWalkSecs': 60, // 見積りでは徒歩1分（実 polyline は 2.5km ≒ 31分）
        'egressWalkSecs': 0,
        'legs': [
          _railLeg(
            route: '各停線',
            fromId: 's0',
            fromName: '始発駅',
            toId: 's1',
            toName: '終着駅',
            dep: 33600,
            arr: 34200,
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
          _mapSeg('transit', 's0', 's1', 'stopOrder', const [
            [35.0, 139.027],
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

    /// avoidModes でバス許容照会を判別するモック。バス許容なら [busOption] を、電車のみなら
    /// origin 起点は [originOption]（既定＝低速電車）・コリドー点起点は [corridorOption]
    /// （既定＝all-walk＝引き直し失敗）を返す。
    http.Client busMock({
      required Map<String, dynamic> busOption,
      Map<String, dynamic>? originOption,
      Map<String, dynamic> Function(double lng)? corridorOption,
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
            : _guidance([
                if (fromOrigin)
                  originOption ?? slowTrainOption()
                else
                  corridorOption?.call(lng) ?? walkOnlyOption(),
              ]);
        body['date'] = req.url.queryParameters['date'];
        return _json(body);
      }
      return _json(const {}, 404);
    });

    test('電車が予算内なら バス許容照会は一度も発行しない（速度不変）', () async {
      // 09:15 発にして「実測徒歩8分で駅着 → 7分待って乗車」と実際に乗れる電車にする。
      // 既定の 09:06 発だと実測徒歩が見積り5分から8分へ伸びて発車後に駅着＝乗り遅れとなり、
      // 到着(arrivalMinutes)だけ予算内に見える「乗れない電車」になってしまい、
      // 「電車で間に合うケース」を表現できない（乗り遅れは last-resort の発火条件）。
      final log = <Uri>[];
      final svc = _service(
        _mock(
          transit: _guidance([_singleTrainOption(dep: 33300, arr: 35100)]),
          log: log,
        ),
      );
      final plan = await svc.plan(
        destination: '新宿',
        destinationLatLng: goal,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 9, m: 50),
        origin: origin,
      );
      expect(plan.totalMin, lessThanOrEqualTo(plan.budgetMin));
      expect(
        firstMissedTransit(plan.segments, DateTime(2026, 6, 27, 9, 0)),
        isNull,
        reason: '前提: 実際に乗れる電車で予算内に収まっている',
      );
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

    test('collapse→board-search が全滅してもバス候補を取り下げない', () async {
      // バスが予算内で勝つ → collapse 判定が立ち board-search が起動する。board-search は
      // 到着だけ見て候補を返すが、その電車は乗り遅れ（09:10 発／乗車駅着 09:31）なので
      // enrich で全滅する。再選定のプールにバスを引き継がないと、せっかく見つけた予算内の
      // バスを捨てて予算外の best-effort へ落ちてしまう。
      final svc = _service(
        busMock(busOption: busOption(), corridorOption: corridorTrainOption),
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
        isNotEmpty,
        reason: 'board-search が全滅したら last-resort のバスへ戻るべき',
      );
      expect(plan.totalMin, lessThanOrEqualTo(plan.budgetMin));
    });

    test('best-effort が予算内でも乗り遅れならバスを引く', () async {
      // 標準乗換は見積り徒歩1分で 09:20 発に間に合うが、実測徒歩31分では乗り遅れる。
      // 乗り遅れたまま到着だけ数えると41分＝予算内に見えるため、到着だけで発火判定すると
      // 「実際には乗れない電車」を提示してバス再照会を撃ち漏らす。
      final svc = _service(
        busMock(busOption: busOption(), originOption: missedTrainOption()),
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
        isNotEmpty,
        reason: '乗り遅れる電車しか無いならバスを引くべき',
      );
      expect(
        firstMissedTransit(plan.segments, DateTime(2026, 6, 27, 9, 0)),
        isNull,
        reason: '乗り遅れる便を確定してはならない',
      );
    });
  });

  // last-resort でバスが勝ったら、そのバス corridor にも徒歩最大化（途中下車・乗車駅探索）を
  // フル適用する（#251）。通常照会（電車が予算内）では #249 の train-only ガードを維持する。
  group('plan: バス corridor の徒歩最大化 (#251)', () {
    const busOrigin = GeoPoint(35.0, 139.0);
    const busGoal = GeoPoint(35.0, 139.127); // 直線 11.6km（全徒歩 145分）
    // バス停 A は origin から徒歩14分。バス corridor はそこから goal まで。
    const bs0 = 139.012;
    const corridor = [bs0, 139.05, 139.09, 139.11, 139.127];
    const busDep = 33300; // 09:15

    /// 迂回バスの corridor が通る緯度。勝者 corridor（lat 35.0）と区別するために使う。
    const detourLat = 35.02;

    /// バスの実ダイヤ速度（モック）。既定は見積り（[trainMetersPerMinute]）と同じにして、
    /// 「見積りが通った候補は実時刻でも通る」フィクスチャにする。[metersPerMinute] を
    /// 下げると「実ダイヤは見積りより遅い」実世界の条件を再現できる。
    int rideMin(GeoPoint a, GeoPoint b, [double? metersPerMinute]) =>
        (haversineKm(a, b) * 1000 / (metersPerMinute ?? trainMetersPerMinute))
            .round();

    /// 電車のみの主照会が返す option。09:50 発 10:20 着で予算65分（10:05 着）に届かない。
    /// コリドーは2点だけにして電車ハイブリッドを1本に抑える。
    Map<String, dynamic> slowTrainOption() => {
      'journey': {
        'departureSecs': 35400, // 09:50
        'arrivalSecs': 37200, // 10:20
        'durationSecs': 1920,
        'accessWalkSecs': 0,
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
          _mapSeg('transit', 's0', 's1', 'stopOrder', const [
            [35.0, 139.0],
            [35.0, 139.10],
          ]),
          _mapSeg('walk', 's1', 'destination', 'estimatedWalk', const [
            [35.0, 139.10],
            [35.0, 139.127],
          ]),
        ],
      },
    };

    /// バス許容照会（origin 起点）が返す door-to-door option。徒歩14分でバス停 A へ出て
    /// 09:15 発のバスに乗り goal まで乗り通す（徒歩14分・到着36分）。
    Map<String, dynamic> busDoorToDoor() => {
      'journey': {
        'departureSecs': busDep,
        'arrivalSecs':
            busDep + rideMin(const GeoPoint(35.0, bs0), busGoal) * 60,
        'durationSecs': 2160,
        'accessWalkSecs': 840, // 徒歩14分
        'egressWalkSecs': 0,
        'legs': [
          {
            'kind': 'transit',
            'mode': 'bus',
            'routeName': 'バス01',
            'from': _station('bs:0', 'A停留所'),
            'to': _station('bs:1', 'B停留所'),
            'departureSecs': busDep,
            'arrivalSecs':
                busDep + rideMin(const GeoPoint(35.0, bs0), busGoal) * 60,
          },
        ],
      },
      'map': {
        'points': const [],
        'segments': [
          _mapSeg('walk', 'origin', 'bs:0', 'osmWalk', const [
            [35.0, 139.0],
            [35.0, bs0],
          ]),
          _mapSeg('transit', 'bs:0', 'bs:1', 'gtfsShape', [
            for (final lng in corridor) [35.0, lng],
          ]),
        ],
      },
    };

    /// last-resort が door-to-door と同時に返す「もう1本のバス」。徒歩0分で乗れて所要も
    /// 短い（16分）ため [_baseForHybrid] の「最短 option」基準ではこちらが選ばれてしまうが、
    /// 徒歩最大化の勝者は徒歩14分の [busDoorToDoor] の方。corridor は北へ迂回させて
    /// （lat [detourLat]）、どちらの corridor を基準にしたかを照会ログで判別できるようにする。
    Map<String, dynamic> detourBus() => {
      'journey': {
        'departureSecs': busDep,
        'arrivalSecs': busDep + 960, // 16分乗車
        'durationSecs': 960,
        'accessWalkSecs': 0,
        'egressWalkSecs': 0,
        'legs': [
          {
            'kind': 'transit',
            'mode': 'bus',
            'routeName': 'バス02',
            'from': _station('bs:n0', 'N停留所'),
            'to': _station('bs:n1', 'M停留所'),
            'departureSecs': busDep,
            'arrivalSecs': busDep + 960,
          },
        ],
      },
      'map': {
        'points': const [],
        'segments': [
          _mapSeg('transit', 'bs:n0', 'bs:n1', 'gtfsShape', const [
            [35.0, 139.0],
            [detourLat, 139.06],
            [35.0, 139.127],
          ]),
        ],
      },
    };

    /// バス許容照会（コリドー点起点）が返す単一バス便。[at] 以降で最も早い便として
    /// 09:15、それを過ぎていれば [at]+5分に発車する。乗車駅探索・実時刻検証の引き直し用。
    /// [busSpeed] を渡すと実ダイヤだけを遅くできる（見積りは [trainMetersPerMinute] のまま）。
    Map<String, dynamic> busLegFrom(
      GeoPoint from,
      GeoPoint to,
      DateTime at, {
      double? busSpeed,
    }) {
      final atSecs = at.hour * 3600 + at.minute * 60;
      final dep = atSecs <= busDep ? busDep : atSecs + 300;
      final arr = dep + rideMin(from, to, busSpeed) * 60;
      return {
        'journey': {
          'departureSecs': dep,
          'arrivalSecs': arr,
          'durationSecs': arr - dep,
          'accessWalkSecs': 0,
          'egressWalkSecs': 0,
          'legs': [
            {
              'kind': 'transit',
              'mode': 'bus',
              'routeName': 'バス01',
              'from': _station('bs:x', 'X停留所'),
              'to': _station('bs:y', 'Y停留所'),
              'departureSecs': dep,
              'arrivalSecs': arr,
            },
          ],
        },
        'map': {
          'points': const [],
          'segments': [
            _mapSeg('transit', 'bs:x', 'bs:y', 'gtfsShape', [
              [from.lat, from.lng],
              [to.lat, to.lng],
            ]),
          ],
        },
      };
    }

    /// all-walk のみ（電車のみ照会をコリドー点から引いたとき＝引き直し失敗の表現）。
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

    /// [withDetourBus] を立てると last-resort が [detourBus] も返す（勝者でない最短 option）。
    /// [busSpeed] は引き直し便の実ダイヤ速度（既定は見積りと同速）。
    http.Client corridorMock({
      List<Uri>? log,
      bool withDetourBus = false,
      double? busSpeed,
    }) => MockClient((req) async {
      log?.add(req.url);
      final path = req.url.path;
      if (path.contains('googleWalkMatrixProxy')) return _matrixFor(req.url);
      if (path.contains('googleWalkProxy')) return _walkFor(req.url);
      if (path.contains('guidance/plan')) {
        final q = req.url.queryParameters;
        final allowsBus = !(q['avoidModes'] ?? '').contains('bus');
        final from = _pt(q['from']!.replaceFirst('geo:', ''));
        final to = _pt(q['to']!.replaceFirst('geo:', ''));
        final hm = (q['time'] ?? '09:00').split(':');
        final at = DateTime(2026, 6, 27, int.parse(hm[0]), int.parse(hm[1]));
        // 迂回 corridor は lat が違うので、緯度も含めて origin 起点かを判定する。
        final fromOrigin =
            (from.lat - busOrigin.lat).abs() < 1e-9 &&
            (from.lng - busOrigin.lng).abs() < 1e-9;
        final body = _guidance([
          if (allowsBus)
            if (fromOrigin) ...[
              busDoorToDoor(),
              if (withDetourBus) detourBus(),
            ] else
              busLegFrom(from, to, at, busSpeed: busSpeed)
          else if (fromOrigin)
            slowTrainOption()
          else
            walkOnlyOption(),
        ]);
        body['date'] = q['date'];
        return _json(body);
      }
      return _json(const {}, 404);
    });

    /// guidance/plan のうち、コリドー点（origin 以外）を起点にしたバス許容照会。
    Iterable<Uri> corridorBusQueries(List<Uri> log) => log.where(
      (u) =>
          u.path.contains('guidance/plan') &&
          !(u.queryParameters['avoidModes'] ?? '').contains('bus') &&
          u.queryParameters['from'] != 'geo:${busOrigin.lat},${busOrigin.lng}',
    );

    Future<RoutePlan> runPlan(http.Client client) => _service(client).plan(
      destination: '目的地',
      destinationLatLng: busGoal,
      departure: const TimeValue(h: 9, m: 0),
      arrival: const TimeValue(h: 10, m: 5), // 予算65分
      origin: busOrigin,
    );

    test('バスが last-resort で勝つとき、手前のバス停で降りて歩く候補を選ぶ', () async {
      // door-to-door のバス（徒歩14分・到着36分）は予算65分に対し29分も余らせる。
      // バス corridor をハイブリッド化できれば、139.11 のバス停で降りて19分歩く候補
      // （徒歩33分・到着52分）が作れる。train-only ガードのままだとこれが生成されず、
      // 徒歩14分の乗り通しが確定してしまう。
      final plan = await runPlan(corridorMock());
      final walkMin = plan.segments
          .where((s) => s.type == SegmentType.walk)
          .fold(0, (a, s) => a + s.minutes);

      expect(
        plan.segments.where((s) => s.type == SegmentType.bus),
        isNotEmpty,
        reason: 'last-resort のバスは残る',
      );
      expect(
        plan.segments.last.type,
        SegmentType.walk,
        reason: '手前のバス停で降りて goal まで歩く',
      );
      expect(
        plan.segments.last.minutes,
        greaterThan(0),
        reason: '降車後の徒歩が0分ならバスに乗り通している',
      );
      expect(
        walkMin,
        greaterThan(14),
        reason: 'door-to-door バス（徒歩14分）より歩く候補を選ぶべき',
      );
      expect(plan.totalMin, lessThanOrEqualTo(plan.budgetMin));
    });

    test('バス corridor 起点の引き直しはバスを許容する', () async {
      final log = <Uri>[];
      await runPlan(corridorMock(log: log));
      // origin 起点のバス許容照会は last-resort（#250）そのものなので除く。コリドー点
      // （バス停）を起点にした照会が出て初めて、バス corridor が徒歩最大化の基準になっている。
      expect(
        corridorBusQueries(log),
        isNotEmpty,
        reason: 'origin 以外（バス停）を起点にバス許容で引き直しているはず',
      );
    });

    test('基準にするのは最短のバス option ではなく徒歩最大化で勝ったバス option', () async {
      // last-resort が2本返す: 徒歩0分・16分乗車の迂回バス（総所要が最短）と、徒歩14分・
      // 21分乗車の door-to-door バス（総所要35分）。徒歩最大化が選ぶのは後者だが、
      // base を「最短の option」で決めると前者の corridor（北へ迂回・lat 35.02）を
      // 引き直してしまい、乗車バス停探索が勝者と無関係な停留所を評価して空振りする。
      final log = <Uri>[];
      final plan = await runPlan(corridorMock(log: log, withDetourBus: true));

      final fromDetour = corridorBusQueries(
        log,
      ).where((u) => u.queryParameters['from']!.startsWith('geo:$detourLat,'));
      expect(fromDetour, isEmpty, reason: '勝者でない迂回バスの corridor を基準にしてはならない');
      final fromWinner = corridorBusQueries(
        log,
      ).where((u) => u.queryParameters['from']!.startsWith('geo:35.0,'));
      expect(
        fromWinner,
        isNotEmpty,
        reason: '勝ったバス option の corridor 上のバス停から引き直すはず',
      );
      expect(
        plan.segments.last.type,
        SegmentType.walk,
        reason: '勝者 corridor で徒歩最大化できているので手前で降りて歩く',
      );
      expect(plan.totalMin, lessThanOrEqualTo(plan.budgetMin));
    });

    test('バスの実ダイヤが見積りより遅ければ ハイブリッドは実時刻検証で落ち乗り通しへ戻る', () async {
      // 見積りは楽観側（[trainMetersPerMinute]）に倒し、実速度の遅さは採用前の
      // [_resolveBoardingTimes] が実時刻で上書きして弾く、という #251 の設計の裏取り。
      // 実ダイヤを半速にすると 139.11 で降りる候補は到着70分（予算65分）で除外され、
      // 予算内で確実に乗れる door-to-door の乗り通しへ安全に戻る。
      final plan = await runPlan(
        corridorMock(busSpeed: trainMetersPerMinute / 2),
      );
      final walkMin = plan.segments
          .where((s) => s.type == SegmentType.walk)
          .fold(0, (a, s) => a + s.minutes);

      expect(plan.segments.last.type, SegmentType.bus, reason: '乗り通しへ戻る');
      expect(walkMin, 14, reason: 'door-to-door バスのアクセス徒歩そのもの');
      expect(
        plan.totalMin,
        lessThanOrEqualTo(plan.budgetMin),
        reason: '遅いハイブリッドを掴んで予算超過してはならない',
      );
    });

    test('電車が予算内なら バス corridor 化は起きずバス許容照会も出ない', () async {
      // #249 の train-only ガード維持。09:15 発の電車で予算内に収まるので last-resort は
      // 発火せず、コリドー引き直しは常に avoidModes=bus のまま。
      final log = <Uri>[];
      final svc = _service(
        _mock(
          transit: _guidance([_singleTrainOption(dep: 33300, arr: 35100)]),
          log: log,
        ),
      );
      final plan = await svc.plan(
        destination: '新宿',
        destinationLatLng: goal,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 9, m: 50),
        origin: origin,
      );
      expect(plan.segments.where((s) => s.type == SegmentType.bus), isEmpty);
      final busAware = log.where(
        (u) =>
            u.path.contains('guidance/plan') &&
            !(u.queryParameters['avoidModes'] ?? '').contains('bus'),
      );
      expect(busAware, isEmpty, reason: '電車 corridor の引き直しはバスを除外したまま');
    });
  });

  // 確定境界（best-effort 縮退・enrich ループの確定パス）で、実測徒歩による乗り遅れを
  // 再判定する（#254）。選定時の乗り遅れ判定は guidance 見積り徒歩に対して走るが、確定直前の
  // enrich が徒歩を Google 実街路へ伸ばすため、そこで初めて発車後に駅着＝乗れない便になり得る。
  group('plan: 確定境界の乗り遅れ再判定 (#254)', () {
    final departureAt = DateTime(2026, 6, 27, 9, 0);

    test('best-effort 縮退は実測徒歩で乗り遅れる経路を確定しない', () async {
      // 既定の _singleTrainOption() は 09:06 発・見積りアクセス徒歩5分だが、map の walk polyline
      // を実測すると8分（09:08 着）＝発車済み。予算50分では全徒歩(69分)も電車も予算内に入らず
      // best-effort へ縮退する。_bestEffort は enrich 前の segments で firstMissedTransit を
      // 見るため見積り5分では乗り遅れず、そのまま enrich して「乗れない電車」を確定していた。
      final svc = _service(_mock(transit: _guidance([_singleTrainOption()])));
      final plan = await svc.plan(
        destination: '新宿',
        destinationLatLng: goal,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 9, m: 50), // 予算50分（何も予算内に入らない）
        origin: origin,
      );
      expect(
        firstMissedTransit(plan.segments, departureAt),
        isNull,
        reason: '実測徒歩で発車後に駅着する便を best-effort で確定してはならない',
      );
    });

    /// 停車駅2点だけの単一電車 option。コリドーが痩せてハイブリッド候補が作られないため、
    /// enrich ループのプールは「標準乗換 ＋ 全徒歩」の2件になる。
    Map<String, dynamic> twoStopOption() {
      const stops = [
        [35.6812, 139.7671], // 東京（origin から直線徒歩8分）
        [35.6909, 139.7003], // 新宿（goal のほぼ隣）
      ];
      return {
        'journey': {
          'departureSecs': 32760, // 09:06
          'arrivalSecs': 34560, // 09:36
          'durationSecs': 2400,
          'accessWalkSecs': 300, // 見積り徒歩5分（実測は8分×factor）
          'egressWalkSecs': 60,
          'legs': [
            _railLeg(
              route: '中央線快速',
              fromId: 'jr:Tokyo',
              fromName: '東京',
              toId: 'jr:Shinjuku',
              toName: '新宿',
              dep: 32760,
              arr: 34560,
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

    test('プールが1件に痩せても enrich 実測の乗り遅れを素通りさせない', () async {
      // 予算75分。全徒歩は見積り69分で予算内＝徒歩最大として真っ先に選ばれるが、実測（×1.3）で
      // 90分へ伸び予算超過して落ちる。残る標準乗換1件は見積り徒歩5分で 09:06 発に間に合うのに、
      // 実測徒歩10分では発車後に駅着する。enrich ループは `pool.length > 1` のときしか除外できず、
      // 1件に痩せたこの候補を missedAfterEnrich のまま確定していた。
      final svc = _service(
        _mock(transit: _guidance([twoStopOption()]), walkFactor: 1.3),
      );
      final plan = await svc.plan(
        destination: '新宿',
        destinationLatLng: goal,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 10, m: 15), // 予算75分
        origin: origin,
      );
      expect(
        firstMissedTransit(plan.segments, departureAt),
        isNull,
        reason: 'プールが1件でも乗り遅れる便を確定してはならない',
      );
    });

    test('乗り遅れ候補が試行上限より多くても全徒歩まで縮退しきる', () async {
      // best-effort の除外ループに試行上限（_maxEnrichAttempts=8）を置くと、乗り遅れ候補が
      // それより多いとき全徒歩へ到達する前に打ち切られ、乗り遅れる便を確定してしまう。
      // 「全徒歩は決して乗り遅れないので縮退先は必ず存在する」という #254 の不変条件は、
      // 上限を置かない（プールが1件に痩せるまで回す）ことでしか成立しない。
      // 09:06 発・実測徒歩8分で乗り遅れる電車を9本並べ、上限を確実に踏み抜かせる。
      final svc = _service(
        _mock(
          transit: _guidance([
            for (var i = 0; i < 9; i++)
              _singleTrainOption(arr: 34560 + i * 60), // 到着だけずらし全便が乗り遅れ
          ]),
        ),
      );
      final plan = await svc.plan(
        destination: '新宿',
        destinationLatLng: goal,
        departure: const TimeValue(h: 9, m: 0),
        arrival: const TimeValue(h: 9, m: 50), // 予算50分（何も予算内に入らない）
        origin: origin,
      );
      expect(
        firstMissedTransit(plan.segments, departureAt),
        isNull,
        reason: '乗り遅れ候補を数で押しても乗れない便を確定してはならない',
      );
      expect(
        plan.segments.every((s) => s.type == SegmentType.walk),
        isTrue,
        reason: '乗れる電車が1本も無いのだから全徒歩へ縮退するはず',
      );
    });
  });

  group('plan: パレート非劣解の代替案 (#290)', () {
    const o = GeoPoint(35.0, 139.000);
    const g = GeoPoint(35.0, 139.100);
    final departureAt = DateTime(2026, 6, 27, 9, 0);

    /// 電車1本の標準 option。既定では transit の map polyline を1点だけにして corridor を
    /// 痩せさせ、ハイブリッド・board-search の生成を封じる（プール＝標準候補＋全徒歩に固定。
    /// [withCorridor] で乗降2点の corridor を持たせられる）。
    /// dep/arr を null にすると時刻なし transit（幽霊便疑い）になる。
    Map<String, dynamic> opt({
      required String line,
      required double boardLon,
      required double alightLon,
      int? dep,
      int? arr,
      required int accessSecs,
      required int egressSecs,
      bool withCorridor = false,
    }) => {
      'journey': {
        'departureSecs': ?dep,
        'arrivalSecs': ?arr,
        'durationSecs': (arr ?? 0) - (dep ?? 0) + accessSecs + egressSecs,
        'accessWalkSecs': accessSecs,
        'egressWalkSecs': egressSecs,
        'legs': [
          {
            'kind': 'transit',
            'mode': 'rail',
            'routeName': line,
            'from': _station('$line:board', '$line乗車'),
            'to': _station('$line:alight', '$line降車'),
            'departureSecs': ?dep,
            'arrivalSecs': ?arr,
          },
        ],
      },
      'map': {
        'points': const [],
        'segments': [
          _mapSeg('walk', 'origin', '$line:board', 'osmWalk', [
            [35.0, 139.000],
            [35.0, boardLon],
          ]),
          _mapSeg('transit', '$line:board', '$line:alight', 'stopOrder', [
            [35.0, boardLon],
            if (withCorridor) [35.0, alightLon],
          ]),
          _mapSeg('walk', '$line:alight', 'destination', 'estimatedWalk', [
            [35.0, alightLon],
            [35.0, 139.100],
          ]),
        ],
      },
    };

    // 勝者（徒歩最大・予算内）: 徒歩11+6=17分・実到着46分。
    Map<String, dynamic> winner() => opt(
      line: '快速W',
      boardLon: 139.010,
      alightLon: 139.095,
      dep: 33300, // 09:15（徒歩11分→09:11着→待ち4分）
      arr: 34800, // 09:40
      accessSecs: 660,
      egressSecs: 360,
    );

    // 早着・徒歩少の非劣解: 徒歩2+2=4分・実到着27分。
    Map<String, dynamic> altEarly() => opt(
      line: '各停E',
      boardLon: 139.002,
      alightLon: 139.098,
      dep: 32700, // 09:05（徒歩2分→09:02着→待ち3分）
      arr: 33900, // 09:25
      accessSecs: 120,
      egressSecs: 120,
    );

    // 中間の非劣解: 徒歩8+2=10分・実到着34分。
    Map<String, dynamic> altMid() => opt(
      line: '準急M',
      boardLon: 139.007,
      alightLon: 139.0985,
      dep: 33000, // 09:10（徒歩8分→09:08着→待ち2分）
      arr: 34320, // 09:32
      accessSecs: 480,
      egressSecs: 120,
    );

    // 乗り遅れ候補: 09:01発だが徒歩2分で09:02駅着＝発車後。楽観到着18分・徒歩3分で
    // 全候補の実到着最早＝パレートフィルタ単体なら必ず先頭で選ばれる位置に置く。
    Map<String, dynamic> missedGhost() => opt(
      line: '幽霊G',
      boardLon: 139.002,
      alightLon: 139.099,
      dep: 32460, // 09:01
      arr: 33360, // 09:16
      accessSecs: 120,
      egressSecs: 60,
    );

    // 時刻なし transit 候補: dep/arr 欠落＋polyline 1点で引き直しでも検証不能。
    // 楽観到着3分・徒歩3分で実到着最早＝パレートフィルタ単体なら必ず選ばれる位置。
    Map<String, dynamic> timelessGhost() => opt(
      line: '時刻なしU',
      boardLon: 139.002,
      alightLon: 139.099,
      accessSecs: 120,
      egressSecs: 60,
    );

    // 4本目の非劣解: 徒歩9+4=13分・実到着41分。E・M より遅いが徒歩は多い（トレードオフ）。
    // パレート上位3件（到着昇順）からは漏れる位置＝検証落ちの補充でだけ現れる。
    Map<String, dynamic> altLate() => opt(
      line: '準々L',
      boardLon: 139.008,
      alightLon: 139.0965,
      dep: 33060, // 09:11（徒歩9分→09:09着→待ち2分）
      arr: 34620, // 09:37
      accessSecs: 540,
      egressSecs: 240,
    );

    // 見積りでは最早（楽観到着3分・徒歩3分）だが、実発車時刻の解決で 09:15発（先頭 option
    // の便）が当たり実測到着41分へ膨らむ時刻なし候補。実測後は E(27,徒歩4)・M(34,徒歩10)
    // に厳密支配される＝見積りベースの選出だけでは劣った候補を提示してしまう位置に置く。
    Map<String, dynamic> estimatedFastGhost() => opt(
      line: '見積早U',
      boardLon: 139.002,
      alightLon: 139.099,
      accessSecs: 120,
      egressSecs: 60,
      withCorridor: true, // polyline 2点＝引き直しで実時刻が解決できる
    );

    Future<RoutePlan> planWith(
      http.Client client, {
      TimeValue arrival = const TimeValue(h: 10, m: 0), // 予算60分
    }) {
      final svc = _service(client);
      return svc.plan(
        destination: '目的地',
        destinationLatLng: g,
        departure: const TimeValue(h: 9, m: 0),
        arrival: arrival,
        origin: o,
        originName: '出発',
      );
    }

    test('非劣解の代替案を到着昇順で返し、予算超過の全徒歩は載せない', () async {
      // プール: 勝者(46分,徒歩17) / 各停E(27分,徒歩4) / 準急M(34分,徒歩10) /
      // 全徒歩(114分,徒歩114)。E・M・全徒歩は互いに非劣解でパレート選出されるが、
      // 全徒歩は予算60分を超えるため検証で落ちる（予算チェックの退行はここで赤くなる）。
      final plan = await planWith(
        _mock(transit: _guidance([altEarly(), winner(), altMid()])),
      );

      // 勝者は徒歩最大の快速W。
      expect(
        plan.segments.any((s) => s.line == '快速W'),
        isTrue,
        reason: '徒歩最大の快速Wが確定経路になるはず',
      );

      expect(plan.alternatives, hasLength(2));
      expect(plan.alternatives[0].segments.any((s) => s.line == '各停E'), isTrue);
      expect(plan.alternatives[1].segments.any((s) => s.line == '準急M'), isTrue);
      expect(plan.alternatives.map((a) => a.totalMin).toList(), [27, 34]);
      for (final alt in plan.alternatives) {
        expect(alt.totalMin, lessThanOrEqualTo(alt.budgetMin));
        expect(
          alt.segments.any((s) => s.type != SegmentType.walk),
          isTrue,
          reason: '予算超過の全徒歩(114分)が代替案に混入してはならない',
        );
        expect(alt.alternatives, isEmpty, reason: '代替案は入れ子にしない');
      }
    });

    test('乗り遅れ候補は実到着最早（パレート選出確実）でも代替案に載せない', () async {
      // 幽霊G は楽観到着18分＝プール最早で、パレートフィルタ単体なら必ず選ばれる。
      // firstMissedTransit の検証を退行させるとGが代替案へ現れ、このテストが赤くなる
      // （#250 の教訓: 除外対象を最早に置かないフィルタテストは偽陽性になる）。
      final plan = await planWith(
        _mock(transit: _guidance([missedGhost(), winner(), altEarly()])),
      );

      expect(plan.alternatives, hasLength(1));
      expect(
        plan.alternatives.single.segments.any((s) => s.line == '各停E'),
        isTrue,
      );
      for (final alt in plan.alternatives) {
        expect(
          alt.segments.any((s) => s.line == '幽霊G'),
          isFalse,
          reason: '発車後に駅着する便を代替案として提示してはならない',
        );
        expect(firstMissedTransit(alt.segments, departureAt), isNull);
      }
    });

    test('時刻なし transit 候補は実到着最早でも代替案に載せない', () async {
      // 時刻なしU は楽観到着3分＝プール最早で、パレートフィルタ単体なら必ず選ばれる。
      // hasUnverifiedTransit の検証を退行させるとUが代替案へ現れ、このテストが赤くなる。
      final plan = await planWith(
        _mock(transit: _guidance([timelessGhost(), winner(), altEarly()])),
      );

      expect(plan.alternatives, hasLength(1));
      expect(
        plan.alternatives.single.segments.any((s) => s.line == '各停E'),
        isTrue,
      );
      for (final alt in plan.alternatives) {
        expect(alt.segments.any((s) => s.line == '時刻なしU'), isFalse);
        expect(
          alt.segments.every(
            (s) => s.type == SegmentType.walk || s.depTime != null,
          ),
          isTrue,
          reason: '実発車時刻を確認できない便を代替案として提示してはならない',
        );
      }
    });

    test('代替案の enrich 失敗（壊れた応答）は確定経路の返却をブロックしない', () async {
      // 各停E のアクセス徒歩（goal=35.0,139.002）だけ壊れた形の応答を返す。勝者の
      // enrich は正常に通り、E は検証中の例外で黙って落ちる。例外の握りを外すと
      // plan() 自体が失敗してこのテストが赤くなる。
      final transit = _guidance([winner(), altEarly()]);
      final client = MockClient((req) async {
        final path = req.url.path;
        if (path.contains('googleWalkMatrixProxy')) return _matrixFor(req.url);
        if (path.contains('googleWalkProxy')) {
          if (req.url.queryParameters['goal'] == '35.0,139.002') {
            return _json({'routes': <String, dynamic>{}}); // List でない壊れた形
          }
          return _walkFor(req.url);
        }
        if (path.contains('guidance/plan')) return _json(transit);
        return _json(const {}, 404);
      });

      final plan = await planWith(client);

      expect(plan.segments.any((s) => s.line == '快速W'), isTrue);
      expect(
        plan.alternatives.any((a) => a.segments.any((s) => s.line == '各停E')),
        isFalse,
        reason: '検証に失敗した候補は黙って落とす',
      );
    });

    test('best-effort 縮退では予算チェックのみ緩和し、乗り遅れは緩和しない', () async {
      // 予算25分では全候補が予算外→best-effort（実到着最早の各停E=27分）へ縮退。
      // 代替案も予算チェックだけ緩和され、快速W(46分)と全徒歩(114分)が非劣解として
      // 載る。幽霊G（楽観到着18分＝最早でパレート選出確実）は緩和後も乗り遅れで除外。
      final plan = await planWith(
        _mock(transit: _guidance([missedGhost(), winner(), altEarly()])),
        arrival: const TimeValue(h: 9, m: 25), // 予算25分
      );

      // 勝者は「今夜乗れる」範囲の実到着最早（各停E）。
      expect(plan.segments.any((s) => s.line == '各停E'), isTrue);
      expect(plan.totalMin, 27);

      expect(plan.alternatives, hasLength(2));
      // 予算超過でも非劣解なら載る（勝者と同じ緩和）。
      expect(plan.alternatives[0].segments.any((s) => s.line == '快速W'), isTrue);
      expect(plan.alternatives[0].totalMin, 46);
      expect(
        plan.alternatives[1].segments.every((s) => s.type == SegmentType.walk),
        isTrue,
        reason: '全徒歩(114分)も非劣解（徒歩最大端）として残る',
      );
      // 乗り遅れの緩和はしない。
      for (final alt in plan.alternatives) {
        expect(alt.segments.any((s) => s.line == '幽霊G'), isFalse);
        expect(firstMissedTransit(alt.segments, departureAt), isNull);
      }
    });

    test('検証で落ちた選出枠は次点の非劣解から補充する（レビュー指摘①）', () async {
      // フロント（到着昇順）: 幽霊G(18,徒歩3)→E(27,4)→M(34,10)→準々L(41,13)。
      // 上位3件だけ検証すると幽霊G が乗り遅れで落ちて2件に痩せるが、プールには検証可能な
      // 次点 L が残っている。補充が無いと「他の候補」が本来より疎になる。
      final plan = await planWith(
        _mock(
          transit: _guidance([
            missedGhost(),
            winner(),
            altEarly(),
            altMid(),
            altLate(),
          ]),
        ),
      );

      expect(plan.alternatives, hasLength(3));
      expect(plan.alternatives.map((a) => a.totalMin).toList(), [27, 34, 41]);
      expect(
        plan.alternatives[2].segments.any((s) => s.line == '準々L'),
        isTrue,
        reason: '検証落ち（幽霊G）の枠は次点の非劣解 L で補充されるはず',
      );
      for (final alt in plan.alternatives) {
        expect(alt.segments.any((s) => s.line == '幽霊G'), isFalse);
      }
    });

    test('実測で他の代替案に厳密支配された候補は提示しない（レビュー指摘②）', () async {
      // 見積早U は見積り（楽観到着3分・徒歩3分）ではフロント先頭だが、実発車時刻の解決で
      // 実測到着41分・徒歩3分になり、検証済みの E(27,4)・M(34,10) に厳密支配される。
      // 見積りベースの選出結果をそのまま返すと「あらゆる軸で劣る候補」を提示してしまう。
      final plan = await planWith(
        _mock(
          transit: _guidance([
            winner(),
            altEarly(),
            altMid(),
            estimatedFastGhost(),
          ]),
        ),
      );

      expect(
        plan.alternatives.any((a) => a.segments.any((s) => s.line == '見積早U')),
        isFalse,
        reason: '実測後に厳密支配される候補（(41,3) vs E(27,4)/M(34,10)）を提示してはならない',
      );
      expect(plan.alternatives, hasLength(2));
      expect(plan.alternatives.map((a) => a.totalMin).toList(), [27, 34]);
    });
  });
}
