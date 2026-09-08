import { expect } from 'vitest';

/// Dart の `expect(action, throwsA(isA<E>()))` に対応する。
///
/// 投げられた例外を返すのは、Dart 側の `.having((e) => e.status, 'status', v)` を
/// 呼び出し側の `expect(e.status).toBe(v)` で書けるようにするため。`rejects.toThrow` は
/// 例外の**型**しか見られず、`status` のような判別フィールドを落としてしまう。
export async function expectThrowsA<E>(
  action: () => unknown,
  type: abstract new (...args: never[]) => E,
): Promise<E> {
  try {
    await action();
  } catch (error) {
    expect(error).toBeInstanceOf(type);
    return error as E;
  }
  expect.fail(`expected ${type.name} to be thrown, but nothing was thrown`);
}
