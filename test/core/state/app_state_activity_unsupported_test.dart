import 'dart:async';

import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/activity_log_repository.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeLocationService implements LocationService {
  @override
  Future<LocationState> request() async => const LocationDenied();
}

/// 触られたかを記録する歩数サービス。非対応環境で購読しないことの反証に使う。
class _RecordingActivityService implements ActivityService {
  _RecordingActivityService(this._controller);

  final StreamController<ActivitySnapshot> _controller;
  var permissionRequested = false;
  var streamSubscribed = false;

  @override
  Future<bool> requestPermission() async {
    permissionRequested = true;
    return true;
  }

  @override
  Stream<ActivitySnapshot> sessionActivityStream() {
    streamSubscribed = true;
    return _controller.stream;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late StreamController<ActivitySnapshot> controller;
  late _RecordingActivityService service;

  setUp(() {
    SharedPreferences.setMockInitialValues({});
    controller = StreamController<ActivitySnapshot>();
    service = _RecordingActivityService(controller);
  });

  tearDown(() {
    // close() の future を返さない。非 broadcast な StreamController は購読が
    // 無いと done を配送できず future が完了しないため、非対応ケース
    // （購読しない）で tearDown が 30 秒タイムアウトする。
    controller.close();
  });

  Future<ProviderContainer> makeContainer({
    required bool stepCountingSupported,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    final container = ProviderContainer(
      overrides: [
        activityLogRepositoryProvider.overrideWith(
          (ref) async => ActivityLogRepository(prefs),
        ),
        activityServiceProvider.overrideWithValue(service),
        locationServiceProvider.overrideWithValue(_FakeLocationService()),
        stepCountingSupportedProvider.overrideWithValue(stepCountingSupported),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  test('歩数計測が非対応なら購読も権限要求もしない', () async {
    final container = await makeContainer(stepCountingSupported: false);
    container.read(appStateProvider);
    await Future<void>.delayed(Duration.zero);

    expect(service.permissionRequested, isFalse);
    expect(service.streamSubscribed, isFalse);
  });

  test('非対応であることが state に出る', () async {
    final container = await makeContainer(stepCountingSupported: false);
    expect(container.read(appStateProvider).activityTrackingSupported, isFalse);
  });

  test('対応環境では従来どおり購読する', () async {
    // 非対応側だけを見ていると、購読の撤去そのものを検出できない。
    final container = await makeContainer(stepCountingSupported: true);
    container.read(appStateProvider);
    await Future<void>.delayed(Duration.zero);

    expect(service.permissionRequested, isTrue);
    expect(service.streamSubscribed, isTrue);
    expect(container.read(appStateProvider).activityTrackingSupported, isTrue);
  });
}
