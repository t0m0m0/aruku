import { dartRound } from '../dart-number';
import { intOr, isRecord, type JsonMap } from '../json';
import { GeoPoint } from '../models/geo-point';
import {
  RouteSegment,
  SegmentType,
  type RoutePlan,
  type StandardTransitSummary,
  type TimetableSource,
} from '../models/route-plan';
import type { TimeValue } from '../models/time-value';
import { startedStopwatch, type Stopwatch } from '../stopwatch';
import { dateTime, plusMinutes, seconds, type Duration } from '../time';
import {
  applyWalkMatrixRows,
  parseDurationMin,
  planAccessWalkMatrix,
  walkCacheKey,
  type AccessWalkDemand,
} from './access-walk-matrix';
import {
  CandidateMeasurer,
  comparableFrom,
  isComparableOption,
  maxMeasureShortlist,
  type Selection,
} from './candidate-measurer';
import { SearchCanceledException, type CancellationToken } from './cancellation';
import {
  evenSample,
  frontierStations,
  haversineKm,
  maxWalkBoardingIndexParallel,
  measureShortlist,
  prewarmFront,
  RouteCandidate,
  selectBestRoute,
  walkFeasiblePrefixCount,
  type FrontierStations,
} from './hybrid-route-selector';
import {
  exactWalkCandidates,
  exactWalkTransferCandidates,
  timetableSources,
} from './exact-walk-candidates';
import { TimeoutException, type HttpClient } from './http-client';
import { ignore, withGrace } from '../promises';
import {
  ArrivalWaveOutcome,
  BestEffortLedger,
  BoardSearchStats,
  EnrichLatencyLedger,
  RouteDiagnostics,
  RouteSearchMetrics,
} from './route-diagnostics';
import {
  arrivalMinutes,
  buildRoutePlan,
  effectiveOffset,
  kcalPerKm,
  trainMetersPerMinute,
  walkMetersPerMinute,
} from './route-plan-builder';
import { RouteException, RoutePhase, type PlanArgs, type SearchEngine } from './route-service';
import { runExactWalkAb } from './exact-walk-ab';
import { SearchDeadline } from './search-deadline';
import { LastResortBus, SearchSession, WalkLegCache } from './search-session';
import { parseGuidancePlan, type TransitOption } from './transit-plan-parser';
import { TransitApiClient } from './transit-api-client';

interface SearchFrame {
  origin: GeoPoint;
  goal: GeoPoint;
  budgetMin: number;
  departureAt: Date;
  metrics: RouteSearchMetrics;
  session: SearchSession;
}

interface CorridorAccessPlan {
  base: TransitOption;
  stops: CorridorStop[];
  frontier: FrontierStations;
  demand: AccessWalkDemand;
}

export interface TransitRouteServiceInit {
  transitClient?: HttpClient;
  proxyClient?: HttpClient;
  transitBaseUrl?: string;
  proxyBaseUrl?: string;
  clock?: () => Date;
  cancellation?: CancellationToken | null;
  deadline?: SearchDeadline;

  onMetrics?: (metrics: RouteSearchMetrics) => void;

  arrivalWaveGrace?: Duration | null;

  exactWalkMax?: boolean;

  exactWalkMaxGrace?: Duration | null;

  exactWalkMaxAb?: boolean;
}

export const defaultArrivalWaveGrace: Duration = seconds(5);

export const defaultExactWalkMaxGrace: Duration = seconds(5);

export const maxHybridCandidates = 40;

const singlePassHybridThreshold = 3;

const maxMatrixSideStations = 10;

const collapseWalkMarginMin = 10;
const collapseSlackRatio = 0.4;

const collapseSlackMinutes = 20;

const boardSearchFanout = 5;

const maxScanMatrixDests = 25;

const maxCorridorStops = 60;

const maxHybridBases = 3;

const corridorFingerprintSamples = 8;

export class TransitRouteService implements SearchEngine {
  constructor(init: TransitRouteServiceInit = {}) {
    this.arrivalWaveGrace = init.arrivalWaveGrace ?? defaultArrivalWaveGrace;
    this.exactWalkMax = init.exactWalkMax ?? false;
    this.exactWalkMaxGrace = init.exactWalkMaxGrace ?? defaultExactWalkMaxGrace;
    this.exactWalkMaxAb = init.exactWalkMaxAb ?? false;
    this.api = new TransitApiClient({
      transitClient: init.transitClient,
      proxyClient: init.proxyClient,
      transitBaseUrl: init.transitBaseUrl,
      proxyBaseUrl: init.proxyBaseUrl,
      cancellation: init.cancellation,
      deadline: init.deadline ?? SearchDeadline.none(),
      recordForReplay: this.exactWalkMaxAb,
    });
    this.deadline = init.deadline ?? SearchDeadline.none();
    this.clock = init.clock ?? ((): Date => new Date());
    this.onMetrics = init.onMetrics ?? null;
    this.measurer = new CandidateMeasurer(this.api, this.diag);
  }

  private readonly api: TransitApiClient;
  private readonly clock: () => Date;

  private readonly deadline: SearchDeadline;
  private readonly arrivalWaveGrace: Duration;
  private readonly exactWalkMax: boolean;
  private readonly exactWalkMaxGrace: Duration;
  private readonly exactWalkMaxAb: boolean;
  private readonly onMetrics: ((metrics: RouteSearchMetrics) => void) | null;

  private readonly diag = new RouteDiagnostics();

  private readonly measurer: CandidateMeasurer;

