import 'dart:convert';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/hybrid_route_selector.dart'
    show haversineKm;
import 'package:aruku/core/services/route_plan_builder.dart'
    show walkMetersPerMinute;
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
}
