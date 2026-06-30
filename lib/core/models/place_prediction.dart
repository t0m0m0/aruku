import 'package:flutter/foundation.dart';

@immutable
class PlacePrediction {
  const PlacePrediction({
    required this.placeId,
    required this.name,
    required this.address,
    this.distanceMeters,
  });

  final String placeId;
  final String name;
  final String address;

  /// Autocomplete(New) に origin を渡したときの現在地からの測地線距離（m, #146 C案）。
  /// 「近くの店」モードの距離昇順再ソートに使う。取得できない候補や origin 未指定では null。
  final int? distanceMeters;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PlacePrediction && placeId == other.placeId;

  @override
  int get hashCode => placeId.hashCode;
}
