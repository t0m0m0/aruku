import 'dart:async';
import 'dart:convert';

import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/notification_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/state/settings_provider.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeLocationService implements LocationService {
  @override
  Future<LocationState> request() async => const LocationDenied();
}

class _FakeActivityService implements ActivityService {
  _FakeActivityService(this._controller);

  final StreamController<ActivitySnapshot> _controller;

  @override
  Future<bool> requestPermission() async => true;

  @override
  Stream<ActivitySnapshot> sessionActivityStream() => _controller.stream;
}

class _FakeNotificationService implements NotificationService {
  int scheduleCount = 0;
  int cancelCount = 0;

  @override
  Future<bool> requestPermission() async => true;

  @override
  Future<void> scheduleStreakReminder({
    required DateTime when,
    required int streakDays,
  }) async {
    scheduleCount++;
  }

  @override
  Future<void> cancelStreakReminder() async {
    cancelCount++;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late StreamController<ActivitySnapshot> controller;
  late _FakeNotificationService notif;

  setUp(() {
    controller = StreamController<ActivitySnapshot>();
    notif = _FakeNotificationService();
  });

  tearDown(() => controller.close());

  Future<ProviderContainer> makeContainer({
    required bool notificationsEnabled,
  }) async {
    SharedPreferences.setMockInitialValues({
      'settings.v1': jsonEncode({
        'notificationsEnabled': notificationsEnabled,
        'weeklyGoalKm': 10.0,
        'healthKitEnabled': false,
      }),
    });
    final container = ProviderContainer(
      overrides: [
        activityServiceProvider.overrideWithValue(
          _FakeActivityService(controller),
        ),
        locationServiceProvider.overrideWithValue(_FakeLocationService()),
        notificationServiceProvider.overrideWithValue(notif),
      ],
    );
    addTearDown(container.dispose);
    await container.read(settingsProvider.future);
    return container;
  }

  Future<void> settle() async {
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
  }

  test('通知オフ時は活動更新でスケジュールせず取消のみ', () async {
    final container = await makeContainer(notificationsEnabled: false);
    final notifier = container.read(appStateProvider.notifier);
    await settle();

    controller.add(ActivitySnapshot.fromSteps(500));
    await settle();

    expect(notifier, isNotNull);
    expect(notif.scheduleCount, 0);
    expect(notif.cancelCount, greaterThan(0));
  });

  test('通知オンでも今日活動済みならスケジュールしない', () async {
    final container = await makeContainer(notificationsEnabled: true);
    final notifier = container.read(appStateProvider.notifier);
    await settle();

    // 今日の歩数が入る＝今日は活動済みなので、守るべき「今日の途切れ」は無い。
    controller.add(ActivitySnapshot.fromSteps(500));
    await settle();

    expect(notifier, isNotNull);
    expect(notif.scheduleCount, 0);
  });
}
