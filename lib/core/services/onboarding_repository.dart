import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'recents_repository.dart';

/// オンボーディング完了状態を SharedPreferences に保存・参照する。
class OnboardingRepository {
  OnboardingRepository(this._prefs);

  static const String _key = 'onboarding.completed.v1';

  final SharedPreferences _prefs;

  bool isCompleted() => _prefs.getBool(_key) ?? false;

  Future<void> markCompleted() => _prefs.setBool(_key, true);
}

final onboardingRepositoryProvider = FutureProvider<OnboardingRepository>((
  ref,
) async {
  final prefs = await ref.watch(sharedPreferencesProvider.future);
  return OnboardingRepository(prefs);
});

/// 起動時にオンボーディング完了フラグを同期参照するためのプロバイダ。
/// オンボーディングのチラつきを避けるため、[main] で SharedPreferences を
/// 先読みして実値に override する。未 override 時（テスト等）は未完了扱い。
final onboardingCompletedProvider = Provider<bool>((ref) => false);
