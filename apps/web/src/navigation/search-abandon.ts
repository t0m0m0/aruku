// 待ち画面から**戻る操作で**離れたら、進行中の検索を止める。
//
// 移植元は `PopScope(canPop: false)` で loading からの戻るを塞いでいた。web では
// 戻ってサイトを離れるのが当然の挙動なので塞がない——代わりに離脱で止める
// （PORTING.md の「loading から戻ったときの検索中断」）。
//
// **合図にコンポーネントのアンマウントを使わない。** StrictMode は
// mount→unmount→mount と走らせるので、開いた直後の「偽のアンマウント」で本物の
// 検索を殺す。ルーターの購読は React の外なのでこの二重実行に晒されない。
//
// **そして「現在地が loading でなくなったこと」だけでも足りない。** ルーターの購読は
// 遷移の**途中**でも呼ばれ、そのとき location はまだ遷移前——`go(loading)` の最中に
// 「loading から離れた」と誤読して、始まったばかりの検索を自分の遷移で殺していた
// （実ブラウザで発覚。ダミーの購読を使った単体テストでは location が原子的に
// 変わるので再現しない）。
//
// 見るのは **POP（戻る／進む）だけ**。これが移植元の PopScope が塞いでいた操作そのもので、
// アプリ側の遷移（push / replace）は検索の成否と対で起きるため止める理由が無い。

import type { StoreApi } from 'zustand/vanilla';

import type { AppStore } from '../state/store';
import { Screen, screenPath } from './screens';

/// 遷移の確定した一断面。
export interface NavigationSnapshot {
  readonly path: string;

  /// 現在地へ至った操作。'POP' が戻る／進む。
  readonly action: 'POP' | 'PUSH' | 'REPLACE';

  /// 遷移が決着しているか。途中の通知を読むと遷移前の location を見てしまう。
  readonly settled: boolean;
}

export interface NavigationSource {
  snapshot(): NavigationSnapshot;

  /// 変化のたびに呼ばれる購読。解除する関数を返す。
  subscribe(listener: () => void): () => void;
}

/// 待ち画面から戻る操作で離れた時点で [AppStore.abandonSearch] を呼ぶ購読を張る。
export function watchSearchAbandon(
  source: NavigationSource,
  store: StoreApi<AppStore>,
): () => void {
  return source.subscribe(() => {
    const { path, action, settled } = source.snapshot();
    if (!settled) return;
    if (action !== 'POP') return;
    if (path === screenPath[Screen.loading]) return;
    store.getState().abandonSearch();
  });
}
