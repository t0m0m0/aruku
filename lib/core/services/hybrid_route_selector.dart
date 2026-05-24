import 'dart:math' as math;

import '../models/geo_point.dart';
import '../models/route_plan.dart';

/// 経路候補（全徒歩・ハイブリッド・標準乗換のいずれか）。データ源に依存しない。
class RouteCandidate {
  const RouteCandidate({
    required this.from,
    required this.to,
    required this.segments,
  });

  final String from;
  final String to;
  final List<RouteSegment> segments;

  int get totalMin => segments.fold(0, (a, s) => a + s.minutes);

  int get walkMinutes => segments
      .where((s) => s.type == SegmentType.walk)
      .fold(0, (a, s) => a + s.minutes);

  double get totalKm => segments.fold<double>(0, (a, s) => a + (s.km ?? 0));

  double get walkKm => segments
      .where((s) => s.type == SegmentType.walk)
      .fold<double>(0, (a, s) => a + (s.km ?? 0));
}

/// 予算内で「徒歩時間最大」の候補を選ぶ。予算内が無ければ最短（ベストエフォート）。
///
/// 全徒歩・ハイブリッド・標準乗換を同一の土俵で比較するため、全徒歩が予算内なら
/// 自然に徒歩最大として選ばれる。同徒歩なら合計の短い方を優先する。
RouteCandidate selectBestRoute({
  required List<RouteCandidate> candidates,
  required int budgetMin,
}) {
  assert(candidates.isNotEmpty, 'candidates must not be empty');

  final within = candidates.where((c) => c.totalMin <= budgetMin).toList();
  if (within.isNotEmpty) {
    return within.reduce((a, b) {
      if (a.walkMinutes != b.walkMinutes) {
        return a.walkMinutes > b.walkMinutes ? a : b;
      }
      return a.totalMin <= b.totalMin ? a : b;
    });
  }
  return candidates.reduce((a, b) => a.totalMin <= b.totalMin ? a : b);
}

const double _earthRadiusKm = 6371.0088;

/// 2点間の大圏距離（km）。徒歩区間の距離概算に用いる。
double haversineKm(GeoPoint a, GeoPoint b) {
  final lat1 = _toRad(a.lat);
  final lat2 = _toRad(b.lat);
  final dLat = _toRad(b.lat - a.lat);
  final dLng = _toRad(b.lng - a.lng);
  final h =
      math.sin(dLat / 2) * math.sin(dLat / 2) +
      math.cos(lat1) * math.cos(lat2) * math.sin(dLng / 2) * math.sin(dLng / 2);
  return 2 * _earthRadiusKm * math.asin(math.min(1, math.sqrt(h)));
}

double _toRad(double deg) => deg * math.pi / 180;
