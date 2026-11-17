import { TimeoutException } from './services/http-client';
import type { Duration } from './time';

/// Dart の `Future.ignore()` に対応する。拒否を捨てる**別の** Promise を作るだけなので、
/// 後から元を await する経路の例外伝播は妨げない——キャンセルを握り潰さないために必要な性質。
export function ignore(promise: Promise<unknown>): void {
  void promise.catch(() => {});
}

/// Dart の `future.timeout(d)` に対応する。[limit] 内に解決しなければ [TimeoutException]。
export function withGrace<T>(promise: Promise<T>, limit: Duration): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new TimeoutException(`grace exceeded after ${limit}ms`)),
      limit,
    );
  });
  return Promise.race([promise, expiry]).finally(() => clearTimeout(timer));
}

/// [promises] の並び順で最初に [accept] を満たす値の index を返す。それより前が全部
/// 「満たさない」と決着した時点で返り、後ろの未決着は待たない。全部が満たさずに
/// 決着したら `index` は null。`values` は返った時点で決着していた値で、未決着は undefined。
///
/// 返る前の拒否は、順で後ろの Promise のものでも伝播する——「待たないかもしれない」
/// Promise の拒否を飲むと、キャンセルを取りこぼす。返った後に届く拒否は捨てる。
export function firstAcceptedInOrder<T>(
  promises: readonly Promise<T>[],
  accept: (value: T) => boolean,
): Promise<{ index: number | null; values: (T | undefined)[] }> {
  return new Promise((resolve, reject) => {
    // T 自体が undefined を含み得るので、決着の有無は値と別の箱で持つ。
    const outcomes = new Array<{ value: T } | undefined>(promises.length).fill(undefined);
    const snapshot = (): (T | undefined)[] => outcomes.map((o) => o?.value);
    let next = 0;
    const advance = (): void => {
      while (next < promises.length) {
        const outcome = outcomes[next];
        if (outcome === undefined) return;
        if (accept(outcome.value)) {
          resolve({ index: next, values: snapshot() });
          return;
        }
        next++;
      }
      resolve({ index: null, values: snapshot() });
    };
    promises.forEach((p, i) => {
      p.then((value) => {
        outcomes[i] = { value };
        advance();
      }, reject);
    });
    advance();
  });
}
