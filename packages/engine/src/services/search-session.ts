import { ignore } from '../promises';
import { startedStopwatch } from '../stopwatch';
import { RouteCandidate } from './hybrid-route-selector';
import { BestEffortLedger, EnrichLatencyLedger } from './route-diagnostics';
import type { TransitOption } from './transit-plan-parser';

export class SearchSession {
  readonly walkCache = new WalkLegCache();

  readonly enrichedCache = new Map<RouteCandidate, RouteCandidate>();

  readonly enrichInflight = new Map<RouteCandidate, Promise<RouteCandidate>>();

  readonly accessWalks = new Map<string, number>();

  readonly enrichLedger = new EnrichLatencyLedger();

  readonly bestEffortLedger = new BestEffortLedger();

  readonly provenance = new CandidateProvenance();
}

export class CandidateProvenance {
  readonly arrivalWave = new Set<RouteCandidate>();

  readonly hybrids = new Set<RouteCandidate>();

  readonly exact = new Set<RouteCandidate>();

  readonly transfer = new Set<RouteCandidate>();

  readonly boardSearchRound = new Map<RouteCandidate, number>();
}

export class LastResortBus {
  constructor(
    private readonly fetch: () => Promise<TransitOption[]>,
    private readonly onWaited: (ms: number) => void,
  ) {}

  private pending: Promise<TransitOption[]> | null = null;
  private adoptedOptions: TransitOption[] | null = null;
  private adoptedCandidates: RouteCandidate[] | null = null;

  get options(): TransitOption[] | null {
    return this.adoptedOptions;
  }

  get candidates(): RouteCandidate[] | null {
    return this.adoptedCandidates;
  }

  prefetch(): void {
    if (this.adoptedCandidates !== null) return;
    ignore(this.issue());
  }

  private issue(): Promise<TransitOption[]> {
    this.pending ??= this.fetch();
    return this.pending;
  }

  async adopt(): Promise<RouteCandidate[]> {
    if (this.adoptedCandidates !== null) return this.adoptedCandidates;
    const pending = this.issue();
    const waitSw = startedStopwatch();
    this.adoptedOptions = await pending;
    this.onWaited(waitSw.elapsedMilliseconds);
    this.adoptedCandidates = this.adoptedOptions.map(
      (o) => new RouteCandidate({ from: o.from, to: o.to, segments: o.segments }),
    );
    return this.adoptedCandidates;
  }
}

export class WalkLegCache {
  private readonly done = new Map<string, RouteCandidate>();
  private readonly inflight = new Map<string, Promise<RouteCandidate | null>>();

  resolve(
    key: string,
    fetch: () => Promise<RouteCandidate | null>,
  ): Promise<RouteCandidate | null> {
    const done = this.done.get(key);
    if (done !== undefined) return Promise.resolve(done);
    const existing = this.inflight.get(key);
    if (existing !== undefined) return existing;
    const started = this.resolveUncached(key, fetch);
    this.inflight.set(key, started);
    return started;
  }

  private async resolveUncached(
    key: string,
    fetch: () => Promise<RouteCandidate | null>,
  ): Promise<RouteCandidate | null> {
    try {
      const result = await fetch();
      if (result !== null) this.done.set(key, result);
      return result;
    } finally {
      this.inflight.delete(key);
    }
  }
}
