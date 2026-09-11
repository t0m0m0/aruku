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

/// Dart の `expect(list, [a, b, c])` に対応する。
///
/// `toEqual` へ落とさないのは、Dart の `equals` が要素を `==` で比べるため。
/// `RouteCandidate` のように `==` を定義していないクラスではそれが**同一性**の比較に
/// なり、「構造は同じだが別インスタンス」を返す実装は落ちる。`toEqual` は構造比較なので
/// それを通してしまい、候補プールの同一性に依存する検証（#318 の先行実測対象など）が
/// 骨抜きになる。
export function expectSameList<T>(
  actual: readonly T[],
  expected: readonly T[],
): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((item, index) => {
    expect(actual[index]).toBe(item);
  });
}
