import '../state/app_state.dart';

/// [Screen] と go_router の location を相互変換する。
///
/// ネスト構造は現行の戻る挙動（auth→settings、それ以外→home）を
/// 実 Navigator の pop で再現するためのもの。onboarding だけは
/// home の外に置き、back 無効の独立ルートとする。
extension ScreenPath on Screen {
  String get path => switch (this) {
    Screen.onboarding => '/onboarding',
    Screen.home => '/home',
    Screen.settings => '/home/settings',
    Screen.auth => '/home/settings/auth',
    Screen.search => '/home/search',
    Screen.searchOrigin => '/home/search-origin',
    Screen.loading => '/home/loading',
    Screen.result => '/home/result',
    Screen.nav => '/home/nav',
    Screen.error => '/home/error',
  };

  static final Map<String, Screen> _byPath = {
    for (final s in Screen.values) s.path: s,
  };

  /// location（クエリ付き可）を [Screen] に解決する。未知のパスは
  /// deep link の打ち間違い等なので安全側の home へフォールバックする。
  static Screen fromLocation(String location) {
    final path = Uri.parse(location).path;
    return _byPath[path] ?? Screen.home;
  }
}
