import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/app_settings.dart';
import 'recents_repository.dart';

/// アプリ設定を SharedPreferences に JSON で保存・参照する。
class SettingsRepository {
  SettingsRepository(this._prefs);

  static const String _key = 'settings.v1';

  final SharedPreferences _prefs;

  /// 保存済みの設定を返す。未保存・破損時は [AppSettings.defaults]。
  AppSettings load() {
    final raw = _prefs.getString(_key);
    if (raw == null || raw.isEmpty) return AppSettings.defaults;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return AppSettings.defaults;
      return AppSettings.fromJson(decoded);
    } on FormatException {
      return AppSettings.defaults;
    }
  }

  Future<void> save(AppSettings settings) =>
      _prefs.setString(_key, jsonEncode(settings.toJson()));
}

final settingsRepositoryProvider = FutureProvider<SettingsRepository>((
  ref,
) async {
  final prefs = await ref.watch(sharedPreferencesProvider.future);
  return SettingsRepository(prefs);
});

/// 起動時の初期到着時刻（時間予算）を同期的に決めるための値。
/// オンボーディング完了フラグと同様、main で保存値を先読みして注入する。
/// 未注入時は [AppSettings.defaults] の値にフォールバックする。
final defaultBudgetMinutesProvider = Provider<int>(
  (ref) => AppSettings.defaults.defaultBudgetMinutes,
);
