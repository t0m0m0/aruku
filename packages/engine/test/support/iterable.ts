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

/// Dart の `Iterable.firstWhere`（該当が無ければ投げる）に対応する。
/// `Array.find` は `undefined` を返すので、そのままだと「1件も無い」ことが
/// 後段の別のエラーになって現れ、失敗の理由が読めなくなる。
export function firstWhere<T>(
  items: readonly T[],
  test: (item: T) => boolean,
): T {
  const found = items.find(test);
  if (found === undefined) {
    throw new Error('no element satisfies the predicate');
  }
  return found;
}

/// Dart の `Iterable.singleWhere`（該当が 0 件でも 2 件以上でも投げる）に対応する。
/// 「その条件を満たす要素がちょうど1つ」という主張そのものなので、`find` へ落とさない。
export function singleWhere<T>(
  items: readonly T[],
  test: (item: T) => boolean,
): T {
  const found = items.filter(test);
  if (found.length !== 1) {
    throw new Error(
      `expected exactly one matching element, got ${found.length}`,
    );
  }
  return found[0];
}
