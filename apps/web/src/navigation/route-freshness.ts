// 開いたままの「今すぐ」経路を、復帰のたびに検算する。
//
// 移植元 `AppNotifier.onAppResumed`（app_state.dart）に相当する。#264 の失効判定は
// 3 箇所で要る:
//
// 1. 画面へ**入る**とき — ルートの loader（guard.ts）
// 2. 照会が**終わった**とき — startSearch の最後の砦
// 3. 開いたまま**居続けた**とき — ここ
//
// 3 が無いと、結果を開いて放置した経路やタブを背面にして戻ってきた経路が、猶予を
// 超えても出たままになる。乗るはずだった便には既に乗れない。
//
// 合図は `visibilitychange`。移植元の AppLifecycleState.resumed に最も近く、
// タブの背面滞在（この問題が起きる主な経路）をそのまま捉える。

import type { StoreApi } from 'zustand/vanilla';

import type { AppStore } from '../state/store';

export interface VisibilitySource {
  /// いま見えているか。
  isVisible(): boolean;

  /// 可視性が変わるたびに呼ばれる購読。解除する関数を返す。
  subscribe(listener: () => void): () => void;
}

/// 画面が見える状態へ戻るたびに [AppStore.revalidateRoute] を呼ぶ購読を張る。
export function watchRouteFreshness(
  source: VisibilitySource,
  store: StoreApi<AppStore>,
): () => void {
  return source.subscribe(() => {
    // 隠れる側では判定しない。見えていない間に home へ戻しても誰も見ておらず、
    // 戻ってきたときにもう一度判定するので取りこぼさない。
    if (!source.isVisible()) return;
    store.getState().revalidateRoute();
  });
}

/// ブラウザの可視性を [VisibilitySource] として見せる。
export function documentVisibility(): VisibilitySource {
  return {
    isVisible: () => document.visibilityState === 'visible',
    subscribe: (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => {
        document.removeEventListener('visibilitychange', listener);
      };
    },
  };
}
