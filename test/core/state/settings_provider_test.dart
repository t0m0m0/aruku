import 'dart:async';

import 'package:aruku/core/models/app_settings.dart';
import 'package:aruku/core/services/notification_service.dart';
import 'package:aruku/core/services/recents_repository.dart';
import 'package:aruku/core/services/settings_repository.dart';
import 'package:aruku/core/state/settings_provider.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// 保存を [gate] が開くまで保留する。並行更新を同時に in-flight へ乗せて
/// lost update を決定的に再現するためのテスト用リポジトリ。
class _GatedRepository extends SettingsRepository {
  _GatedRepository(super.prefs);

  final Completer<void> _gate = Completer<void>();

  void open() => _gate.complete();

  @override
  Future<void> save(AppSettings settings) async {
    await _gate.future;
    await super.save(settings);
  }
}

/// save が必ず失敗するリポジトリ。失敗時方針の検証に使う。
class _ThrowingRepository extends SettingsRepository {
  _ThrowingRepository(super.prefs);

  @override
  Future<void> save(AppSettings settings) async =>
      throw StateError('save failed');
}

/// [shouldThrow] が真の間だけ save が失敗するリポジトリ。
/// 失敗後もキューが後続を止めないことの検証に使う。
class _ConditionalRepository extends SettingsRepository {
  _ConditionalRepository(super.prefs, this._shouldThrow);

  final bool Function() _shouldThrow;

  @override
  Future<void> save(AppSettings settings) async {
    if (_shouldThrow()) throw StateError('save failed');
    await super.save(settings);
  }
}

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

  test('並行する別々の setter が lost update を起こさない', () async {
    final prefs = await SharedPreferences.getInstance();
    final gated = _GatedRepository(prefs);
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWith((ref) => prefs),
        settingsRepositoryProvider.overrideWith((ref) async => gated),
      ],
    );
    addTearDown(container.dispose);
    await container.read(settingsProvider.future);

    final notifier = container.read(settingsProvider.notifier);
    final f1 = notifier.setNotifications(false);
    final f2 = notifier.setHealthKitEnabled(true);
    gated.open();
    await Future.wait([f1, f2]);

    final settings = container.read(settingsProvider).value!;
    expect(settings.notificationsEnabled, isFalse);
    expect(settings.healthKitEnabled, isTrue);
  });

  test('保存失敗時は直前の値を維持し例外を伝播する', () async {
    final prefs = await SharedPreferences.getInstance();
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWith((ref) => prefs),
        settingsRepositoryProvider.overrideWith(
          (ref) async => _ThrowingRepository(prefs),
        ),
      ],
    );
    addTearDown(container.dispose);
    await container.read(settingsProvider.future);

    await expectLater(
      container.read(settingsProvider.notifier).setHealthKitEnabled(true),
      throwsA(isA<StateError>()),
    );

    // 失敗した変更は state に反映されない（既定値を保持）。
    expect(container.read(settingsProvider).value!.healthKitEnabled, isFalse);
  });

  test('失敗した更新の後も後続の更新は成功する', () async {
    final prefs = await SharedPreferences.getInstance();
    var shouldThrow = true;
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWith((ref) => prefs),
        settingsRepositoryProvider.overrideWith(
          (ref) async => _ConditionalRepository(prefs, () => shouldThrow),
        ),
      ],
    );
    addTearDown(container.dispose);
    await container.read(settingsProvider.future);

    final notifier = container.read(settingsProvider.notifier);
    await expectLater(
      notifier.setHealthKitEnabled(true),
      throwsA(isA<StateError>()),
    );

    shouldThrow = false;
    await notifier.setWeeklyGoalKm(30);

    expect(container.read(settingsProvider).value!.weeklyGoalKm, 30);
  });
}
