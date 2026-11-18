import { durationZero, type Duration } from '../time';

export class SearchDeadline {
  constructor(total: Duration, options: { elapsed?: () => Duration } = {}) {
    this.budget = { total, elapsed: options.elapsed ?? realtimeElapsed() };
  }

  static none(): SearchDeadline {
    const deadline = new SearchDeadline(0);
    deadline.budget = null;
    return deadline;
  }

  private budget: { total: Duration; elapsed: () => Duration } | null;

  get remaining(): Duration | null {
    const budget = this.budget;
    if (budget === null) return null;
    const left = budget.total - budget.elapsed();
    return left < 0 ? durationZero : left;
  }

  isExpired(): boolean {
    return this.remaining === durationZero;
  }
}

function realtimeElapsed(): () => Duration {
  const start = performance.now();
  return () => performance.now() - start;
}
