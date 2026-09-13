// 移植元: lib/core/models/place_prediction.dart

/// 地点検索（typeahead）の候補。座標は持たない——Google autocomplete が返さないため、
/// 確定時に `PlacesService.fetchLatLng` で引く2段フロー。
export interface PlacePrediction {
  readonly placeId: string;
  readonly name: string;
  readonly address: string;

  /// Autocomplete に origin を渡したときの現在地からの測地線距離（m, #146 C案）。
  /// 「近くの店」モードの距離昇順再ソートに使う。origin 未指定や取得できない候補では null。
  readonly distanceMeters: number | null;
}
