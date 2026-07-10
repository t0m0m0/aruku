import '../../l10n/app_localizations.dart';
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
  arrive,
  board,
  alight,
}

/// [maneuver] のローカライズ済みラベル。UI 層（BuildContext を持つ側）で
/// AppLocalizations を解決してから呼び出す。
String maneuverLabel(AppLocalizations l10n, NavManeuver maneuver) =>
    switch (maneuver) {
      NavManeuver.straight => l10n.navManeuverStraight,
      NavManeuver.slightLeft => l10n.navManeuverSlightLeft,
      NavManeuver.slightRight => l10n.navManeuverSlightRight,
      NavManeuver.left => l10n.navManeuverLeft,
      NavManeuver.right => l10n.navManeuverRight,
      NavManeuver.arrive => l10n.navManeuverArrive,
      NavManeuver.board => l10n.navManeuverBoardGeneric,
      NavManeuver.alight => l10n.navManeuverAlightGeneric,
    };

/// 現在地から算出したナビ表示状態。
class NavGuidance {
  const NavGuidance({
    required this.progress,
    required this.totalKm,
    required this.traveledKm,
    required this.remainingKm,
    required this.remainingWalkKm,
    required this.distanceToNextTurnM,
    required this.currentManeuver,
    required this.nextManeuver,
    required this.distanceToNextTurnNextM,
    required this.etaMinutesRemaining,
    required this.consumedKcal,
    required this.offRouteMeters,
    required this.isOnTrainSegment,
    this.currentLine,
    this.currentStationName,
    this.nextLine,
    this.nextStationName,
  });

  /// 0–1 の進捗率。
  final double progress;

  /// 合計距離（km）。route.totalKm（API由来）ではなく、traveledKm/remainingKm
  /// と同じポリライン実測値から算出し、三者の合計不一致を防ぐ。
  final double totalKm;
  final double traveledKm;
  final double remainingKm;

  /// 残りの徒歩距離（km）。[remainingKm] は電車区間を含む全行程の残りだが、
  /// 歩行アプリの文脈では「あと何km歩くか」が重要なため、未走破の徒歩区間
  /// のみを合算した値を別に持つ。徒歩のみ経路では [remainingKm] と一致する。
  final double remainingWalkKm;

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

  /// [currentManeuver] が [NavManeuver.board]/[NavManeuver.alight] のときの路線名。
  final String? currentLine;

  /// [currentManeuver] が [NavManeuver.board]/[NavManeuver.alight] のときの駅名
  /// （乗車なら乗車駅、下車なら降車駅）。
  final String? currentStationName;

  /// [nextManeuver] が [NavManeuver.board]/[NavManeuver.alight] のときの路線名。
  final String? nextLine;

  /// [nextManeuver] が [NavManeuver.board]/[NavManeuver.alight] のときの駅名。
  final String? nextStationName;
}

/// 曲がりとして認識する最小角度。これ未満は直進扱い。
const double _turnThresholdDeg = 25;

/// 「曲がり」と「斜め」を分ける角度。
const double _sharpThresholdDeg = 50;

class _Maneuver {
  const _Maneuver(
    this.maneuver,
    this.distanceAlong, {
    this.line,
    this.stationName,
  });
  final NavManeuver maneuver;
  final double distanceAlong;

  /// [NavManeuver.board]/[NavManeuver.alight] のときの路線名・駅名。
  final String? line;
  final String? stationName;
}

class _FlatPath {
  const _FlatPath(this.points, this.walkPoint, this.segIndex);

  /// 全区間を連結した頂点列。
  final List<GeoPoint> points;

  /// 各頂点が徒歩区間由来か（kcal 按分用）。
  final List<bool> walkPoint;

  /// 各頂点が由来する route.segments のインデックス（ETA の区間按分用）。
  final List<int> segIndex;
}

