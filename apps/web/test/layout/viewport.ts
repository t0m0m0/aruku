/// 幅の判定（`useIsDesktop`）の両側を作る治具。
///
/// jsdom には matchMedia が無く、test/setup.ts が敷くのは「幅を答えない」実装
/// （＝常にモバイル）。デスクトップ側はここで差し替える。

import { act } from '@testing-library/react';
import { vi } from 'vitest';

import { desktopMediaQuery } from '../../src/layout/breakpoints';

export interface StubbedViewport {
  /// ウィンドウ幅が境界を跨いだときにブラウザが送るのと同じ通知を出す。
  cross(desktop: boolean): void;

  /// 幅の変化を待っている購読の数。解除漏れの検出に使う。
  listenerCount(): number;
}

/// `desktopMediaQuery` にだけ答える matchMedia を立てる。別のクエリを問い合わせたら
/// 落とす——幅の判定の入口が増えたことに気付けるように。
export function stubViewport(desktop: boolean): StubbedViewport {
  const listeners = new Set<() => void>();
  const mql = {
    matches: desktop,
    media: desktopMediaQuery,
    addEventListener: (_type: 'change', listener: () => void) => {
      listeners.add(listener);
    },
    removeEventListener: (_type: 'change', listener: () => void) => {
      listeners.delete(listener);
    },
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => {
      if (query !== desktopMediaQuery) {
        throw new Error(`想定外のメディアクエリ: ${query}`);
      }
      return mql;
    }),
  );
  return {
    cross(next: boolean) {
      mql.matches = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
    listenerCount: () => listeners.size,
  };
}
