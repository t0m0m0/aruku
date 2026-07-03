import 'package:flutter/foundation.dart';

import 'geo_point.dart';

sealed class LocationState {
  const LocationState();
}

@immutable
class LocationLoading extends LocationState {
  const LocationLoading();
}

@immutable
class LocationAvailable extends LocationState {
  const LocationAvailable(this.position);

  final GeoPoint position;
}

@immutable
class LocationDenied extends LocationState {
  const LocationDenied();
}

/// 権限は許可済みだが、GPS の一時的な失敗（屋内・電波不良・タイムアウト等）で
/// 現在地を取得できなかった状態。設定画面への誘導ではなく再試行が適切。
@immutable
class LocationUnavailable extends LocationState {
  const LocationUnavailable();
}
