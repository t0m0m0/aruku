import { dartRound } from '../dart-number';
import { intOr, isRecord, type JsonMap } from '../json';
import { GeoPoint } from '../models/geo-point';
import { RouteSegment, SegmentType, type TimetableSource } from '../models/route-plan';
import { decodePolyline } from '../polyline';
import { firstAcceptedInOrder } from '../promises';
import { startedStopwatch } from '../stopwatch';
import { plusMinutes } from '../time';
import { parseDurationMin, walkCacheKey } from './access-walk-matrix';
import { SearchCanceledException } from './cancellation';
import { measureShortlist, reachableWithinBudget, RouteCandidate } from './hybrid-route-selector';
import { BestEffortLedger, EnrichLatencyLedger, RouteDiagnostics } from './route-diagnostics';
import {
  arrivalMinutes,
  firstMissedTransit,
  hasUnverifiedTransit,
  kcalPerKm,
} from './route-plan-builder';
import { RouteException } from './route-service';
import { parsePackRide, type PackRide } from './pack-departures';
import type { LastResortBus, SearchSession, WalkLegCache } from './search-session';
import type { TransitApiClient } from './transit-api-client';
import { parseGuidancePlan, type TransitOption } from './transit-plan-parser';

export interface Selection {
  chosen: RouteCandidate;
  enriched: RouteCandidate;
}

export const maxMeasureShortlist = 13;

export interface CandidateMeasurerOptions {
  rideDepartures?: boolean;
  verifyRideDepartures?: boolean;
}

export class CandidateMeasurer {
  constructor(
    private readonly api: TransitApiClient,
    private readonly diag: RouteDiagnostics,
    options: CandidateMeasurerOptions = {},
  ) {
    this.rideDepartures = options.rideDepartures ?? false;
    this.verifyRideDepartures = options.verifyRideDepartures ?? false;
  }

  private readonly verifyRideDepartures: boolean;
  private packVerifiedLegCount = 0;
  private packMismatchLegCount = 0;
  private packUnverifiedLegCount = 0;

  get packVerifiedLegs(): number {
    return this.packVerifiedLegCount;
  }

  get packMismatchLegs(): number {
    return this.packMismatchLegCount;
  }

  get packUnverifiedLegs(): number {
    return this.packUnverifiedLegCount;
  }

  private readonly rideDepartures: boolean;
  private packUnavailable = false;
  private packBoardingLegCount = 0;
  private readonly packSources = new Map<string, TimetableSource>();

