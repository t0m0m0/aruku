import { kDebugMode, kReleaseMode } from '../build-mode';
import { debugPrint } from '../debug-print';
import { SegmentType } from '../models/route-plan';
import type { RouteCandidate } from './hybrid-route-selector';
import { arrivalMinutes, firstMissedTransit, maxBoardingWait } from './route-plan-builder';

export class BoardSearchStats {
  rounds = 0;

  scanCount = 0;

  probes = 0;

  best = -1;

  truncated = false;

  probeFailed = false;

  readonly walkByRound: number[] = [];

  readonly probeLatency = new ProbeLatencyLedger();
}

export class ProbeLatencyLedger {
  private closedSerial = 0;
  private closedParallel = 0;
  private roundSerial = 0;
  private roundParallel = 0;

  record(args: { walkMs: number; guidanceMs: number }): void {
    const serial = args.walkMs + args.guidanceMs;
    const parallel = Math.max(args.walkMs, args.guidanceMs);
    if (serial > this.roundSerial) this.roundSerial = serial;
    if (parallel > this.roundParallel) this.roundParallel = parallel;
  }

  endRound(): void {
    this.closedSerial += this.roundSerial;
    this.closedParallel += this.roundParallel;
    this.roundSerial = 0;
    this.roundParallel = 0;
  }

  get serialMs(): number {
    return this.closedSerial + this.roundSerial;
  }

  get parallelMs(): number {
    return this.closedParallel + this.roundParallel;
  }
}

export class EnrichLatencyLedger {
  private closedCritical = 0;
  private passCritical = 0;
  private closedWalk = 0;
  private passWalk = 0;
  private closedPasses = 0;
  private passHasCandidate = false;

  private passId = 0;
  private readonly abandonedCandidates = new Set<object>();

  candidates = 0;

  resolveDepth = 0;

  get abandoned(): number {
    return this.abandonedCandidates.size;
  }

  begin(): number {
    this.candidates++;
    return this.passId;
  }

  abandon(candidate: object): void {
    this.abandonedCandidates.add(candidate);
  }

  record(args: { chainMs: number; walkMs: number; resolveSteps: number; pass?: number }): void {
    if (args.pass === undefined) this.candidates++;
    else if (args.pass !== this.passId) return;
    this.passHasCandidate = true;
    if (args.chainMs > this.passCritical) {
      this.passCritical = args.chainMs;
      this.passWalk = args.walkMs;
    }
    if (args.resolveSteps > this.resolveDepth) {
      this.resolveDepth = args.resolveSteps;
    }
  }

  endPass(): void {
    this.passId++;
    if (!this.passHasCandidate) return;
    this.closedCritical += this.passCritical;
    this.closedWalk += this.passWalk;
    this.closedPasses++;
    this.passCritical = 0;
    this.passWalk = 0;
    this.passHasCandidate = false;
  }

  get criticalPathMs(): number {
    return this.closedCritical + (this.passHasCandidate ? this.passCritical : 0);
  }

  get walkPathMs(): number {
    return this.closedWalk + (this.passHasCandidate ? this.passWalk : 0);
  }

  get passes(): number {
    return this.closedPasses + (this.passHasCandidate ? 1 : 0);
  }
}

export class BestEffortLedger {
  entries = 0;

  candidates = 0;

  resolveDepth = 0;

  retries = 0;

  totalMs = 0;

  enter(): void {
    this.entries++;
  }

  recordPool(args: { candidates: number; resolveDepth: number }): void {
    this.candidates += args.candidates;
    if (args.resolveDepth > this.resolveDepth) {
      this.resolveDepth = args.resolveDepth;
    }
  }

  recordRetry(): void {
    this.retries++;
  }

  addMs(ms: number): void {
    this.totalMs += ms;
  }
}

export const ArrivalWaveOutcome = {
  ok: 0,

  timeout: 1,

  error: 2,

  empty: 3,
} as const;
export type ArrivalWaveOutcome = (typeof ArrivalWaveOutcome)[keyof typeof ArrivalWaveOutcome];

