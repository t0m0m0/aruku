/// Dart の `Future.timeout(duration, onTimeout: ...)` に対応する。
///
/// vitest のテスト単位のタイムアウトへ委ねないのは、失敗の理由が「なぜ止まったか」を
/// 語らなくなるため。移植元は `fail('scan チャンクが同時到達しない（直列でデッドロック）')`
/// のように、時間切れの意味そのものをメッセージに書いている。
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => never,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      try {
        onTimeout();
      } catch (error) {
        reject(error);
      }
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
