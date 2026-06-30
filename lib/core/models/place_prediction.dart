import 'package:flutter/foundation.dart';

import 'geo_point.dart';

@immutable
class PlacePrediction {
  const PlacePrediction({
    required this.placeId,
    required this.name,
    required this.address,
    this.latLng,
    this.distanceMeters,
  });

  final String placeId;
  final String name;
  final String address;

  /// Text Search(New) 由来の候補のみ持つ同梱座標（#146）。Autocomplete 由来は null で、
  /// 確定時に [PlacesService.fetchLatLng] で引く。非 null なら details 呼び出し不要。
  final GeoPoint? latLng;

  /// Autocomplete(New) に origin を渡したときの現在地からの測地線距離（m, #146 C案）。
  /// 距離昇順の再ソートに使う。取得できない候補や origin 未指定では null。
  final int? distanceMeters;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PlacePrediction && placeId == other.placeId;

  @override
  int get hashCode => placeId.hashCode;
}
