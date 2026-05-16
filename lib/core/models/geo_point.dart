import 'package:flutter/foundation.dart';

@immutable
class GeoPoint {
  const GeoPoint(this.lat, this.lng);

  final double lat;
  final double lng;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is GeoPoint && lat == other.lat && lng == other.lng;

  @override
  int get hashCode => Object.hash(lat, lng);
}
