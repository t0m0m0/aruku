// 移植元: lib/core/navigation/screen_paths.dart

/// 画面の識別子。ルート表の語彙であって**状態ではない**——現在どの画面かの権威は
/// URL（React Router）が持つ。移植元は `AppState.screen` にミラーを置き、go_router
/// との双方向同期とエコー遮断を三重に敷いていたが、#386 で権威を URL 一本にした
/// ためミラーごと不要になった。
export const Screen = {
  home: 'home',
  settings: 'settings',
  search: 'search',
  searchOrigin: 'searchOrigin',
  loading: 'loading',
  result: 'result',
  error: 'error',
} as const;
export type Screen = (typeof Screen)[keyof typeof Screen];

/// ネスト構造は戻り先を表す（settings/search/result/error→home）。
export const screenPath: Readonly<Record<Screen, string>> = {
  [Screen.home]: '/home',
  [Screen.settings]: '/home/settings',
  [Screen.search]: '/home/search',
  [Screen.searchOrigin]: '/home/search-origin',
  [Screen.loading]: '/home/loading',
  [Screen.result]: '/home/result',
  [Screen.error]: '/home/error',
};

/// 未知の location / 表示前提データを欠く deep link の安全な戻り先。
export const fallbackScreen: Screen = Screen.home;

const screenByPath = new Map<string, Screen>(
  Object.entries(screenPath).map(([screen, path]) => [path, screen as Screen]),
);

/// location（クエリ付き可）を [Screen] に解決する。未知のパスは deep link の
/// 打ち間違い等なので安全側の home へフォールバックする。
export function screenFromLocation(location: string): Screen {
  const path = new URL(location, 'https://placeholder.invalid').pathname;
  return screenByPath.get(path) ?? fallbackScreen;
}