  async plan(args: PlanArgs): Promise<RoutePlan> {
    const { departure, arrival, destination, destinationLatLng } = args;
    const origin = args.origin ?? null;
    const onProgress = args.onProgress;
    if (!this.api.hasTransitApi) throw new RouteException('NO_TRANSIT_API');
    if (origin === null) throw new RouteException('NO_ORIGIN');
    if (destinationLatLng === null) throw new RouteException('NO_DESTINATION');
    const budgetMin = budgetMinutesOf(departure, arrival);

    const metrics = new RouteSearchMetrics();
    const totalSw = startedStopwatch();

    onProgress?.(RoutePhase.routing);

    const departureAt = this.departureDateTime(departure);
    const arrivalWave = this.api.fetchGuidanceArrivalAt(
      origin,
      destinationLatLng,
      departureAt,
      budgetMin,
    );
    ignore(arrivalWave);
    const exactWave =
      this.exactWalkMax || this.exactWalkMaxAb
        ? this.api.fetchExactWalkMax(origin, destinationLatLng, departureAt, budgetMin, {
            transfers: this.exactWalkMaxAb,
          })
        : null;
    const exactSw = startedStopwatch();
    if (exactWave !== null) {
      ignore(exactWave);
      void exactWave.then(
        () => exactSw.stop(),
        () => exactSw.stop(),
      );
    }

    const guidanceSw = startedStopwatch();
    const body = await this.api.fetchGuidanceAt(origin, destinationLatLng, departureAt, {
      purpose: 'initial',
    });
    metrics.guidanceMs = guidanceSw.elapsedMilliseconds;
    const options = parseGuidancePlan(body);
    if (options.length === 0) throw new RouteException('ZERO_RESULTS');

    onProgress?.(RoutePhase.walkability);

    const exactGraced = exactWave === null ? null : withGrace(exactWave, this.exactWalkMaxGrace);
    if (exactGraced !== null) {
      ignore(exactGraced);
      void exactGraced.then(
        () => exactSw.stop(),
        () => exactSw.stop(),
      );
    }

    const wave = await this.arrivalWaveOptions(
      withGrace(arrivalWave, this.arrivalWaveGrace),
      options,
    );
    metrics.arrivalWaveOutcome = wave.outcome;
    metrics.arrivalWaveOptions = wave.fresh.length;

    const plan = await this.selectMeasured([...options, ...wave.fresh], budgetMin, departure, {
      origin,
      goal: destinationLatLng,
      onProgress,
      fromName: args.originName ?? null,
      toName: destination,
      metrics,
      arrivalWaveOptions: new Set(wave.fresh),
      exactWave: exactGraced,
      standardTransit: standardTransitSummary(options, departureAt),
    });

    metrics.totalMs = totalSw.elapsedMilliseconds;
    metrics.guidanceCalls = this.api.guidanceCalls;
    metrics.guidanceDupCalls = this.api.guidanceDupCalls;
    metrics.guidanceCacheHits = this.api.guidanceCacheHits;
    const byPurpose = this.api.guidanceCallsByPurpose;
    metrics.guidanceInitial = byPurpose.initial;
    metrics.guidanceArrival = byPurpose.arrival;
    metrics.guidanceBoarding = byPurpose.boarding;
    metrics.guidanceNames = byPurpose.names;
    metrics.guidanceBoardSearch = byPurpose.boardSearch;
    metrics.guidanceBus = byPurpose.bus;
    metrics.walkCalls = this.api.walkCalls;
    metrics.matrixCalls = this.api.matrixCalls;
    metrics.matrixElements = this.api.matrixElements;
    metrics.exactCalls = this.api.exactCalls;
    if (exactWave !== null) metrics.exactMs = exactSw.elapsedMilliseconds;
    this.diag.logMetrics(metrics);
    this.onMetrics?.(metrics);

    return plan;
  }

  close(): void {
    this.api.close();
  }

  private async arrivalWaveOptions(
    wave: Promise<JsonMap>,
    departureOptions: TransitOption[],
  ): Promise<{ outcome: ArrivalWaveOutcome; fresh: TransitOption[] }> {
    try {
      const parsed = parseGuidancePlan(await wave);
      const seen = new Set(departureOptions.map((o) => this.optionKey(o)));
      const fresh: TransitOption[] = [];
      for (const o of parsed) {
        const key = this.optionKey(o);
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push(o);
      }
      this.diag.log(() => `arrival 波: ${parsed.length} options → 純増 ${fresh.length}件を合流`);
      return {
        outcome: parsed.length === 0 ? ArrivalWaveOutcome.empty : ArrivalWaveOutcome.ok,
        fresh,
      };
    } catch (error) {
      if (error instanceof SearchCanceledException) throw error;
      if (error instanceof TimeoutException) {
        this.diag.log(() => 'arrival 波: 猶予切れ → departure 波のみで続行');
        return { outcome: ArrivalWaveOutcome.timeout, fresh: [] };
      }
      this.diag.log(() => `arrival 波: 失敗（${String(error)}）→ departure 波のみで続行`);
      return { outcome: ArrivalWaveOutcome.error, fresh: [] };
    }
  }

  private async exactWaveCandidates(
    wave: Promise<JsonMap>,
    ends: { origin: GeoPoint; goal: GeoPoint; from: string; to: string },
  ): Promise<{
    candidates: RouteCandidate[] | null;
    transfers: RouteCandidate[];
    capped: boolean;
    sources: TimetableSource[];
  }> {
    try {
      const body = await wave;
      const candidates = exactWalkCandidates(body, ends);
      const transfers = this.exactWalkMaxAb ? exactWalkTransferCandidates(body, ends) : [];
      const stats = body['stats'];
      const capped = isRecord(stats) && stats['truncated'] === true;
      this.diag.log(() => `exactWalkMax: ${candidates.length}件を合流（打ち切り=${capped}）`);
      return { candidates, transfers, capped, sources: timetableSources(body) };
    } catch (error) {
      if (error instanceof SearchCanceledException) throw error;
      this.diag.log(() => `exactWalkMax: 失敗（${String(error)}）→ 厳密走査の候補なしで続行`);
      return { candidates: null, transfers: [], capped: false, sources: [] };
    }
  }