export class RouteSearchMetrics {
  collapseFired = false;

  boardSearchActivated = false;

  singlePassMeasure = false;

  guidanceMs = 0;

  hybridMs = 0;

  enrichMs = 0;

  boardSearchMs = 0;

  boardSearchRounds = 0;

  boardSearchScanCount = 0;

  boardSearchBest = -1;

  boardSearchTruncated = false;

  boardSearchProbeFailed = false;

  boardSearchWalkByRound: readonly number[] = [];

  boardSearchWinnerRound = -1;

  finalWalkMinutes = -1;

  boardSearchProbeSerialMs = 0;

  boardSearchProbeParallelMs = 0;

  boardSearchSpeculated = false;

  boardSearchSpeculationWasted = false;

  boardSearchSpeculationProbes = 0;

  enrichCriticalMs = 0;

  enrichWalkMs = 0;

  enrichPasses = 0;

  enrichResolveDepth = 0;

  enrichCandidates = 0;

  enrichAbandoned = 0;

  bestEffortMs = 0;

  bestEffortEntries = 0;

  bestEffortCandidates = 0;

  bestEffortResolveDepth = 0;

  bestEffortRetries = 0;

  busLastResortMs = 0;

  finalizeMs = 0;

  totalMs = 0;

  guidanceCalls = 0;

  guidanceDupCalls = 0;

  guidanceCacheHits = 0;

  guidanceInitial = 0;

  guidanceArrival = 0;

  guidanceBoarding = 0;

  guidanceNames = 0;

  guidanceBoardSearch = 0;

  guidanceBus = 0;

  arrivalWaveOutcome: ArrivalWaveOutcome | null = null;

  arrivalWaveOptions = 0;

  arrivalWaveBaseUsed = false;

  arrivalWaveWon = false;

  exactMs = 0;

  exactCandidates = -1;

  exactCapped = false;

  exactWon = false;

  walkA = -1;

  walkB = -1;

  walkBPrime = -1;

  transferCandidates = -1;

  transferDropped = 0;

  transferWon = false;

  collapseB: boolean | null = null;

  abMs = 0;

  get coveredBase(): boolean {
    return this.exactCandidates > 0;
  }

  walkCalls = 0;

  matrixCalls = 0;

  matrixElements = 0;

  accessMatrixRequestedLegs = 0;

  accessMatrixUniqueLegs = 0;

  exactCalls = 0;

  rideDepartureCalls = 0;

  packBoardingLegs = 0;

  packVerifiedLegs = 0;

  packMismatchLegs = 0;

  packUnverifiedLegs = 0;

  get httpRoundTrips(): number {
    return (
      this.guidanceCalls +
      this.walkCalls +
      this.matrixCalls +
      this.exactCalls +
      this.rideDepartureCalls
    );
  }

  recordSpeculationWaste(searches: readonly BoardSearchStats[]): void {
    this.boardSearchSpeculationWasted = true;
    this.boardSearchSpeculationProbes = searches.reduce((n, s) => n + s.probes, 0);
  }

  recordBoardSearches(searches: readonly BoardSearchStats[]): void {
    let dominant: BoardSearchStats | null = null;
    for (const s of searches) {
      if (s.rounds > this.boardSearchRounds) this.boardSearchRounds = s.rounds;
      if (
        dominant === null ||
        s.rounds > dominant.rounds ||
        (s.rounds === dominant.rounds && s.scanCount > dominant.scanCount)
      ) {
        dominant = s;
      }
    }
    if (dominant === null) return;
    this.boardSearchScanCount = dominant.scanCount;
    this.boardSearchBest = dominant.best;
    this.boardSearchTruncated = dominant.truncated;
    this.boardSearchProbeFailed = dominant.probeFailed;
    this.boardSearchWalkByRound = Object.freeze([...dominant.walkByRound]);
    this.boardSearchProbeSerialMs = dominant.probeLatency.serialMs;
    this.boardSearchProbeParallelMs = dominant.probeLatency.parallelMs;
  }

