import '../geo/geo_math.dart';
import '../models/geo_point.dart';
import '../models/route_plan.dart';

/// [leg] の終点座標。polyline が空（時刻表データが揃わない区間など）の場合は
/// 終点が特定できないため null を返す。
GeoPoint? legEndPoint(RouteSegment leg) =>
    leg.polyline.isEmpty ? null : leg.polyline.last;

/// [leg] を Google Maps アプリへ引き継ぐための URL を組み立てる。
///
/// destination は [legEndPoint] があれば座標、無ければ [RouteSegment.toName]
/// をそのまま渡す（Uri のクエリエンコードに委ね、文字列連結でエンコードしない）。
///
/// [origin] は省略可能。結果画面（ハブ）は歩行中の GPS 追跡を持たず、現在地が
/// 未確定のことがある。省略時は origin クエリ自体を付けない — Google Maps は
/// origin 省略時に端末の現在地を出発地として扱うため、誤った固定座標を渡すより
/// 安全（#305）。
Uri buildLegHandoffUri({required RouteSegment leg, GeoPoint? origin}) {
  final endPoint = legEndPoint(leg);
  final queryParameters = <String, String>{
    'api': '1',
    if (origin != null) 'origin': '${origin.lat},${origin.lng}',
    'destination': endPoint != null
        ? '${endPoint.lat},${endPoint.lng}'
        : leg.toName,
    'travelmode': leg.type == SegmentType.walk ? 'walking' : 'transit',
  };
  // 徒歩区間のみ Google Maps アプリの「ナビ開始」直行を指定する。公共交通は
  // 乗換案内の一覧表示に留めたいため dir_action は付けない。
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