  private async selectMeasured(
    options: TransitOption[],
    budgetMin: number,
    departure: TimeValue,
    ctx: {
      origin: GeoPoint;
      goal: GeoPoint;
      metrics: RouteSearchMetrics;
      arrivalWaveOptions: Set<TransitOption>;
      exactWave: Promise<JsonMap> | null;
      onProgress?: (phase: RoutePhase) => void;
      fromName: string | null;
      toName: string | null;
      standardTransit: StandardTransitSummary | null;
    },
  ): Promise<RoutePlan> {
    const { origin, goal, metrics, arrivalWaveOptions } = ctx;
    const departureAt = this.departureDateTime(departure);
    this.diag.log(
      () =>
        `=== plan start: budget=${budgetMin}m departureAt=${String(departureAt)} ` +
        `options=${options.length} ===`,
    );
    const session = new SearchSession();
    const { provenance } = session;
    const search: SearchFrame = { origin, goal, budgetMin, departureAt, metrics, session };

    const { candidates, base } = await this.initialCandidates(options, arrivalWaveOptions, search);

    let sources: TimetableSource[] = [];
    const takeExact = async (wave: Promise<JsonMap>): Promise<RouteCandidate[]> => {
      const result = await this.exactWaveCandidates(wave, {
        origin,
        goal,
        from: options[0].from,
        to: options[0].to,
      });
      const exact = result.candidates ?? [];
      metrics.exactCandidates = result.candidates === null ? -1 : exact.length;
      metrics.exactCapped = result.capped;
      sources = result.sources;
      for (const c of exact) {
        provenance.exact.add(c);
        this.diag.log(() => `exact: ${this.diag.candLine(c, budgetMin, departureAt)}`);
      }
      for (const c of result.transfers) {
        provenance.transfer.add(c);
        this.diag.log(() => `exact transfer: ${this.diag.candLine(c, budgetMin, departureAt)}`);
      }
      return exact;
    };
    if (ctx.exactWave !== null && !this.exactWalkMaxAb) {
      candidates.push(...(await takeExact(ctx.exactWave)));
    }
    this.diag.log(() => `total candidates: ${candidates.length}`);

    const bus = new LastResortBus(
      () => this.fetchBusOptions(origin, goal, departureAt),
      (ms) => {
        metrics.busLastResortMs = ms;
      },
    );
    const select = (pool: RouteCandidate[]): Promise<Selection> =>
      this.measurer.selectAndEnrich(pool, budgetMin, departureAt, {
        origin,
        goal,
        session,
        enrichLedger: session.enrichLedger,
        bestEffortLedger: session.bestEffortLedger,
        bus,
      });

    const estWinner = selectBestRoute({
      candidates,
      budgetMin,
      origin,
      goal,
      departureAt,
    });
    const estWithin = arrivalMinutes(estWinner.segments, departureAt) <= budgetMin;
    const preCollapse =
      base !== null && estWithin && this.isCollapse(estWinner, options, budgetMin, departureAt);

    const trainBoardSearch = new BoardSearchStats();
    let speculationAbandoned = false;
    let trainBoardSearchFuture: Promise<RouteCandidate[]> | null = null;
    if (base !== null && preCollapse) {
      this.diag.log(() => 'preCollapse=true → 電車系 board-search を enrich と並行に投機起動');
      metrics.boardSearchSpeculated = true;
      trainBoardSearchFuture = this.buildBoardSearchCandidate(
        base,
        origin,
        goal,
        budgetMin,
        departureAt,
        session.walkCache,
        trainBoardSearch,
        provenance.boardSearchRound,
        () => speculationAbandoned,
      );
      ignore(trainBoardSearchFuture);
    }

    const enrichSw = startedStopwatch();
    if (estWithin && !preCollapse) await this.prewarm(candidates, estWinner, search);
    let selected = await select(candidates);
    enrichSw.stop();

    this.diag.log(
      () =>
        'selected(initial): ' +
        `chosen(見積り)=${this.diag.candLine(selected.chosen, budgetMin, departureAt)} | ` +
        `enriched(実測)=${this.diag.candLine(selected.enriched, budgetMin, departureAt)}`,
    );

    const busBase = this.busBaseFor(selected.chosen, bus.candidates, bus.options);

    const collapseOptions = bus.options === null ? options : [...options, ...bus.options];
    const collapse =
      (base !== null || busBase !== null) &&
      this.isCollapse(selected.chosen, collapseOptions, budgetMin, departureAt);
    metrics.collapseFired = collapse;
    let boardSearchExtra: RouteCandidate[] = [];
    if (collapse) {
      metrics.boardSearchActivated = true;
      const boardSw = startedStopwatch();
      this.diag.log(() => 'collapse=true → board-search フォールバック起動');
      const extra = await this.collapseBoardSearch(
        { base, busBase, trainBoardSearchFuture, trainBoardSearch, arrivalWaveOptions },
        search,
      );
      if (extra.length > 0) {
        boardSearchExtra = extra;
        this.diag.log(() => `徒歩最大化候補: ${extra.length}件をプールへ追加`);
        enrichSw.start();
        selected = await select([...candidates, ...(bus.candidates ?? []), ...extra]);
        enrichSw.stop();
        this.diag.log(
          () =>
            'selected(after board-search): ' +
            this.diag.candLine(selected.enriched, budgetMin, departureAt),
        );
      } else {
        this.diag.log(() => '徒歩最大化候補: なし');
      }
      metrics.boardSearchWinnerRound = provenance.boardSearchRound.get(selected.chosen) ?? 0;
      metrics.boardSearchMs = boardSw.elapsedMilliseconds;
    } else if (base !== null || busBase !== null) {
      this.diag.log(() => 'collapse=false → フォールバック起動せず');
    }
    if (trainBoardSearchFuture !== null && !collapse) {
      speculationAbandoned = true;
      this.diag.log(() => '投機 board-search 空振り: collapse=false → 打ち切り');
    }

    let abSw: Stopwatch | null = null;
    if (this.exactWalkMaxAb) {
      const ab = await runExactWalkAb(
        { measurer: this.measurer, api: this.api, diag: this.diag },
        {
          a: selected,
          poolA: [...candidates, ...(bus.candidates ?? []), ...boardSearchExtra],
          collapseA: collapse,
          takeExact: () =>
            ctx.exactWave === null ? Promise.resolve([]) : takeExact(ctx.exactWave),
          isCollapse: (chosen) =>
            this.isCollapse(
              chosen,
              bus.options === null ? options : [...options, ...bus.options],
              budgetMin,
              departureAt,
            ),
          reselect: (from, rejected) =>
            this.measurer.selectAndEnrich(from, budgetMin, departureAt, {
              origin,
              goal,
              session,
              enrichLedger: new EnrichLatencyLedger(),
              bestEffortLedger: new BestEffortLedger(),
              bus,
              rejected,
            }),
          provenance,
          walkCache: session.walkCache,
          metrics,
          budgetMin,
          departureAt,
        },
      );
      selected = ab.selected;
      abSw = ab.abSw;
    } else {
      metrics.exactWon = provenance.exact.has(selected.chosen);
    }

    metrics.arrivalWaveWon = provenance.arrivalWave.has(selected.chosen);

    metrics.enrichMs = enrichSw.elapsedMilliseconds;
    metrics.recordEnrich(session.enrichLedger);
    metrics.recordBestEffort(session.bestEffortLedger);

    const finalizeSw = startedStopwatch();
    const named = await this.measurer.finalizeStationNames(selected.enriched, departureAt);
    if (abSw === null) metrics.finalizeMs = finalizeSw.elapsedMilliseconds;
    else metrics.abMs = abSw.elapsedMilliseconds;
    metrics.finalWalkMinutes = named.walkMinutes;
    if (speculationAbandoned) {
      metrics.recordSpeculationWaste(trainBoardSearch);
      this.diag.log(() => `投機 board-search 空振りの対価: probe ${trainBoardSearch.probes}本`);
    }
    this.diag.log(() => `=== FINAL: ${this.diag.candLine(named, budgetMin, departureAt)} ===`);

    return this.build(named, departure, budgetMin, ctx.onProgress, {
      fromName: ctx.fromName,
      toName: ctx.toName,
      standardTransit: ctx.standardTransit,
      timetableSources: sources,
    });
  }