  recordEnrich(ledger: EnrichLatencyLedger): void {
    this.enrichCriticalMs = ledger.criticalPathMs;
    this.enrichWalkMs = ledger.walkPathMs;
    this.enrichPasses = ledger.passes;
    this.enrichResolveDepth = ledger.resolveDepth;
    this.enrichCandidates = ledger.candidates;
    this.enrichAbandoned = ledger.abandoned;
  }

  recordBestEffort(ledger: BestEffortLedger): void {
    this.bestEffortMs = ledger.totalMs;
    this.bestEffortEntries = ledger.entries;
    this.bestEffortCandidates = ledger.candidates;
    this.bestEffortResolveDepth = ledger.resolveDepth;
    this.bestEffortRetries = ledger.retries;
  }

  toLogLine(): string {
    return (
      `collapse=${flag(this.collapseFired)} ` +
      `boardSearch=${flag(this.boardSearchActivated)} ` +
      `singlePass=${flag(this.singlePassMeasure)} ` +
      `http=${this.httpRoundTrips} ` +
      `guidanceCalls=${this.guidanceCalls} walkCalls=${this.walkCalls} matrixCalls=${this.matrixCalls} ` +
      `matrixElements=${this.matrixElements} ` +
      `accessMatrixRequestedLegs=${this.accessMatrixRequestedLegs} ` +
      `accessMatrixUniqueLegs=${this.accessMatrixUniqueLegs} ` +
      `exactCalls=${this.exactCalls} ` +
      `guidanceDupCalls=${this.guidanceDupCalls} ` +
      `guidanceCacheHits=${this.guidanceCacheHits} ` +
      `guidanceInitial=${this.guidanceInitial} guidanceArrival=${this.guidanceArrival} ` +
      `guidanceBoarding=${this.guidanceBoarding} guidanceNames=${this.guidanceNames} ` +
      `guidanceBoardSearch=${this.guidanceBoardSearch} guidanceBus=${this.guidanceBus} ` +
      `rideDepartureCalls=${this.rideDepartureCalls} packBoardingLegs=${this.packBoardingLegs} ` +
      `packVerifiedLegs=${this.packVerifiedLegs} packMismatchLegs=${this.packMismatchLegs} ` +
      `packUnverifiedLegs=${this.packUnverifiedLegs} ` +
      `arrivalWaveOutcome=${this.arrivalWaveOutcome ?? -1} ` +
      `arrivalWaveOptions=${this.arrivalWaveOptions} ` +
      `arrivalWaveBaseUsed=${flag(this.arrivalWaveBaseUsed)} ` +
      `arrivalWaveWon=${flag(this.arrivalWaveWon)} ` +
      `exactMs=${this.exactMs} exactCandidates=${this.exactCandidates} ` +
      `exactCapped=${flag(this.exactCapped)} exactWon=${flag(this.exactWon)} ` +
      `coveredBase=${flag(this.coveredBase)} walkA=${this.walkA} walkB=${this.walkB} ` +
      `walkBPrime=${this.walkBPrime} transferCandidates=${this.transferCandidates} ` +
      `transferDropped=${this.transferDropped} transferWon=${flag(this.transferWon)} ` +
      `collapseB=${this.collapseB === null ? -1 : flag(this.collapseB)} abMs=${this.abMs} ` +
      `guidanceMs=${this.guidanceMs} hybridMs=${this.hybridMs} enrichMs=${this.enrichMs} ` +
      `boardSearchMs=${this.boardSearchMs} ` +
      `boardSearchRounds=${this.boardSearchRounds} ` +
      `boardSearchScanCount=${this.boardSearchScanCount} ` +
      `boardSearchBest=${this.boardSearchBest} ` +
      `boardSearchTruncated=${flag(this.boardSearchTruncated)} ` +
      `boardSearchProbeFailed=${flag(this.boardSearchProbeFailed)} ` +
      `boardSearchProbeSerialMs=${this.boardSearchProbeSerialMs} ` +
      `boardSearchProbeParallelMs=${this.boardSearchProbeParallelMs} ` +
      `boardSearchSpeculated=${flag(this.boardSearchSpeculated)} ` +
      `boardSearchSpeculationWasted=${flag(this.boardSearchSpeculationWasted)} ` +
      `boardSearchSpeculationProbes=${this.boardSearchSpeculationProbes} ` +
      `enrichCriticalMs=${this.enrichCriticalMs} enrichWalkMs=${this.enrichWalkMs} ` +
      `enrichPasses=${this.enrichPasses} ` +
      `enrichResolveDepth=${this.enrichResolveDepth} ` +
      `enrichCandidates=${this.enrichCandidates} ` +
      `enrichAbandoned=${this.enrichAbandoned} ` +
      `bestEffortMs=${this.bestEffortMs} bestEffortEntries=${this.bestEffortEntries} ` +
      `bestEffortCandidates=${this.bestEffortCandidates} ` +
      `bestEffortResolveDepth=${this.bestEffortResolveDepth} ` +
      `bestEffortRetries=${this.bestEffortRetries} ` +
      `busLastResortMs=${this.busLastResortMs} ` +
      'boardSearchWalkByRound=' +
      `${this.boardSearchWalkByRound.length === 0 ? '-' : this.boardSearchWalkByRound.join(',')} ` +
      `boardSearchWinnerRound=${this.boardSearchWinnerRound} ` +
      `finalWalkMinutes=${this.finalWalkMinutes} ` +
      `finalizeMs=${this.finalizeMs} totalMs=${this.totalMs}`
    );
  }
}

