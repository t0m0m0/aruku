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

  /// 標準乗換経路のうち、途中駅候補を持つ最短経路をハイブリッドの基準にする。
  _TransitParse? _baseForHybrid(List<_TransitParse> parsed) {
    _TransitParse? best;
    for (final p in parsed) {
      if (p.firstTrainIndex < 0 || p.calling.length < 3) continue;
      if (best == null || p.totalMin < best.totalMin) best = p;
    }
    return best;
  }

  /// 基準経路の途中停車駅を goal 側（=徒歩が長い側）から評価し、予算内に収まる
  /// 最初（=徒歩最大）の駅で打ち切る。評価数は [_maxHybridCandidates] でキャップ。
  Future<List<RouteCandidate>> _buildHybrids(
    _TransitParse base,
    GeoPoint origin,
    GeoPoint goal,
    int budgetMin,
  ) async {
    final calling = base.calling;
    final station0 = calling.first;
    final firstWalkMin = base.segments
        .take(base.firstTrainIndex)
        .fold<int>(0, (a, s) => a + s.minutes);

    final result = <RouteCandidate>[];
    var fetched = 0;
    for (var i = calling.length - 2; i >= 1; i--) {
      if (fetched >= _maxHybridCandidates) break;
      fetched++;
      final s = calling[i];
      final walk = await _tryWalk(
        origin,
        s.coord,
        fromName: base.from,
        toName: s.name,
      );
      if (walk == null) continue;

      final transitMin = transitMinutesFromStation(
        standardTotalMin: base.totalMin,
        firstWalkMin: firstWalkMin,
        rideSkipMin: _minutesBetween(s.toTime, station0.toTime),
      );
      final trainSeg = RouteSegment(
        type: SegmentType.train,
        fromName: s.name,
        toName: base.to,
        minutes: transitMin,
        km: haversineKm(s.coord, goal),
        line: base.firstTrainLine,
        stops: calling.length - 1 - i,
      );
      final hybrid = RouteCandidate(
        from: base.from,
        to: base.to,
        segments: [walk.segments.first, trainSeg],
      );
      result.add(hybrid);
      if (hybrid.totalMin <= budgetMin) break;
    }
    return result;
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
    var firstTrainIndex = -1;
    String? firstTrainLine;
    var calling = const <_Calling>[];

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
        if (firstTrainIndex < 0) {
          firstTrainIndex = segments.length;
          firstTrainLine = sec['line_name'] as String?;
          calling = _parseCalling(sec);
        }
        segments.add(
          RouteSegment(
            type: SegmentType.train,
            fromName: fromName,
            toName: toName,
            minutes: minutes,
            km: km,
            line: sec['line_name'] as String?,
            stops: (sec['stop_count'] as num?)?.toInt(),
            fare: (sec['fare'] as num?)?.toInt(),
          ),
        );
      }
    }

    return _TransitParse(
      from: from,
      to: to,
      segments: segments,
      firstTrainIndex: firstTrainIndex,
      firstTrainLine: firstTrainLine,
      calling: calling,
    );
  }

  /// 乗車列車の途中停車駅（座標・発着時刻が揃うもののみ）を取得する。
  List<_Calling> _parseCalling(Map<String, dynamic> trainSection) {
    final transport = trainSection['transport'];
    final raw =
        (transport is Map ? transport['calling_at'] : null) ??
        trainSection['calling_at'];
    if (raw is! List) return const [];

    final out = <_Calling>[];
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
        _Calling(
          name: e['name'] as String? ?? '',
          coord: GeoPoint(lat, lon),
          fromTime: fromTime,
          toTime: toTime,
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

/// 解析済みの標準乗換経路。ハイブリッド構築に必要な乗車列車情報を保持する。
class _TransitParse {
  _TransitParse({
    required this.from,
    required this.to,
    required this.segments,
    required this.firstTrainIndex,
    required this.firstTrainLine,
    required this.calling,
  });

  final String from;
  final String to;
  final List<RouteSegment> segments;
  final int firstTrainIndex;
  final String? firstTrainLine;
  final List<_Calling> calling;

  int get totalMin => segments.fold(0, (a, s) => a + s.minutes);

  RouteCandidate toCandidate() =>
      RouteCandidate(from: from, to: to, segments: segments);
}

/// 乗車列車の停車駅（途中駅含む）。
class _Calling {
  _Calling({
    required this.name,
    required this.coord,
    required this.fromTime,
    required this.toTime,
  });

  final String name;
  final GeoPoint coord;
  final DateTime fromTime;
  final DateTime toTime;
}