  private async initialCandidates(
    options: TransitOption[],
    arrivalWaveOptions: Set<TransitOption>,
    search: SearchFrame,
  ): Promise<{ candidates: RouteCandidate[]; base: TransitOption | null }> {
    const { origin, goal, budgetMin, departureAt, metrics, session } = search;
    const { provenance } = session;

    const candidates: RouteCandidate[] = options.map(
      (o) => new RouteCandidate({ from: o.from, to: o.to, segments: o.segments }),
    );
    for (const c of candidates) {
      this.diag.log(() => `standard: ${this.diag.candLine(c, budgetMin, departureAt)}`);
    }

    for (let i = 0; i < options.length; i++) {
      if (arrivalWaveOptions.has(options[i])) provenance.arrivalWave.add(candidates[i]);
    }

    const bases = this.basesForHybrid(options);
    const base = bases.length === 0 ? null : bases[0];
    metrics.arrivalWaveBaseUsed = bases.some((b) => arrivalWaveOptions.has(b));
    const hybridSw = startedStopwatch();
    if (bases.length > 0) {
      this.diag.log(() => `hybrid bases: ${bases.length}家系`);
      const built = await this.buildCorridorHybrids(
        bases,
        origin,
        goal,
        budgetMin,
        departureAt,
        session.accessWalks,
        metrics,
      );
      for (let i = 0; i < bases.length; i++) {
        if (arrivalWaveOptions.has(bases[i])) {
          for (const c of built[i]) provenance.arrivalWave.add(c);
        }
      }
      const merged = this.mergeHybrids(
        built,
        (h) => arrivalMinutes(h.segments, departureAt) <= budgetMin,
      );
      candidates.push(...merged);
      for (const h of merged) provenance.hybrids.add(h);
      this.diag.log(() => `merged hybrids: ${merged.length}件（上限${maxHybridCandidates}）`);
    } else {
      this.diag.log(() => 'no base route (corridor<2); all-walk only');
      await this.measureAccessWalks(origin, goal, [], session.accessWalks, metrics);
    }
    metrics.hybridMs = hybridSw.elapsedMilliseconds;

    const allWalk = this.measuredWalk(
      origin,
      goal,
      options[0].from,
      options[0].to,
      session.accessWalks,
    );
    candidates.push(allWalk);
    this.diag.log(() => `allWalk: ${this.diag.candLine(allWalk, budgetMin, departureAt)}`);
    return { candidates, base };
  }

  private async prewarm(
    candidates: RouteCandidate[],
    estWinner: RouteCandidate,
    search: SearchFrame,
  ): Promise<void> {
    const { origin, goal, budgetMin, departureAt, metrics, session } = search;
    const shortlist = measureShortlist({
      candidates,
      budgetMin,
      departureAt,
      origin,
      goal,
    });
    const front = prewarmFront({
      shortlist,
      chosen: estWinner,
      hybrids: session.provenance.hybrids,
      singlePassHybridThreshold,
      maxMeasureShortlist,
      allowSinglePass: !this.deadline.isExpired(),
    });
    const prewarm = front.prewarm;
    metrics.singlePassMeasure = front.singlePass;
    this.diag.log(() =>
      front.singlePass
        ? `非崩壊: 予算内短リスト${prewarm.length}件を1パスで先行実測（#318 Option A: reject多発ルート）`
        : `非崩壊: 見積りフロント${prewarm.length}件を1パスで先行実測（#315 winner 先行実測）`,
    );
    await this.measurer.measureUntilWinner(
      prewarm,
      budgetMin,
      departureAt,
      session,
      session.enrichLedger,
    );
  }

  private async collapseBoardSearch(
    a: {
      base: TransitOption | null;
      busBase: TransitOption | null;
      trainBoardSearchFuture: Promise<RouteCandidate[]> | null;
      trainBoardSearch: BoardSearchStats;
      arrivalWaveOptions: Set<TransitOption>;
    },
    search: SearchFrame,
  ): Promise<RouteCandidate[]> {
    const { base, busBase, trainBoardSearch } = a;
    const { origin, goal, budgetMin, departureAt, metrics, session } = search;
    const { provenance } = session;
    const busBoardSearch = new BoardSearchStats();
    const systems: Promise<RouteCandidate[]>[] = [];
    if (base !== null) {
      systems.push(
        a.trainBoardSearchFuture ??
          this.buildBoardSearchCandidate(
            base,
            origin,
            goal,
            budgetMin,
            departureAt,
            session.walkCache,
            trainBoardSearch,
            provenance.boardSearchRound,
          ),
      );
    }
    if (busBase !== null) {
      systems.push(
        (async (): Promise<RouteCandidate[]> => {
          this.diag.log(() => 'バス corridor を基準に徒歩最大化（#251）');
          return [
            ...(
              await this.buildCorridorHybrids(
                [busBase],
                origin,
                goal,
                budgetMin,
                departureAt,
                session.accessWalks,
                metrics,
              )
            )[0],
            ...(await this.buildBoardSearchCandidate(
              busBase,
              origin,
              goal,
              budgetMin,
              departureAt,
              session.walkCache,
              busBoardSearch,
              provenance.boardSearchRound,
            )),
          ];
        })(),
      );
    }
    const builtPerSystem = await Promise.all(systems);
    if (base !== null && a.arrivalWaveOptions.has(base)) {
      for (const c of builtPerSystem[0]) provenance.arrivalWave.add(c);
    }
    metrics.recordBoardSearches([
      ...(base !== null ? [trainBoardSearch] : []),
      ...(busBase !== null ? [busBoardSearch] : []),
    ]);
    return builtPerSystem.flat();
  }

