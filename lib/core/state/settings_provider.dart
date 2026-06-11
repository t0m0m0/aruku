import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/app_settings.dart';
import '../services/settings_repository.dart';
import '../services/sync_meta_repository.dart';

/// アプリ設定を保持し、変更を永続化するノーティファイア。
class SettingsNotifier extends AsyncNotifier<AppSettings> {
  @override
  Future<AppSettings> build() async {
    final repo = await ref.watch(settingsRepositoryProvider.future);
    return repo.load();
  }

  Future<void> setNotifications(bool enabled) =>
      _update((s) => s.copyWith(notificationsEnabled: enabled));

  /// 現在値に [change] を適用し、保存してから state を更新する。
  Future<void> _update(AppSettings Function(AppSettings) change) async {
    final repo = await ref.read(settingsRepositoryProvider.future);
    final next = change(state.value ?? AppSettings.defaults);
    await repo.save(next);
    state = AsyncData(next);
    // クラウド同期の last-write-wins 用にローカル変更時刻を更新する。
    final meta = await ref.read(syncMetaRepositoryProvider.future);
    await meta.markLocalChanged();
  }
}

final settingsProvider = AsyncNotifierProvider<SettingsNotifier, AppSettings>(
  SettingsNotifier.new,
);
