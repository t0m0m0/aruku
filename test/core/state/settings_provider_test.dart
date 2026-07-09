import 'package:aruku/core/models/app_settings.dart';
import 'package:aruku/core/services/notification_service.dart';
import 'package:aruku/core/services/recents_repository.dart';
import 'package:aruku/core/services/settings_repository.dart';
import 'package:aruku/core/state/settings_provider.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeNotificationService implements NotificationService {
  int permissionCount = 0;

  @override
  Future<bool> requestPermission() async {
    permissionCount++;
    return true;
  }

  @override
  Future<void> scheduleStreakReminder({
    required DateTime when,
    required int streakDays,
  }) async {}

  @override
  Future<void> cancelStreakReminder() async {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  Future<ProviderContainer> makeContainer({
    NotificationService? notifications,
  }) async {
    final prefs = await SharedPreferences.getInstance();
    return ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWith((ref) => prefs),
        if (notifications != null)
          notificationServiceProvider.overrideWithValue(notifications),
      ],
    );
  }

  test('初期ロードは defaults', () async {
    final container = await makeContainer();
    addTearDown(container.dispose);

    final settings = await container.read(settingsProvider.future);
    expect(settings, AppSettings.defaults);
  });

  test('setNotifications で値が変わり永続化される', () async {
    final container = await makeContainer();
    addTearDown(container.dispose);
    await container.read(settingsProvider.future);

    await container.read(settingsProvider.notifier).setNotifications(false);

    expect(
      container.read(settingsProvider).value!.notificationsEnabled,
      isFalse,
    );

    // 永続化されている（リポジトリから読み直しても残る）。
    final repo = await container.read(settingsRepositoryProvider.future);
    expect(repo.load().notificationsEnabled, isFalse);
  });

  test('setWeeklyGoalKm で値が変わり永続化される', () async {
    final container = await makeContainer();
    addTearDown(container.dispose);
    await container.read(settingsProvider.future);

    await container.read(settingsProvider.notifier).setWeeklyGoalKm(20);

    expect(container.read(settingsProvider).value!.weeklyGoalKm, 20);

    // 永続化されている（リポジトリから読み直しても残る）。
    final repo = await container.read(settingsRepositoryProvider.future);
    expect(repo.load().weeklyGoalKm, 20);
  });

  test('setHealthKitEnabled で値が変わり永続化される', () async {
    final container = await makeContainer();
    addTearDown(container.dispose);
    await container.read(settingsProvider.future);

    await container.read(settingsProvider.notifier).setHealthKitEnabled(true);

    expect(container.read(settingsProvider).value!.healthKitEnabled, isTrue);

    // 永続化されている（リポジトリから読み直しても残る）。
    final repo = await container.read(settingsRepositoryProvider.future);
    expect(repo.load().healthKitEnabled, isTrue);
  });

  test('setNotifications(true) で通知権限を要求する', () async {
    final notif = _FakeNotificationService();
    final container = await makeContainer(notifications: notif);
    addTearDown(container.dispose);
    await container.read(settingsProvider.future);

    await container.read(settingsProvider.notifier).setNotifications(true);

    expect(notif.permissionCount, 1);
  });

  test('setNotifications(false) では通知権限を要求しない', () async {
    final notif = _FakeNotificationService();
    final container = await makeContainer(notifications: notif);
    addTearDown(container.dispose);
    await container.read(settingsProvider.future);

    await container.read(settingsProvider.notifier).setNotifications(false);

    expect(notif.permissionCount, 0);
  });
}
