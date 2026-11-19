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
    for (const l of listeners.slice()) l();
  };
  return {
    api,
    listenerCount: () => listeners.length,
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
  it('待ち画面へ入る遷移の途中で止めない', () => {
    const abandonSearch = vi.fn();
    const s = source({ path: screenPath[Screen.home], action: 'PUSH', settled: true });
    watchSearchAbandon(s.api, storeWith(abandonSearch));

    s.navigate({ path: screenPath[Screen.loading], action: 'PUSH' });

    expect(abandonSearch).not.toHaveBeenCalled();
  });

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

  it('遷移が決着するまで判断しない', () => {
    const abandonSearch = vi.fn();
    const s = source(onLoading);
    watchSearchAbandon(s.api, storeWith(abandonSearch));

    s.navigate({ path: screenPath[Screen.home], action: 'POP' });

    expect(abandonSearch).toHaveBeenCalledOnce();
  });
});

describe('購読', () => {
  it('解除すると残らない', () => {
    const s = source(onLoading);
    const stop = watchSearchAbandon(
      s.api,
      storeWith(() => {}),
    );

    stop();

    expect(s.listenerCount()).toBe(0);
  });
});
