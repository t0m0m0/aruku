import type { Navigate } from '../state/store';
import { Screen, screenFromLocation, screenPath } from './screens';

/// ルーターのうち、この層が要る2つ。React Router の `Router` をそのまま受けず絞るのは、
/// fake を置いて履歴の積み方を反証できるようにするため。
export interface RouterLike {
  currentPath(): string;
  navigate(path: string, options?: { replace?: boolean }): void;
}

/// ブラウザ履歴のうち、[seedInitialHistory] が要るもの。
export interface HistoryLike {
  /// 画面の分類に使う。クエリ・ハッシュを含まない。
  currentPath(): string;

  /// 積み直しに使う。クエリ・ハッシュを保つ。
  currentUrl(): string;

  /// 現在のエントリがこのアプリのルーターの作ったものか。
  isRouterEntry(): boolean;

  replaceState(url: string): void;
  pushState(url: string): void;
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
///
/// ルーター由来のエントリでも何もしない。アプリ内で home→子と遷移した後のリロードが
/// これにあたり、履歴は既に [home, 子] になっている。敷き直すとリロードのたびに home が
/// 1つ増え、home へ戻った後に重複した home を何度も戻らないと離脱できなくなる
/// （PR #391 レビュー。実ブラウザで history.length が 3→4 になるのを確認）。
export function seedInitialHistory(history: HistoryLike): void {
  if (history.isRouterEntry()) return;

  // replaceState の前に控える。積み直す URL はクエリ・ハッシュごと元のまま——
  // pathname だけにすると deep link の状態が黙って消える。
  const url = history.currentUrl();
  const path = history.currentPath();
  const screen = screenFromLocation(path);
  if (screen === Screen.home || screenPath[screen] !== path) return;
  history.replaceState(screenPath[Screen.home]);
  history.pushState(url);
}

/// `window.history` を [HistoryLike] へ寄せる。
///
/// ルーター由来かどうかを `history.state` の有無で見るのは、React Router が自分の作った
/// エントリに `{idx, key, usr}` を刻むため。アドレスバー直打ち・外部からの deep link は
/// null で入ってくる（実ブラウザで確認）。リロードでは刻まれた state が保たれるので、
/// 「一度このアプリが積んだ履歴か」の判定になる。
export function browserHistory(): HistoryLike {
  return {
    currentPath: () => window.location.pathname,
    currentUrl: () =>
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    isRouterEntry: () => window.history.state !== null,
    replaceState: (url) => window.history.replaceState(null, '', url),
    pushState: (url) => window.history.pushState(null, '', url),
  };
}
