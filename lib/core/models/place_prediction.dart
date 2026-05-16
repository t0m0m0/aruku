import 'package:flutter/foundation.dart';

@immutable
class PlacePrediction {
  const PlacePrediction({
    required this.placeId,
    required this.name,
    required this.address,
  });

  final String placeId;
  final String name;
  final String address;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PlacePrediction && placeId == other.placeId;

  @override
  int get hashCode => placeId.hashCode;
}
