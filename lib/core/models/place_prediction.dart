import 'package:flutter/foundation.dart';

import 'geo_point.dart';

@immutable
class PlacePrediction {
  const PlacePrediction({
    required this.placeId,
    required this.name,
    required this.address,
    this.latLng,
    this.kind,
    this.areaLabel,
  });

  final String placeId;
  final String name;
  final String address;

  /// Transit API は suggest 時点で座標を返すため、候補に同梱する。
  /// details 相当の2回目呼び出しは不要。
  final GeoPoint? latLng;

  /// Transit API の `kind`（station / stop / place / address）。
  final String? kind;

  /// 同名衝突時に逆ジオで補う「県＋市区町村」（例: 「長野県上田市」）。
  /// 衝突していない通常候補では null のまま。
  final String? areaLabel;

  PlacePrediction withAreaLabel(String? label) => PlacePrediction(
    placeId: placeId,
    name: name,
    address: address,
    latLng: latLng,
    kind: kind,
    areaLabel: label,
  );

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PlacePrediction && placeId == other.placeId;

  @override
  int get hashCode => placeId.hashCode;
}