const flag = (value: boolean): string => (value ? '1' : '0');

export interface RouteDiagnosticsInit {
  verbose?: boolean;
  metricsEnabled?: boolean;
}

export class RouteDiagnostics {
  constructor(init: RouteDiagnosticsInit = {}) {
    this.verbose = init.verbose ?? kDebugMode;
    this.metricsEnabled = init.metricsEnabled ?? !kReleaseMode;
  }

  private readonly verbose: boolean;
  private readonly metricsEnabled: boolean;

  log(build: () => string): void {
    if (this.verbose) debugPrint(`[route] ${build()}`);
  }

  logMetrics(metrics: RouteSearchMetrics): void {
    if (this.metricsEnabled) {
      debugPrint(`[route-metrics] ${metrics.toLogLine()}`);
    }
  }

  segSummary(c: RouteCandidate): string {
    return c.segments
      .map((s) => {
        switch (s.type) {
          case SegmentType.walk:
            return `walk${s.minutes}m`;
          case SegmentType.train:
            return `${s.line ?? 'train'}_train${s.minutes}m`;
          case SegmentType.bus:
            return `${s.line ?? 'bus'}_bus${s.minutes}m`;
        }
      })
      .join('+');
  }

  candLine(c: RouteCandidate, budgetMin: number, departureAt: Date): string {
    const arr = arrivalMinutes(c.segments, departureAt);
    const missed = firstMissedTransit(c.segments, departureAt);
    const wait = maxBoardingWait(c.segments, departureAt);
    return (
      `walk=${c.walkMinutes}m arr=${arr}m slack=${budgetMin - arr}m ` +
      `within=${arr <= budgetMin} maxWait=${wait}m ` +
      `missed=${missed !== null} [${this.segSummary(c)}]`
    );
  }

  boardingStationOf(c: RouteCandidate): string {
    for (const s of c.segments) {
      switch (s.type) {
        case SegmentType.walk:
          continue;
        case SegmentType.train:
        case SegmentType.bus:
          return s.fromName.length === 0 ? '?' : s.fromName;
      }
    }
    return '?';
  }
}