  async selectAndEnrich(
    candidates: RouteCandidate[],
    budgetMin: number,
    departureAt: Date,
    ctx: {
      origin: GeoPoint;
      goal: GeoPoint;
      session: SearchSession;
      enrichLedger: EnrichLatencyLedger;
      bestEffortLedger: BestEffortLedger;
      bus?: LastResortBus;
      rejected?: Set<RouteCandidate>;
    },
  ): Promise<Selection> {
    const { origin, goal, session, enrichLedger, bestEffortLedger } = ctx;
    const rejected = ctx.rejected ?? new Set<RouteCandidate>();

    const giveUp = async (): Promise<Selection> => {
      ctx.bus?.prefetch();
      const fallback = await this.bestEffortResolved(
        candidates,
        budgetMin,
        departureAt,
        session.walkCache,
        bestEffortLedger,
      );
      const segs = fallback.enriched.segments;
      const arrival = arrivalMinutes(segs, departureAt);
      const missed = firstMissedTransit(segs, departureAt) !== null;
      if (ctx.bus === undefined) return fallback;
      if (arrival <= budgetMin && !missed) {
        this.diag.log(() => `  → best-effort が予算内(arr=${arrival}m) → バス再照会せず`);
        return fallback;
      }
      const bus = await ctx.bus.adopt();
      const fresh = bus.filter((b) => !candidates.some((c) => c === b));
      if (fresh.length === 0) {
        this.diag.log(() => '  → 追加できるバス候補なし → best-effort のまま');
        return fallback;
      }
      this.diag.log(
        () =>
          '  → best-effort が' +
          (missed ? '乗り遅れ' : `予算外(arr=${arrival}m)`) +
          ` → バス候補 ${fresh.length}件をプールへ追加して選び直し（last-resort）`,
      );
      return this.selectAndEnrich([...candidates, ...fresh], budgetMin, departureAt, {
        origin,
        goal,
        session,
        enrichLedger,
        bestEffortLedger,
        rejected,
      });
    };

    const within = measureShortlist({
      candidates,
      budgetMin,
      departureAt,
      origin,
      goal,
    });
    if (within.length === 0) {
      this.diag.log(
        () => '  → 見積り予算内候補なし → best-effort 縮退（予算外ならバス last-resort）',
      );
      return giveUp();
    }

    const cap = Math.min(within.length, maxMeasureShortlist);
    const firstTierWalk = within[0].walkMinutes;
    let firstTierEnd = 0;
    while (firstTierEnd < cap && within[firstTierEnd].walkMinutes === firstTierWalk) {
      firstTierEnd++;
    }
    const ranges: [number, number][] = [[0, firstTierEnd]];
    if (firstTierEnd < cap) ranges.push([firstTierEnd, cap]);
    for (const range of ranges) {
      const batch = within.slice(range[0], range[1]);
      this.diag.log(() =>
        range[0] === 0
          ? `measure tier: walk=${firstTierWalk}m ${batch.length}件を候補間並列で実測`
          : `reject後の残り予算内候補 ${batch.length}件を1並列バッチで一括実測（#315 B）`,
      );
      const { winnerIdx, enriched } = await this.measureUntilWinner(
        batch,
        budgetMin,
        departureAt,
        session,
        enrichLedger,
        { waitAll: ctx.rejected !== undefined },
      );
      for (let k = 0; k < batch.length; k++) {
        const e = enriched[k];
        if (e === undefined) continue;
        if (e === null) {
          this.diag.log(
            () => `  → 棄却(実測失敗): ${this.diag.candLine(batch[k], budgetMin, departureAt)}`,
          );
          rejected.add(batch[k]);
          continue;
        }
        const v = invariantViolation(e.segments, budgetMin, departureAt);
        if (v.overBudget || v.missed || v.unverified) {
          this.diag.log(
            () =>
              '  → 棄却(' +
              (v.overBudget ? '予算超過' : v.missed ? '乗り遅れ' : '未確認便') +
              `): ${this.diag.candLine(e, budgetMin, departureAt)}`,
          );
          rejected.add(batch[k]);
        }
      }
      const enrichedWinner = winnerIdx === null ? null : enriched[winnerIdx];
      if (winnerIdx !== null && enrichedWinner != null) {
        const chosen = batch[winnerIdx];
        this.diag.log(
          () => `  → 確定: ${this.diag.candLine(enrichedWinner, budgetMin, departureAt)}`,
        );
        return { chosen, enriched: enrichedWinner };
      }
    }
    this.diag.log(
      () => '  → 予算内候補が実測で全滅 → best-effort 縮退（予算外ならバス last-resort）',
    );
    return giveUp();
  }

