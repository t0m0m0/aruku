import 'dart:async';
import 'dart:convert';

import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/daily_activity.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/activity_log_repository.dart';
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

  test('履歴ロード完了前にナビ入場したセッションは書き込まない（過大計上を防ぐ）', () async {
    // 起動時に今日 1000 歩が記録済みだが、履歴ロードを遅延させ、ロード完了前に
    // nav 入場する状況を作る。基準歩数が未確定（=0）のまま退場すると、当日累計
    // からの差分が「当日全歩数」に膨れてしまうため、そのセッションは書き込まない。
    SharedPreferences.setMockInitialValues({
      'settings.v1': jsonEncode({
        'notificationsEnabled': true,
        'weeklyGoalKm': 10.0,
        'healthKitEnabled': true,
      }),
    });
    final prefs = await SharedPreferences.getInstance();
    final repo = ActivityLogRepository(prefs);
    await repo.upsert(DailyActivity(date: DateTime.now(), steps: 1000));

    final container = ProviderContainer(
      overrides: [
        activityServiceProvider.overrideWithValue(
          _FakeActivityService(controller),
        ),
        locationServiceProvider.overrideWithValue(_FakeLocationService()),
        healthServiceProvider.overrideWithValue(health),
        activityLogRepositoryProvider.overrideWith((ref) async {
          await Future<void>.delayed(const Duration(milliseconds: 20));
          return repo;
        }),
      ],
    );
    addTearDown(container.dispose);
    await container.read(settingsProvider.future);

    final notifier = container.read(appStateProvider.notifier);
    // 購読は確立済み、履歴ロードはまだ遅延中のうちに nav 入場する。
    await settle();
    notifier.go(Screen.nav);
    await settle();

    // セッション歩数 500 が届く（ロード前なので pending に保持される）。
    controller.add(ActivitySnapshot.fromSteps(500));
    // 履歴ロードが完了し、基準 1000 に 500 が加算され当日累計 1500 になる。
    await Future<void>.delayed(const Duration(milliseconds: 30));

    notifier.go(Screen.home);
    await settle();

    // 基準未確定のまま始まったセッションなので書き込まない（1500 の過大計上を防ぐ）。
    expect(health.writeCount, 0);
  });
}
