import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';

import '../models/geo_point.dart';
import '../models/location_state.dart';

abstract interface class LocationService {
  Future<LocationState> request();

  /// ナビ中の現在地を連続取得するストリーム。
  Stream<GeoPoint> positionStream();
}

class GeolocatorLocationService implements LocationService {
  @override
  Future<LocationState> request() async {
    try {
      final serviceEnabled = await Geolocator.isLocationServiceEnabled();
      if (!serviceEnabled) return const LocationDenied();

      var permission = await Geolocator.checkPermission();
      if (permission == LocationPermission.denied) {
        permission = await Geolocator.requestPermission();
      }
      if (permission == LocationPermission.denied ||
          permission == LocationPermission.deniedForever) {
        return const LocationDenied();
      }

      final pos = await Geolocator.getCurrentPosition(
        locationSettings: const LocationSettings(
          timeLimit: Duration(seconds: 10),
        ),
      );
      return LocationAvailable(GeoPoint(pos.latitude, pos.longitude));
    } on LocationServiceDisabledException {
      // 前段チェック通過後にサービスが切られた場合（TOCTOU）。前段の
      // isLocationServiceEnabled 判定と同じく再試行不可の LocationDenied に寄せる。
      return const LocationDenied();
    } on PermissionDefinitionsNotFoundException {
      // プラットフォーム側の権限定義不足。再試行では解消しないため LocationDenied。
      return const LocationDenied();
    } catch (_) {
      // GPS の一時的な失敗やタイムアウトは権限拒否に丸めず、再試行可能な
      // LocationUnavailable として区別する。
      return const LocationUnavailable();
    }
  }

  @override
  Stream<GeoPoint> positionStream() => Geolocator.getPositionStream(
    locationSettings: const LocationSettings(
      accuracy: LocationAccuracy.high,
      distanceFilter: 5,
    ),
  ).map((p) => GeoPoint(p.latitude, p.longitude));
}

final locationServiceProvider = Provider<LocationService>(
  (_) => GeolocatorLocationService(),
);
