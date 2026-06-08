import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/app_settings.dart';
import '../services/settings_repository.dart';

/// アプリ設定を保持し、変更を永続化するノーティファイア。
class SettingsNotifier extends AsyncNotifier<AppSettings> {
  @override
  Future<AppSettings> build() async {
    final repo = await ref.watch(settingsRepositoryProvider.future);
    return repo.load();
  }

  Future<void> setUnit(DistanceUnit unit) =>
      _update((s) => s.copyWith(unit: unit));

  Future<void> setNotifications(bool enabled) =>
      _update((s) => s.copyWith(notificationsEnabled: enabled));

  Future<void> setDefaultBudget(int minutes) =>
      _update((s) => s.copyWith(defaultBudgetMinutes: minutes));

  /// 現在値に [change] を適用し、保存してから state を更新する。
  Future<void> _update(AppSettings Function(AppSettings) change) async {
    final repo = await ref.read(settingsRepositoryProvider.future);
    final next = change(state.value ?? AppSettings.defaults);
    await repo.save(next);
    state = AsyncData(next);
  }
}

final settingsProvider = AsyncNotifierProvider<SettingsNotifier, AppSettings>(
  SettingsNotifier.new,
);
