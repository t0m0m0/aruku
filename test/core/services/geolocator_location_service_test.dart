// plugin_platform_interface は geolocator の推移的依存。プラットフォーム実装を
// モックするテスト専用の import なので、直接依存の追加はせずこの lint を許可する。
// ignore_for_file: depend_on_referenced_packages
import 'dart:async';

import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:geolocator/geolocator.dart';
import 'package:plugin_platform_interface/plugin_platform_interface.dart';

/// Geolocator のプラットフォーム実装を差し替えるモック。各呼び出しの戻り値／
/// 例外をテストごとに注入し、`GeolocatorLocationService.request()` の分岐を
/// 決定的に検証する。
class _MockGeolocatorPlatform extends GeolocatorPlatform
    with MockPlatformInterfaceMixin {
  bool serviceEnabled = true;
  LocationPermission permission = LocationPermission.always;
  Position? position;
  Object? positionError;

  /// getCurrentPosition に渡された設定を記録する（timeLimit 検証用）。
  LocationSettings? lastSettings;

  @override
  Future<bool> isLocationServiceEnabled() async => serviceEnabled;

  @override
  Future<LocationPermission> checkPermission() async => permission;

  @override
  Future<LocationPermission> requestPermission() async => permission;

  @override
  Future<Position> getCurrentPosition({LocationSettings? locationSettings}) {
    lastSettings = locationSettings;
    if (positionError != null) return Future.error(positionError!);
    return Future.value(position);
  }

  Stream<Position>? positionStreamToReturn;

  @override
  Stream<Position> getPositionStream({LocationSettings? locationSettings}) =>
      positionStreamToReturn ?? const Stream.empty();
}

Position _fakePosition(double lat, double lng, {double heading = 0}) =>
    Position(
      latitude: lat,
      longitude: lng,
      timestamp: DateTime.fromMillisecondsSinceEpoch(0),
      accuracy: 1,
      altitude: 0,
      altitudeAccuracy: 0,
      heading: heading,
      headingAccuracy: 0,
      speed: 0,
      speedAccuracy: 0,
    );

void main() {
  late _MockGeolocatorPlatform mock;

  setUp(() {
    mock = _MockGeolocatorPlatform();
    GeolocatorPlatform.instance = mock;
  });

  final service = GeolocatorLocationService();

  test('権限許可＋座標取得成功で LocationAvailable', () async {
    mock.position = _fakePosition(35.68, 139.76);

    final result = await service.request();

    expect(result, isA<LocationAvailable>());
    final pos = (result as LocationAvailable).position;
    expect(pos.lat, 35.68);
    expect(pos.lng, 139.76);
  });

  test('位置情報サービス無効なら LocationDenied', () async {
    mock.serviceEnabled = false;

    expect(await service.request(), isA<LocationDenied>());
  });

  test('権限 denied なら LocationDenied', () async {
    mock.permission = LocationPermission.denied;

    expect(await service.request(), isA<LocationDenied>());
  });

  test('権限 deniedForever なら LocationDenied', () async {
    mock.permission = LocationPermission.deniedForever;

    expect(await service.request(), isA<LocationDenied>());
  });

  test('権限許可済みで GPS タイムアウトなら LocationUnavailable（誤って Denied にしない）', () async {
    mock.positionError = TimeoutException('gps timeout');

    final result = await service.request();

    expect(result, isA<LocationUnavailable>());
    expect(result, isNot(isA<LocationDenied>()));
  });

  test('権限許可済みで一時的な取得エラーなら LocationUnavailable', () async {
    mock.positionError = const PositionUpdateException('temporary failure');

    expect(await service.request(), isA<LocationUnavailable>());
  });

  test('取得中にサービス無効例外なら LocationDenied（前段チェックと同じ扱い）', () async {
    // isLocationServiceEnabled 通過後にサービスが切られた場合（TOCTOU）。
    // 再試行不可な状態なので '取得失敗' ではなく '位置情報なし' に寄せる。
    mock.positionError = const LocationServiceDisabledException();

    expect(await service.request(), isA<LocationDenied>());
  });

  test('権限定義が無ければ LocationDenied（再試行不可）', () async {
    mock.positionError = const PermissionDefinitionsNotFoundException(
      'missing platform permission entries',
    );

    expect(await service.request(), isA<LocationDenied>());
  });

  test('getCurrentPosition に timeLimit が渡される', () async {
    mock.position = _fakePosition(0, 0);

    await service.request();

    expect(mock.lastSettings?.timeLimit, isNotNull);
    expect(mock.lastSettings!.timeLimit! > Duration.zero, isTrue);
  });

  group('positionStream', () {
    test('Position.heading を GeoPoint.heading に伝播する', () async {
      mock.positionStreamToReturn = Stream.value(
        _fakePosition(35.68, 139.76, heading: 90.0),
      );

      final point = await service.positionStream().first;

      expect(point.lat, 35.68);
      expect(point.lng, 139.76);
      expect(point.heading, 90.0);
    });

    test('headingが無効値（負値）ならnullに丸める', () async {
      mock.positionStreamToReturn = Stream.value(
        _fakePosition(35.68, 139.76, heading: -1.0),
      );

      final point = await service.positionStream().first;

      expect(point.heading, isNull);
    });
  });
}
