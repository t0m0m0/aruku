export class Stopwatch {
  private accumulated = 0;
  private startedAt: number | null = null;

  start(): void {
    this.startedAt ??= performance.now();
  }

  stop(): void {
    if (this.startedAt === null) return;
    this.accumulated += performance.now() - this.startedAt;
    this.startedAt = null;
  }

  get elapsedMilliseconds(): number {
    const running = this.startedAt === null ? 0 : performance.now() - this.startedAt;
    return Math.trunc(this.accumulated + running);
  }
}

export function startedStopwatch(): Stopwatch {
  const sw = new Stopwatch();
  sw.start();
  return sw;
}
