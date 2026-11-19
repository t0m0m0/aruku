import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StylizedMap } from '../../src/map/stylized-map';

let emitResize: ((width: number, height: number) => void) | null = null;

function fireResize(width: number, height: number) {
  act(() => {
    emitResize!(width, height);
  });
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(private cb: ResizeObserverCallback) {
        emitResize = (width, height) => {
          this.cb([{ contentRect: { width, height } } as ResizeObserverEntry], this);
        };
      }
      observe() {}
      disconnect() {}
      unobserve() {}
    },
  );
});

afterEach(() => {
  emitResize = null;
  vi.unstubAllGlobals();
});

function svgOf(container: HTMLElement) {
  return container.querySelector('svg')!;
}

describe('StylizedMap', () => {
  it('装飾なので読み上げへ出さない', () => {
    const { container } = render(<StylizedMap />);

    expect(svgOf(container).getAttribute('aria-hidden')).toBe('true');
  });

  it('既定では経路を描く', () => {
    const { container } = render(<StylizedMap />);

    expect(container.querySelector('[data-part="route"]')).not.toBeNull();
  });

  it('showRoute が false なら経路を描かない', () => {
    const { container } = render(<StylizedMap showRoute={false} />);

    expect(container.querySelector('[data-part="route"]')).toBeNull();
  });

  it('経路を落としても地図そのものは残る', () => {
    const { container } = render(<StylizedMap showRoute={false} />);

    expect(svgOf(container)).not.toBeNull();
  });
});

describe('枠に合わせた配置', () => {
  it('測れるまでは既定の寸法で描く', () => {
    const { container } = render(<StylizedMap />);

    expect(svgOf(container).getAttribute('viewBox')).toBe('0 0 360 240');
  });

  it('枠を測ったらその寸法で描く', () => {
    const { container } = render(<StylizedMap />);

    fireResize(360, 800);

    expect(svgOf(container).getAttribute('viewBox')).toBe('0 0 360 800');
  });

  it('切り落とさない', () => {
    const { container } = render(<StylizedMap />);

    fireResize(360, 800);

    expect(svgOf(container).getAttribute('preserveAspectRatio')).not.toBe('xMidYMid slice');
  });

  it('割合で置く図形は枠に対する割合のまま', () => {
    const { container } = render(<StylizedMap />);

    fireResize(360, 800);

    const water = container.querySelectorAll('rect')[1];
    expect(water.getAttribute('y')).toBe(String(800 * 0.82));
    expect(water.getAttribute('height')).toBe(String(800 * 0.18));
  });

  it('絶対寸法の図形は枠が変わっても寸法を変えない', () => {
    const { container } = render(<StylizedMap />);

    fireResize(360, 800);
    const tall = container.querySelector('rect[width="26"]');

    fireResize(1200, 240);
    const wide = container.querySelector('rect[width="26"]');

    expect(tall).not.toBeNull();
    expect(wide).not.toBeNull();
    expect(wide!.getAttribute('height')).toBe('22');
  });

  it('縦長の枠でも終点の印が枠の中に残る', () => {
    const { container } = render(<StylizedMap />);

    fireResize(360, 800);

    const end = container.querySelector('[data-part="route"] path')!;
    const d = end.getAttribute('d')!;
    const firstX = Number(d.split(' ')[1]);
    expect(firstX).toBeCloseTo(360 * 0.85, 5);
    expect(firstX).toBeLessThan(360);
  });
});
