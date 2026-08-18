import 'package:flutter/foundation.dart';
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
  const GeolocatorLocationService({
    this.timeout = kLocationRequestTimeout,
    this.timeoutWholeRequest = kIsWeb,
  });

  /// 取得を打ち切るまでの上限。テストから短縮して注入する。
  final Duration timeout;

  /// 権限要求を含む取得全体に [timeout] をかけるか。既定は Web のみ。
  ///
  /// ネイティブで有効にしてはいけない。`requestPermission` は OS の権限ダイアログを
  /// 待つため、包むとユーザーが考えている間に「取得できず」へ落ちる。ネイティブは
  /// `LocationSettings.timeLimit` が実際に効くので全体を包む必要もない。
  ///
  /// Web だけ必要なのは、そこでしか無制限に止まらないから。geolocator_web は
  /// timeLimit を事実上無効化し（下記）、さらに checkPermission が 'prompt' を
  /// denied へ写すため初回は必ず requestPermission を通り、その実装は内部で座標
  /// 取得を行う。最後の getCurrentPosition だけを包んでも素通りする。
  ///
  /// 代償として、Web ではユーザーが [timeout] 内に許可を決めないと再試行可能な
  /// 「取得できず」になる。決定そのものは次の取得で反映される。
  final bool timeoutWholeRequest;

  /// 打ち切りは LocationUnavailable（再試行可能）へ落とす——返らない理由を権限拒否と
  /// 断定できないため、明示的な拒否の LocationDenied とは区別する。
  @override
  Future<LocationState> request() {
    if (!timeoutWholeRequest) return _resolve();
    return _resolve().timeout(
      timeout,
      onTimeout: () => const LocationUnavailable(),
    );
  }

  Future<LocationState> _resolve() async {
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

      // timeLimit はネイティブでのみ効く。geolocator_web は W3C の
      // PositionOptions.timeout（ミリ秒）へ Duration.inMicroseconds を渡すため、
      // 10 秒指定が約 2.8 時間として解釈される。Web を支えているのは request() の
      // 全体タイムアウト側。#359 参照。
      final pos = await Geolocator.getCurrentPosition(
        locationSettings: LocationSettings(timeLimit: timeout),
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
}

final locationServiceProvider = Provider<LocationService>(
  (_) => const GeolocatorLocationService(),
);
