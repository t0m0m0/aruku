import '../geo/geo_math.dart';
import '../models/geo_point.dart';
import '../models/route_plan.dart';

/// [leg] の終点座標。polyline が空（時刻表データが揃わない区間など）の場合は
/// 終点が特定できないため null を返す。
GeoPoint? legEndPoint(RouteSegment leg) =>
    leg.polyline.isEmpty ? null : leg.polyline.last;

/// [route] の [index] 番目の区間を Google Maps へ引き継ぐときの destination。
///
/// 座標→名前、区間自身→経路構造 の順で解決し、どれも取れなければ null:
///
/// 1. 区間の polyline 末尾
/// 2. 次区間の polyline 先頭
/// 3. 区間の [RouteSegment.toName]
/// 4. 最終区間なら [RoutePlan.to]、それ以外は次区間の [RouteSegment.fromName]
///
/// 区間単体では 1・3 しか見られず、`toName` は non-nullable なのに空文字を正規に
/// 取り得るため（#322 と同根）、polyline を欠く区間で destination が空になっていた。
/// 空クエリで Google Maps を開くと目的地未設定の経路検索画面が出る（#323）。
///
/// 2・4 が新規の推測でないのは、[RoutePlan.segments] が連結していることによる:
/// 次区間の始点は自区間の終点と同じ地点で、最終区間の到着地は route_plan_builder が
/// タイムラインの到着ノードに [RoutePlan.to] を描くのと同じ。名前より座標を先に
/// 見るのは、駅名が同名別駅を持ち Google Maps 側の解決が揺れるため。
String? legHandoffDestination(RoutePlan route, int index) {
  final leg = legAt(route, index);
  if (leg == null) return null;
  final next = legAt(route, index + 1);

  final endPoint =
      legEndPoint(leg) ??
      (next != null && next.polyline.isNotEmpty ? next.polyline.first : null);
  if (endPoint != null) return '${endPoint.lat},${endPoint.lng}';

  for (final name in [
    leg.toName,
    if (next != null) next.fromName else route.to,
  ]) {
    if (name.isNotEmpty) return name;
  }
  return null;
}

/// [route] の [index] 番目の区間を Google Maps アプリへ引き継ぐための URL を
/// 組み立てる。[legHandoffDestination] が決まらない区間は引き継ぎ自体が成立
/// しないため null を返す（文字列は Uri のクエリエンコードに委ね、文字列連結で
/// エンコードしない）。
///
/// [origin] は省略可能。結果画面（ハブ）は歩行中の GPS 追跡を持たず、現在地が
/// 未確定のことがある。省略時は origin クエリ自体を付けない — Google Maps は
/// origin 省略時に端末の現在地を出発地として扱うため、誤った固定座標を渡すより
/// 安全（#305）。
Uri? buildLegHandoffUri({
  required RoutePlan route,
  required int index,
  GeoPoint? origin,
}) {
  final leg = legAt(route, index);
  final destination = legHandoffDestination(route, index);
  if (leg == null || destination == null) return null;
  final queryParameters = <String, String>{
    'api': '1',
    if (origin != null) 'origin': '${origin.lat},${origin.lng}',
    'destination': destination,
    'travelmode': leg.type == SegmentType.walk ? 'walking' : 'transit',
  };
  // 徒歩区間のみ Google Maps アプリの「ナビ開始」直行を指定する。公共交通は
  // 乗換案内の一覧表示に留めたいため dir_action は付けない。
  //
  // 電車・バスの [RouteSegment.depTime]（固定出発の便）は URL に載せられない。Maps
  // URLs（api=1）に出発時刻パラメータが無く、時刻指定は Directions API（サーバー側）
  // 専用のため。よって dir_action を付けず乗換案内の一覧で開き、Maps 側の出発時刻選択に
  // 委ねる（ナビ直行にすると「現在時刻」の別便へ確定してしまう）。固定出発を厳密に引き継ぐ
  // 手段が無いことを踏まえ、公共交通は「厳密な引き継ぎ」ではなく一覧提示に留める設計。
  if (leg.type == SegmentType.walk) {
    queryParameters['dir_action'] = 'navigate';
  }
  return Uri.https('www.google.com', '/maps/dir/', queryParameters);
}

/// 現在地 [current] が [leg] の終点に到着したとみなせるか。
///
/// 終点座標が不明（polyline 空）な区間は、実際には未到着でも自動完了させて
/// しまう危険があるため常に false を返す（曖昧なら進めない、#305）。
bool isLegArrived({
  required RouteSegment leg,
  required GeoPoint current,
  double thresholdKm = 0.008,
}) {
  final endPoint = legEndPoint(leg);
  if (endPoint == null) return false;
  return metersBetween(current, endPoint) <= thresholdKm * 1000;
}

/// [route] の [index] 番目の区間。範囲外は null。
RouteSegment? legAt(RoutePlan route, int index) {
  if (index < 0 || index >= route.segments.length) return null;
  return route.segments[index];
}
