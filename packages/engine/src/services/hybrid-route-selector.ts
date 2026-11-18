import { dartRound } from '../dart-number';
import type { GeoPoint } from '../models/geo-point';
import { SegmentType, type RouteSegment } from '../models/route-plan';
import {
  arrivalMinutes,
  firstMissedTransit,
  maxBoardingWait,
  walkMetersPerMinute,
} from './route-plan-builder';

export interface RouteCandidateInit {
  from: string;
  to: string;
  segments: RouteSegment[];
}

export class RouteCandidate {
  constructor(init: RouteCandidateInit) {
    this.from = init.from;
    this.to = init.to;
    this.segments = init.segments;
  }

  readonly from: string;
  readonly to: string;
  readonly segments: RouteSegment[];

  get totalMin(): number {
    return this.segments.reduce((a, s) => a + s.minutes, 0);
  }

  get walkMinutes(): number {
    return this.segments
      .filter((s) => s.type === SegmentType.walk)
      .reduce((a, s) => a + s.minutes, 0);
  }

  get transferCount(): number {
    const transitSegmentCount = this.segments.filter((s) => s.type !== SegmentType.walk).length;
    return transitSegmentCount === 0 ? 0 : transitSegmentCount - 1;
  }

  get totalKm(): number {
    return this.segments.reduce((a, s) => a + (s.km ?? 0), 0);
  }

  get walkKm(): number {
    return this.segments
      .filter((s) => s.type === SegmentType.walk)
      .reduce((a, s) => a + (s.km ?? 0), 0);
  }
}

export interface SelectBestRouteArgs {
  candidates: RouteCandidate[];
  budgetMin: number;
  origin?: GeoPoint | null;
  goal?: GeoPoint | null;
  departureAt?: Date | null;
  maxBacktrackRatio?: number;
}

export function selectBestRoute(args: SelectBestRouteArgs): RouteCandidate {
  const { candidates, budgetMin } = args;
  const origin = args.origin ?? null;
  const goal = args.goal ?? null;
  const departureAt = args.departureAt ?? null;
  const maxBacktrackRatio = args.maxBacktrackRatio ?? defaultMaxBacktrackRatio;

  if (candidates.length === 0) {
    throw new Error('candidates must not be empty');
  }

  const pool = forwardCandidates(candidates, origin, goal, {
    maxBacktrackRatio,
  });

  const arrival = (c: RouteCandidate): number =>
    departureAt === null ? c.totalMin : arrivalMinutes(c.segments, departureAt);

  const within = pool.filter((c) => arrival(c) <= budgetMin);
  if (within.length > 0) {
    return within.reduce((a, b) => {
      if (a.walkMinutes !== b.walkMinutes) {
        return a.walkMinutes > b.walkMinutes ? a : b;
      }
      const arrivalA = arrival(a);
      const arrivalB = arrival(b);
      if (arrivalA !== arrivalB) return arrivalA < arrivalB ? a : b;
      return a.transferCount <= b.transferCount ? a : b;
    });
  }
  const fallback =
    departureAt === null ? pool : (reachableWithinBudget(pool, budgetMin, departureAt) ?? pool);
  return fallback.reduce((a, b) => {
    const arrivalA = arrival(a);
    const arrivalB = arrival(b);
    if (arrivalA !== arrivalB) return arrivalA < arrivalB ? a : b;
    return a.transferCount <= b.transferCount ? a : b;
  });
}

const defaultMaxBacktrackRatio = 0.15;

export function reachableWithinBudget(
  candidates: RouteCandidate[],
  budgetMin: number,
  departureAt: Date,
): RouteCandidate[] | null {
  const reachable = candidates.filter(
    (c) =>
      maxBoardingWait(c.segments, departureAt) <= budgetMin &&
      firstMissedTransit(c.segments, departureAt) === null,
  );
  return reachable.length === 0 ? null : reachable;
}

export function forwardCandidates(
  candidates: RouteCandidate[],
  origin: GeoPoint | null,
  goal: GeoPoint | null,
  options: { maxBacktrackRatio?: number } = {},
): RouteCandidate[] {
  if (origin === null || goal === null) return candidates;
  const maxBacktrackRatio = options.maxBacktrackRatio ?? defaultMaxBacktrackRatio;
  const forward = candidates.filter((c) => !isBacktrackDetour(c, origin, goal, maxBacktrackRatio));
  return forward.length > 0 ? forward : candidates;
}

function isBacktrackDetour(
  c: RouteCandidate,
  origin: GeoPoint,
  goal: GeoPoint,
  maxBacktrackRatio: number,
): boolean {
  const dog = haversineKm(origin, goal);
  if (dog === 0) return false;
  const limit = -maxBacktrackRatio * dog;
  for (const seg of c.segments) {
    switch (seg.type) {
      case SegmentType.walk:
        continue;
      case SegmentType.train:
      case SegmentType.bus:
        for (const p of evenSample(seg.polyline, maxBacktrackSamplesPerLeg)) {
          if (advanceKm(origin, goal, dog, p) < limit) return true;
        }
    }
  }
  return false;
}

const maxBacktrackSamplesPerLeg = 32;

function advanceKm(origin: GeoPoint, goal: GeoPoint, dog: number, p: GeoPoint): number {
  const dop = haversineKm(origin, p);
  const dpg = haversineKm(p, goal);
  return (dop * dop + dog * dog - dpg * dpg) / (2 * dog);
}

