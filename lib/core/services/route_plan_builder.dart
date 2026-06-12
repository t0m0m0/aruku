import '../models/route_plan.dart';
import '../models/time_value.dart';

/// 徒歩 1km あたりの消費カロリー。徒歩区間のみに適用する。
const int kcalPerKm = 57;

/// 徒歩の平均速度（分速メートル）。候補選定フェーズで直線距離から所要時間を
/// 概算するのに使う（不動産表示の慣行 80m/分）。確定経路の表示値は Google
/// Routes の実測へ上書きされる。
const double walkMetersPerMinute = 80.0;

/// 電車の平均速度（分速メートル）。calling_at に発着時刻が無い停車駅では時刻表の
/// 差で乗車時間を出せないため、停車駅を結ぶ折れ線長からこの速度で概算する
/// （各停・乗換・停車を含む実効平均 30km/h ≒ 500m/分）。時刻が揃う停車駅は
/// 精度の高い時刻表の差を優先する。
const double trainMetersPerMinute = 500.0;

/// isNow のときは dateOffset を無視して当日扱い。budget 計算と epoch で共有。
int effectiveOffset(TimeValue t) => t.isNow ? 0 : t.dateOffset;

/// 当日0時基準の絶対分。isNow / dateOffset を踏まえ日跨ぎ計算の共通基準にする。
int absoluteMinutes(TimeValue t) =>
    t.totalMinutes + effectiveOffset(t) * 24 * 60;

/// 出発〜到着の予算（分）。日跨ぎ（dateOffset / isNow）を考慮する。
int budgetMinutes(TimeValue departure, TimeValue arrival) =>
    absoluteMinutes(arrival) - absoluteMinutes(departure);

/// 出発時刻 + 経過分を "h:mm" へ整形（時は24で剰余）。
String formatClock(TimeValue dep, int addMinutes) {
  final total = dep.h * 60 + dep.m + addMinutes;
  final h = (total ~/ 60) % 24;
  final m = total % 60;
  return '$h:${m.toString().padLeft(2, '0')}';
}

/// 出発を基点とした経過分 [cum] を、区間 [seg] を経た時点へ進める。
/// 時刻表の発着時刻（[RouteSegment.depTime]/[RouteSegment.arrTime]）が揃い
/// [anchor]（出発の絶対時刻）が与えられた電車区間では、駅着から発車までの待ち時間を
/// 吸収して降車時刻まで進める（乗車前・乗り換え待ちを到着時刻に反映する #65）。
/// 戻り値の [wait] はこの区間に乗る前に待った分（タイムライン表示用）。
/// 時刻が欠落した区間や [anchor] 無しでは従来どおり所要分を加算し待ちは 0。
({int cum, int wait}) _advance(int cum, RouteSegment seg, DateTime? anchor) {
  final dep = seg.depTime;
  final arr = seg.arrTime;
  if (anchor != null && dep != null && arr != null) {
    final boardRel = dep.difference(anchor).inMinutes;
    final ride = arr.difference(anchor).inMinutes - boardRel;
    // 降車が始発前等の不整合データ（ride < 0）は所要分にフォールバックする。
    if (ride >= 0) {
      // boardRel <= cum は予定列車の発車後に駅着＝乗り遅れ。次列車の時刻表は
      // 持たないため待ち無しとし、実到着 cum に乗車時間 ride を足して同じ乗車
      // 時間の後続列車に乗る近似で進める（次列車の待ちは反映せず到着は楽観側）。
      final wait = boardRel > cum ? boardRel - cum : 0;
      return (cum: cum + wait + ride, wait: wait);
    }
  }
  return (cum: cum + seg.minutes, wait: 0);
}

/// 出発を基点に全区間を進めた到着までの総所要分（時刻表が揃う電車区間では
/// 乗車前・乗り換え待ちを含む #65）。[departureAt] は出発の絶対時刻で、省略時は
/// 時刻表を使わず各区間の所要分を累積する。選定（予算判定）と表示（タイムライン）が
/// 同じ到着時刻を用いるよう、累積ロジックを [_advance] に一本化して共有する。
int arrivalMinutes(List<RouteSegment> segments, DateTime? departureAt) {
  var cum = 0;
  for (final seg in segments) {
    cum = _advance(cum, seg, departureAt).cum;
  }
  return cum;
}

/// 電車区間ノードの補足文。乗車前に待ちがあれば「○分待ち · 路線名」と前置きする。
String _trainSub(String? line, int wait) {
  final name = line ?? '電車';
  return wait > 0 ? '$wait分待ち · $name' : name;
}

/// 区間列から RoutePlan を構築する（合計距離・徒歩距離・kcal・徒歩比率・
/// タイムライン）。データ源（Google / NAVITIME）に依存しない純粋関数。
/// [departureAt] は出発の絶対時刻（時刻表データとの差で待ち時間を算出する基点）。
/// 省略時は時刻表を使わず累積所要分でタイムラインを組む。
RoutePlan buildRoutePlan({
  required String from,
  required String to,
  required List<RouteSegment> segments,
  required TimeValue departure,
  required int budgetMin,
  DateTime? departureAt,
}) {
  final totalKm = segments.fold<double>(0, (a, s) => a + (s.km ?? 0));
  final walkKm = segments
      .where((s) => s.type == SegmentType.walk)
      .fold<double>(0, (a, s) => a + (s.km ?? 0));
  final kcal = segments
      .where((s) => s.type == SegmentType.walk)
      .fold<int>(0, (a, s) => a + (s.kcal ?? 0));

  final nodes = <TimelineNode>[
    TimelineNode(time: formatClock(departure, 0), place: from, sub: '出発'),
  ];
  // 出発からの経過分。電車区間では待ち時間を含めて進む（#65）。
  var cum = 0;
  for (var i = 0; i < segments.length; i++) {
    final seg = segments[i];
    final advanced = _advance(cum, seg, departureAt);
    cum = advanced.cum;
    final isLast = i == segments.length - 1;
    nodes.add(
      TimelineNode(
        time: formatClock(departure, cum),
        place: isLast ? to : seg.toName,
        sub: isLast
            ? (cum <= budgetMin ? '到着 · 制限内 ✓' : '到着')
            : (seg.type == SegmentType.train
                  ? _trainSub(seg.line, advanced.wait)
                  : '徒歩へ'),
      ),
    );
  }
  // 待ち時間込みの到着までの総所要分（時刻表が無ければ累積所要分に一致する）。
  final totalMin = cum;

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
