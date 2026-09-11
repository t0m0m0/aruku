import type { Navigate } from '../state/store';
import { Screen, screenFromLocation, screenPath } from './screens';

/// ルーターのうち、この層が要る2つ。React Router の `Router` をそのまま受けず絞るのは、
/// fake を置いて履歴の積み方を反証できるようにするため。
export interface RouterLike {
  currentPath(): string;
  navigate(path: string, options?: { replace?: boolean }): void;
}

/// ブラウザ履歴のうち、[seedInitialHistory] が要る3つ。
export interface HistoryLike {
  currentPath(): string;
  replaceState(path: string): void;
  pushState(path: string): void;
}

/// 移植元の戻り挙動（settings/search/result/error→home）を再現する push / replace の選択。
///
/// 移植元は go_router のネスト構造で Navigator の pop スタックを作っていた。React Router
/// のネストは `<Outlet>` の入れ子であって履歴を積まないので、URL の前置きだけでは戻り先に
/// ならない。だからここで明示的に積む——home から子へだけ push し、それ以外は replace
/// することで、履歴は常に高々 [home, 子] に保たれる。
export function navigationIntent(from: Screen, to: Screen): 'push' | 'replace' {
  return from === Screen.home && to !== Screen.home ? 'push' : 'replace';
}

export function createNavigator(router: RouterLike): Navigate {
  return (path: string) => {
    const from = screenFromLocation(router.currentPath());
    const to = screenFromLocation(path);
    router.navigate(path, {
      replace: navigationIntent(from, to) === 'replace',
    });
  };
}

/// 子の画面を直接開いた（deep link・リロード）ときに、その下へ home を敷く。
///
/// 履歴にその1件しか無い状態では、戻るとアプリの外へ出る。移植元では go_router が
/// ネスト構造から親ルートを合成して [home, 子] を作っていた部分にあたる。
///
/// ルーターの `navigate` ではなく生の History API を使い、**ルーターを作る前に**呼ぶ。
/// ルーターは `RouterProvider` がマウントするまで履歴に繋がらないので、それ以前の
/// navigate は履歴に現れない（実ブラウザで確認。PR #391 レビューの対応中）。マウント後に
/// 遷移で積む手もあるが、home を1フレーム描いてから子へ跳ぶちらつきが出る。
///
/// 未知のパスでは何もしない。[resolveRedirect] が home へ寄せるので、ここで敷くと
/// 同じ home が2つ積まれるだけになる。
export function seedInitialHistory(history: HistoryLike): void {
  const path = history.currentPath();
  const screen = screenFromLocation(path);
  if (screen === Screen.home || screenPath[screen] !== path) return;
  history.replaceState(screenPath[Screen.home]);
  history.pushState(path);
}

/// `window.history` を [HistoryLike] へ寄せる。
export function browserHistory(): HistoryLike {
  return {
    currentPath: () => window.location.pathname,
    replaceState: (path) => window.history.replaceState(null, '', path),
    pushState: (path) => window.history.pushState(null, '', path),
  };
}
