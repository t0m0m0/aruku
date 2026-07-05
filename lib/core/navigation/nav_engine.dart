import '../geo/geo_math.dart';
import '../models/geo_point.dart';
import '../models/route_plan.dart';

/// ナビの曲がり案内種別。
enum NavManeuver {
  straight,
  slightLeft,
  slightRight,
  left,
  right,
  arrive;

  String get label => switch (this) {
    NavManeuver.straight => '直進',
    NavManeuver.slightLeft => '斜め左',
    NavManeuver.slightRight => '斜め右',
    NavManeuver.left => '左折',
    NavManeuver.right => '右折',
    NavManeuver.arrive => 'まもなく到着',
  };
}

/// 現在地から算出したナビ表示状態。
class NavGuidance {
  const NavGuidance({
    required this.progress,
    required this.traveledKm,
    required this.remainingKm,
    required this.distanceToNextTurnM,
    required this.currentManeuver,
    required this.nextManeuver,
    required this.distanceToNextTurnNextM,
    required this.etaMinutesRemaining,
    required this.consumedKcal,
    required this.offRouteMeters,
    required this.isOnTrainSegment,
  });

  /// 0–1 の進捗率。
  final double progress;
  final double traveledKm;
  final double remainingKm;

  /// 次の曲がり地点までの距離（メートル）。
  final int distanceToNextTurnM;

  /// 次に行う操作。
  final NavManeuver currentManeuver;

  /// その次の操作（無ければ null）。
  final NavManeuver? nextManeuver;
  final int? distanceToNextTurnNextM;

  /// 到着までの残り時間（分）。
  final int etaMinutesRemaining;

  /// これまでに消費したカロリー（徒歩距離比で按分）。
  final int consumedKcal;

  /// 現在地から経路までの最短距離（メートル）。オフルート判定に使う。
  final double offRouteMeters;

  /// 現在地の最寄り区間が電車かどうか。電車区間はポリライン誤差が
  /// 大きく出やすいため、オフルート再検索の抑制に使う。
  final bool isOnTrainSegment;
}

/// 曲がりとして認識する最小角度。これ未満は直進扱い。
const double _turnThresholdDeg = 25;

/// 「曲がり」と「斜め」を分ける角度。
const double _sharpThresholdDeg = 50;

class _Maneuver {
  const _Maneuver(this.maneuver, this.distanceAlong);
  final NavManeuver maneuver;
  final double distanceAlong;
}

class _FlatPath {
  const _FlatPath(this.points, this.walkPoint);

  /// 全区間を連結した頂点列。
  final List<GeoPoint> points;

  /// 各頂点が徒歩区間由来か（kcal 按分用）。
  final List<bool> walkPoint;
}

