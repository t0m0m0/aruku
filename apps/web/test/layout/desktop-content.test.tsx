// 移植元: lib/shared/widgets/desktop_content.dart。
//
// モバイル幅で素通しすることが「< 820px の見た目を1ピクセルも変えない」の根拠。
// 包む要素が1つ増えるだけでも、flex の子や :first-child の効き方が変わりうる。

import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { desktopMediaQuery } from '../../src/layout/breakpoints';
import { DesktopContent } from '../../src/layout/desktop-content';

function stubWidth(desktop: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: desktop,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
  expect(desktopMediaQuery).toBeDefined();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DesktopContent', () => {
  it('モバイル幅では包まずに子をそのまま出す', () => {
    stubWidth(false);

    const { container } = render(
      <DesktopContent maxWidth={620}>
        <p data-testid="child">本文</p>
      </DesktopContent>,
    );

    expect(container.firstElementChild).toBe(screen.getByTestId('child'));
  });

  it('デスクトップ幅では最大幅を与えて中央へ寄せる', () => {
    stubWidth(true);

    render(
      <DesktopContent maxWidth={620}>
        <p data-testid="child">本文</p>
      </DesktopContent>,
    );

    // 最大幅は画面ごとに違う（home 620 / settings 760 / error 520）ので、クラスでは
    // なくインラインで与える。CSS Modules の値は jsdom から見えず、画面ごとの
    // 取り違えを検証できない。
    const box = screen.getByTestId('child').parentElement;
    expect(box?.style.maxWidth).toBe('620px');
    expect(box?.style.marginInline).toBe('auto');
  });
});
