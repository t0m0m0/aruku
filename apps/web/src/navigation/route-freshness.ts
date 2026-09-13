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
// 合図は 2 つ要る:
//
// - `visibilitychange` — タブの背面滞在から戻ったとき。移植元の
//   AppLifecycleState.resumed に最も近い
// - **猶予の締切に張るタイマー** — 前面に置いたまま見続けているとき。可視性は
//   変わらないので上だけでは一生検算されず、乗れない便の経路を見せ続ける
//   （PR #398 の Codex レビュー。最初は前者だけで塞いだつもりになっていた）

import type { StoreApi } from 'zustand/vanilla';

import { routeFreshness } from '../state/app-state';
import type { AppStore } from '../state/store';

export interface VisibilitySource {
  /// いま見えているか。
  isVisible(): boolean;

  /// 可視性が変わるたびに呼ばれる購読。解除する関数を返す。
  subscribe(listener: () => void): () => void;
}

/// タイマーの差し替え口。テストで締切の到来を制御するために注入する。
export interface FreshnessTimers {
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
  now(): Date;
}

const browserTimers: FreshnessTimers = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms) as unknown as number,
  clearTimeout: (id) => {
    globalThis.clearTimeout(id);
  },
  now: () => new Date(),
};

/// 復帰と締切の両方で [AppStore.revalidateRoute] を呼ぶ購読を張る。
export function watchRouteFreshness(
  source: VisibilitySource,
  store: StoreApi<AppStore>,
  timers: FreshnessTimers = browserTimers,
): () => void {
  const stopVisibility = source.subscribe(() => {
    // 隠れる側では判定しない。見えていない間に home へ戻しても誰も見ておらず、
    // 戻ってきたときにもう一度判定するので取りこぼさない。
    if (!source.isVisible()) return;
    store.getState().revalidateRoute();
  });

  let timer: number | null = null;

  /// いま保持している経路の締切へタイマーを張り直す。
  ///
  /// 経路が変わるたびに引き直す。前の経路の締切が残っていると、新しい経路を
  /// その時刻に巻き添えで捨てる。
  function reschedule(): void {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    const { route, routeAsOf } = store.getState();
    // routeAsOf を持つのは isNow 経路だけ。固定出発は時間経過で腐らない。
    if (route === null || routeAsOf === null) return;

    const remaining = routeAsOf.getTime() + routeFreshness - timers.now().getTime();
    timer = timers.setTimeout(() => {
      timer = null;
      store.getState().revalidateRoute();
    }, Math.max(remaining, 0));
  }

  const stopStore = store.subscribe(reschedule);
  reschedule();

  return () => {
    stopVisibility();
    stopStore();
    if (timer !== null) timers.clearTimeout(timer);
  };
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
