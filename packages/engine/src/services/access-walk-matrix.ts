import { dartRound } from '../dart-number';
import { isRecord } from '../json';
import type { GeoPoint } from '../models/geo-point';

export const maxWalkMatrixElements = 25;

export function walkCacheKey(origin: GeoPoint, dest: GeoPoint): string {
  return (
    `${origin.lat.toFixed(5)},${origin.lng.toFixed(5)}` +
    `|${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}`
  );
}

export interface AccessWalkDemand {
  readonly boardStops: readonly GeoPoint[];
  readonly alightStops: readonly GeoPoint[];
}

export interface WalkMatrixRequest {
  readonly origins: readonly GeoPoint[];
  readonly dests: readonly GeoPoint[];
}

export interface AccessWalkMatrixPlan {
  readonly requests: readonly WalkMatrixRequest[];
  readonly requestedLegs: number;
  readonly uniqueLegs: number;
}

export function planAccessWalkMatrix(
  origin: GeoPoint,
  goal: GeoPoint,
  demands: readonly AccessWalkDemand[],
  isMeasured: (key: string) => boolean,
  maxElements: number = maxWalkMatrixElements,
): AccessWalkMatrixPlan {
  const boardDests = new Map<string, GeoPoint>();
  const alightOrigins = new Map<string, GeoPoint>();
  let requestedLegs = 0;
  for (const d of demands) {
    for (const s of d.boardStops) {
      const key = walkCacheKey(origin, s);
      if (!boardDests.has(key)) boardDests.set(key, s);
    }
    for (const s of d.alightStops) {
      const key = walkCacheKey(s, goal);
      if (!alightOrigins.has(key)) alightOrigins.set(key, s);
    }
    requestedLegs += d.boardStops.length + 1 + d.alightStops.length;
  }
  const allWalkKey = walkCacheKey(origin, goal);
  if (!boardDests.has(allWalkKey)) boardDests.set(allWalkKey, goal);
  if (demands.length === 0) requestedLegs = 1;

  const pending = (legs: Map<string, GeoPoint>): GeoPoint[] =>
    [...legs].filter(([key]) => !isMeasured(key)).map(([, p]) => p);
  const chunk = (ps: GeoPoint[]): GeoPoint[][] => {
    const out: GeoPoint[][] = [];
    for (let i = 0; i < ps.length; i += maxElements) {
      out.push(ps.slice(i, i + maxElements));
    }
    return out;
  };
  return {
    requests: [
      ...chunk(pending(boardDests)).map((dests) => ({ origins: [origin], dests })),
      ...chunk(pending(alightOrigins)).map((origins) => ({ origins, dests: [goal] })),
    ],
    requestedLegs,
    uniqueLegs: boardDests.size + alightOrigins.size,
  };
}

export function applyWalkMatrixRows(
  request: WalkMatrixRequest,
  rows: readonly unknown[] | null,
  measured: Map<string, number>,
): void {
  if (rows === null) return;
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const oi = indexOrZero(row['originIndex']);
    const di = indexOrZero(row['destinationIndex']);
    const min = parseDurationMin(row['duration']);
    if (min === null) continue;
    if (oi < 0 || oi >= request.origins.length) continue;
    if (di < 0 || di >= request.dests.length) continue;
    measured.set(walkCacheKey(request.origins[oi], request.dests[di]), min);
  }
}

export function parseDurationMin(duration: unknown): number | null {
  if (typeof duration !== 'string') return null;
  const digits = duration.replaceAll('s', '');
  if (!/^[+-]?\d+$/.test(digits)) return null;
  return dartRound(Number.parseInt(digits, 10) / 60);
}

function indexOrZero(value: unknown): number {
  return typeof value === 'number' ? Math.trunc(value) : 0;
}
