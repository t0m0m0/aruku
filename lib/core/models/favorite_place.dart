import 'package:flutter/foundation.dart';

import 'geo_point.dart';

/// スターで保存されたお気に入りの目的地（地点）。
/// 同一地点の重複保存を避けるため [dedupeKey] で同一性を判定する。
@immutable
class FavoritePlace {
  const FavoritePlace({
    required this.name,
    this.placeId,
    this.latLng,
    this.address,
    this.savedAt,
  });

  final String name;
  final String? placeId;
  final GeoPoint? latLng;
  final String? address;

  /// 保存した時刻（UTC）。一覧は新しい順に並べる。
  final DateTime? savedAt;

  String get dedupeKey =>
      placeId != null && placeId!.isNotEmpty ? 'id:$placeId' : 'name:$name';

  FavoritePlace copyWith({
    String? name,
    String? placeId,
    GeoPoint? latLng,
    String? address,
    DateTime? savedAt,
  }) {
    return FavoritePlace(
      name: name ?? this.name,
      placeId: placeId ?? this.placeId,
      latLng: latLng ?? this.latLng,
      address: address ?? this.address,
      savedAt: savedAt ?? this.savedAt,
    );
  }

  Map<String, dynamic> toJson() => {
    'name': name,
    if (placeId != null) 'placeId': placeId,
    if (latLng != null) 'lat': latLng!.lat,
    if (latLng != null) 'lng': latLng!.lng,
    if (address != null) 'address': address,
    if (savedAt != null) 'savedAt': savedAt!.toUtc().toIso8601String(),
  };

  static FavoritePlace fromJson(Map<String, dynamic> json) {
    final lat = json['lat'];
    final lng = json['lng'];
    final savedAt = json['savedAt'];
    return FavoritePlace(
      name: json['name'] as String,
      placeId: json['placeId'] as String?,
      latLng: (lat is num && lng is num)
          ? GeoPoint(lat.toDouble(), lng.toDouble())
          : null,
      address: json['address'] as String?,
      savedAt: savedAt is String ? DateTime.parse(savedAt) : null,
    );
  }
}
