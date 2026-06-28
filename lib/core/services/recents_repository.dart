import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/recent_place.dart';

class RecentsRepository {
  RecentsRepository(this._prefs);

  static const String _key = 'recents.destinations.v1';
  static const int maxItems = 10;

  final SharedPreferences _prefs;

  // add/clear は load→変更→save の複合操作。fire-and-forget で多重に呼ばれても
  // 互いの書き込みを上書きしないよう、書き込み系を直列化する。
  Future<void> _writeLock = Future<void>.value();

  Future<List<RecentPlace>> load() async {
    final raw = _prefs.getString(_key);
    if (raw == null || raw.isEmpty) return const [];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      return decoded
          .whereType<Map<String, dynamic>>()
          .map(RecentPlace.fromJson)
          .toList(growable: false);
    } on FormatException {
      return const [];
    }
  }

  Future<void> add(RecentPlace dest) {
    return _serialize(() async {
      final stamped = dest.usedAt == null
          ? dest.copyWith(usedAt: DateTime.now().toUtc())
          : dest;
      final current = await load();
      final filtered = current.where((e) => e.dedupeKey != stamped.dedupeKey);
      final next = <RecentPlace>[stamped, ...filtered];
      final clipped = next.length > maxItems ? next.sublist(0, maxItems) : next;
      await _save(clipped);
    });
  }

  Future<void> clear() {
    return _serialize(() => _prefs.remove(_key));
  }

  /// 一覧を丸ごと差し替える（クラウド同期の適用など）。
  /// [maxItems] を超える分は先頭から切り詰める。
  Future<void> replaceAll(List<RecentPlace> items) {
    return _serialize(() {
      final clipped = items.length > maxItems
          ? items.sublist(0, maxItems)
          : items;
      return _save(clipped.toList(growable: false));
    });
  }

  /// 書き込み系操作を直前の操作完了後に実行し、load→save の競合を防ぐ。
  Future<void> _serialize(Future<void> Function() action) {
    final result = _writeLock.then((_) => action());
    // 失敗が後続をブロックしないよう、ロック鎖はエラーを飲み込む。
    _writeLock = result.catchError((_) {});
    return result;
  }

  Future<void> _save(List<RecentPlace> items) async {
    final encoded = jsonEncode(items.map((e) => e.toJson()).toList());
    await _prefs.setString(_key, encoded);
  }
}

/// SharedPreferences インスタンスを非同期取得するプロバイダ。
/// main 側で overrideWithValue する形でも、テスト側で差し替えても良い。
final sharedPreferencesProvider = FutureProvider<SharedPreferences>((ref) {
  return SharedPreferences.getInstance();
});

final recentsRepositoryProvider = FutureProvider<RecentsRepository>((
  ref,
) async {
  final prefs = await ref.watch(sharedPreferencesProvider.future);
  return RecentsRepository(prefs);
});
