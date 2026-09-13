// 移植元: lib/shared/widgets/aruku_button.dart。
//
// 移植元が Semantics(button:) と MergeSemantics で手当てしていた読み上げは、
// HTML では <button> を使うこと自体が満たす。テストはその「ネイティブ要素を
// 使っている」ことを反証する——div + onClick へ退行しても見た目は変わらない。

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ArukuButton } from '../../src/shared/button';

describe('ArukuButton', () => {
  it('ラベルを読み上げ名に持つボタンとして出る', () => {
    render(<ArukuButton label="ルートを検索" onPress={() => {}} />);

    expect(screen.getByRole('button', { name: 'ルートを検索' })).toBeDefined();
  });

  it('押すと onPress が呼ばれる', async () => {
    const onPress = vi.fn();
    render(<ArukuButton label="目的地を選ぶ" onPress={onPress} />);

    screen.getByRole('button').click();

    expect(onPress).toHaveBeenCalledOnce();
  });

  it('先頭アイコンは読み上げ名に混ざらない', () => {
    render(
      <ArukuButton
        label="ルートを検索"
        onPress={() => {}}
        icon={<span data-testid="icon">装飾</span>}
      />,
    );

    // 描かれてはいるが、「装飾 ルートを検索」とは読まれない。
    expect(screen.getByTestId('icon')).toBeDefined();
    expect(screen.getByRole('button', { name: 'ルートを検索' })).toBeDefined();
  });
});
