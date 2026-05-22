import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config/app_config.dart';
import '../models/geo_point.dart';
import '../models/route_plan.dart';
import '../models/time_value.dart';
import 'route_plan_builder.dart';
import 'route_service.dart';

/// NAVITIME route_transit（プロキシ経由）から徒歩比率最大・予算優先の
/// ルートを生成する。レスポンス → RoutePlan の変換は純粋関数に集約する。
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
    // NAVITIME route_transit は座標 goal が前提（地名のみは非対応）。
    if (destinationLatLng == null) {
      throw const RouteException('NO_DESTINATION');
    }
    final budgetMin = budgetMinutes(departure, arrival);

    onProgress?.call(RoutePhase.routing);

    // start_time/goal_time は排他指定のため start_time のみ送り、
    // 予算はクライアント側で吸収する。
    final body = await _fetch({
      'start': '${origin.lat},${origin.lng}',
      'goal': '${destinationLatLng.lat},${destinationLatLng.lng}',
      'start_time': _startTime(departure),
    });

    final items = body['items'] as List<dynamic>? ?? const [];
    if (items.isEmpty) throw const RouteException('ZERO_RESULTS');

    final candidates = items
        .map((e) => _toCandidate(e as Map<String, dynamic>))
        .toList();

    onProgress?.call(RoutePhase.walkability);

    final withinBudget = candidates
        .where((c) => c.totalMin <= budgetMin)
        .toList();
    final chosen = withinBudget.isNotEmpty
        ? withinBudget.reduce((a, b) => a.walkRatio >= b.walkRatio ? a : b)
        : candidates.reduce((a, b) => a.totalMin <= b.totalMin ? a : b);

    onProgress?.call(RoutePhase.building);
    return buildRoutePlan(
      from: chosen.from,
      to: chosen.to,
      segments: chosen.segments,
      departure: departure,
      budgetMin: budgetMin,
    );
  }

  Future<Map<String, dynamic>> _fetch(Map<String, String> params) async {
    final uri = Uri.parse(
      '$_proxyBaseUrl/navitimeProxy',
    ).replace(queryParameters: params);
    final res = await _client.get(uri);
    if (res.statusCode != 200) {
      throw RouteException('HTTP ${res.statusCode}');
    }
    return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  }

  _NaviCandidate _toCandidate(Map<String, dynamic> item) {
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

    return _NaviCandidate(from: from, to: to, segments: segments);
  }

  /// 出発時刻を ISO8601（秒なし区切り）へ整形。過去時刻は翌日扱いにする。
  String _startTime(TimeValue t) {
    final now = _clock();
    var dt = DateTime(now.year, now.month, now.day, t.h, t.m);
    if (dt.isBefore(now)) dt = dt.add(const Duration(days: 1));
    final y = dt.year.toString().padLeft(4, '0');
    final mo = dt.month.toString().padLeft(2, '0');
    final d = dt.day.toString().padLeft(2, '0');
    final h = dt.hour.toString().padLeft(2, '0');
    final mi = dt.minute.toString().padLeft(2, '0');
    return '$y-$mo-${d}T$h:$mi:00';
  }
}

class _NaviCandidate {
  _NaviCandidate({
    required this.from,
    required this.to,
    required this.segments,
  });

  final String from;
  final String to;
  final List<RouteSegment> segments;

  int get totalMin => segments.fold(0, (a, s) => a + s.minutes);
  double get _totalKm => segments.fold<double>(0, (a, s) => a + (s.km ?? 0));
  double get _walkKm => segments
      .where((s) => s.type == SegmentType.walk)
      .fold<double>(0, (a, s) => a + (s.km ?? 0));
  double get walkRatio => _totalKm == 0 ? 0 : _walkKm / _totalKm;
}
