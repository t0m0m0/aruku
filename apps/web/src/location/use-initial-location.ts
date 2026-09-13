import { useEffect } from 'react';
import type { StoreApi } from 'zustand/vanilla';

import type { AppStore } from '../state/store';

/// まだ一度も取っていなければ現在地を取りに行く。
///
/// 移植元は `AppNotifier.build()` で取っていた。ストア生成時に呼ぶと、モジュール
/// 読み込みだけで権限ダイアログが出る（store.ts の注記）ので、マウントの効果へ移した。
///
/// **画面を開く入口すべてから呼ぶ。** home だけが呼んでいたときは、`/home/search` を
/// 直接開いたりリロードしたりすると HomeScreen がマウントされず、位置が loading の
/// まま固まった——位置バイアスも「近くの店」も永久に出ない（PR #395 の Codex レビュー）。
///
/// 二重取得にはならない。決着済み（loading 以外）なら何もせず、取得中の要求には
/// `refreshLocation` 自身が相乗りする。
///
/// 判定はストアから直に読む。`locationState` を依存に入れると取得の完了で効果自体が
/// 再実行される——「一度だけ」を状態の変化で壊すことになる。
export function useInitialLocation(store: StoreApi<AppStore>): void {
  useEffect(() => {
    const { locationState, refreshLocation } = store.getState();
    if (locationState.kind !== 'loading') return;
    void refreshLocation();
  }, [store]);
}