  private async bestEffortResolved(
    candidates: RouteCandidate[],
    budgetMin: number,
    departureAt: Date,
    walkCache: WalkLegCache,
    ledger: BestEffortLedger,
  ): Promise<Selection> {
    ledger.enter();
    const sw = startedStopwatch();
    const depths = new Array<number>(candidates.length).fill(0);
    const resolved = await Promise.all(
      candidates.map((c, i) =>
        this.resolveBoardingTimes(c, departureAt, () => {
          depths[i]++;
        }),
      ),
    );
    ledger.recordPool({
      candidates: candidates.length,
      resolveDepth: depths.length === 0 ? 0 : Math.max(...depths),
    });
    const verified = resolved.filter((c) => !hasUnverifiedTransit(c.segments));
    let pool = verified.length > 0 ? verified : resolved;
    for (;;) {
      const fallback = bestEffort(pool, budgetMin, departureAt);
      const enriched = await this.enrichWalkGeometry(fallback, walkCache);
      const missed = firstMissedTransit(enriched.segments, departureAt) !== null;
      if (!missed || pool.length === 1) {
        if (missed) {
          this.diag.log(
            () =>
              '  → best-effort: 乗り遅れない候補が尽きた（最後の1件）→ ' +
              `そのまま縮退: ${this.diag.candLine(enriched, budgetMin, departureAt)}`,
          );
        }
        ledger.addMs(sw.elapsedMilliseconds);
        return { chosen: fallback, enriched };
      }
      this.diag.log(
        () =>
          '  → best-effort: enrich実測で乗り遅れ→除外して選び直し: ' +
          this.diag.candLine(enriched, budgetMin, departureAt),
      );
      ledger.recordRetry();
      pool = pool.filter((c) => c !== fallback);
    }
  }

  async measureCandidate(
    c: RouteCandidate,
    departureAt: Date,
    session: SearchSession,
    ledger: EnrichLatencyLedger,
  ): Promise<RouteCandidate> {
    const hit = session.enrichedCache.get(c);
    if (hit !== undefined) return hit;
    const inflight = session.enrichInflight.get(c);
    if (inflight !== undefined) return inflight;
    const started = this.measureUncached(c, departureAt, session, ledger);
    session.enrichInflight.set(c, started);
    return started;
  }

  private async measureUncached(
    c: RouteCandidate,
    departureAt: Date,
    session: SearchSession,
    ledger: EnrichLatencyLedger,
  ): Promise<RouteCandidate> {
    const pass = ledger.begin();
    const sw = startedStopwatch();
    const walkSw = startedStopwatch();
    let steps = 0;
    try {
      const walked = await this.enrichWalkGeometry(c, session.walkCache);
      walkSw.stop();
      const e = await this.resolveBoardingTimes(walked, departureAt, () => {
        steps++;
      });
      sw.stop();
      ledger.record({
        chainMs: sw.elapsedMilliseconds,
        walkMs: walkSw.elapsedMilliseconds,
        resolveSteps: steps,
        pass,
      });
      session.enrichedCache.set(c, e);
      return e;
    } catch (error) {
      if (error instanceof SearchCanceledException) throw error;
      sw.stop();
      walkSw.stop();
      ledger.record({
        chainMs: sw.elapsedMilliseconds,
        walkMs: walkSw.elapsedMilliseconds,
        resolveSteps: steps,
        pass,
      });
      throw error;
    } finally {
      session.enrichInflight.delete(c);
    }
  }

  async measureUntilWinner(
    batch: RouteCandidate[],
    budgetMin: number,
    departureAt: Date,
    session: SearchSession,
    ledger: EnrichLatencyLedger,
    options: { waitAll?: boolean } = {},
  ): Promise<{
    winnerIdx: number | null;
    enriched: (RouteCandidate | null | undefined)[];
  }> {
    const survives = (e: RouteCandidate | null): boolean => {
      if (e === null) return false;
      const v = invariantViolation(e.segments, budgetMin, departureAt);
      return !v.overBudget && !v.missed && !v.unverified;
    };
    const measuring = batch.map((c) => this.measureOrDrop(c, departureAt, session, ledger));
    let index: number | null;
    let values: (RouteCandidate | null | undefined)[];
    if (options.waitAll ?? false) {
      const all = await Promise.all(measuring);
      const first = all.findIndex(survives);
      index = first < 0 ? null : first;
      values = all;
    } else {
      ({ index, values } = await firstAcceptedInOrder(measuring, survives));
    }
    values.forEach((e, k) => {
      if (e === undefined) ledger.abandon(batch[k]);
    });
    ledger.endPass();
    return { winnerIdx: index, enriched: values };
  }

