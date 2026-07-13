import 'package:aruku/core/navigation/screen_paths.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('ScreenPath.path', () {
    test('全 Screen が一意の絶対パスを持つ', () {
      final paths = Screen.values.map((s) => s.path).toSet();
      expect(paths.length, Screen.values.length);
      for (final p in paths) {
        expect(p, startsWith('/'));
      }
    });

    test('ネスト構造が現行の戻る挙動と一致する', () {
      // back: settings→home を実 pop で再現するためのネスト。
      expect(Screen.settings.path, '/home/settings');
      expect(Screen.home.path, '/home');
      // onboarding だけは home の外（back 無効の独立ルート）。
      expect(Screen.onboarding.path, '/onboarding');
    });
  });

  group('ScreenPath.fromLocation', () {
    test('全 Screen の path が往復変換できる', () {
      for (final s in Screen.values) {
        expect(ScreenPath.fromLocation(s.path), s, reason: s.name);
      }
    });

    test('クエリ付き location でも解決できる', () {
      expect(ScreenPath.fromLocation('/home/result?foo=1'), Screen.result);
    });

    test('未知の location は home へフォールバックする', () {
      expect(ScreenPath.fromLocation('/unknown'), Screen.home);
      expect(ScreenPath.fromLocation(''), Screen.home);
      expect(ScreenPath.fromLocation('/home/nope'), Screen.home);
    });
  });
}
