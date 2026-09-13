// 移植元: lib/features/home/home_widgets.dart の _IconHit / _IconHitState。
//
// 初回の移植ではタップ領域の確保だけを運び、非同期中の待ち表示と二度押し止めを
// 落としていた（PR #394 レビュー）。10 秒かかり得る測位で、押しても何も起きて
// いないように見える。

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { IconHitButton } from '../../src/shared/icon-hit-button';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe('IconHitButton', () => {
  it('非同期の処理が終わるまで待ち表示にし、押せなくする', async () => {
    const { promise, resolve } = deferred();
    render(
      <IconHitButton label="現在地を再取得" onPress={() => promise}>
        <span data-testid="icon" />
      </IconHitButton>,
    );

    fireEvent.click(screen.getByRole('button', { name: '現在地を再取得' }));

    const button = screen.getByRole('button', { name: '現在地を再取得' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(screen.queryByTestId('icon')).toBeNull();
    expect(screen.getByRole('status')).toBeDefined();

    resolve();
    expect(await screen.findByTestId('icon')).toBeDefined();
    expect(
      screen.getByRole('button', { name: '現在地を再取得' }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('待っている間の再押下は無視する', () => {
    const { promise } = deferred();
    const onPress = vi.fn(() => promise);
    render(
      <IconHitButton label="現在地を再取得" onPress={onPress}>
        <span />
      </IconHitButton>,
    );

    const button = screen.getByRole('button', { name: '現在地を再取得' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(onPress).toHaveBeenCalledOnce();
  });

  // 移植元は「同期処理ならスピナーは出さない」と分岐している。目的地の検索チップの
  // ように即座に遷移するものが、一瞬スピナーに化けるのを避けるため。
  it('同期の処理では待ち表示にしない', () => {
    render(
      <IconHitButton label="目的地を検索" onPress={() => {}}>
        <span data-testid="icon" />
      </IconHitButton>,
    );

    fireEvent.click(screen.getByRole('button', { name: '目的地を検索' }));

    expect(screen.getByTestId('icon')).toBeDefined();
    expect(screen.queryByRole('status')).toBeNull();
  });

  // 失敗の表示は呼び出し側の仕事（現在地なら「取得失敗」）。ここが担うのは、
  // 押せる状態へ戻すことと、拒否を握る先の無い unhandledrejection にしないこと。
  it('失敗しても待ち表示のまま固まらない', async () => {
    render(
      <IconHitButton label="現在地を再取得" onPress={() => Promise.reject(new Error('boom'))}>
        <span data-testid="icon" />
      </IconHitButton>,
    );

    fireEvent.click(screen.getByRole('button', { name: '現在地を再取得' }));

    expect(await screen.findByTestId('icon')).toBeDefined();
  });
});
