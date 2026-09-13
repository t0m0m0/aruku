// 待ち画面からの離脱で検索を止める購読（navigation/search-abandon.ts）。

import { describe, expect, it, vi } from 'vitest';

import { Screen, screenPath } from '../../src/navigation/screens';
import {
  watchSearchAbandon,
  type PathSource,
} from '../../src/navigation/search-abandon';

function source(initial: string) {
  let path = initial;
  const listeners: (() => void)[] = [];
  const api: PathSource = {
    currentPath: () => path,
    subscribe: (listener) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
  };
  return {
    api,
    goTo(next: string) {
      path = next;
      for (const l of [...listeners]) l();
    },
    listenerCount: () => listeners.length,
  };
}

function storeWith(abandonSearch: () => void) {
  return { getState: () => ({ abandonSearch }) } as never;
}

describe('待ち画面からの離脱', () => {
  it('離れたら止める', () => {
    const abandonSearch = vi.fn();
    const s = source(screenPath[Screen.loading]);
    watchSearchAbandon(s.api, storeWith(abandonSearch));

    s.goTo(screenPath[Screen.home]);

    expect(abandonSearch).toHaveBeenCalledOnce();
  });

  // 待ち画面の中での遷移（クエリ変更など）で止めてはいけない。
  it('待ち画面に留まっている間は止めない', () => {
    const abandonSearch = vi.fn();
    const s = source(screenPath[Screen.loading]);
    watchSearchAbandon(s.api, storeWith(abandonSearch));

    s.goTo(screenPath[Screen.loading]);

    expect(abandonSearch).not.toHaveBeenCalled();
  });

  // 成功で result へ移るときもここは通る。止めてよいかはストアが判断する
  // （進行中でなければ何もしない）ので、ここでは素直に呼ぶ。
  it('結果画面へ移るときも呼ぶ（可否の判断はストア）', () => {
    const abandonSearch = vi.fn();
    const s = source(screenPath[Screen.loading]);
    watchSearchAbandon(s.api, storeWith(abandonSearch));

    s.goTo(screenPath[Screen.result]);

    expect(abandonSearch).toHaveBeenCalledOnce();
  });

  it('解除すると購読が残らない', () => {
    const s = source(screenPath[Screen.loading]);
    const stop = watchSearchAbandon(s.api, storeWith(() => {}));

    stop();

    expect(s.listenerCount()).toBe(0);
  });
});
