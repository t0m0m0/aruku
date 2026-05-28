import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../models/recent_destination.dart';

class RecentsRepository {
  RecentsRepository(this._prefs);

  static const String _key = 'recents.destinations.v1';
  static const int maxItems = 10;

  final SharedPreferences _prefs;

  Future<List<RecentDestination>> load() async {
    final raw = _prefs.getString(_key);
    if (raw == null || raw.isEmpty) return const [];
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! List) return const [];
      return decoded
          .whereType<Map<String, dynamic>>()
          .map(RecentDestination.fromJson)
          .toList(growable: false);
    } on FormatException {
      return const [];
    }
  }

  Future<void> add(RecentDestination dest) async {
    final stamped = dest.usedAt == null
        ? dest.copyWith(usedAt: DateTime.now().toUtc())
        : dest;
    final current = await load();
    final filtered = current.where((e) => e.dedupeKey != stamped.dedupeKey);
    final next = <RecentDestination>[stamped, ...filtered];
    final clipped = next.length > maxItems ? next.sublist(0, maxItems) : next;
    await _save(clipped);
  }

  Future<void> clear() async {
    await _prefs.remove(_key);
  }

  Future<void> _save(List<RecentDestination> items) async {
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
