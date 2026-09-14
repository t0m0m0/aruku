// 移植元: lib/shared/widgets/aruku_map.dart の _StylizedMapPainter。
//
// 実地図が出せないとき（キー未設定／loading 画面の背景）に描く作り物の地図。装飾なので
// 形そのものは検証しない——押さえるのは「読み上げへ漏れないこと」と「経路を描くかどうかの
// 切り替え」だけで、そこが崩れると意味のない地名が読み上げられたり、loading の背景に
// 存在しない経路が出たりする。

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StylizedMap } from '../../src/map/stylized-map';

describe('StylizedMap', () => {
  it('装飾なので読み上げへ出さない', () => {
    const { container } = render(<StylizedMap />);

    expect(container.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
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

    expect(container.querySelector('svg')).not.toBeNull();
  });
});
