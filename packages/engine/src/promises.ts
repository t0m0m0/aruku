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
