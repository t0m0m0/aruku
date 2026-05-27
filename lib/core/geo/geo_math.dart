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

/// [p] を折れ線 [path] に投影し、最近接点・経路沿い累積距離・逸脱距離を返す。
/// 投影は局所平面近似（等角）で行い、距離は [metersBetween] で算出する。
PolylineSnap snapToPolyline(List<GeoPoint> path, GeoPoint p) {
  assert(path.length >= 2, 'path must have at least 2 points');

  final lat0 = _toRad(path.first.lat);
  final cosLat0 = math.cos(lat0);
  // 局所平面（メートル）への変換。経度は基準緯度の cos で縮める。
  (double, double) xy(GeoPoint g) =>
      (g.lng * _metersPerDeg * cosLat0, g.lat * _metersPerDeg);

  final (px, py) = xy(p);

  var bestOffset = double.infinity;
  var bestAlong = 0.0;
  var bestIndex = 0;
  var bestPoint = path.first;
  var cumulative = 0.0;

  for (var i = 0; i < path.length - 1; i++) {
    final a = path[i];
    final b = path[i + 1];
    final (ax, ay) = xy(a);
    final (bx, by) = xy(b);
    final abx = bx - ax;
    final aby = by - ay;
    final abLenSq = abx * abx + aby * aby;
    final edgeMeters = metersBetween(a, b);

    var t = abLenSq == 0 ? 0.0 : ((px - ax) * abx + (py - ay) * aby) / abLenSq;
    t = t.clamp(0.0, 1.0);

    final projX = ax + t * abx;
    final projY = ay + t * aby;
    final offset = math.sqrt(
      (px - projX) * (px - projX) + (py - projY) * (py - projY),
    );

    if (offset < bestOffset) {
      bestOffset = offset;
      bestAlong = cumulative + t * edgeMeters;
      bestIndex = i;
      bestPoint = GeoPoint(
        a.lat + (b.lat - a.lat) * t,
        a.lng + (b.lng - a.lng) * t,
      );
    }
    cumulative += edgeMeters;
  }

  return PolylineSnap(
    point: bestPoint,
    segmentIndex: bestIndex,
    distanceAlongMeters: bestAlong,
    offsetMeters: bestOffset,
  );
}

const double _metersPerDeg = 111320.0;

double _toRad(double deg) => deg * math.pi / 180;
