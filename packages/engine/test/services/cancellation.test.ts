// 移植元: test/core/services/cancellation_test.dart
//
// #384 が移した6ファイルはキャンセルを TransitApiClient / TransitRouteService 越しにしか
// 触らない。冪等な cancel・cancel 済みトークンへの onCancel・コールバックの発火順は
// そちら経由では一度も通らないので、移植元のテストをここへ運ぶ。

import { describe, expect, it } from 'vitest';

import {
  CancellationToken,
  SearchCanceledException,
} from '../../src/services/cancellation';

describe('CancellationToken', () => {
  it('初期状態は未キャンセルで throwIfCanceled が通る', () => {
    const token = new CancellationToken();
    expect(token.isCanceled).toBe(false);
    expect(() => token.throwIfCanceled()).not.toThrow();
  });

  it('cancel すると isCanceled が立ち throwIfCanceled が投げる', () => {
    const token = new CancellationToken();
    token.cancel();
    expect(token.isCanceled).toBe(true);
    expect(() => token.throwIfCanceled()).toThrow(SearchCanceledException);
  });

  it('登録済みのコールバックは cancel で発火する', () => {
    const token = new CancellationToken();
    let fired = 0;
    token.onCancel(() => fired++);
    expect(fired).toBe(0);

    token.cancel();
    expect(fired).toBe(1);
  });

  it('複数のコールバックが登録順に全て発火する', () => {
    const token = new CancellationToken();
    const order: string[] = [];
    token.onCancel(() => order.push('a'));
    token.onCancel(() => order.push('b'));
    token.cancel();
    expect(order).toEqual(['a', 'b']);
  });

  it('cancel 済みトークンへの onCancel は即座に発火する', () => {
    const token = new CancellationToken();
    token.cancel();
    let fired = 0;
    token.onCancel(() => fired++);
    expect(fired).toBe(1);
  });

  it('cancel は冪等でコールバックを二度発火しない', () => {
    const token = new CancellationToken();
    let fired = 0;
    token.onCancel(() => fired++);
    token.cancel();
    token.cancel();
    expect(fired).toBe(1);
  });
});
