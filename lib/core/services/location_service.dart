import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:geolocator/geolocator.dart';

import '../models/geo_point.dart';
import '../models/location_state.dart';

abstract interface class LocationService {
  Future<LocationState> request();
}

/// 現在地の単発取得を打ち切るまでの上限。
const Duration kLocationRequestTimeout = Duration(seconds: 10);

class GeolocatorLocationService implements LocationService {
  const GeolocatorLocationService({this.timeout = kLocationRequestTimeout});

  /// 取得を打ち切るまでの上限。テストから短縮して注入する。
  final Duration timeout;

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

      // timeLimit だけに頼らず自前でも打ち切る。geolocator_web は W3C の
      // PositionOptions.timeout（ミリ秒）へ Duration.inMicroseconds を渡すため、
      // 10 秒指定が約 2.8 時間として解釈され Web では timeLimit が効かない。
      // await が解決しないと例外も状態更新も起きず、無音で止まる。#359 参照。
      final pos = await Geolocator.getCurrentPosition(
        locationSettings: LocationSettings(timeLimit: timeout),
      ).timeout(timeout);
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
}

final locationServiceProvider = Provider<LocationService>(
  (_) => const GeolocatorLocationService(),
);
