import 'dart:math' as math;

import '../models/geo_point.dart';
import '../models/route_plan.dart';
import 'route_plan_builder.dart';

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
///
/// [departureAt]（出発の絶対時刻）を渡すと、予算内判定・タイブレーク・縮退の
/// すべてで [RouteCandidate.totalMin]（待ち抜きの単純合計）ではなく、時刻表の
/// 乗車前・乗り換え待ちを含む実到着時刻 [arrivalMinutes] を用いる。これにより
/// 表示（タイムライン）と同じ到着時刻で締切を判定し、待ち時間で実際には超過する
/// 経路を「予算内」と誤選定しない。間に合う候補がある限り、徒歩を短くしてでも
/// 締切内の候補を提示する。[departureAt] 省略時は従来どおり totalMin で判定する。
RouteCandidate selectBestRoute({
  required List<RouteCandidate> candidates,
  required int budgetMin,
  GeoPoint? origin,
  GeoPoint? goal,
  DateTime? departureAt,
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

  // 待ち時間込みの実到着分。departureAt が無ければ待ち抜き合計へフォールバック。
  int arrival(RouteCandidate c) => departureAt == null
      ? c.totalMin
      : arrivalMinutes(c.segments, departureAt);

  final within = pool.where((c) => arrival(c) <= budgetMin).toList();
  if (within.isNotEmpty) {
    return within.reduce((a, b) {
      if (a.walkMinutes != b.walkMinutes) {
        return a.walkMinutes > b.walkMinutes ? a : b;
      }
      return arrival(a) <= arrival(b) ? a : b;
    });
  }
  // 予算内が無いとき（best-effort）。departureAt 指定時は、乗車待ちが予算を超える
  // 「今夜乗れない」電車（終電後の翌朝始発など）を後回しにし、乗車待ちが予算内の候補
  // （全徒歩は待ち0で常に含む）から最早到着を選ぶ（#121 原因②）。予算が十分大きく
  // 実際に待てる場合は電車も残るため、原理的に正しい挙動になる。
  final fallback = departureAt == null
      ? pool
      : reachableWithinBudget(pool, budgetMin, departureAt) ?? pool;
  return fallback.reduce((a, b) => arrival(a) <= arrival(b) ? a : b);
}

/// best-effort 選定で「今夜乗れる」候補に絞る。次の両方を満たす候補だけを残す
/// （全徒歩は電車を含まず常に残る）：
/// - 各時刻表電車の乗車待ち（[maxBoardingWait]）がいずれも [budgetMin] 内
///   （終電後の翌朝始発など「待てば乗れるが今夜は無理」な電車を除く・#121 原因②）。
/// - 乗り遅れる電車が無い（[firstMissedTrain] == null）。徒歩を延ばして発車後に駅着する
///   電車は実際には乗れず、[maxBoardingWait] では待ち0に見えて素通りするため明示的に除く。
///   発車時刻のみで判定するため、降車駅の時刻を欠く NAVITIME データでも乗り遅れを拾える。
///
/// 該当が無ければ null を返し、呼び出し側は元の全候補へ縮退する。選定中の pool
/// （[selectBestRoute]）と縮退時の全候補（NaviTimeRouteService）の双方で同じ判定を
/// 共有するための純粋関数。
List<RouteCandidate>? reachableWithinBudget(
  List<RouteCandidate> candidates,
  int budgetMin,
  DateTime departureAt,
) {
  final reachable = candidates
      .where(
        (c) =>
            maxBoardingWait(c.segments, departureAt) <= budgetMin &&
            firstMissedTrain(c.segments, departureAt) == null,
      )
      .toList();
  return reachable.isEmpty ? null : reachable;
}

/// 乗車駅探索（docs/notes/walk-max-board-search.md）：乗車駅候補（前半徒歩 t1 の
/// 昇順）について「到着が予算内の最遠 index ＝ 総徒歩最大」を二分探索で返す。
///
/// t1 は index 増で単調増、X→goal の電車所要 t2 は単調減で、door-to-door 到着
/// （[evaluate] が返す origin からの総所要分）は index に対して単調増という前提を使い、
/// 予算内可否のステップ境界を二分探索する。これにより [evaluate]（候補駅ごとの
/// route_transit 引き直しという IO）の回数を全 [count] の線形ではなく O(log count) に
/// 抑える。[evaluate] は予算外・経路無しを大きな値で表してよい。
///
/// 戻り値は `evaluate(index) <= budgetMin` を満たす最大 index。先頭すら予算外・
/// [count] が 0 なら null（[count] 0 では [evaluate] を一度も呼ばない）。
Future<int?> maxWalkBoardingIndex({
  required int count,
  required int budgetMin,
  required Future<int> Function(int index) evaluate,
}) async {
  var lo = 0;
  var hi = count - 1;
  int? best;
  while (lo <= hi) {
    final mid = (lo + hi) >> 1;
    if (await evaluate(mid) <= budgetMin) {
      best = mid; // mid は予算内。さらに遠く（大きい index）を試す。
      lo = mid + 1;
    } else {
      hi = mid - 1; // mid は予算外。手前を試す。
    }
  }
  return best;
}

/// 候補の電車区間に、出発地より進行方向(origin→goal)の後方へ
/// [maxBacktrackRatio] × 直線距離(origin→goal) を超えて戻る駅を含むか。
/// 徒歩区間は判定しない（目的地へ近づくための短い徒歩を弾かないため）。
///
/// 電車区間の polyline は停車駅座標で構成される前提（transit は shape を返さず、
/// 停車駅を結ぶ折れ線で合成される）。将来 transit shape が有効になり線路追従の
/// 細かな頂点が入ると、一時的に後方へカーブする1頂点でも候補全体が除外され得る
/// 点に注意（その場合は判定対象を停車駅へ限定する必要がある）。
bool _isBacktrackDetour(
  RouteCandidate c,
  GeoPoint origin,
  GeoPoint goal,
  double maxBacktrackRatio,
) {
  final dog = haversineKm(origin, goal);
  if (dog == 0) return false;
  final limit = -maxBacktrackRatio * dog;
  for (final seg in c.segments) {
    if (seg.type != SegmentType.train) continue;
    for (final p in seg.polyline) {
      if (_advanceKm(origin, goal, dog, p) < limit) return true;
    }
  }
  return false;
}

/// 点 [p] の、origin→goal 方向への射影長（km）。前方なら正、出発地より後方
/// （目的地と逆方向）なら負。余弦定理で origin→p ベクトルを origin→goal 方向へ
/// 射影して求める。[dog] は origin→goal 距離（呼び出し側で算出済みを渡す）。
/// 球面距離を平面の余弦定理へ投入する近似だが、都市スケールでは十分。
double _advanceKm(GeoPoint origin, GeoPoint goal, double dog, GeoPoint p) {
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
