// 開いたままの経路を復帰のたびに検算する購読（navigation/route-freshness.ts）。

import { describe, expect, it, vi } from 'vitest';

import {
  watchRouteFreshness,
  type VisibilitySource,
} from '../../src/navigation/route-freshness';

function source(visible: boolean) {
  let isVisible = visible;
  const listeners: (() => void)[] = [];
  const api: VisibilitySource = {
    isVisible: () => isVisible,
    subscribe: (listener) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
  };
  return {
    api,
    listenerCount: () => listeners.length,
    set(next: boolean) {
      isVisible = next;
      for (const l of [...listeners]) l();
    },
  };
}

function storeWith(revalidateRoute: () => void) {
  return { getState: () => ({ revalidateRoute }) } as never;
}

describe('復帰での検算', () => {
  it('見える状態へ戻ったら検算する', () => {
    const revalidateRoute = vi.fn();
    const s = source(false);
    watchRouteFreshness(s.api, storeWith(revalidateRoute));

    s.set(true);

    expect(revalidateRoute).toHaveBeenCalledOnce();
  });

  // 見えていない間に home へ戻しても誰も見ていない。戻ってきたときに判定するので
  // 取りこぼさない。
  it('隠れる側では検算しない', () => {
    const revalidateRoute = vi.fn();
    const s = source(true);
    watchRouteFreshness(s.api, storeWith(revalidateRoute));

    s.set(false);

    expect(revalidateRoute).not.toHaveBeenCalled();
  });

  it('解除すると購読が残らない', () => {
    const s = source(true);
    const stop = watchRouteFreshness(s.api, storeWith(() => {}));

    stop();

    expect(s.listenerCount()).toBe(0);
  });
});