  private async fetchBusOptions(
    origin: GeoPoint,
    goal: GeoPoint,
    departureAt: Date,
  ): Promise<TransitOption[]> {
    this.diag.log(() => 'バス last-resort: avoidModes からバスを外して再照会');
    let body: JsonMap;
    try {
      body = await this.api.fetchGuidanceAt(origin, goal, departureAt, {
        allowBus: true,
        purpose: 'bus',
      });
    } catch (error) {
      if (!(error instanceof RouteException)) throw error;
      this.diag.log(() => `バス last-resort: 再照会失敗 (${error.status})`);
      return [];
    }
    return parseGuidancePlan(body).filter((o) =>
      o.segments.some((s) => s.type === SegmentType.bus),
    );
  }

  private isCollapse(
    winner: RouteCandidate,
    options: TransitOption[],
    budgetMin: number,
    departureAt: Date,
  ): boolean {
    const arrival = arrivalMinutes(winner.segments, departureAt);
    if (arrival > budgetMin) {
      this.diag.log(() => `collapse判定: 予算外(arr=${arrival}m>budget=${budgetMin}m)→対象外`);
      return false;
    }
    const slack = budgetMin - arrival;
    const relativeThreshold = budgetMin * collapseSlackRatio;
    if (slack < relativeThreshold && slack < collapseSlackMinutes) {
      this.diag.log(
        () =>
          `collapse判定: 症状(2)未達 slack=${slack}m < ` +
          `相対閾値=${relativeThreshold.toFixed(1)}m` +
          `(=${budgetMin}m×${collapseSlackRatio}) かつ < ` +
          `絶対閾値=${collapseSlackMinutes}m →起動せず`,
      );
      return false;
    }
    let bestStandardWalk = 0;
    for (const o of options) {
      const c = new RouteCandidate({ from: o.from, to: o.to, segments: o.segments });
      if (
        arrivalMinutes(c.segments, departureAt) <= budgetMin &&
        c.walkMinutes > bestStandardWalk
      ) {
        bestStandardWalk = c.walkMinutes;
      }
    }
    const margin = winner.walkMinutes - bestStandardWalk;
    const result = margin <= collapseWalkMarginMin;
    this.diag.log(
      () =>
        `collapse判定: slack=${slack}m(≥閾値) ` +
        `winnerWalk=${winner.walkMinutes}m bestStandardWalk=${bestStandardWalk}m ` +
        `margin=${margin}m ${result ? '≤' : '>'} ${collapseWalkMarginMin} ` +
        `→症状(1)=${result ? '達' : '未達'} → collapse=${result}`,
    );
    return result;
  }

