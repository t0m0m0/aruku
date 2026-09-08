/// Dart のカスケード記法（`Foo()..a = 1..b = 2`）に対応する。TypeScript に同じ構文は
/// 無く、素直に書くと文へ分解されるが、配列リテラルの中で組み立てている箇所
/// （`recordBoardSearches([BoardSearchStats()..rounds = 3, ...])`）が式のままでなくなり、
/// テストの形が変わる。形を保つためだけの薄い helper。
export function cascade<T>(value: T, apply: (value: T) => void): T {
  apply(value);
  return value;
}
