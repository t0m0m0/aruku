import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/sync_data.dart';
import '../services/activity_log_repository.dart';
import '../services/crash_reporter.dart';
import '../services/recents_repository.dart';
import '../services/settings_repository.dart';
import '../services/sync_meta_repository.dart';
import '../services/sync_service.dart';
import 'auth_provider.dart';
import 'recents_provider.dart';
import 'settings_provider.dart';

enum SyncPhase { idle, syncing, success, error }

@immutable
class SyncStatus {
  const SyncStatus({this.phase = SyncPhase.idle, this.lastSyncedAt});

  final SyncPhase phase;
  final DateTime? lastSyncedAt;

  SyncStatus copyWith({SyncPhase? phase, DateTime? lastSyncedAt}) => SyncStatus(
    phase: phase ?? this.phase,
    lastSyncedAt: lastSyncedAt ?? this.lastSyncedAt,
  );
}

/// クラウド同期を司るノーティファイア。
///
/// [sync] でローカルスナップショットを組み立て、リモートと last-write-wins で
/// マージし、勝った側をローカルへ適用しつつリモートへ書き戻す。未ログイン時は
/// 何もしない（ゲスト含め uid があれば同期するが、UI では通常ログイン後に促す）。
class SyncNotifier extends Notifier<SyncStatus> {
  static final DateTime _epoch = DateTime.fromMillisecondsSinceEpoch(
    0,
    isUtc: true,
  );

  @override
  SyncStatus build() => const SyncStatus();

  Future<void> sync() async {
    final user = ref.read(authProvider).value;
    if (user == null || state.phase == SyncPhase.syncing) return;
    final crashReporter = ref.read(crashReporterProvider);

    state = state.copyWith(phase: SyncPhase.syncing);
    try {
      final service = ref.read(syncServiceProvider);
      final meta = await ref.read(syncMetaRepositoryProvider.future);
      final recentsRepo = await ref.read(recentsRepositoryProvider.future);
      final recentOriginsRepo = await ref.read(
        recentOriginsRepositoryProvider.future,
      );
      final settingsRepo = await ref.read(settingsRepositoryProvider.future);
      final activityRepo = await ref.read(activityLogRepositoryProvider.future);

      final local = SyncData(
        updatedAt: meta.localUpdatedAt ?? _epoch,
        settings: settingsRepo.load(),
        recents: await recentsRepo.load(),
        recentOrigins: await recentOriginsRepo.load(),
        activity: await activityRepo.load(),
      );
      final remote = await service.fetch(user.uid);
      final merged = remote == null
          ? local
          : SyncData.mergeLww(local: local, remote: remote);

      // リモートが勝った場合のみローカルへ適用する。
      if (!identical(merged, local)) {
        await settingsRepo.save(merged.settings);
        await recentsRepo.replaceAll(merged.recents);
        await recentOriginsRepo.replaceAll(merged.recentOrigins);
        await activityRepo.replaceAll(merged.activity);
        // 反映内容で UI を最新化する（アクティビティはメモリ保持のため次回起動で反映）。
        ref.invalidate(settingsProvider);
        ref.invalidate(recentsProvider);
        ref.invalidate(recentOriginsProvider);
      }

      // リモートが既にマージ結果と同一なら push を省き、無駄な Firestore
      // 書き込みを避ける（リモートが勝った直後や、変更が無い定期同期など）。
      if (remote == null || !merged.hasSameSnapshot(remote)) {
        await service.push(user.uid, merged);
      }
      // ローカルクロックを同期点に合わせる。
      await meta.markLocalChanged(merged.updatedAt);
      final syncedAt = DateTime.now().toUtc();
      await meta.setSyncedAt(syncedAt);
      state = SyncStatus(phase: SyncPhase.success, lastSyncedAt: syncedAt);
    } catch (e, stack) {
      crashReporter.recordError(e, stack, context: 'sync.run').ignore();
      state = state.copyWith(phase: SyncPhase.error);
    }
  }
}

final syncProvider = NotifierProvider<SyncNotifier, SyncStatus>(
  SyncNotifier.new,
);
