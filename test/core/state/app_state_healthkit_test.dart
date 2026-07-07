import 'dart:async';
import 'dart:convert';

import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/health_service.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/state/settings_provider.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeLocationService implements LocationService {
  @override
  Future<LocationState> request() async => const LocationDenied();

  @override
  Stream<GeoPoint> positionStream() => const Stream.empty();
}

class _FakeActivityService implements ActivityService {
  _FakeActivityService(this._controller);

  final StreamController<ActivitySnapshot> _controller;

  @override
  Future<bool> requestPermission() async => true;

  @override
  Stream<ActivitySnapshot> sessionActivityStream() => _controller.stream;
}

class _FakeHealthService implements HealthService {
  WalkingWorkout? written;
  int writeCount = 0;

  @override
  Future<bool> requestAuthorization() async => true;

  @override
  Future<bool> writeWalkingWorkout(WalkingWorkout workout) async {
    written = workout;
    writeCount++;
    return true;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late StreamController<ActivitySnapshot> controller;
  late _FakeHealthService health;

  setUp(() {
    controller = StreamController<ActivitySnapshot>();
    health = _FakeHealthService();
  });

  tearDown(() => controller.close());

  Future<ProviderContainer> makeContainer({
    required bool healthKitEnabled,
  }) async {
    SharedPreferences.setMockInitialValues({
      'settings.v1': jsonEncode({
        'notificationsEnabled': true,
        'weeklyGoalKm': 10.0,
        'healthKitEnabled': healthKitEnabled,
      }),
    });
    final container = ProviderContainer(
      overrides: [
        activityServiceProvider.overrideWithValue(
          _FakeActivityService(controller),
        ),
        locationServiceProvider.overrideWithValue(_FakeLocationService()),
        healthServiceProvider.overrideWithValue(health),
      ],
    );
    addTearDown(container.dispose);
    // 設定を先読みして `.value` を確定させる（本番では起動時に読み込まれる）。
    await container.read(settingsProvider.future);
    return container;
  }

  Future<void> settle() async {
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
  }

  test('連携オン時、ナビ退場でセッション歩行がワークアウトとして書き込まれる', () async {
    final container = await makeContainer(healthKitEnabled: true);
    final notifier = container.read(appStateProvider.notifier);
    await settle();

    notifier.go(Screen.nav);
    await settle();
    // セッション中に 500 歩あるく。
    controller.add(ActivitySnapshot.fromSteps(500));
    await settle();

    notifier.go(Screen.home);
    await settle();

    expect(health.writeCount, 1);
    final w = health.written!;
    expect(w.steps, 500);
    final snap = ActivitySnapshot.fromSteps(500);
    expect(w.km, snap.km);
    expect(w.kcal, snap.kcal);
    expect(w.end.isBefore(w.start), isFalse);
  });

  test('連携オフ時はワークアウトを書き込まない', () async {
    final container = await makeContainer(healthKitEnabled: false);
    final notifier = container.read(appStateProvider.notifier);
    await settle();

    notifier.go(Screen.nav);
    await settle();
    controller.add(ActivitySnapshot.fromSteps(500));
    await settle();

    notifier.go(Screen.home);
    await settle();

    expect(health.writeCount, 0);
  });

  test('セッション中に歩数が増えなければ書き込まない', () async {
    final container = await makeContainer(healthKitEnabled: true);
    final notifier = container.read(appStateProvider.notifier);
    await settle();

    notifier.go(Screen.nav);
    await settle();
    // 歩数の計測なし。
    notifier.go(Screen.home);
    await settle();

    expect(health.writeCount, 0);
  });
}