  private async buildBoardSearchCandidate(
    base: TransitOption,
    origin: GeoPoint,
    goal: GeoPoint,
    budgetMin: number,
    departureAt: Date,
    walkCache: WalkLegCache,
    stats: BoardSearchStats,
    roundOf: Map<RouteCandidate, number>,
    abandoned?: () => boolean,
  ): Promise<RouteCandidate[]> {
    const stops = this.corridorStops(base);
    if (stops.length < 2) return [];
    if (this.deadline.isExpired()) {
      this.diag.log(() => 'board-search: 締切切れのため起動せず縮退');
      return [];
    }
    const allowBus = base.segments.some((s) => s.type === SegmentType.bus);

    const scanCount = await this.boardSearchScanCount(origin, stops, budgetMin);
    stats.scanCount = scanCount;
    if (scanCount === 0) {
      this.diag.log(() => 'board-search: 予算内の乗車駅なし（t1 実測で全点予算外）');
      return [];
    }

    const built = new Map<number, RouteCandidate | null>();
    const unevaluated = new Set<number>();

    const bestWalkSoFar = (): number => {
      let best = 0;
      for (const c of built.values()) {
        if (c === null) continue;
        if (arrivalMinutes(c.segments, departureAt) > budgetMin) continue;
        if (c.walkMinutes > best) best = c.walkMinutes;
      }
      return best;
    };

    const builtInRound = new Map<number, number>();
    const buildAt = async (i: number): Promise<RouteCandidate | null> => {
      const cached = built.get(i);
      if (cached !== undefined) return cached;
      builtInRound.set(i, stats.rounds);
      stats.probes++;
      const x = stops[i];
      const walkSw = startedStopwatch();
      const measuredWalk = await this.measurer.tryWalk(origin, x.coord, base.from, '', walkCache);
      walkSw.stop();
      if (measuredWalk === null) stats.probeFailed = true;
      const walk1 = measuredWalk ?? this.estimateWalk(origin, x.coord, base.from, '');
      const boardAt = plusMinutes(departureAt, walk1.totalMin);
      const guidanceSw = startedStopwatch();
      const options = await this.fetchTransitOptionsFrom(x.coord, goal, boardAt, {
        allowBus,
        onUpstreamFailure: () => {
          stats.probeFailed = true;
          unevaluated.add(i);
        },
      });
      guidanceSw.stop();
      stats.probeLatency.record({
        walkMs: walkSw.elapsedMilliseconds,
        guidanceMs: guidanceSw.elapsedMilliseconds,
      });
      if (options.length === 0) {
        this.diag.log(
          () =>
            `board-search i=${i} walk1=${walk1.totalMin}m guidance失敗` +
            `(${unevaluated.has(i) ? '上流エラー→未評価' : '経路なし→予算外扱い'})`,
        );
        built.set(i, null);
        return null;
      }
      const walk1Seg = walk1.segments[0];
      const cands = options.map(
        (o) =>
          new RouteCandidate({
            from: base.from,
            to: o.to,
            segments: [...(walk1Seg.minutes > 0 ? [walk1Seg] : []), ...o.segments],
          }),
      );
      const withinHere = cands.filter((c) => arrivalMinutes(c.segments, departureAt) <= budgetMin);
      const earlier = (a: RouteCandidate, b: RouteCandidate): RouteCandidate => {
        const arrivalA = arrivalMinutes(a.segments, departureAt);
        const arrivalB = arrivalMinutes(b.segments, departureAt);
        if (arrivalA !== arrivalB) return arrivalA < arrivalB ? a : b;
        return a.transferCount <= b.transferCount ? a : b;
      };
      const cand =
        withinHere.length === 0
          ? cands.reduce(earlier)
          : withinHere.reduce((a, b) =>
              a.walkMinutes !== b.walkMinutes
                ? a.walkMinutes > b.walkMinutes
                  ? a
                  : b
                : earlier(a, b),
            );
      this.diag.log(
        () =>
          `board-search i=${i} walk1=${walk1.totalMin}m ` +
          `乗車駅=${this.diag.boardingStationOf(cand)} ` +
          `候補${cands.length}本(予算内${withinHere.length}) ` +
          this.diag.candLine(cand, budgetMin, departureAt),
      );
      built.set(i, cand);
      return cand;
    };

    const best = await maxWalkBoardingIndexParallel({
      count: scanCount,
      budgetMin,
      fanout: boardSearchFanout,
      onRound: () => {
        if (stats.rounds > 0) stats.walkByRound.push(bestWalkSoFar());
        stats.rounds++;
        stats.probeLatency.endRound();
      },
      shouldContinue: () => {
        if (abandoned?.() ?? false) return false;
        if (!this.deadline.isExpired()) return true;
        stats.truncated = true;
        return false;
      },
      evaluate: async (i) => {
        const c = await buildAt(i);
        if (c !== null) return arrivalMinutes(c.segments, departureAt);
        return unevaluated.has(i) ? null : budgetMin + (1 << 20);
      },
    });
    if (this.deadline.isExpired()) stats.truncated = true;
    if (stats.rounds > 0) stats.walkByRound.push(bestWalkSoFar());
    const withinEntries = [...built.entries()].flatMap(([k, v]): [number, RouteCandidate][] =>
      v !== null && arrivalMinutes(v.segments, departureAt) <= budgetMin ? [[k, v]] : [],
    );
    stats.best = withinEntries.reduce((m, [k]) => (k > m ? k : m), -1);
    this.diag.log(
      () =>
        'board-search: 実測k分割並列探索の境界 best=' +
        `${best === null ? 'null(予算内乗車駅なし)' : String(best)} / コリドー点${stops.length}` +
        ` / 予算内最遠=${stats.best}`,
    );
    const within = withinEntries.map(([, v]) => v);
    for (const [k, v] of withinEntries) {
      roundOf.set(v, builtInRound.get(k) ?? 0);
    }
    this.diag.log(() => `board-search: 予算内候補 ${within.length}件を返す`);
    return within;
  }

  private async boardSearchScanCount(
    origin: GeoPoint,
    stops: CorridorStop[],
    budgetMin: number,
  ): Promise<number> {
    const walk1 = stops.map((s) =>
      dartRound((haversineKm(origin, s.coord) * 1000) / walkMetersPerMinute),
    );
    const ranges: { start: number; end: number }[] = [];
    for (let start = 0; start < stops.length; start += maxScanMatrixDests) {
      ranges.push({
        start,
        end: Math.min(start + maxScanMatrixDests, stops.length),
      });
    }
    const chunks = await Promise.all(
      ranges.map((r) =>
        this.api.fetchWalkMatrix(
          [origin],
          stops.slice(r.start, r.end).map((s) => s.coord),
        ),
      ),
    );
    for (let c = 0; c < ranges.length; c++) {
      const rows = chunks[c];
      if (rows === null) continue;
      const r = ranges[c];
      for (const e of rows) {
        if (!isRecord(e)) continue;
        const di = intOr(e['destinationIndex'], 0);
        const min = parseDurationMin(e['duration']);
        if (min === null || di < 0 || di >= r.end - r.start) continue;
        walk1[r.start + di] = min;
      }
    }
    return walkFeasiblePrefixCount(walk1, budgetMin);
  }

  private async measureAccessWalks(
    origin: GeoPoint,
    goal: GeoPoint,
    demands: readonly AccessWalkDemand[],
    measured: Map<string, number>,
    metrics: RouteSearchMetrics,
  ): Promise<void> {
    const plan = planAccessWalkMatrix(origin, goal, demands, (k) => measured.has(k));
    metrics.accessMatrixRequestedLegs += plan.requestedLegs;
    metrics.accessMatrixUniqueLegs += plan.uniqueLegs;
    const rows = await Promise.all(
      plan.requests.map((r) => this.api.fetchWalkMatrix([...r.origins], [...r.dests])),
    );
    for (let i = 0; i < plan.requests.length; i++) {
      applyWalkMatrixRows(plan.requests[i], rows[i], measured);
    }
  }

  private corridorAccessPlan(
    base: TransitOption,
    origin: GeoPoint,
    goal: GeoPoint,
    budgetMin: number,
  ): CorridorAccessPlan {
    const stops = this.corridorStops(base);
    const frontier = frontierStations(
      stops.map((s) => s.coord),
      origin,
      goal,
      budgetMin,
      { maxPerSide: maxMatrixSideStations },
    );
    const baseMin = base.segments.reduce((a, s) => a + s.minutes, 0);
    this.diag.log(
      () =>
        `base route: totalMin=${baseMin}m corridorStops=${stops.length} ` +
        `frontier.boarding=[${frontier.boarding.join(', ')}] ` +
        `alighting=[${frontier.alighting.join(', ')}]`,
    );
    return {
      base,
      stops,
      frontier,
      demand: {
        boardStops: frontier.boarding.map((i) => stops[i].coord),
        alightStops: frontier.alighting.map((i) => stops[i].coord),
      },
    };
  }

