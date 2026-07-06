import 'package:flutter/foundation.dart';

@immutable
class GeoPoint {
  const GeoPoint(this.lat, this.lng, {this.heading});

  final double lat;
  final double lng;

  /// 進行方向（度、真北基準）。取得できない場合はnull。
  /// 位置の同一性比較（==/hashCode）には含めない。
  final double? heading;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GeoPoint && lat == other.lat && lng == other.lng;

  @override
  int get hashCode => Object.hash(lat, lng);
}
