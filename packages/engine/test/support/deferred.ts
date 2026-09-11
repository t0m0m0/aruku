/// Dart の `Completer<T>` に対応する。外から解決／拒否できる Promise。
export interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly isCompleted: boolean;
  complete(value: T): void;
  completeError(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let completed = false;
  return {
    promise,
    get isCompleted() {
      return completed;
    },
    complete(value) {
      completed = true;
      resolve(value);
    },
    completeError(error) {
      completed = true;
      reject(error);
    },
  };
}