  private async buildCorridorHybrids(
    bases: readonly TransitOption[],
    origin: GeoPoint,
    goal: GeoPoint,
    budgetMin: number,
    departureAt: Date,
    measured: Map<string, number>,
    metrics: RouteSearchMetrics,
  ): Promise<RouteCandidate[][]> {
    const plans = bases.map((b) => this.corridorAccessPlan(b, origin, goal, budgetMin));
    await this.measureAccessWalks(
      origin,
      goal,
      plans.map((p) => p.demand),
      measured,
      metrics,
    );
    this.diag.log(
      () =>
        `measured ${measured.size} legs; ` +
        `allWalk(origin->goal)=${measured.get(walkCacheKey(origin, goal))}m ` +
        '(null=matrix失敗→直線推定へ)',
    );
    return plans.map((p) => {
      const hybrids = this.buildMeasuredHybrids(
        p.base,
        p.stops,
        p.frontier,
        measured,
        origin,
        goal,
      );
      this.diag.log(() => `built ${hybrids.length} hybrids:`);
      for (const c of hybrids) {
        this.diag.log(() => `  hybrid: ${this.diag.candLine(c, budgetMin, departureAt)}`);
      }
      return hybrids;
    });
  }

  private buildMeasuredHybrids(
    base: TransitOption,
    stops: CorridorStop[],
    frontier: FrontierStations,
    measured: Map<string, number>,
    origin: GeoPoint,
    goal: GeoPoint,
  ): RouteCandidate[] {
    const result: RouteCandidate[] = [];
    for (const b of frontier.boarding) {
      const walk1 = this.measuredWalkSeg(
        origin,
        stops[b].coord,
        base.from,
        stops[b].name,
        measured,
      );
      for (const a of frontier.alighting) {
        if (a <= b) continue;
        if (stops[a].section !== stops[b].section) continue;
        const rideKm = railKm(stops, b, a);
        const ride = dartRound((rideKm * 1000) / trainMetersPerMinute);
        if (ride < 0) continue;
        const walk2 = this.measuredWalkSeg(stops[a].coord, goal, stops[a].name, base.to, measured);
        result.push(
          new RouteCandidate({
            from: base.from,
            to: base.to,
            segments: [
              ...(walk1.minutes > 0 ? [walk1] : []),
              new RouteSegment({
                type: stops[b].type,
                fromName: stops[b].name,
                toName: stops[a].name,
                minutes: ride,
                km: rideKm,
                line: stops[b].line,
                stops: a - b,
                polyline: stops.slice(b, a + 1).map((s) => s.coord),
              }),
              ...(walk2.minutes > 0 ? [walk2] : []),
            ],
          }),
        );
      }
    }
    return result;
  }

  private measuredWalkSeg(
    a: GeoPoint,
    b: GeoPoint,
    fromName: string,
    toName: string,
    measured: Map<string, number>,
  ): RouteSegment {
    const est = this.estimateWalk(a, b, fromName, toName).segments[0];
    const min = measured.get(walkCacheKey(a, b));
    if (min === undefined || est.minutes === 0) return est;
    return new RouteSegment({
      type: SegmentType.walk,
      fromName,
      toName,
      minutes: min,
      km: est.km,
      kcal: est.kcal,
      polyline: est.polyline,
    });
  }

  private measuredWalk(
    origin: GeoPoint,
    goal: GeoPoint,
    fromName: string,
    toName: string,
    measured: Map<string, number>,
  ): RouteCandidate {
    return new RouteCandidate({
      from: fromName,
      to: toName,
      segments: [this.measuredWalkSeg(origin, goal, fromName, toName, measured)],
    });
  }

  private build(
    chosen: RouteCandidate,
    departure: TimeValue,
    budgetMin: number,
    onProgress: ((phase: RoutePhase) => void) | undefined,
    extras: {
      fromName: string | null;
      toName: string | null;
      standardTransit: StandardTransitSummary | null;
      timetableSources: TimetableSource[];
    },
  ): RoutePlan {
    onProgress?.(RoutePhase.building);
    const departureAt = this.departureDateTime(departure);
    return buildRoutePlan({
      from: displayName(extras.fromName, chosen.from),
      to: displayName(extras.toName, chosen.to),
      segments: chosen.segments,
      departure,
      budgetMin,
      departureAt,
      standardTransit: extras.standardTransit,
      timetableSources: extras.timetableSources,
    });
  }

  private busBaseFor(
    winner: RouteCandidate,
    busCandidates: RouteCandidate[] | null,
    busOptions: TransitOption[] | null,
  ): TransitOption | null {
    if (busOptions === null) return null;
    if (!winner.segments.some((s) => s.type === SegmentType.bus)) return null;
    const i = busCandidates?.findIndex((c) => c === winner) ?? -1;
    const scope = i >= 0 ? [busOptions[i]] : busOptions;
    return this.baseForHybrid(scope, true);
  }

  private baseForHybrid(options: TransitOption[], allowBus = false): TransitOption | null {
    let best: TransitOption | null = null;
    let bestMin = 0;
    for (const o of options) {
      if (o.corridors.every((c) => c.coords.length < 2)) continue;
      if (!allowBus && o.segments.some((s) => s.type === SegmentType.bus)) {
        continue;
      }
      const min = o.segments.reduce((a, s) => a + s.minutes, 0);
      if (best === null || min < bestMin) {
        best = o;
        bestMin = min;
      }
    }
    return best;
  }

  basesForHybrid(options: TransitOption[]): TransitOption[] {
    const repByFamily = new Map<string, { option: TransitOption; min: number; index: number }>();
    for (let i = 0; i < options.length; i++) {
      const o = options[i];
      if (o.corridors.every((c) => c.coords.length < 2)) continue;
      if (o.segments.some((s) => s.type === SegmentType.bus)) continue;
      const key = this.routeFamilyKey(o);
      const min = o.segments.reduce((a, s) => a + s.minutes, 0);
      const current = repByFamily.get(key);
      if (current === undefined || min < current.min) {
        repByFamily.set(key, { option: o, min, index: i });
      }
    }
    const reps = [...repByFamily.values()].sort((a, b) => {
      const byMin = a.min - b.min;
      return byMin !== 0 ? byMin : a.index - b.index;
    });
    return reps.slice(0, maxHybridBases).map((r) => r.option);
  }

