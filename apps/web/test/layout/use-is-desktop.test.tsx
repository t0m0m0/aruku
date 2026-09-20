// 移植元: lib/core/config/layout_breakpoints.dart（境界 820px）と
// lib/shared/widgets/responsive_scope.dart（実測幅を1点へ流し込む注入点）。
//
// 移植元が provider + ResponsiveScope の2枚で作っていた注入点は、web では
// matchMedia そのものが担う。差し替える先が1つなので、幅の両側を作るテストは
// このスタブだけで書ける——各画面が window.innerWidth を直読みしない限りは。

import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  desktopBreakpointPx,
  desktopMediaQuery,
} from '../../src/layout/breakpoints';
import { useIsDesktop } from '../../src/layout/use-is-desktop';

function Probe() {
  return <p>{useIsDesktop() ? 'desktop' : 'mobile'}</p>;
}

/// `desktopMediaQuery` に対してだけ [matches] を返す matchMedia を立てる。
/// 別のクエリを問い合わせたら落とす——問い合わせ先が増えたことに気付けるように。
function stubMatchMedia(matches: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches,
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
    /// ウィンドウ幅が境界を跨いだときにブラウザがするのと同じ通知を送る。
    cross(next: boolean) {
      mql.matches = next;
      act(() => {
        for (const listener of listeners) listener();
      });
    },
    listenerCount: () => listeners.size,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('デスクトップ幅の判定', () => {
  it('境界は 820px で、その幅ちょうどからデスクトップ側', () => {
    expect(desktopBreakpointPx).toBe(820);
    expect(desktopMediaQuery).toBe('(min-width: 820px)');
  });

  it('境界以上の幅ではデスクトップと判定する', () => {
    stubMatchMedia(true);

    render(<Probe />);

    expect(screen.getByText('desktop')).toBeDefined();
  });

  it('境界未満の幅ではモバイルと判定する', () => {
    stubMatchMedia(false);

    render(<Probe />);

    expect(screen.getByText('mobile')).toBeDefined();
  });

  it('ウィンドウ幅が境界を跨ぐと判定が切り替わる', () => {
    const media = stubMatchMedia(false);
    render(<Probe />);

    media.cross(true);

    expect(screen.getByText('desktop')).toBeDefined();
  });

  it('外したコンポーネントは幅の変化を購読し続けない', () => {
    const media = stubMatchMedia(false);
    const view = render(<Probe />);
    expect(media.listenerCount()).toBe(1);

    view.unmount();

    expect(media.listenerCount()).toBe(0);
  });

  it('matchMedia を差し替えないテストはモバイル側で走る', () => {
    // jsdom に matchMedia は無く、test/setup.ts が「幅を答えない」実装を敷いている。
    // 既存の画面テストはこの経路で走るので、デスクトップ分岐を足しても
    // モバイル側の検証が黙ってデスクトップ UI を見に行くことはない。
    render(<Probe />);

    expect(screen.getByText('mobile')).toBeDefined();
  });
});
