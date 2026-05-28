import 'package:flutter/foundation.dart';

import 'geo_point.dart';

@immutable
class RecentDestination {
  const RecentDestination({
    required this.name,
    this.placeId,
    this.latLng,
    this.address,
    this.usedAt,
  });

  final String name;
  final String? placeId;
  final GeoPoint? latLng;
  final String? address;
  final DateTime? usedAt;

  String get dedupeKey =>
      placeId != null && placeId!.isNotEmpty ? 'id:$placeId' : 'name:$name';

  RecentDestination copyWith({
    String? name,
    String? placeId,
    GeoPoint? latLng,
    String? address,
    DateTime? usedAt,
  }) {
    return RecentDestination(
      name: name ?? this.name,
      placeId: placeId ?? this.placeId,
      latLng: latLng ?? this.latLng,
      address: address ?? this.address,
      usedAt: usedAt ?? this.usedAt,
    );
  }

  Map<String, dynamic> toJson() => {
    'name': name,
    if (placeId != null) 'placeId': placeId,
    if (latLng != null) 'lat': latLng!.lat,
    if (latLng != null) 'lng': latLng!.lng,
    if (address != null) 'address': address,
    if (usedAt != null) 'usedAt': usedAt!.toUtc().toIso8601String(),
  };

  static RecentDestination fromJson(Map<String, dynamic> json) {
    final lat = json['lat'];
    final lng = json['lng'];
    final usedAt = json['usedAt'];
    return RecentDestination(
      name: json['name'] as String,
      placeId: json['placeId'] as String?,
      latLng: (lat is num && lng is num)
          ? GeoPoint(lat.toDouble(), lng.toDouble())
          : null,
      address: json['address'] as String?,
      usedAt: usedAt is String ? DateTime.parse(usedAt) : null,
    );
  }
}
