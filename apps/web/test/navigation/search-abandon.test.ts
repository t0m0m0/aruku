// 待ち画面からの離脱で検索を止める購読（navigation/search-abandon.ts）。
//
// この治具は「遷移の途中でも購読が呼ばれる」ことを再現する。当初は location が原子的に
// 変わる治具で書いており、実ブラウザで起きていた誤発火（go(loading) の最中に
// 「loading から離れた」と読む）を再現できていなかった。

import { describe, expect, it, vi } from 'vitest';

import { Screen, screenPath } from '../../src/navigation/screens';
import {
  watchSearchAbandon,
  type NavigationSnapshot,
  type NavigationSource,
} from '../../src/navigation/search-abandon';

function source(initial: NavigationSnapshot) {
  let snapshot = initial;
  const listeners: (() => void)[] = [];
  const api: NavigationSource = {
    snapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
  };
  const notify = () => {
    for (const l of [...listeners]) l();
  };
  return {
    api,
    listenerCount: () => listeners.length,
    /// 遷移を最後まで進める。途中（未確定）の通知も1回挟む——ルーターは実際に
    /// そこで購読を呼ぶ。
    navigate(next: Omit<NavigationSnapshot, 'settled'>) {
      snapshot = { ...snapshot, settled: false };
      notify();
      snapshot = { ...next, settled: true };
      notify();
    },
  };
}

function storeWith(abandonSearch: () => void) {
  return { getState: () => ({ abandonSearch }) } as never;
}

const onLoading: NavigationSnapshot = {
  path: screenPath[Screen.loading],
  action: 'PUSH',
  settled: true,
};

describe('戻る操作での離脱', () => {
  it('待ち画面から戻ったら止める', () => {
    const abandonSearch = vi.fn();
    const s = source(onLoading);
    watchSearchAbandon(s.api, storeWith(abandonSearch));

    s.navigate({ path: screenPath[Screen.home], action: 'POP' });

    expect(abandonSearch).toHaveBeenCalledOnce();
  });
});

describe('止めてはいけない遷移', () => {
  // これが実ブラウザで起きていた。startSearch は go(loading) で遷移するが、その
  // 途中の通知では location がまだ home——「離れた」と読むと、始まったばかりの
  // 検索を自分の遷移で殺す。
  it('待ち画面へ入る遷移の途中で止めない', () => {
    const abandonSearch = vi.fn();
    const s = source({ path: screenPath[Screen.home], action: 'PUSH', settled: true });
    watchSearchAbandon(s.api, storeWith(abandonSearch));

    s.navigate({ path: screenPath[Screen.loading], action: 'PUSH' });

    expect(abandonSearch).not.toHaveBeenCalled();
  });

  // 成功・失敗での遷移はアプリ側が起こすもの（replace）。検索の結果と対で起きるので
  // 止める理由が無い。
  it.each([
    [screenPath[Screen.result], 'REPLACE' as const],
    [screenPath[Screen.error], 'REPLACE' as const],
  ])('%s への replace では止めない', (path, action) => {
    const abandonSearch = vi.fn();
    const s = source(onLoading);
    watchSearchAbandon(s.api, storeWith(abandonSearch));

    s.navigate({ path, action });

    expect(abandonSearch).not.toHaveBeenCalled();
  });

  it('待ち画面に留まる通知では止めない', () => {
    const abandonSearch = vi.fn();
    const s = source(onLoading);
    watchSearchAbandon(s.api, storeWith(abandonSearch));

    s.navigate({ path: screenPath[Screen.loading], action: 'POP' });

    expect(abandonSearch).not.toHaveBeenCalled();
  });

  // 決着前の断面は location が遷移前のまま。読むと1つ前の画面について判断してしまう。
  it('遷移が決着するまで判断しない', () => {
    const abandonSearch = vi.fn();
    const s = source(onLoading);
    watchSearchAbandon(s.api, storeWith(abandonSearch));

    s.navigate({ path: screenPath[Screen.home], action: 'POP' });

    // 途中で1回、決着で1回呼ばれるが、止めるのは決着後の1回だけ。
    expect(abandonSearch).toHaveBeenCalledOnce();
  });
});

describe('購読', () => {
  it('解除すると残らない', () => {
    const s = source(onLoading);
    const stop = watchSearchAbandon(s.api, storeWith(() => {}));

    stop();

    expect(s.listenerCount()).toBe(0);
  });
});
