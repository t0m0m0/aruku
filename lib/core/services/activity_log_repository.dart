import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/daily_activity.dart';
import 'recents_repository.dart' show sharedPreferencesProvider;

/// 日次の活動量（歩数）を SharedPreferences に永続化する。
/// ストリーク・週次集計の元データを供給する。
class ActivityLogRepository {
  ActivityLogRepository(this._prefs);

  static const String storageKey = 'activity.log.v1';

  /// 履歴を保持する日数。これより古い日付は upsert 時に刈り取る。
  static const int retentionDays = 400;

  final SharedPreferences _prefs;

  // upsert は load→変更→save の複合操作。fire-and-forget で多重に呼ばれても
  // 互いの書き込みを失わないよう、書き込み系を直列化する。
  Future<void> _writeLock = Future<void>.value();

  /// 日付昇順の全履歴を返す。破損時は空リストにフォールバックする。
  Future<List<DailyActivity>> load() async {
    final raw = _prefs.getString(storageKey);
    if (raw == null || raw.isEmpty) return const [];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      final items =
          decoded
              .whereType<Map<String, dynamic>>()
              .map(DailyActivity.fromJson)
              .toList()
            ..sort((a, b) => a.date.compareTo(b.date));
      return items;
    } on FormatException {
      return const [];
    }
  }

  /// [entry] の日付分を追加または上書きし、古い履歴を刈り取って保存する。
  Future<void> upsert(DailyActivity entry, {DateTime? now}) {
    return _serialize(() async {
      final cutoff = (now ?? DateTime.now()).subtract(
        const Duration(days: retentionDays),
      );
      final current = await load();
      final next = [
        for (final e in current)
          if (e.dateKey != entry.dateKey && !e.date.isBefore(cutoff)) e,
        entry,
      ]..sort((a, b) => a.date.compareTo(b.date));
      await _save(next);
    });
  }

  /// 履歴を丸ごと差し替える（クラウド同期の適用など）。
  /// 日付昇順に整え、保持期間を超える古い日付は切り捨てる。
  Future<void> replaceAll(List<DailyActivity> items, {DateTime? now}) {
    return _serialize(() async {
      final cutoff = (now ?? DateTime.now()).subtract(
        const Duration(days: retentionDays),
      );
      final next = [
        for (final e in items)
          if (!e.date.isBefore(cutoff)) e,
      ]..sort((a, b) => a.date.compareTo(b.date));
      await _save(next);
    });
  }

  /// 書き込み系操作を直前の操作完了後に実行し、load→save の競合を防ぐ。
  Future<void> _serialize(Future<void> Function() action) {
    final result = _writeLock.then((_) => action());
    // 失敗が後続をブロックしないよう、ロック鎖はエラーを飲み込む。
    _writeLock = result.catchError((_) {});
    return result;
  }

  Future<void> _save(List<DailyActivity> items) async {
    final encoded = jsonEncode(items.map((e) => e.toJson()).toList());
    await _prefs.setString(storageKey, encoded);
  }
}

final activityLogRepositoryProvider = FutureProvider<ActivityLogRepository>((
  ref,
) async {
  final prefs = await ref.watch(sharedPreferencesProvider.future);
  return ActivityLogRepository(prefs);
});