  async measureOrDrop(
    c: RouteCandidate,
    departureAt: Date,
    session: SearchSession,
    ledger: EnrichLatencyLedger,
  ): Promise<RouteCandidate | null> {
    try {
      return await this.measureCandidate(c, departureAt, session, ledger);
    } catch (error) {
      if (error instanceof SearchCanceledException) throw error;
      return null;
    }
  }

  async withMeasuredTransferWalks(
    candidates: RouteCandidate[],
    walkCache: WalkLegCache,
  ): Promise<RouteCandidate[]> {
    const measured = await Promise.all(
      candidates.map(async (c) => {
        const walks = c.segments.filter(
          (s, i, segs) =>
            s.type === SegmentType.walk &&
            i > 0 &&
            i < segs.length - 1 &&
            segs[i - 1].type !== SegmentType.walk &&
            segs[i + 1].type !== SegmentType.walk,
        );
        const legs = await Promise.all(
          walks.map((s) =>
            this.tryWalk(s.polyline[0], s.polyline[1], s.fromName, s.toName, walkCache),
          ),
        );
        return legs.every((leg) => leg !== null);
      }),
    );
    return candidates.filter((_, i) => measured[i]);
  }

  async enrichWalkGeometry(chosen: RouteCandidate, cache: WalkLegCache): Promise<RouteCandidate> {
    const segments = await Promise.all(
      chosen.segments.map(async (seg) => {
        if (seg.type !== SegmentType.walk || seg.polyline.length < 2) return seg;
        const walk = await this.tryWalk(
          seg.polyline[0],
          seg.polyline[seg.polyline.length - 1],
          seg.fromName,
          seg.toName,
          cache,
        );
        return walk?.segments[0] ?? seg;
      }),
    );
    return new RouteCandidate({ from: chosen.from, to: chosen.to, segments });
  }

  async tryWalk(
    origin: GeoPoint,
    dest: GeoPoint,
    fromName: string,
    toName: string,
    cache: WalkLegCache | null,
  ): Promise<RouteCandidate | null> {
    const key = walkCacheKey(origin, dest);
    const result =
      cache === null
        ? await this.fetchWalkLeg(origin, dest)
        : await cache.resolve(key, () => this.fetchWalkLeg(origin, dest));
    return result === null ? null : renameWalk(result, fromName, toName);
  }

  private async fetchWalkLeg(origin: GeoPoint, dest: GeoPoint): Promise<RouteCandidate | null> {
    try {
      const body = await this.api.fetchWalkRoute(origin, dest);
      const routes = body['routes'];
      if (!Array.isArray(routes) || routes.length === 0) return null;
      const route: unknown = routes[0];
      if (!isRecord(route)) return null;
      const minutes = parseDurationMin(route['duration']);
      if (minutes === null) return null;
      const km = intOr(route['distanceMeters'], 0) / 1000.0;
      const shape = parseEncodedPolyline(route['polyline']);
      return new RouteCandidate({
        from: '',
        to: '',
        segments: [
          new RouteSegment({
            type: SegmentType.walk,
            fromName: '',
            toName: '',
            minutes,
            km,
            kcal: dartRound(km * kcalPerKm),
            polyline: shape.length > 0 ? shape : [origin, dest],
          }),
        ],
      });
    } catch (error) {
      if (!(error instanceof RouteException)) throw error;
      return null;
    }
  }

