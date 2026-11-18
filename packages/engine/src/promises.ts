import { TimeoutException } from './services/http-client';
import type { Duration } from './time';

export function ignore(promise: Promise<unknown>): void {
  void promise.catch(() => {});
}

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

export function firstAcceptedInOrder<T>(
  promises: readonly Promise<T>[],
  accept: (value: T) => boolean,
): Promise<{ index: number | null; values: (T | undefined)[] }> {
  return new Promise((resolve, reject) => {
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
