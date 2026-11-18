import { expect } from 'vitest';

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

export function expectSameList<T>(actual: readonly T[], expected: readonly T[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((item, index) => {
    expect(actual[index]).toBe(item);
  });
}
