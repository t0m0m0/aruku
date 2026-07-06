import 'dart:math' as math;

import '../models/geo_point.dart';
import '../services/hybrid_route_selector.dart' show haversineKm;

/// 2点間の距離（メートル）。既存の [haversineKm] を再利用する。
double metersBetween(GeoPoint a, GeoPoint b) => haversineKm(a, b) * 1000;

/// [from] から [to] への初期方位（0–360 度、北=0・東=90）。
double bearingDegrees(GeoPoint from, GeoPoint to) {
  final lat1 = _toRad(from.lat);
  final lat2 = _toRad(to.lat);
  final dLng = _toRad(to.lng - from.lng);
  final y = math.sin(dLng) * math.cos(lat2);
  final x =
      math.cos(lat1) * math.sin(lat2) -
      math.sin(lat1) * math.cos(lat2) * math.cos(dLng);
  final deg = math.atan2(y, x) * 180 / math.pi;
  return (deg + 360) % 360;
}

/// 折れ線への投影結果。
class PolylineSnap {
  const PolylineSnap({
    required this.point,
    required this.segmentIndex,
    required this.distanceAlongMeters,
    required this.offsetMeters,
  });

  /// 折れ線上の最近接点。
  final GeoPoint point;

  /// 最近接の辺のインデックス（path[i]→path[i+1]）。
  final int segmentIndex;

  /// 折れ線始点から最近接点までの経路沿い距離（メートル）。
  final double distanceAlongMeters;

  /// 入力点から折れ線までの最短距離（メートル）。
  final double offsetMeters;
}

/// 直前スナップ位置から探索を絞り込む範囲（メートル、前後）。
/// 自己交差・並走区間で離れた辺へ飛ぶのを防ぐ。
const double _snapWindowMeters = 300.0;

/// ウィンドウ内探索の結果がこれを超えるオフセットなら、実際の逸脱・
/// 経路再計算直後などとみなしグローバル探索へフォールバックする。
const double _snapWindowFallbackOffsetMeters = 80.0;

/// [p] を折れ線 [path] に投影し、最近接点・経路沿い累積距離・逸脱距離を返す。
/// 投影は局所平面近似（等角）で行い、距離は [metersBetween] で算出する。
///
/// [previousDistanceAlongMeters] を渡すと、まずその前後
/// [_snapWindowMeters] の範囲内の辺のみから最近接点を探す。経路が自己交差・
/// 並走している場合でも、直前の進捗との連続性を優先することで、無関係な
/// 離れた地点へスナップして [PolylineSnap.distanceAlongMeters]（＝進捗）が
/// 前後にジャンプするのを防ぐ。ウィンドウ内の最良オフセットが
/// [_snapWindowFallbackOffsetMeters] を超える場合（実際に経路から外れた、
/// 履歴が無い等）は、従来どおり経路全体からのグローバル探索にフォールバック
/// する。
PolylineSnap snapToPolyline(
  List<GeoPoint> path,
  GeoPoint p, {
  double? previousDistanceAlongMeters,
}) {
  assert(path.length >= 2, 'path must have at least 2 points');

  final lat0 = _toRad(path.first.lat);
  final cosLat0 = math.cos(lat0);
  // 局所平面（メートル）への変換。経度は基準緯度の cos で縮める。
  (double, double) xy(GeoPoint g) =>
      (g.lng * _metersPerDeg * cosLat0, g.lat * _metersPerDeg);

  final (px, py) = xy(p);

  final edgeStart = <double>[];
  final edgeLen = <double>[];
  var cumulative = 0.0;
  for (var i = 0; i < path.length - 1; i++) {
    edgeStart.add(cumulative);
    final len = metersBetween(path[i], path[i + 1]);
    edgeLen.add(len);
    cumulative += len;
  }

  PolylineSnap? searchEdges(Iterable<int> indices) {
    var bestOffset = double.infinity;
    var bestAlong = 0.0;
    var bestIndex = 0;
    var bestPoint = path.first;

    for (final i in indices) {
      final a = path[i];
      final b = path[i + 1];
      final (ax, ay) = xy(a);
      final (bx, by) = xy(b);
      final abx = bx - ax;
      final aby = by - ay;
      final abLenSq = abx * abx + aby * aby;

      var t = abLenSq == 0
          ? 0.0
          : ((px - ax) * abx + (py - ay) * aby) / abLenSq;
      t = t.clamp(0.0, 1.0);

      final projX = ax + t * abx;
      final projY = ay + t * aby;
      final offset = math.sqrt(
        (px - projX) * (px - projX) + (py - projY) * (py - projY),
      );

      if (offset < bestOffset) {
        bestOffset = offset;
        bestAlong = edgeStart[i] + t * edgeLen[i];
        bestIndex = i;
        bestPoint = GeoPoint(
          a.lat + (b.lat - a.lat) * t,
          a.lng + (b.lng - a.lng) * t,
        );
      }
    }

    if (bestOffset.isInfinite) return null;
    return PolylineSnap(
      point: bestPoint,
      segmentIndex: bestIndex,
      distanceAlongMeters: bestAlong,
      offsetMeters: bestOffset,
    );
  }

  if (previousDistanceAlongMeters != null) {
    final lo = previousDistanceAlongMeters - _snapWindowMeters;
    final hi = previousDistanceAlongMeters + _snapWindowMeters;
    final windowIndices = [
      for (var i = 0; i < edgeLen.length; i++)
        if (edgeStart[i] + edgeLen[i] >= lo && edgeStart[i] <= hi) i,
    ];
    final windowed = searchEdges(windowIndices);
    if (windowed != null &&
        windowed.offsetMeters <= _snapWindowFallbackOffsetMeters) {
      return windowed;
    }
  }

  return searchEdges(List.generate(path.length - 1, (i) => i))!;
}

const double _metersPerDeg = 111320.0;

double _toRad(double deg) => deg * math.pi / 180;
