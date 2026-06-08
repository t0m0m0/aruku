import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/favorite_place.dart';
import 'recents_repository.dart' show sharedPreferencesProvider;

/// スターで保存したお気に入り地点を SharedPreferences に永続化する。
class FavoritesRepository {
  FavoritesRepository(this._prefs);

  static const String _key = 'favorites.places.v1';
  static const int maxItems = 50;

  final SharedPreferences _prefs;

  // toggle/remove は load→変更→save の複合操作。fire-and-forget で多重に
  // 呼ばれても互いの書き込みを上書きしないよう、書き込み系を直列化する。
  Future<void> _writeLock = Future<void>.value();

  Future<List<FavoritePlace>> load() async {
    final raw = _prefs.getString(_key);
    if (raw == null || raw.isEmpty) return const [];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      return decoded
          .whereType<Map<String, dynamic>>()
          .map(FavoritePlace.fromJson)
          .toList(growable: false);
    } on FormatException {
      return const [];
    }
  }

  Future<bool> contains(FavoritePlace place) async {
    final current = await load();
    return current.any((e) => e.dedupeKey == place.dedupeKey);
  }

  /// 未登録なら追加、登録済みなら削除する。
  Future<void> toggle(FavoritePlace place) {
    return _serialize(() async {
      final current = await load();
      final exists = current.any((e) => e.dedupeKey == place.dedupeKey);
      if (exists) {
        await _save(
          current
              .where((e) => e.dedupeKey != place.dedupeKey)
              .toList(growable: false),
        );
        return;
      }
      final stamped = place.savedAt == null
          ? place.copyWith(savedAt: DateTime.now().toUtc())
          : place;
      final next = <FavoritePlace>[stamped, ...current];
      final clipped = next.length > maxItems ? next.sublist(0, maxItems) : next;
      await _save(clipped);
    });
  }

  Future<void> remove(FavoritePlace place) {
    return _serialize(() async {
      final current = await load();
      await _save(
        current
            .where((e) => e.dedupeKey != place.dedupeKey)
            .toList(growable: false),
      );
    });
  }

  Future<void> clear() {
    return _serialize(() => _prefs.remove(_key));
  }

  /// 書き込み系操作を直前の操作完了後に実行し、load→save の競合を防ぐ。
  Future<void> _serialize(Future<void> Function() action) {
    final result = _writeLock.then((_) => action());
    // 失敗が後続をブロックしないよう、ロック鎖はエラーを飲み込む。
    _writeLock = result.catchError((_) {});
    return result;
  }

  Future<void> _save(List<FavoritePlace> items) async {
    final encoded = jsonEncode(items.map((e) => e.toJson()).toList());
    await _prefs.setString(_key, encoded);
  }
}

final favoritesRepositoryProvider = FutureProvider<FavoritesRepository>((
  ref,
) async {
  final prefs = await ref.watch(sharedPreferencesProvider.future);
  return FavoritesRepository(prefs);
});
