/// Dart の `Iterable.single` / `.first` / `.last` に対応する。件数の主張そのものなので、
/// `[0]` へ落とさず「1件でなければ落ちる」性質ごと運ぶ。
export function single<T>(items: readonly T[]): T {
  if (items.length !== 1) {
    throw new Error(`expected exactly one element, got ${items.length}`);
  }
  return items[0];
}

export function first<T>(items: readonly T[]): T {
  if (items.length === 0) throw new Error('expected a non-empty list');
  return items[0];
}

export function last<T>(items: readonly T[]): T {
  if (items.length === 0) throw new Error('expected a non-empty list');
  return items[items.length - 1];
}
