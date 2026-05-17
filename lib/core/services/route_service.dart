import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../config/app_config.dart';
import '../models/geo_point.dart';
import '../models/route_plan.dart';
import '../models/time_value.dart';

/// ルート計算の進捗段階。ローディング表示の3ステップに対応する。
enum RoutePhase { routing, walkability, building }

abstract interface class RouteService {
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
    void Function(RoutePhase)? onProgress,
  });
}

class RouteException implements Exception {
  const RouteException(this.status);
  final String status;

  @override
  String toString() => 'RouteException($status)';
}

/// Google エンコード済みポリラインを座標列へデコードする。
List<GeoPoint> decodePolyline(String encoded) {
  final points = <GeoPoint>[];
  var index = 0;
  var lat = 0;
  var lng = 0;

  int next() {
    var shift = 0;
    var result = 0;
    while (index < encoded.length) {
      final b = encoded.codeUnitAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
      if (b < 0x20) break;
    }
    return (result & 1) != 0 ? ~(result >> 1) : (result >> 1);
  }

  while (index < encoded.length) {
    lat += next();
    lng += next();
    points.add(GeoPoint(lat / 1e5, lng / 1e5));
  }
  return points;
}

/// Directions API（プロキシ経由）で予算内かつ徒歩比率最大のルートを生成する。
class GoogleRouteService implements RouteService {
  GoogleRouteService({
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

  static const _kcalPerKm = 57;

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
    final dest = destinationLatLng != null
        ? '${destinationLatLng.lat},${destinationLatLng.lng}'
        : destination;
    if (dest == null || dest.isEmpty) {
      throw const RouteException('NO_DESTINATION');
    }
    final originStr = '${origin.lat},${origin.lng}';
    final budgetMin = arrival.totalMinutes - departure.totalMinutes;

    onProgress?.call(RoutePhase.routing);

    // 段階1: 全徒歩。予算内なら徒歩100%が最良。
    final walking = _toCandidate(
      _firstRoute(
        await _fetch({
          'origin': originStr,
          'destination': dest,
          'mode': 'walking',
        }),
      ),
    );
    if (walking.totalMin <= budgetMin) {
      onProgress?.call(RoutePhase.walkability);
      onProgress?.call(RoutePhase.building);
      return _toPlan(walking, departure, budgetMin);
    }

    // 段階2: transit + alternatives。予算内かつ徒歩比率最大を選ぶ。
    final transit = await _fetch({
      'origin': originStr,
      'destination': dest,
      'mode': 'transit',
      'alternatives': 'true',
      'departure_time': _departureEpoch(departure).toString(),
    });
    final candidates = (transit['routes'] as List<dynamic>)
        .map((r) => _toCandidate(r as Map<String, dynamic>))
        .toList();
    if (candidates.isEmpty) throw const RouteException('ZERO_RESULTS');

    onProgress?.call(RoutePhase.walkability);

    final withinBudget = candidates
        .where((c) => c.totalMin <= budgetMin)
        .toList();
    final chosen = withinBudget.isNotEmpty
        ? withinBudget.reduce((a, b) => a.walkRatio >= b.walkRatio ? a : b)
        // 段階3: 予算内が無ければ徒歩を含む全候補から最短（ベストエフォート）。
        : [
            walking,
            ...candidates,
          ].reduce((a, b) => a.totalMin <= b.totalMin ? a : b);

    onProgress?.call(RoutePhase.building);
    return _toPlan(chosen, departure, budgetMin);
  }

  Future<Map<String, dynamic>> _fetch(Map<String, String> params) async {
    final uri = Uri.parse(
      '$_proxyBaseUrl/directionsProxy',
    ).replace(queryParameters: params);
    final res = await _client.get(uri);
    if (res.statusCode != 200) {
      throw RouteException('HTTP ${res.statusCode}');
    }
    final body = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    final status = body['status'];
    if (status != 'OK') {
      throw RouteException(status is String ? status : 'UNKNOWN');
    }
    return body;
  }

  Map<String, dynamic> _firstRoute(Map<String, dynamic> body) {
    final routes = body['routes'] as List<dynamic>;
    if (routes.isEmpty) throw const RouteException('ZERO_RESULTS');
    return routes.first as Map<String, dynamic>;
  }

  _Candidate _toCandidate(Map<String, dynamic> route) {
    final leg = (route['legs'] as List<dynamic>).first as Map<String, dynamic>;
    final from = leg['start_address'] as String? ?? '出発地';
    final to = leg['end_address'] as String? ?? '目的地';
    final segments = <RouteSegment>[];

    for (final s in leg['steps'] as List<dynamic>) {
      final step = s as Map<String, dynamic>;
      final meters = (step['distance'] as Map)['value'] as int;
      final seconds = (step['duration'] as Map)['value'] as int;
      final km = meters / 1000.0;
      final minutes = (seconds / 60).round();
      final poly = decodePolyline(
        (step['polyline'] as Map?)?['points'] as String? ?? '',
      );

      if (step['travel_mode'] == 'TRANSIT') {
        final td = step['transit_details'] as Map<String, dynamic>;
        segments.add(
          RouteSegment(
            type: SegmentType.train,
            fromName: (td['departure_stop'] as Map)['name'] as String,
            toName: (td['arrival_stop'] as Map)['name'] as String,
            minutes: minutes,
            km: km,
            line: (td['line'] as Map)['name'] as String?,
            stops: td['num_stops'] as int?,
            polyline: poly,
          ),
        );
      } else {
        segments.add(
          RouteSegment(
            type: SegmentType.walk,
            fromName: from,
            toName: to,
            minutes: minutes,
            km: km,
            kcal: (km * _kcalPerKm).round(),
            polyline: poly,
          ),
        );
      }
    }

    // 徒歩区間の前後名称を隣接境界へ補正する。
    for (var i = 0; i < segments.length; i++) {
      if (segments[i].type != SegmentType.walk) continue;
      final fromName = i == 0 ? from : segments[i - 1].toName;
      final toName = i == segments.length - 1 ? to : segments[i + 1].fromName;
      segments[i] = RouteSegment(
        type: SegmentType.walk,
        fromName: fromName,
        toName: toName,
        minutes: segments[i].minutes,
        km: segments[i].km,
        kcal: segments[i].kcal,
        polyline: segments[i].polyline,
      );
    }

    return _Candidate(from: from, to: to, segments: segments);
  }

  RoutePlan _toPlan(_Candidate c, TimeValue departure, int budgetMin) {
    final totalKm = c.segments.fold<double>(0, (a, s) => a + (s.km ?? 0));
    final walkKm = c.segments
        .where((s) => s.type == SegmentType.walk)
        .fold<double>(0, (a, s) => a + (s.km ?? 0));
    final totalMin = c.segments.fold<int>(0, (a, s) => a + s.minutes);
    final kcal = c.segments
        .where((s) => s.type == SegmentType.walk)
        .fold<int>(0, (a, s) => a + (s.kcal ?? 0));

    final nodes = <TimelineNode>[
      TimelineNode(time: _fmt(departure, 0), place: c.from, sub: '出発'),
    ];
    var cum = 0;
    for (var i = 0; i < c.segments.length; i++) {
      final seg = c.segments[i];
      cum += seg.minutes;
      final isLast = i == c.segments.length - 1;
      nodes.add(
        TimelineNode(
          time: _fmt(departure, cum),
          place: isLast ? c.to : seg.toName,
          sub: isLast
              ? (totalMin <= budgetMin ? '到着 · 制限内 ✓' : '到着')
              : (seg.type == SegmentType.train ? (seg.line ?? '電車') : '徒歩へ'),
        ),
      );
    }

    return RoutePlan(
      from: c.from,
      to: c.to,
      totalKm: totalKm,
      totalMin: totalMin,
      budgetMin: budgetMin,
      kcal: kcal,
      walkKm: walkKm,
      walkRatio: totalKm == 0 ? 0 : walkKm / totalKm,
      segments: c.segments,
      timelineNodes: nodes,
    );
  }

  int _departureEpoch(TimeValue t) {
    final now = _clock();
    var dt = DateTime(now.year, now.month, now.day, t.h, t.m);
    // 過去時刻だと transit が劣化/エラーになるため翌日扱いにする。
    if (dt.isBefore(now)) dt = dt.add(const Duration(days: 1));
    return dt.millisecondsSinceEpoch ~/ 1000;
  }

  String _fmt(TimeValue dep, int addMinutes) {
    final total = dep.h * 60 + dep.m + addMinutes;
    final h = (total ~/ 60) % 24;
    final m = total % 60;
    return '$h:${m.toString().padLeft(2, '0')}';
  }
}

class _Candidate {
  _Candidate({required this.from, required this.to, required this.segments});

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

final routeServiceProvider = Provider<RouteService>((ref) {
  final client = http.Client();
  ref.onDispose(client.close);
  return GoogleRouteService(client: client);
});
