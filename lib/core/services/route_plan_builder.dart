import '../models/route_plan.dart';
import '../models/time_value.dart';

/// 徒歩 1km あたりの消費カロリー。徒歩区間のみに適用する。
const int kcalPerKm = 57;

/// 徒歩の平均速度（分速メートル）。候補選定フェーズで直線距離から所要時間を
/// 概算するのに使う（不動産表示の慣行 80m/分）。確定経路の表示値は Google
/// Routes の実測へ上書きされる。
const double walkMetersPerMinute = 80.0;

/// isNow のときは dateOffset を無視して当日扱い。budget 計算と epoch で共有。
int effectiveOffset(TimeValue t) => t.isNow ? 0 : t.dateOffset;

/// 出発〜到着の予算（分）。日跨ぎ（dateOffset / isNow）を考慮する。
int budgetMinutes(TimeValue departure, TimeValue arrival) =>
    (arrival.totalMinutes + effectiveOffset(arrival) * 24 * 60) -
    (departure.totalMinutes + effectiveOffset(departure) * 24 * 60);

/// 出発時刻 + 経過分を "h:mm" へ整形（時は24で剰余）。
String formatClock(TimeValue dep, int addMinutes) {
  final total = dep.h * 60 + dep.m + addMinutes;
  final h = (total ~/ 60) % 24;
  final m = total % 60;
  return '$h:${m.toString().padLeft(2, '0')}';
}

/// 区間列から RoutePlan を構築する（合計距離・徒歩距離・kcal・徒歩比率・
/// タイムライン）。データ源（Google / NAVITIME）に依存しない純粋関数。
RoutePlan buildRoutePlan({
  required String from,
  required String to,
  required List<RouteSegment> segments,
  required TimeValue departure,
  required int budgetMin,
}) {
  final totalKm = segments.fold<double>(0, (a, s) => a + (s.km ?? 0));
  final walkKm = segments
      .where((s) => s.type == SegmentType.walk)
      .fold<double>(0, (a, s) => a + (s.km ?? 0));
  final totalMin = segments.fold<int>(0, (a, s) => a + s.minutes);
  final kcal = segments
      .where((s) => s.type == SegmentType.walk)
      .fold<int>(0, (a, s) => a + (s.kcal ?? 0));

  final nodes = <TimelineNode>[
    TimelineNode(time: formatClock(departure, 0), place: from, sub: '出発'),
  ];
  var cum = 0;
  for (var i = 0; i < segments.length; i++) {
    final seg = segments[i];
    cum += seg.minutes;
    final isLast = i == segments.length - 1;
    nodes.add(
      TimelineNode(
        time: formatClock(departure, cum),
        place: isLast ? to : seg.toName,
        sub: isLast
            ? (totalMin <= budgetMin ? '到着 · 制限内 ✓' : '到着')
            : (seg.type == SegmentType.train ? (seg.line ?? '電車') : '徒歩へ'),
      ),
    );
  }

  return RoutePlan(
    from: from,
    to: to,
    totalKm: totalKm,
    totalMin: totalMin,
    budgetMin: budgetMin,
    kcal: kcal,
    walkKm: walkKm,
    walkRatio: totalKm == 0 ? 0 : walkKm / totalKm,
    segments: segments,
    timelineNodes: nodes,
  );
}