  async resolveBoardingTimes(
    cand: RouteCandidate,
    departureAt: Date,
    onRedraw?: () => void,
  ): Promise<RouteCandidate> {
    const segs = [...cand.segments];
    let changed = false;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.type === SegmentType.walk) continue;
      if (seg.depTime !== null) continue;
      if (seg.polyline.length < 2) continue;
      const cumBefore = arrivalMinutes(segs.slice(0, i), departureAt);
      const boardAt = plusMinutes(departureAt, cumBefore);
      const picked = await this.packRide(seg, boardAt);
      if (picked !== null) {
        if (this.verifyRideDepartures) await this.verifyPackRide(seg, boardAt, picked);
        segs[i] = seg.copyWith({
          fromName: seg.fromName.length === 0 ? picked.from : undefined,
          toName: seg.toName.length === 0 ? picked.to : undefined,
          depTime: picked.dep,
          arrTime: picked.arr,
          minutes: Math.trunc((picked.arr.getTime() - picked.dep.getTime()) / 60000),
        });
        changed = true;
        continue;
      }
      onRedraw?.();
      const ep = await this.fetchTransitEndpoints(
        seg.polyline[0],
        seg.polyline[seg.polyline.length - 1],
        boardAt,
        { purpose: 'boarding', type: seg.type, line: seg.line },
      );
      if (ep === null || ep.dep === null) continue;
      if (ep.dep.getTime() < boardAt.getTime()) continue;
      const ride =
        ep.arr !== null && ep.arr.getTime() >= ep.dep.getTime()
          ? Math.trunc((ep.arr.getTime() - ep.dep.getTime()) / 60000)
          : seg.minutes;
      segs[i] = seg.copyWith({
        fromName: seg.fromName.length === 0 ? ep.from : undefined,
        toName: seg.toName.length === 0 ? ep.to : undefined,
        depTime: ep.dep,
        arrTime: ep.arr ?? undefined,
        minutes: ride,
      });
      changed = true;
    }
    if (!changed) return cand;
    return new RouteCandidate({ from: cand.from, to: cand.to, segments: segs });
  }

  get packBoardingLegs(): number {
    return this.packBoardingLegCount;
  }

  get packTimetableSources(): TimetableSource[] {
    return [...this.packSources.values()];
  }

  private async verifyPackRide(seg: RouteSegment, boardAt: Date, picked: PackRide): Promise<void> {
    const ep = await this.fetchTransitEndpoints(
      seg.polyline[0],
      seg.polyline[seg.polyline.length - 1],
      boardAt,
      { purpose: 'boarding', type: seg.type, line: seg.line },
    );
    const dep = ep?.dep ?? null;
    const arr = ep?.arr ?? null;
    if (ep === null || dep === null || arr === null) {
      this.packUnverifiedLegCount++;
      return;
    }
    if (dep.getTime() === picked.dep.getTime() && arr.getTime() === picked.arr.getTime()) {
      this.packVerifiedLegCount++;
      return;
    }
    this.packMismatchLegCount++;
    this.diag.log(
      () =>
        `rideDepartures 検証: 食い違い ${seg.line ?? ''} パック ${picked.from}>${picked.to} ` +
        `${clock(picked.dep)}-${clock(picked.arr)} / Transit ${ep.from}>${ep.to} ${clock(dep)}-${clock(arr)}`,
    );
  }

  private async packRide(seg: RouteSegment, boardAt: Date): Promise<PackRide | null> {
    if (!this.rideDepartures || this.packUnavailable) return null;
    if (seg.type !== SegmentType.train || seg.line === null || seg.line.trim() === '') return null;
    let answer;
    try {
      const body = await this.api.fetchRideDeparture(
        boardAt,
        seg.polyline[0],
        seg.polyline[seg.polyline.length - 1],
        { boardName: seg.fromName, alightName: seg.toName, line: seg.line },
      );
      answer = parsePackRide(body);
    } catch (error) {
      if (error instanceof SearchCanceledException) throw error;
      answer = null;
    }
    if (answer === null) {
      this.packUnavailable = true;
      this.diag.log(() => 'rideDepartures: 失敗 → この検索の残りは Transit で乗車時刻を確定');
      return null;
    }
    const { ride } = answer;
    if (ride === null || ride.dep.getTime() < boardAt.getTime()) return null;
    for (const source of answer.sources) {
      const seen = this.packSources.get(source.feedId);
      if (seen === undefined || seen.fetchedAt.getTime() < source.fetchedAt.getTime()) {
        this.packSources.set(source.feedId, source);
      }
    }
    this.packBoardingLegCount++;
    return ride;
  }

  async fetchTransitEndpoints(
    board: GeoPoint,
    alight: GeoPoint,
    at: Date,
    options: {
      purpose: 'boarding' | 'names';
      type?: SegmentType;
      line?: string | null;
      needFrom?: boolean;
      needTo?: boolean;
      requireTimetable?: boolean;
    },
  ): Promise<{
    from: string;
    to: string;
    dep: Date | null;
    arr: Date | null;
  } | null> {
    const type = options.type ?? SegmentType.train;
    const line = options.line ?? null;
    const needFrom = options.needFrom ?? false;
    const needTo = options.needTo ?? false;
    const requireTimetable = options.requireTimetable ?? true;

    let body: JsonMap;
    try {
      body = await this.api.fetchGuidanceAt(board, alight, at, {
        allowBus: type === SegmentType.bus,
        purpose: options.purpose,
      });
    } catch (error) {
      if (!(error instanceof RouteException)) throw error;
      return null;
    }
    const direct = parseGuidancePlan(body).filter(
      (o) =>
        o.segments.filter((s) => s.type === type).length === 1 &&
        o.segments.every((s) => s.type === type || s.type === SegmentType.walk),
    );
    const comparable = requireTimetable ? comparableFrom(direct, at) : direct;
    const sameLine = comparable.filter((o) => firstOfType(o, type).line === line);
    const cands =
      line === null || line.length === 0 || sameLine.length === 0 ? comparable : sameLine;
    let leastWalk: number | null = null;
    for (const o of cands) {
      const w = walkMinutesOf(o);
      if (leastWalk === null || w < leastWalk) leastWalk = w;
    }
    const shortest = cands.filter((o) => walkMinutesOf(o) === leastWalk);
    const fillsNeeded = (o: TransitOption): boolean => {
      const leg = firstOfType(o, type);
      return (!needFrom || leg.fromName.length > 0) && (!needTo || leg.toName.length > 0);
    };
    const named = shortest.filter(fillsNeeded);
    const best = earliestArrival(named.length > 0 ? named : shortest, at);
    if (best === null) return null;
    const leg = firstOfType(best, type);
    return {
      from: leg.fromName,
      to: leg.toName,
      dep: leg.depTime,
      arr: leg.arrTime,
    };
  }

  async finalizeStationNames(chosen: RouteCandidate, departureAt: Date): Promise<RouteCandidate> {
    const segs = [...chosen.segments];
    const targets: number[] = [];
    for (let i = 0; i < segs.length; i++) {
      if (
        segs[i].type !== SegmentType.walk &&
        (segs[i].fromName.length === 0 || segs[i].toName.length === 0) &&
        segs[i].polyline.length >= 2
      ) {
        targets.push(i);
      }
    }
    const fetched = await Promise.all(
      targets.map((i) =>
        this.fetchTransitEndpoints(
          segs[i].polyline[0],
          segs[i].polyline[segs[i].polyline.length - 1],
          departureAt,
          {
            purpose: 'names',
            type: segs[i].type,
            line: segs[i].line,
            needFrom: segs[i].fromName.length === 0,
            needTo: segs[i].toName.length === 0,
            requireTimetable: false,
          },
        ),
      ),
    );
    for (let k = 0; k < targets.length; k++) {
      const names = fetched[k];
      if (names === null) continue;
      const i = targets[k];
      segs[i] = segs[i].copyWith({
        fromName: segs[i].fromName.length === 0 ? names.from : undefined,
        toName: segs[i].toName.length === 0 ? names.to : undefined,
      });
    }
    this.propagateStationNames(segs);
    return new RouteCandidate({ from: chosen.from, to: chosen.to, segments: segs });
  }

  private propagateStationNames(segs: RouteSegment[]): void {
    for (let i = 0; i < segs.length; i++) {
      if (segs[i].type === SegmentType.walk) continue;
      const board = segs[i].fromName;
      const alight = segs[i].toName;
      if (
        i > 0 &&
        segs[i - 1].type === SegmentType.walk &&
        segs[i - 1].toName.length === 0 &&
        board.length > 0
      ) {
        segs[i - 1] = segs[i - 1].copyWith({ toName: board });
      }
      if (
        i + 1 < segs.length &&
        segs[i + 1].type === SegmentType.walk &&
        segs[i + 1].fromName.length === 0 &&
        alight.length > 0
      ) {
        segs[i + 1] = segs[i + 1].copyWith({ fromName: alight });
      }
    }
  }
}

