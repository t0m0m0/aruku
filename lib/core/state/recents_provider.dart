import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/recent_destination.dart';
import '../services/recents_repository.dart';
import '../services/sync_meta_repository.dart';

class RecentsNotifier extends AsyncNotifier<List<RecentDestination>> {
  @override
  Future<List<RecentDestination>> build() async {
    final repo = await ref.watch(recentsRepositoryProvider.future);
    return repo.load();
  }

  Future<void> add(RecentDestination dest) async {
    final repo = await ref.read(recentsRepositoryProvider.future);
    await repo.add(dest);
    state = AsyncData(await repo.load());
    await _touchSync();
  }

  Future<void> clear() async {
    final repo = await ref.read(recentsRepositoryProvider.future);
    await repo.clear();
    state = const AsyncData([]);
    await _touchSync();
  }

  /// クラウド同期の last-write-wins 用にローカル変更時刻を更新する。
  Future<void> _touchSync() async {
    final meta = await ref.read(syncMetaRepositoryProvider.future);
    await meta.markLocalChanged();
  }
}

final recentsProvider =
    AsyncNotifierProvider<RecentsNotifier, List<RecentDestination>>(
      RecentsNotifier.new,
    );