/// [route] のジオメトリと [current] から表示用のナビ状態を算出する。
NavGuidance computeGuidance({
  required RoutePlan route,
  required GeoPoint current,
}) {
  final flat = _flatten(route);
  final pts = flat.points;

  if (pts.length < 2) {
    return NavGuidance(
      progress: 0,
      traveledKm: 0,
      remainingKm: route.totalKm,
      distanceToNextTurnM: 0,
      currentManeuver: NavManeuver.arrive,
      nextManeuver: null,
      distanceToNextTurnNextM: null,
      etaMinutesRemaining: route.totalMin,
      consumedKcal: 0,
      offRouteMeters: 0,
      isOnTrainSegment: false,
    );
  }

  // 辺の長さ・累積距離・徒歩フラグ。
  final edgeLen = <double>[];
  final edgeWalk = <bool>[];
  var totalLen = 0.0;
  for (var i = 0; i < pts.length - 1; i++) {
    final len = metersBetween(pts[i], pts[i + 1]);
    edgeLen.add(len);
    edgeWalk.add(flat.walkPoint[i] && flat.walkPoint[i + 1]);
    totalLen += len;
  }

  final snap = snapToPolyline(pts, current);
  final s = snap.distanceAlongMeters.clamp(0.0, totalLen);
  final progress = totalLen == 0 ? 0.0 : (s / totalLen).clamp(0.0, 1.0);
  final remaining = (totalLen - s).clamp(0.0, totalLen);

  // 徒歩距離の総和と走破済み徒歩距離 → kcal 按分。
  var totalWalk = 0.0;
  var traveledWalk = 0.0;
  var cum = 0.0;
  for (var i = 0; i < edgeLen.length; i++) {
    if (edgeWalk[i]) {
      totalWalk += edgeLen[i];
      final coveredEnd = s.clamp(cum, cum + edgeLen[i]);
      traveledWalk += (coveredEnd - cum).clamp(0.0, edgeLen[i]);
    }
    cum += edgeLen[i];
  }
  final consumedKcal = totalWalk == 0
      ? 0
      : (route.kcal * (traveledWalk / totalWalk)).round();

  // 曲がり地点（末尾に arrive を必ず付ける）。
  final events = _maneuvers(pts, edgeLen, flat.walkPoint)
    ..add(_Maneuver(NavManeuver.arrive, totalLen));

  var k = events.indexWhere((e) => e.distanceAlong > s + 1.0);
  if (k < 0) k = events.length - 1;
  final currentEvent = events[k];
  final isArrive = currentEvent.maneuver == NavManeuver.arrive;
  final next = isArrive ? null : events[k + 1];

  return NavGuidance(
    progress: progress,
    traveledKm: s / 1000,
    remainingKm: remaining / 1000,
    distanceToNextTurnM: (currentEvent.distanceAlong - s)
        .clamp(0, totalLen)
        .round(),
    currentManeuver: currentEvent.maneuver,
    nextManeuver: next?.maneuver,
    distanceToNextTurnNextM: next == null
        ? null
        : (next.distanceAlong - s).clamp(0, totalLen).round(),
    etaMinutesRemaining: (route.totalMin * (1 - progress)).round(),
    consumedKcal: consumedKcal,
    offRouteMeters: snap.offsetMeters,
    isOnTrainSegment: !edgeWalk[snap.segmentIndex],
  );
}

_FlatPath _flatten(RoutePlan route) {
  final pts = <GeoPoint>[];
  final walk = <bool>[];
  for (final seg in route.segments) {
    final isWalk = seg.type == SegmentType.walk;
    for (final p in seg.polyline) {
      pts.add(p);
      walk.add(isWalk);
    }
  }
  return _FlatPath(pts, walk);
}

/// 連続する辺の方位差から曲がり地点を抽出する。
/// ターン案内は徒歩区間のみを対象にし、電車などの線形カーブは除外する。
List<_Maneuver> _maneuvers(
  List<GeoPoint> pts,
  List<double> edgeLen,
  List<bool> walk,
) {
  final out = <_Maneuver>[];
  var cum = 0.0;
  for (var i = 1; i < pts.length - 1; i++) {
    cum += edgeLen[i - 1];
    if (edgeLen[i - 1] == 0 || edgeLen[i] == 0) continue;
    // 前後の辺がともに徒歩のときだけ曲がりとして扱う。
    if (!(walk[i - 1] && walk[i] && walk[i + 1])) continue;
    final b1 = bearingDegrees(pts[i - 1], pts[i]);
    final b2 = bearingDegrees(pts[i], pts[i + 1]);
    final diff = ((b2 - b1 + 540) % 360) - 180; // 正=右, 負=左
    final mag = diff.abs();
    if (mag < _turnThresholdDeg) continue;
    final right = diff > 0;
    final maneuver = mag >= _sharpThresholdDeg
        ? (right ? NavManeuver.right : NavManeuver.left)
        : (right ? NavManeuver.slightRight : NavManeuver.slightLeft);
    out.add(_Maneuver(maneuver, cum));
  }
  return out;
}
