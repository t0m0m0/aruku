// 待ち画面を離れたら進行中の検索を止める。
//
// 移植元は `PopScope(canPop: false)` で loading からの戻るを塞いでいた。web では
// 戻ってサイトを離れるのが当然の挙動なので塞がない——代わりに離脱で止める
// （PORTING.md の「loading から戻ったときの検索中断」）。
//
// **合図にコンポーネントのアンマウントを使わない。** StrictMode は
// mount→unmount→mount と走らせるので、開いた直後の「偽のアンマウント」で本物の
// 検索を殺す（実際にテストで踏んだ。#386 home スライスで現在地の取得が踏んだのと
// 同じ罠）。ルーターの購読は React の外なので、この二重実行に晒されない。

import type { StoreApi } from 'zustand/vanilla';

import type { AppStore } from '../state/store';
import { Screen, screenPath } from './screens';

/// 現在地の通知だけを取り出したルーター。
export interface PathSource {
  currentPath(): string;

  /// 変化のたびに呼ばれる購読。解除する関数を返す。
  subscribe(listener: () => void): () => void;
}

/// 待ち画面から離れた時点で [AppStore.abandonSearch] を呼ぶ購読を張る。
///
/// 止めてよいかの判断はストアが持つ（進行中でなければ何もしない）。成功で result へ
/// 移るときもここは通るので、一律に止めると出たばかりの結果の後始末まで巻き添えにする。
export function watchSearchAbandon(
  source: PathSource,
  store: StoreApi<AppStore>,
): () => void {
  return source.subscribe(() => {
    if (source.currentPath() === screenPath[Screen.loading]) return;
    store.getState().abandonSearch();
  });
}
