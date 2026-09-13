import type { Navigate } from '../state/store';
import { Screen, screenFromLocation, screenPath } from './screens';

/// ルーターのうち、この層が要る2つ。React Router の `Router` をそのまま受けず絞るのは、
/// fake を置いて履歴の積み方を反証できるようにするため。
export interface RouterLike {
  currentPath(): string;
  navigate(path: string, options?: { replace?: boolean }): void;

  /// 履歴を1つ戻る。子から home へ帰るときに、積んだ子を降ろすために使う。
  back(): void;
}

/// ブラウザ履歴のうち、[seedInitialHistory] が要るもの。
export interface HistoryLike {
  /// 画面の分類に使う。クエリ・ハッシュを含まない。
  currentPath(): string;

  /// 積み直しに使う。クエリ・ハッシュを保つ。
  currentUrl(): string;

  /// 現在のエントリがこのアプリのルーターの作ったものか。
  isRouterEntry(): boolean;

  /// このアプリの履歴に、現在のエントリより手前があるか。
  hasParentEntry(): boolean;

  /// 1つ戻る。
  back(): void;

  /// 履歴の深さ（React Router が `state.idx` に持つもの）を明示して書く。
  ///
  /// 敷いた履歴をルーター自身が作ったものと**区別できない形**にするため。深さを
  /// 書かないとルーターが現在のエントリへ 0 を振り、敷いた子が「手前が無い」と
  /// 読まれる。子から子への遷移は replace で idx を保つので、その後ガードを要る
  /// 画面へ移ってリロードすると、真下に home があるのに降りられなくなる。
  replaceState(url: string, index: number): void;
  pushState(url: string, index: number): void;
}

/// 移植元の戻り挙動（settings/search/result/error→home）を再現する履歴操作の選択。
///
/// 移植元は go_router のネスト構造で Navigator の pop スタックを作っていた。React Router
/// のネストは `<Outlet>` の入れ子であって履歴を積まないので、URL の前置きだけでは戻り先に
/// ならない。だからここで明示的に積み降ろしする。履歴は常に高々 [home, 子] に保たれる。
///
/// 子から home へ `replace` しないのは、それが [home, home] を作るため——最初の「戻る」が
/// home を再表示するだけでアプリを離れられない。積んだ子を降ろす `pop` が移植元の挙動。
///
/// `pop` は「子に居るなら真下は home」という不変条件に依る。それを保っているのは
/// このテーブル自身と [seedInitialHistory]（直接開いた子の下に home を敷く）。
export function navigationIntent(
  from: Screen,
  to: Screen,
): 'push' | 'replace' | 'pop' {
  if (from === to) return 'replace';
  if (from === Screen.home) return 'push';
  return to === Screen.home ? 'pop' : 'replace';
}

export function createNavigator(router: RouterLike): Navigate {
  return (path: string) => {
    const from = screenFromLocation(router.currentPath());
    const to = screenFromLocation(path);
    const intent = navigationIntent(from, to);
    if (intent === 'pop') {
      router.back();
      return;
    }
    router.navigate(path, { replace: intent === 'replace' });
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
/// [canSeed] が偽の画面にも敷かない。/home/result のように表示前提データを要る画面を
/// 直接開くと、起動直後のストアはまだそれを持たずガードが home へ寄せる。先に [home, 子]
/// を積むとその下に余分な home が残り、最初の「戻る」が home を再表示するだけになる
/// （実ブラウザで履歴が +2 になるのを確認。PR #391 レビュー）。
///
/// ルーター由来のエントリでも何もしない。アプリ内で home→子と遷移した後のリロードが
/// これにあたり、履歴は既に [home, 子] になっている。敷き直すとリロードのたびに home が
/// 1つ増え、home へ戻った後に重複した home を何度も戻らないと離脱できなくなる
/// （PR #391 レビュー。実ブラウザで history.length が 3→4 になるのを確認）。
export function seedInitialHistory(
  history: HistoryLike,
  canSeed: (url: string) => boolean,
): void {
  // replaceState の前に控える。積み直す URL はクエリ・ハッシュごと元のまま——
  // pathname だけにすると deep link の状態が黙って消える。
  const url = history.currentUrl();
  const path = history.currentPath();
  const screen = screenFromLocation(path);
  if (screen === Screen.home || screenPath[screen] !== path) return;

  if (history.isRouterEntry()) {
    // リロードでここへ来る。表示前提データはメモリ上のストアにしか無いので、
    // アプリ内で開いた result / loading / error をリロードすると通らなくなる。
    // ガードに差し替えさせると真下の home と重なって [home, home] になるため、
    // 既にある home へ降りる。降りるだけならエントリは増えない。
    if (!canSeed(url) && history.hasParentEntry()) history.back();
    return;
  }

  if (!canSeed(url)) return;
  history.replaceState(screenPath[Screen.home], 0);
  history.pushState(url, 1);
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
    // React Router は自分の履歴の深さを `idx` に持つ。0 は「このアプリで最初に開いた
    // エントリ」で、手前へ降りるとアプリの外へ出る。
    hasParentEntry: () => {
      const state: unknown = window.history.state;
      const idx =
        typeof state === 'object' && state !== null && 'idx' in state
          ? state.idx
          : null;
      return typeof idx === 'number' && idx > 0;
    },
    // ルーターが自分で書くのと同じ形（`{ idx }` だけ。usr / key は初期エントリでも
    // 付かない）にする。react-router の createBrowserHistory は state.idx が在れば
    // それを起点に採り、無いときだけ 0 を書き込む。
    replaceState: (url, index) =>
      window.history.replaceState({ idx: index }, '', url),
    pushState: (url, index) => window.history.pushState({ idx: index }, '', url),
    back: () => window.history.back(),
  };
}
