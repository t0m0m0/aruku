import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/recent_place.dart';
import '../services/recents_repository.dart';
import '../services/sync_meta_repository.dart';

/// 履歴ノーティファイアの共通実装。永続化先リポジトリだけを差し替えて、
/// 目的地履歴と出発地履歴で同じ振る舞いを共有する。
abstract class _RecentsNotifierBase extends AsyncNotifier<List<RecentPlace>> {
  /// このノーティファイアが読み書きするリポジトリのプロバイダ。
  FutureProvider<RecentsRepository> get repositoryProvider;

  @override
  Future<List<RecentPlace>> build() async {
    final repo = await ref.watch(repositoryProvider.future);
    return repo.load();
  }

  Future<void> add(RecentPlace place) async {
    final repo = await ref.read(repositoryProvider.future);
    await repo.add(place);
    state = AsyncData(await repo.load());
    await _touchSync();
  }

  Future<void> clear() async {
    final repo = await ref.read(repositoryProvider.future);
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

/// 目的地履歴のノーティファイア。
class RecentsNotifier extends _RecentsNotifierBase {
  @override
  FutureProvider<RecentsRepository> get repositoryProvider =>
      recentsRepositoryProvider;
}

/// 出発地履歴のノーティファイア。目的地とは別キーで独立管理する。
class RecentOriginsNotifier extends _RecentsNotifierBase {
  @override
  FutureProvider<RecentsRepository> get repositoryProvider =>
      recentOriginsRepositoryProvider;
}

final recentsProvider =
    AsyncNotifierProvider<RecentsNotifier, List<RecentPlace>>(
      RecentsNotifier.new,
    );

final recentOriginsProvider =
    AsyncNotifierProvider<RecentOriginsNotifier, List<RecentPlace>>(
      RecentOriginsNotifier.new,
    );
