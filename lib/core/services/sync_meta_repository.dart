import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'recents_repository.dart';

/// 同期のためのローカルメタ情報を保存する。
///
/// [localUpdatedAt] はローカルデータが最後に変更された時刻で、last-write-wins の
/// 比較に使う。設定・履歴の変更時に [markLocalChanged] で更新する。
/// これが無いと、まっさらな端末でログインした際にローカルの空データでリモートを
/// 上書きしてしまう。
class SyncMetaRepository {
  SyncMetaRepository(this._prefs);

  static const String _localKey = 'sync.localUpdatedAt.v1';
  static const String _syncedKey = 'sync.lastSyncedAt.v1';

  final SharedPreferences _prefs;

  DateTime? get localUpdatedAt => _readUtc(_localKey);

  DateTime? get lastSyncedAt => _readUtc(_syncedKey);

  Future<void> markLocalChanged([DateTime? now]) =>
      _writeUtc(_localKey, now ?? DateTime.now());

  Future<void> setSyncedAt(DateTime at) => _writeUtc(_syncedKey, at);

  DateTime? _readUtc(String key) {
    final raw = _prefs.getString(key);
    if (raw == null) return null;
    return DateTime.tryParse(raw);
  }

  Future<void> _writeUtc(String key, DateTime value) =>
      _prefs.setString(key, value.toUtc().toIso8601String());
}

final syncMetaRepositoryProvider = FutureProvider<SyncMetaRepository>((
  ref,
) async {
  final prefs = await ref.watch(sharedPreferencesProvider.future);
  return SyncMetaRepository(prefs);
});
