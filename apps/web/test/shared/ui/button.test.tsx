// shadcn/ui の Button。移植元 flutter-final:lib/shared/widgets/aruku_button.dart の
// 読み上げ（Semantics(button:) と MergeSemantics）は、HTML では <button> を使うこと
// 自体が満たす。テストはその「ネイティブ要素を使っている」ことを反証する——
// div + onClick へ退行しても見た目は変わらない。

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { SearchIcon } from '../../../src/shared/icons';
import { Button } from '../../../src/shared/ui/button';

describe('Button', () => {
  it('中身の文言を読み上げ名に持つボタンとして出る', () => {
    render(<Button>ルートを検索</Button>);

    expect(screen.getByRole('button', { name: 'ルートを検索' })).toBeDefined();
  });

  it('押すと onClick が呼ばれる', () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>目的地を選ぶ</Button>);

    screen.getByRole('button').click();

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('既定では form を送信しない', () => {
    const onSubmit = vi.fn((event: SubmitEvent) => {
      event.preventDefault();
    });
    render(
      <form
        onSubmit={(event) => {
          onSubmit(event.nativeEvent as SubmitEvent);
        }}
      >
        <Button>ルートを検索</Button>
      </form>,
    );

    screen.getByRole('button').click();

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('無効のときは押しても onClick が呼ばれない', () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        ルートを検索
      </Button>,
    );

    screen.getByRole('button').click();

    expect(onClick).not.toHaveBeenCalled();
  });

  it('アイコンは読み上げ名に混ざらない', () => {
    render(
      <Button>
        <SearchIcon />
        ルートを検索
      </Button>,
    );

    expect(screen.getByRole('button', { name: 'ルートを検索' })).toBeDefined();
  });

  it('アイコンの寸法を上書きしない', () => {
    // shadcn の原本は中の svg を size-4（16px）へ揃える。CTA のアイコンは
    // width 属性で 20px を指定しており、クラスで上書きされると黙って縮む。
    render(<Button>x</Button>);

    expect(screen.getByRole('button').className).not.toMatch(/\[&_svg[^\]]*\]:size-/);
  });

  it('呼び出し側の className を足せる', () => {
    render(<Button className="extra">ルートを検索</Button>);

    expect(screen.getByRole('button').classList).toContain('extra');
  });
});
