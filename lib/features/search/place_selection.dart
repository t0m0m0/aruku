import '../../core/models/geo_point.dart';
import '../../core/models/place_prediction.dart';
import '../../core/models/recent_place.dart';
import '../../core/services/places_service.dart';

/// 候補を確定できる地点へ解決する。座標を引けなければ null。
///
/// 全画面検索とデスクトップのタイプアヘッドが同じ規則で確定するよう、
/// 画面から切り離して1つに置く。片側だけ直すと「ある入口からだけ座標なしの
/// 目的地が入る」形で壊れ、経路照会まで届かない。
Future<RecentPlace?> resolvePlacePrediction(
  PlacesService service,
  PlacePrediction prediction,
) async {
  // Google autocomplete は座標を返さないため、確定時に details で座標を引く。
  // オフライン時の SocketException など PlacesException 以外も座標なし扱いにする
  // （取りこぼすと呼び出し側の選択中フラグが立ったままリストが固まる）。
  GeoPoint? latLng;
  try {
    latLng = await service.fetchLatLng(prediction.placeId);
  } catch (_) {
    latLng = null;
  }
  // 経路照会（/guidance/plan）は from/to ともに座標必須。
  // 座標が取れない候補は確定させず、別候補の再選択を促す。
  if (latLng == null) return null;
  return RecentPlace(
    name: prediction.name,
    placeId: prediction.placeId,
    latLng: latLng,
    address: prediction.address,
  );
}