export function comparableFrom(options: TransitOption[], at: Date): TransitOption[] {
  const comparable = options.filter((o) => isComparableOption(o, at));
  if (comparable.length > 0) return comparable;
  return options.length === 0 ? options : [options[0]];
}

export function earliestArrival(options: TransitOption[], at: Date): TransitOption | null {
  let best: TransitOption | null = null;
  let bestArr = 0;
  for (const o of comparableFrom(options, at)) {
    const arr = arrivalMinutes(o.segments, at);
    if (best === null || arr < bestArr) {
      best = o;
      bestArr = arr;
    }
  }
  return best;
}

function invariantViolation(
  segments: RouteSegment[],
  budgetMin: number,
  departureAt: Date,
): { overBudget: boolean; missed: boolean; unverified: boolean } {
  return {
    overBudget: arrivalMinutes(segments, departureAt) > budgetMin,
    missed: firstMissedTransit(segments, departureAt) !== null,
    unverified: hasUnverifiedTransit(segments),
  };
}

function bestEffort(
  candidates: RouteCandidate[],
  budgetMin: number,
  departureAt: Date,
): RouteCandidate {
  const pool = reachableWithinBudget(candidates, budgetMin, departureAt) ?? candidates;
  return pool.reduce((a, b) =>
    arrivalMinutes(a.segments, departureAt) <= arrivalMinutes(b.segments, departureAt) ? a : b,
  );
}