  private routeFamilyKey(o: TransitOption): string {
    const keys = new Set<string>();
    for (const s of o.segments) {
      if (s.type !== SegmentType.train && s.type !== SegmentType.bus) continue;
      keys.add(
        s.line === null || s.line.length === 0
          ? `@${this.corridorFingerprint(s.polyline)}`
          : s.line,
      );
    }
    return [...keys].sort().join('|');
  }

  private corridorFingerprint(polyline: GeoPoint[]): string {
    return evenSample(polyline, corridorFingerprintSamples)
      .map((p) => coordKey(p))
      .join(',');
  }

  private hybridKey(c: RouteCandidate): string {
    return c.segments
      .map(
        (s) =>
          `${s.type}:${s.line ?? ''}:` +
          `${coordKey(s.polyline.length > 0 ? s.polyline[0] : null)}>` +
          coordKey(s.polyline.length > 0 ? s.polyline[s.polyline.length - 1] : null),
      )
      .join('|');
  }

  private optionKey(o: TransitOption): string {
    const parts = [
      this.hybridKey(new RouteCandidate({ from: o.from, to: o.to, segments: o.segments })),
    ];
    for (const s of o.segments) {
      if (s.type === SegmentType.walk) continue;
      parts.push(`${isoOrEmpty(s.depTime)}>${isoOrEmpty(s.arrTime)}`);
    }
    return parts.join('#');
  }

  mergeHybrids(
    perBase: RouteCandidate[][],
    within: (candidate: RouteCandidate) => boolean,
  ): RouteCandidate[] {
    const sorted = perBase.map((list) => [...list].sort((a, b) => b.walkMinutes - a.walkMinutes));
    const seen = new Set<string>();
    const out: RouteCandidate[] = [];
    for (const keepWithin of [true, false]) {
      const phase = sorted.map((list) => list.filter((h) => within(h) === keepWithin));
      for (let rank = 0; out.length < maxHybridCandidates; rank++) {
        let progressed = false;
        for (const list of phase) {
          if (rank >= list.length) continue;
          progressed = true;
          const key = this.hybridKey(list[rank]);
          if (!seen.has(key)) {
            seen.add(key);
            out.push(list[rank]);
          }
          if (out.length >= maxHybridCandidates) break;
        }
        if (!progressed) break;
      }
      if (out.length >= maxHybridCandidates) break;
    }
    return out;
  }

  private corridorStops(base: TransitOption): CorridorStop[] {
    const transitSegs = base.segments.filter(
      (s) => s.type === SegmentType.train || s.type === SegmentType.bus,
    );
    const out: CorridorStop[] = [];
    for (const c of base.corridors) {
      const seg = c.legIndex < transitSegs.length ? transitSegs[c.legIndex] : null;
      for (const p of evenSample(c.coords, maxCorridorStops)) {
        out.push(
          new CorridorStop(p, c.legIndex, seg?.line ?? null, seg?.type ?? SegmentType.train),
        );
      }
    }
    return out;
  }

  private async fetchTransitOptionsFrom(
    x: GeoPoint,
    goal: GeoPoint,
    at: Date,
    options: { allowBus?: boolean; onUpstreamFailure?: () => void } = {},
  ): Promise<TransitOption[]> {
    let body: JsonMap;
    try {
      body = await this.api.fetchGuidanceAt(x, goal, at, {
        allowBus: options.allowBus ?? false,
        purpose: 'boardSearch',
      });
    } catch (error) {
      if (!(error instanceof RouteException)) throw error;
      options.onUpstreamFailure?.();
      return [];
    }
    return comparableFrom(
      parseGuidancePlan(body).filter((o) => o.segments.some((s) => s.type !== SegmentType.walk)),
      at,
    );
  }

  private estimateWalk(
    origin: GeoPoint,
    dest: GeoPoint,
    fromName: string,
    toName: string,
  ): RouteCandidate {
    const km = haversineKm(origin, dest);
    const minutes = dartRound((km * 1000) / walkMetersPerMinute);
    return new RouteCandidate({
      from: fromName,
      to: toName,
      segments: [
        new RouteSegment({
          type: SegmentType.walk,
          fromName,
          toName,
          minutes,
          km,
          kcal: dartRound(km * kcalPerKm),
          polyline: [origin, dest],
        }),
      ],
    });
  }

  private departureDateTime(t: TimeValue): Date {
    const now = this.clock();
    return dateTime(
      now.getFullYear(),
      now.getMonth() + 1,
      now.getDate() + effectiveOffset(t),
      t.h,
      t.m,
    );
  }
}

class CorridorStop {
  constructor(
    readonly coord: GeoPoint,
    readonly section: number,
    readonly line: string | null,
    readonly type: SegmentType,
  ) {}

  get name(): string {
    return '';
  }
}

function budgetMinutesOf(departure: TimeValue, arrival: TimeValue): number {
  return (
    arrival.totalMinutes +
    effectiveOffset(arrival) * 24 * 60 -
    (departure.totalMinutes + effectiveOffset(departure) * 24 * 60)
  );
}

function displayName(override: string | null, fallback: string): string {
  const name = override?.trim();
  return name !== undefined && name.length > 0 ? name : fallback;
}

function railKm(stops: CorridorStop[], b: number, a: number): number {
  let km = 0;
  for (let i = b; i < a; i++) {
    km += haversineKm(stops[i].coord, stops[i + 1].coord);
  }
  return km;
}

export function standardTransitSummary(
  options: readonly TransitOption[],
  at: Date,
): StandardTransitSummary | null {
  let best: StandardTransitSummary | null = null;
  for (const o of options) {
    if (o.segments.every((s) => s.type === SegmentType.walk)) continue;
    if (!isComparableOption(o, at)) continue;
    const totalMin = arrivalMinutes(o.segments, at);
    if (best === null || totalMin < best.totalMin) {
      best = {
        walkMinutes: new RouteCandidate(o).walkMinutes,
        totalMin,
      };
    }
  }
  return best;
}

function coordKey(p: GeoPoint | null): string {
  return p === null ? '-' : `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
}

function isoOrEmpty(d: Date | null): string {
  return d === null ? '' : d.toISOString();
}
