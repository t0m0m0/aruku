import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../models/favorite_place.dart';
import '../services/favorites_repository.dart';

class FavoritesNotifier extends AsyncNotifier<List<FavoritePlace>> {
  @override
  Future<List<FavoritePlace>> build() async {
    final repo = await ref.watch(favoritesRepositoryProvider.future);
    return repo.load();
  }

  /// 未登録なら追加、登録済みなら削除する。
  Future<void> toggle(FavoritePlace place) async {
    final repo = await ref.read(favoritesRepositoryProvider.future);
    await repo.toggle(place);
    state = AsyncData(await repo.load());
  }

  Future<void> remove(FavoritePlace place) async {
    final repo = await ref.read(favoritesRepositoryProvider.future);
    await repo.remove(place);
    state = AsyncData(await repo.load());
  }

  Future<void> clear() async {
    final repo = await ref.read(favoritesRepositoryProvider.future);
    await repo.clear();
    state = const AsyncData([]);
  }

  /// 現在の state（ロード済み一覧）に同一地点が含まれるか。
  /// 未ロード時は false。
  bool isFavorite(FavoritePlace place) {
    final list = state.value;
    if (list == null) return false;
    return list.any((e) => e.dedupeKey == place.dedupeKey);
  }
}

final favoritesProvider =
    AsyncNotifierProvider<FavoritesNotifier, List<FavoritePlace>>(
      FavoritesNotifier.new,
    );
