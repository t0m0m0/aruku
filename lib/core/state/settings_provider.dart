import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/app_settings.dart';
import '../services/notification_service.dart';
import '../services/settings_repository.dart';
import '../services/sync_meta_repository.dart';

/// アプリ設定を保持し、変更を永続化するノーティファイア。
class SettingsNotifier extends AsyncNotifier<AppSettings> {
  @override
  Future<AppSettings> build() async {
    final repo = await ref.watch(settingsRepositoryProvider.future);
    return repo.load();
  }

  Future<void> setNotifications(bool enabled) async {
    await _update((s) => s.copyWith(notificationsEnabled: enabled));
    if (!enabled) return;
    // オプトイン時に通知権限を要求する（実機のみ効果あり）。実際のスケジュール
    // 判断は appStateProvider がストリーク状況に応じて行う。拒否されても予約は
    // 無害なため、失敗はデバッグ時のみログに残す。
    try {
      await ref.read(notificationServiceProvider).requestPermission();
    } catch (e) {
      assert(() {
        debugPrint('notification permission request error: $e');
        return true;
      }());
    }
  }

  Future<void> setWeeklyGoalKm(double km) =>
      _update((s) => s.copyWith(weeklyGoalKm: km));

  Future<void> setHealthKitEnabled(bool enabled) =>
      _update((s) => s.copyWith(healthKitEnabled: enabled));

  /// 直前の更新が state をコミットするまで次の read-modify-write を待たせる
  /// FIFO キュー。これが無いと並行 setter が同じ古い state を基に丸ごと書き戻し、
  /// 一方の変更が失われる（lost update）。
  Future<void> _queue = Future<void>.value();

  /// 現在値に [change] を適用し、保存してから state を更新する。
  /// 複数の呼び出しは [_queue] で直列化され、各 [change] は直前の更新が反映済みの
  /// state を読む。
  Future<void> _update(AppSettings Function(AppSettings) change) {
    final result = _queue.then((_) => _applyChange(change));
    // 失敗しても後続の設定変更まで止めないよう、キューにはエラーを伝播させない。
    // 呼び出し元へは result 経由で失敗が伝わる。state を AsyncError にはしない
    // ―― 表示中の他の設定値まで巻き込んで消してしまうため。
    _queue = result.catchError((_) {});
    return result;
  }

  Future<void> _applyChange(AppSettings Function(AppSettings) change) async {
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