function walkMinutesOf(o: TransitOption): number {
  return o.segments.filter((s) => s.type === SegmentType.walk).reduce((a, s) => a + s.minutes, 0);
}

function renameWalk(cached: RouteCandidate, fromName: string, toName: string): RouteCandidate {
  return new RouteCandidate({
    from: fromName,
    to: toName,
    segments: [cached.segments[0].copyWith({ fromName, toName })],
  });
}

export function isComparableOption(o: TransitOption, at: Date): boolean {
  return o.segments.every(hasUsableTimes) && firstMissedTransit(o.segments, at) === null;
}

function hasUsableTimes(s: RouteSegment): boolean {
  if (s.type === SegmentType.walk) return s.minutes >= 0;
  const dep = s.depTime;
  const arr = s.arrTime;
  return dep !== null && arr !== null && arr.getTime() >= dep.getTime();
}

function firstOfType(o: TransitOption, type: SegmentType): RouteSegment {
  const leg = o.segments.find((s) => s.type === type);
  if (leg === undefined) {
    throw new Error(`no ${type} segment in option`);
  }
  return leg;
}

function parseEncodedPolyline(polyline: unknown): GeoPoint[] {
  const encoded = isRecord(polyline) ? polyline['encodedPolyline'] : null;
  if (typeof encoded !== 'string' || encoded.length === 0) return [];
  return decodePolyline(encoded).map(([lat, lng]) => new GeoPoint(lat, lng));
}

function clock(d: Date): string {
  return d.toTimeString().slice(0, 5);
}
