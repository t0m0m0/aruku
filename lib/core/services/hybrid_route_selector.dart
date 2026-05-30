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
///
/// [origin] と [goal] を渡すと、電車区間が出発地より進行方向の後方（目的地と逆）へ
/// [maxBacktrackRatio] × 直線距離(origin→goal) を超えて戻る「逆戻り迂回」候補を
/// 選定前に除外する（例: 蒲田→川崎→品川 の川崎経由）。全候補が逆戻りなら除外せず
/// 従来どおり最短へ縮退する。[origin]/[goal] 未指定時は方向フィルタを掛けない。
RouteCandidate selectBestRoute({
  required List<RouteCandidate> candidates,
  required int budgetMin,
  GeoPoint? origin,
  GeoPoint? goal,
  double maxBacktrackRatio = 0.15,
}) {
  assert(candidates.isNotEmpty, 'candidates must not be empty');

  var pool = candidates;
  if (origin != null && goal != null) {
    final forward = pool
        .where((c) => !_isBacktrackDetour(c, origin, goal, maxBacktrackRatio))
        .toList();
    if (forward.isNotEmpty) pool = forward;
  }

  final within = pool.where((c) => c.totalMin <= budgetMin).toList();
  if (within.isNotEmpty) {
    return within.reduce((a, b) {
      if (a.walkMinutes != b.walkMinutes) {
        return a.walkMinutes > b.walkMinutes ? a : b;
      }
      return a.totalMin <= b.totalMin ? a : b;
    });
  }
  return pool.reduce((a, b) => a.totalMin <= b.totalMin ? a : b);
}

/// 候補の電車区間に、出発地より進行方向(origin→goal)の後方へ
/// [maxBacktrackRatio] × 直線距離(origin→goal) を超えて戻る駅を含むか。
/// 徒歩区間は判定しない（目的地へ近づくための短い徒歩を弾かないため）。
bool _isBacktrackDetour(
  RouteCandidate c,
  GeoPoint origin,
  GeoPoint goal,
  double maxBacktrackRatio,
) {
  final limit = -maxBacktrackRatio * haversineKm(origin, goal);
  for (final seg in c.segments) {
    if (seg.type != SegmentType.train) continue;
    for (final p in seg.polyline) {
      if (_advanceKm(origin, goal, p) < limit) return true;
    }
  }
  return false;
}

/// 点 [p] の、origin→goal 方向への射影長（km）。前方なら正、出発地より後方
/// （目的地と逆方向）なら負。余弦定理で origin→p ベクトルを origin→goal 方向へ
/// 射影して求める。origin と goal が同一点なら 0。
double _advanceKm(GeoPoint origin, GeoPoint goal, GeoPoint p) {
  final dog = haversineKm(origin, goal);
  if (dog == 0) return 0;
  final dop = haversineKm(origin, p);
  final dpg = haversineKm(p, goal);
  return (dop * dop + dog * dog - dpg * dpg) / (2 * dog);
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