export interface MeasureShortlistArgs {
  candidates: RouteCandidate[];
  budgetMin: number;
  departureAt: Date;
  origin?: GeoPoint | null;
  goal?: GeoPoint | null;
}

export function measureShortlist(args: MeasureShortlistArgs): RouteCandidate[] {
  const { candidates, budgetMin, departureAt } = args;
  const forward = forwardCandidates(candidates, args.origin ?? null, args.goal ?? null);
  return forward
    .filter((c) => arrivalMinutes(c.segments, departureAt) <= budgetMin)
    .sort((a, b) => {
      if (a.walkMinutes !== b.walkMinutes) {
        return b.walkMinutes - a.walkMinutes;
      }
      const aa = arrivalMinutes(a.segments, departureAt);
      const ab = arrivalMinutes(b.segments, departureAt);
      if (aa !== ab) return aa - ab;
      return a.transferCount - b.transferCount;
    });
}

export interface PrewarmFrontArgs {
  shortlist: RouteCandidate[];
  chosen: RouteCandidate;
  hybrids: Set<RouteCandidate>;
  singlePassHybridThreshold: number;
  maxMeasureShortlist: number;
  allowSinglePass?: boolean;
}

export interface PrewarmFront {
  prewarm: RouteCandidate[];
  singlePass: boolean;
}

export function prewarmFront(args: PrewarmFrontArgs): PrewarmFront {
  const { shortlist, chosen, hybrids } = args;
  const allowSinglePass = args.allowSinglePass ?? true;
  const inBudgetHybrids = shortlist.filter((c) => hybrids.has(c)).length;
  if (allowSinglePass && inBudgetHybrids >= args.singlePassHybridThreshold) {
    const cap = Math.min(shortlist.length, args.maxMeasureShortlist);
    return { prewarm: shortlist.slice(0, cap), singlePass: true };
  }
  return { prewarm: [chosen], singlePass: false };
}

export interface MaxWalkBoardingIndexParallelArgs {
  count: number;
  budgetMin: number;

  evaluate: (index: number) => Promise<number | null>;
  fanout?: number;
  shouldContinue?: () => boolean;
  onRound?: () => void;
}

export async function maxWalkBoardingIndexParallel(
  args: MaxWalkBoardingIndexParallelArgs,
): Promise<number | null> {
  const { count, budgetMin, evaluate } = args;
  const fanout = args.fanout ?? 3;
  let lo = 0;
  let hi = count - 1;
  let best: number | null = null;
  while (lo <= hi) {
    if (args.shouldContinue !== undefined && !args.shouldContinue()) break;
    args.onRound?.();
    const span = hi - lo;
    const probes =
      span < fanout
        ? range(lo, hi)
        : [
            ...new Set(
              Array.from(
                { length: fanout },
                (_, j) => lo + Math.trunc((span * (j + 1)) / (fanout + 1)),
              ),
            ),
          ].sort((a, b) => a - b);
    const results = await Promise.all(probes.map((p) => evaluate(p)));
    let nextLo = lo;
    let nextHi = hi;
    let evaluated = false;
    for (let j = 0; j < probes.length; j++) {
      const arrival = results[j];
      if (arrival === null) continue;
      evaluated = true;
      if (arrival <= budgetMin) {
        if (best === null || probes[j] > best) best = probes[j];
        nextLo = probes[j] + 1;
      } else {
        nextHi = probes[j] - 1;
        break;
      }
    }
    if (!evaluated) break;
    lo = nextLo;
    hi = nextHi;
  }
  return best;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

export function walkFeasiblePrefixCount(walk1Min: number[], budgetMin: number): number {
  let last = -1;
  for (let i = 0; i < walk1Min.length; i++) {
    if (walk1Min[i] <= budgetMin) last = i;
  }
  return last + 1;
}

export function evenSample<T>(items: T[], maxCount: number): T[] {
  if (items.length <= maxCount || maxCount < 2) return items;
  return Array.from(
    { length: maxCount },
    (_, k) => items[dartRound((k * (items.length - 1)) / (maxCount - 1))],
  );
}

export interface FrontierStations {
  boarding: number[];
  alighting: number[];
}

export function frontierStations(
  stops: GeoPoint[],
  origin: GeoPoint,
  goal: GeoPoint,
  budgetMin: number,
  options: { maxPerSide?: number } = {},
): FrontierStations {
  const maxPerSide = options.maxPerSide ?? 10;

  const pick = (sideWalk: (i: number) => number): number[] => {
    const feasible = stops.map((_, i) => i).filter((i) => sideWalk(i) <= budgetMin);
    if (feasible.length <= maxPerSide || maxPerSide < 2) {
      return feasible.slice(0, Math.max(maxPerSide, 0));
    }
    return [...new Set(evenSample(feasible, maxPerSide))];
  };

  return {
    boarding: pick((i) => straightWalkMinutes(origin, stops[i])),
    alighting: pick((i) => straightWalkMinutes(stops[i], goal)),
  };
}

function straightWalkMinutes(a: GeoPoint, b: GeoPoint): number {
  return dartRound((haversineKm(a, b) * 1000) / walkMetersPerMinute);
}

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(h)));
}

const earthRadiusKm = 6371.0088;

const toRad = (deg: number): number => (deg * Math.PI) / 180;
