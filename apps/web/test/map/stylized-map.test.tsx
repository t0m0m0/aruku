// 移植元: lib/shared/widgets/aruku_map.dart の _StylizedMapPainter。
//
// 実地図が出せないとき（キー未設定／読み込み前／loading 画面の背景）に描く作り物の地図。
// 装飾なので形そのものは検証しないが、**枠に対する置き方**は別——移植元は実ピクセルの
// Size を受け取り、割合で置く図形（公園・道路・経路）と絶対寸法で置く図形（建物・ピン・
// 線の太さ）を混ぜている。その2種類の区別が崩れると絵が壊れる。

import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { StylizedMap } from '../../src/map/stylized-map';

/// jsdom に ResizeObserver は無い。枠の大きさを測る経路を通すため、コールバックを
/// 捕まえて任意の寸法で発火できる差し替えを置く。
let emitResize: ((width: number, height: number) => void) | null = null;

/// React の状態更新なので act で包む。包まないと viewBox が更新前のまま読める。
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
          this.cb(
            [{ contentRect: { width, height } } as ResizeObserverEntry],
            this as unknown as ResizeObserver,
          );
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

// 固定の viewBox を slice で埋めると、枠の縦横比が違うぶんだけ切り落とされる。縦長の
// 背景（360x800）では横 360 単位のうち中央 108 単位しか映らず、公園も建物もほぼ画面外へ出て、
// 絶対寸法の道路だけが 3.3 倍に太る（PR #402 の Codex レビュー）。枠を測って 1 単位 = 1px に
// する——移植元が Size を受け取っているのと同じ形。
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

  // 切り落とさない＝縦横比を合わせにいかない。
  it('切り落とさない', () => {
    const { container } = render(<StylizedMap />);

    fireResize(360, 800);

    expect(svgOf(container).getAttribute('preserveAspectRatio')).not.toBe(
      'xMidYMid slice',
    );
  });

  it('割合で置く図形は枠に対する割合のまま', () => {
    const { container } = render(<StylizedMap />);

    fireResize(360, 800);

    // 水面は高さの 82% から下（移植元 Rect.fromLTWH(0, h*0.82, w, h*0.18)）。
    const water = container.querySelectorAll('rect')[1]!;
    expect(water.getAttribute('y')).toBe(String(800 * 0.82));
    expect(water.getAttribute('height')).toBe(String(800 * 0.18));
  });

  it('絶対寸法の図形は枠が変わっても寸法を変えない', () => {
    const { container } = render(<StylizedMap />);

    fireResize(360, 800);
    const tall = container.querySelector('rect[width="26"]');

    fireResize(1200, 240);
    const wide = container.querySelector('rect[width="26"]');

    // 移植元の建物は 26x22 の固定寸法。枠の縦横比で伸び縮みしない。
    expect(tall).not.toBeNull();
    expect(wide).not.toBeNull();
    expect(wide!.getAttribute('height')).toBe('22');
  });

  it('縦長の枠でも終点の印が枠の中に残る', () => {
    const { container } = render(<StylizedMap />);

    fireResize(360, 800);

    // 終点は (w*0.85, h*0.85)。切り落としていれば枠外の座標になる。
    const end = container.querySelector('[data-part="route"] path')!;
    const d = end.getAttribute('d')!;
    const firstX = Number(d.split(' ')[1]);
    expect(firstX).toBeCloseTo(360 * 0.85, 5);
    expect(firstX).toBeLessThan(360);
  });
});
