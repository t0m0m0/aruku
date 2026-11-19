import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { desktopBreakpointPx, desktopMediaQuery } from '../../src/layout/breakpoints';
import { useIsDesktop } from '../../src/layout/use-is-desktop';
import { stubViewport } from './viewport';

function Probe() {
  return <p>{useIsDesktop() ? 'desktop' : 'mobile'}</p>;
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
    stubViewport(true);

    render(<Probe />);

    expect(screen.getByText('desktop')).toBeDefined();
  });

  it('境界未満の幅ではモバイルと判定する', () => {
    stubViewport(false);

    render(<Probe />);

    expect(screen.getByText('mobile')).toBeDefined();
  });

  it('ウィンドウ幅が境界を跨ぐと判定が切り替わる', () => {
    const media = stubViewport(false);
    render(<Probe />);

    media.cross(true);

    expect(screen.getByText('desktop')).toBeDefined();
  });

  it('外したコンポーネントは幅の変化を購読し続けない', () => {
    const media = stubViewport(false);
    const view = render(<Probe />);
    expect(media.listenerCount()).toBe(1);

    view.unmount();

    expect(media.listenerCount()).toBe(0);
  });

  it('matchMedia を差し替えないテストはモバイル側で走る', () => {
    render(<Probe />);

    expect(screen.getByText('mobile')).toBeDefined();
  });
});
