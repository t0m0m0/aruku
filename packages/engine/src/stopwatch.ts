/// Dart の `Stopwatch` に対応する。停止・再開をまたいで累積し、`elapsedMilliseconds` は
/// 切り捨てで返す。
///
/// `Date.now()` ではなく `performance.now()` を使うのは、前者が壁時計で NTP 補正や手動の
/// 時刻変更で前後に飛ぶため——フェーズ所要が負になったり跳ねたりして、実機ログの集計
/// （#309）が静かに汚れる。`performance.now()` は単調で `Stopwatch` と同じ性質を持つ。
export class Stopwatch {
  private accumulated = 0;
  private startedAt: number | null = null;

  start(): void {
    if (this.startedAt === null) this.startedAt = performance.now();
  }

  stop(): void {
    if (this.startedAt === null) return;
    this.accumulated += performance.now() - this.startedAt;
    this.startedAt = null;
  }

  get elapsedMilliseconds(): number {
    const running =
      this.startedAt === null ? 0 : performance.now() - this.startedAt;
    return Math.trunc(this.accumulated + running);
  }
}

/// 計測を開始した [Stopwatch]。移植元の `Stopwatch()..start()` に対応する。
export function startedStopwatch(): Stopwatch {
  const sw = new Stopwatch();
  sw.start();
  return sw;
}
