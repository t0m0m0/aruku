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

export function firstWhere<T>(items: readonly T[], test: (item: T) => boolean): T {
  const found = items.find(test);
  if (found === undefined) {
    throw new Error('no element satisfies the predicate');
  }
  return found;
}

export function singleWhere<T>(items: readonly T[], test: (item: T) => boolean): T {
  const found = items.filter(test);
  if (found.length !== 1) {
    throw new Error(`expected exactly one matching element, got ${found.length}`);
  }
  return found[0];
}
