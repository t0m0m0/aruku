import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config/app_config.dart';
import '../models/geo_point.dart';
import '../models/route_plan.dart';
import '../models/time_value.dart';
import 'hybrid_route_selector.dart';
import 'route_plan_builder.dart';
import 'route_service.dart';

/// NAVITIME route_transit（プロキシ経由）から、予算内で徒歩を最大化するルートを
/// 生成する。標準乗換経路に加え、途中駅まで歩いて乗車するハイブリッド経路を候補化する。
class NaviTimeRouteService implements RouteService {
  NaviTimeRouteService({
    http.Client? client,
    String? proxyBaseUrl,
    DateTime Function()? clock,
  }) : _client = client ?? http.Client(),
       _clock = clock ?? DateTime.now,
       _proxyBaseUrl = (proxyBaseUrl ?? AppConfig.proxyBaseUrl).replaceAll(
         RegExp(r'/+$'),
         '',
       );

  final http.Client _client;
  final String _proxyBaseUrl;
  final DateTime Function() _clock;

  /// ハイブリッド候補駅の評価上限（= 徒歩 API 呼び出し回数の上限）。
  static const int _maxHybridCandidates = 6;

  @override
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
    void Function(RoutePhase)? onProgress,
  }) async {
    if (_proxyBaseUrl.isEmpty) throw const RouteException('NO_PROXY');
    if (origin == null) throw const RouteException('NO_ORIGIN');
    // NAVITIME route_transit / route_walk は座標が前提（地名のみは非対応）。
    if (destinationLatLng == null) {
      throw const RouteException('NO_DESTINATION');
    }
    final budgetMin = budgetMinutes(departure, arrival);

    onProgress?.call(RoutePhase.routing);

    final body = await _fetchTransit(origin, destinationLatLng, departure);
    final items = body['items'] as List<dynamic>? ?? const [];
    if (items.isEmpty) throw const RouteException('ZERO_RESULTS');

    final parsed = items
        .map((e) => _parseTransit(e as Map<String, dynamic>))
        .toList();

    onProgress?.call(RoutePhase.walkability);

    final candidates = <RouteCandidate>[
      for (final p in parsed) p.toCandidate(),
    ];

    // 全徒歩。予算内なら徒歩 100% が最良のためハイブリッド探索を省く。
    final fullWalk = await _tryWalk(
      origin,
      destinationLatLng,
      fromName: parsed.first.from,
      toName: parsed.first.to,
    );
    if (fullWalk != null) {
      candidates.add(fullWalk);
      if (fullWalk.totalMin <= budgetMin) {
        return _build(
          selectBestRoute(candidates: candidates, budgetMin: budgetMin),
          departure,
          budgetMin,
          onProgress,
        );
      }
    }

    // 途中駅まで歩いて乗車するハイブリッド候補を追加する。
    final base = _baseForHybrid(parsed);
    if (base != null) {
      candidates.addAll(
        await _buildHybrids(base, origin, destinationLatLng, budgetMin),
      );
    }

    return _build(
      selectBestRoute(candidates: candidates, budgetMin: budgetMin),
      departure,
      budgetMin,
      onProgress,
    );
  }

  RoutePlan _build(
    RouteCandidate chosen,
    TimeValue departure,
    int budgetMin,
    void Function(RoutePhase)? onProgress,
  ) {
    onProgress?.call(RoutePhase.building);
    return buildRoutePlan(
      from: chosen.from,
      to: chosen.to,
      segments: chosen.segments,
      departure: departure,
      budgetMin: budgetMin,
    );
  }

  /// 停車駅タイムラインを持つ最短の標準経路をハイブリッドの基準にする。
  _TransitParse? _baseForHybrid(List<_TransitParse> parsed) {
    _TransitParse? best;
    for (final p in parsed) {
      if (p.stops.length < 2) continue;
      if (best == null || p.totalMin < best.totalMin) best = p;
    }
    return best;
  }

  /// 基準経路の停車駅から「乗車駅 b → 降車駅 a（b より後方）」の全分割を候補化する。
  /// 各駅で origin→駅 と 駅→goal の徒歩を取得し、乗車時間は時刻表の差で求める。
  /// これにより乗車を後ろ倒し（徒歩を増やす）したり、手前で降りて目的地まで歩く
  /// 候補が同じ土俵に並ぶ。徒歩 API の呼び出しは [_maxHybridCandidates] 駅でキャップ。
  Future<List<RouteCandidate>> _buildHybrids(
    _TransitParse base,
    GeoPoint origin,
    GeoPoint goal,
    int budgetMin,
  ) async {
    final stops = base.stops;
    final indices = _sampleIndices(stops.length, _maxHybridCandidates);

    // 各停車駅の origin→駅 / 駅→goal 徒歩を並列取得（座標でキャッシュ）。
    final originCache = <String, Future<RouteCandidate?>>{};
    final goalCache = <String, Future<RouteCandidate?>>{};
    Future<RouteCandidate?> originWalk(_Stop s) => originCache.putIfAbsent(
      _key(s.coord),
      () => _tryWalk(origin, s.coord, fromName: base.from, toName: s.name),
    );
    Future<RouteCandidate?> goalWalk(_Stop s) => goalCache.putIfAbsent(
      _key(s.coord),
      () => _tryWalk(s.coord, goal, fromName: s.name, toName: base.to),
    );

    final fromOrigin = <int, RouteCandidate?>{};
    final toGoal = <int, RouteCandidate?>{};
    await Future.wait([
      for (final i in indices)
        originWalk(stops[i]).then((v) => fromOrigin[i] = v),
      for (final i in indices) goalWalk(stops[i]).then((v) => toGoal[i] = v),
    ]);

    final result = <RouteCandidate>[];
    for (final b in indices) {
      final walk1 = fromOrigin[b]?.segments.first;
      if (walk1 == null) continue;
      for (final a in indices) {
        if (a <= b) continue;
        // 乗換をまたぐ b→a は単一乗車として表現できない（路線・乗換・運賃を
        // 誤る）ため、同一乗車区間内のペアのみ候補化する。
        if (stops[a].section != stops[b].section) continue;
        final walk2 = toGoal[a]?.segments.first;
        if (walk2 == null) continue;
        final ride = _minutesBetween(stops[a].arr, stops[b].dep);
        if (ride < 0) continue;
        final segments = <RouteSegment>[
          if (walk1.minutes > 0) walk1,
          RouteSegment(
            type: SegmentType.train,
            fromName: stops[b].name,
            toName: stops[a].name,
            minutes: ride,
            km: _railKm(stops, b, a),
            line: stops[b].line,
            stops: a - b,
          ),
          if (walk2.minutes > 0) walk2,
        ];
        result.add(
          RouteCandidate(from: base.from, to: base.to, segments: segments),
        );
      }
    }
    return result;
  }

  /// 乗車区間 [b]→[a]（同一区間・連続インデックス）の距離概算。途中停車駅を
  /// 結ぶ折れ線長で、始終点の直線距離より実鉄道距離に近い値を返す。
  double _railKm(List<_Stop> stops, int b, int a) {
    var km = 0.0;
    for (var i = b; i < a; i++) {
      km += haversineKm(stops[i].coord, stops[i + 1].coord);
    }
    return km;
  }

  String _key(GeoPoint p) => '${p.lat},${p.lng}';

  /// [n] 個の停車駅から最大 [cap] 個を等間隔に抽出する（両端を含む）。
  List<int> _sampleIndices(int n, int cap) {
    if (n <= cap) return [for (var i = 0; i < n; i++) i];
    final out = <int>{};
    for (var k = 0; k < cap; k++) {
      out.add((k * (n - 1) / (cap - 1)).round());
    }
    return out.toList()..sort();
  }

  Future<Map<String, dynamic>> _fetchTransit(
    GeoPoint origin,
    GeoPoint goal,
    TimeValue departure,
  ) => _fetch('navitimeProxy', {
    'start': '${origin.lat},${origin.lng}',
    'goal': '${goal.lat},${goal.lng}',
    'start_time': _startTime(departure),
    'options': 'railway_calling_at',
  });

  /// origin→dest の徒歩を Route(walk) で取得して単一の徒歩区間候補にする。
  /// 徒歩 API はハイブリッド探索の補助であり、失敗時は null（標準経路へ縮退）。
  Future<RouteCandidate?> _tryWalk(
    GeoPoint origin,
    GeoPoint dest, {
    required String fromName,
    required String toName,
  }) async {
    try {
      final body = await _fetch('navitimeWalkProxy', {
        'start': '${origin.lat},${origin.lng}',
        'goal': '${dest.lat},${dest.lng}',
      });
      final items = body['items'] as List<dynamic>? ?? const [];
      if (items.isEmpty) return null;
      final move =
          ((items.first as Map<String, dynamic>)['summary']
                  as Map<String, dynamic>?)?['move']
              as Map<String, dynamic>?;
      final minutes = (move?['time'] as num?)?.toInt();
      if (minutes == null) return null;
      final km = ((move?['distance'] as num?)?.toInt() ?? 0) / 1000.0;
      return RouteCandidate(
        from: fromName,
        to: toName,
        segments: [
          RouteSegment(
            type: SegmentType.walk,
            fromName: fromName,
            toName: toName,
            minutes: minutes,
            km: km,
            kcal: (km * kcalPerKm).round(),
          ),
        ],
      );
    } on RouteException {
      return null;
    }
  }

  Future<Map<String, dynamic>> _fetch(
    String path,
    Map<String, String> params,
  ) async {
    final uri = Uri.parse(
      '$_proxyBaseUrl/$path',
    ).replace(queryParameters: params);
    final res = await _client.get(uri);
    if (res.statusCode != 200) {
      throw RouteException('HTTP ${res.statusCode}');
    }
    return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  }

  _TransitParse _parseTransit(Map<String, dynamic> item) {
    final sections = (item['sections'] as List<dynamic>)
        .cast<Map<String, dynamic>>();
    final points = sections.where((s) => s['type'] == 'point').toList();
    final from = points.isNotEmpty
        ? (points.first['name'] as String? ?? '出発地')
        : '出発地';
    final to = points.isNotEmpty
        ? (points.last['name'] as String? ?? '目的地')
        : '目的地';

    String nameAt(int i) => sections[i]['name'] as String? ?? '';

    final segments = <RouteSegment>[];
    final stops = <_Stop>[];
    var trainSection = 0;

    for (var i = 0; i < sections.length; i++) {
      final sec = sections[i];
      if (sec['type'] != 'move') continue;
      final meters = (sec['distance'] as num?)?.toInt() ?? 0;
      final minutes = (sec['time'] as num?)?.toInt() ?? 0;
      final km = meters / 1000.0;
      final fromName = i > 0 ? nameAt(i - 1) : from;
      final toName = i + 1 < sections.length ? nameAt(i + 1) : to;

      if (sec['move'] == 'walk') {
        segments.add(
          RouteSegment(
            type: SegmentType.walk,
            fromName: fromName,
            toName: toName,
            minutes: minutes,
            km: km,
            kcal: (km * kcalPerKm).round(),
          ),
        );
      } else {
        final line = sec['line_name'] as String?;
        stops.addAll(_parseCalling(sec, line, trainSection));
        trainSection++;
        segments.add(
          RouteSegment(
            type: SegmentType.train,
            fromName: fromName,
            toName: toName,
            minutes: minutes,
            km: km,
            line: line,
            stops: (sec['stop_count'] as num?)?.toInt(),
            fare: (sec['fare'] as num?)?.toInt(),
          ),
        );
      }
    }

    return _TransitParse(from: from, to: to, segments: segments, stops: stops);
  }

  /// 電車区間の停車駅（座標・発着時刻が揃うもののみ）を順序通りに取得する。
  /// [line] はその区間から乗車する際の路線名、[section] は乗車区間の通し番号
  /// （乗換をまたぐペアを除外するために用いる）。
  List<_Stop> _parseCalling(
    Map<String, dynamic> trainSec,
    String? line,
    int section,
  ) {
    final transport = trainSec['transport'];
    final raw =
        (transport is Map ? transport['calling_at'] : null) ??
        trainSec['calling_at'];
    if (raw is! List) return const [];

    final out = <_Stop>[];
    for (final e in raw) {
      if (e is! Map) continue;
      final coord = e['coord'];
      final lat = coord is Map ? (coord['lat'] as num?)?.toDouble() : null;
      final lon = coord is Map
          ? ((coord['lon'] as num?) ?? (coord['lng'] as num?))?.toDouble()
          : null;
      final fromTime = DateTime.tryParse(e['from_time'] as String? ?? '');
      final toTime = DateTime.tryParse(e['to_time'] as String? ?? '');
      if (lat == null || lon == null || fromTime == null || toTime == null) {
        continue;
      }
      out.add(
        _Stop(
          name: e['name'] as String? ?? '',
          coord: GeoPoint(lat, lon),
          arr: fromTime,
          dep: toTime,
          line: line,
          section: section,
        ),
      );
    }
    return out;
  }

  int _minutesBetween(DateTime later, DateTime earlier) =>
      (later.difference(earlier).inSeconds / 60).round();

  /// 出発時刻を ISO8601 へ整形。dateOffset（isNow→0）で日付を決定する。
  String _startTime(TimeValue t) {
    final now = _clock();
    final dt = DateTime(
      now.year,
      now.month,
      now.day,
      t.h,
      t.m,
    ).add(Duration(days: effectiveOffset(t)));
    final y = dt.year.toString().padLeft(4, '0');
    final mo = dt.month.toString().padLeft(2, '0');
    final d = dt.day.toString().padLeft(2, '0');
    final h = dt.hour.toString().padLeft(2, '0');
    final mi = dt.minute.toString().padLeft(2, '0');
    return '$y-$mo-${d}T$h:$mi:00';
  }
}

/// 解析済みの標準乗換経路。ハイブリッド構築に必要な停車駅タイムラインを保持する。
class _TransitParse {
  _TransitParse({
    required this.from,
    required this.to,
    required this.segments,
    required this.stops,
  });

  final String from;
  final String to;
  final List<RouteSegment> segments;

  /// 経路上の全電車区間の停車駅を出発側から順に並べたもの。
  final List<_Stop> stops;

  int get totalMin => segments.fold(0, (a, s) => a + s.minutes);

  RouteCandidate toCandidate() =>
      RouteCandidate(from: from, to: to, segments: segments);
}

/// 経路上の停車駅。乗車・降車の候補点になる。
class _Stop {
  _Stop({
    required this.name,
    required this.coord,
    required this.arr,
    required this.dep,
    required this.line,
    required this.section,
  });

  final String name;
  final GeoPoint coord;

  /// この駅への到着時刻（降車に使用）。
  final DateTime arr;

  /// この駅からの発車時刻（乗車に使用）。
  final DateTime dep;

  /// この駅から乗車する際の路線名。
  final String? line;

  /// この駅が属する乗車区間の通し番号。乗換をまたぐ駅は番号が異なる。
  final int section;
}