/// [route] のジオメトリと [current] から表示用のナビ状態を算出する。
///
/// [previousDistanceAlongMeters] を渡すと、自己交差・並走区間での
/// スナップジャンプを避けるため直前位置との連続性を優先する
/// （[snapToPolyline] 参照）。
NavGuidance computeGuidance({
  required RoutePlan route,
  required GeoPoint current,
  double? previousDistanceAlongMeters,
}) {
  final flat = _flatten(route);
  final pts = flat.points;

  if (pts.length < 2) {
    return NavGuidance(
      progress: 0,
      totalKm: route.totalKm,
      traveledKm: 0,
      remainingKm: route.totalKm,
      remainingWalkKm: route.walkKm,
      distanceToNextTurnM: 0,
      currentManeuver: NavManeuver.arrive,
      nextManeuver: null,
      distanceToNextTurnNextM: null,
      etaMinutesRemaining: route.totalMin,
      consumedKcal: 0,
      offRouteMeters: 0,
      isOnTrainSegment: false,
      currentLine: null,
      currentStationName: null,
      nextLine: null,
      nextStationName: null,
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

  final snap = snapToPolyline(
    pts,
    current,
    previousDistanceAlongMeters: previousDistanceAlongMeters,
  );
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
  final remainingWalk = (totalWalk - traveledWalk).clamp(0.0, totalWalk);

  final elapsedMin = _elapsedMinutes(
    route: route,
    edgeLen: edgeLen,
    edgeSeg: flat.segIndex,
    s: s,
  );
  final etaMinutesRemaining = (route.totalMin - elapsedMin).clamp(
    0.0,
    route.totalMin.toDouble(),
  );

  // 曲がり地点・乗車/下車地点を距離順にマージし、末尾に arrive を必ず付ける。
  final events =
      [
          ..._maneuvers(pts, edgeLen, flat.walkPoint),
          ..._trainEvents(route, pts, edgeLen, flat.segIndex),
        ]
        ..sort((a, b) => a.distanceAlong.compareTo(b.distanceAlong))
        ..add(_Maneuver(NavManeuver.arrive, totalLen));

  var k = events.indexWhere((e) => e.distanceAlong > s + 1.0);
  if (k < 0) k = events.length - 1;
  final currentEvent = events[k];
  final isArrive = currentEvent.maneuver == NavManeuver.arrive;
  final next = isArrive ? null : events[k + 1];

  return NavGuidance(
    progress: progress,
    totalKm: totalLen / 1000,
    traveledKm: s / 1000,
    remainingKm: remaining / 1000,
    remainingWalkKm: remainingWalk / 1000,
    distanceToNextTurnM: (currentEvent.distanceAlong - s)
        .clamp(0, totalLen)
        .round(),
    currentManeuver: currentEvent.maneuver,
    nextManeuver: next?.maneuver,
    distanceToNextTurnNextM: next == null
        ? null
        : (next.distanceAlong - s).clamp(0, totalLen).round(),
    etaMinutesRemaining: etaMinutesRemaining.round(),
    consumedKcal: consumedKcal,
    offRouteMeters: snap.offsetMeters,
    isOnTrainSegment: !edgeWalk[snap.segmentIndex],
    currentLine: currentEvent.line,
    currentStationName: currentEvent.stationName,
    nextLine: next?.line,
    nextStationName: next?.stationName,
  );
}

_FlatPath _flatten(RoutePlan route) {
  final pts = <GeoPoint>[];
  final walk = <bool>[];
  final segIndex = <int>[];
  for (var i = 0; i < route.segments.length; i++) {
    final seg = route.segments[i];
    final isWalk = seg.type == SegmentType.walk;
    for (final p in seg.polyline) {
      pts.add(p);
      walk.add(isWalk);
      segIndex.add(i);
    }
  }
  return _FlatPath(pts, walk, segIndex);
}

/// 現在地までの走破距離 [s] から、区間ごとの実所要時間（[RouteSegment.minutes]）を
/// 積み上げて経過時間（分）を算出する。距離按分の進捗率をそのまま時間に使うと、
/// 徒歩より大幅に速い電車区間で ETA が実態と乖離するため、区間境界ごとに
/// その区間の実所要時間を計上し、現在滞在中の区間内でのみ距離按分する。
double _elapsedMinutes({
  required RoutePlan route,
  required List<double> edgeLen,
  required List<int> edgeSeg,
  required double s,
}) {
  final segLen = List<double>.filled(route.segments.length, 0.0);
  for (var i = 0; i < edgeLen.length; i++) {
    segLen[edgeSeg[i]] += edgeLen[i];
  }

  // route.totalMin は乗換待ちや実測到着時刻を含み、区間の minutes 合計と
  // 一致しないことがある（route_plan_builder._advance を参照）。区間間の
  // 相対的な所要時間比は保ったまま totalMin に正規化し、走破完了時に
  // 必ず 0 分へ収束するようにする。
  final rawSum = route.segments.fold<double>(0, (a, seg) => a + seg.minutes);
  final scale = rawSum == 0 ? 1.0 : route.totalMin / rawSum;

  var elapsed = 0.0;
  var segStart = 0.0;
  for (var i = 0; i < route.segments.length; i++) {
    final len = segLen[i];
    final segEnd = segStart + len;
    final minutes = route.segments[i].minutes * scale;
    if (s >= segEnd) {
      elapsed += minutes;
    } else if (s > segStart) {
      final frac = len == 0 ? 1.0 : ((s - segStart) / len).clamp(0.0, 1.0);
      elapsed += minutes * frac;
      break;
    } else {
      break;
    }
    segStart = segEnd;
  }
  return elapsed;
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

/// transit（電車・バス）区間の開始・終了地点に乗車/下車イベントを生成する。
List<_Maneuver> _trainEvents(
  RoutePlan route,
  List<GeoPoint> pts,
  List<double> edgeLen,
  List<int> segIndex,
) {
  final cumAtVertex = List<double>.filled(pts.length, 0.0);
  for (var j = 1; j < pts.length; j++) {
    cumAtVertex[j] = cumAtVertex[j - 1] + edgeLen[j - 1];
  }

  final out = <_Maneuver>[];
  for (var i = 0; i < route.segments.length; i++) {
    final seg = route.segments[i];
    switch (seg.type) {
      case SegmentType.walk:
        continue;
      case SegmentType.train:
      case SegmentType.bus:
        break;
    }
    final vertices = [
      for (var j = 0; j < segIndex.length; j++)
        if (segIndex[j] == i) j,
    ];
    if (vertices.isEmpty) continue;
    out.add(
      _Maneuver(
        NavManeuver.board,
        cumAtVertex[vertices.first],
        line: seg.line,
        stationName: seg.fromName,
      ),
    );
    out.add(
      _Maneuver(
        NavManeuver.alight,
        cumAtVertex[vertices.last],
        line: seg.line,
        stationName: seg.toName,
      ),
    );
  }
  return out;
}
