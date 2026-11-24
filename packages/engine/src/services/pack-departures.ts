import { isRecord, type JsonMap } from '../json';
import type { TimetableSource } from '../models/route-plan';
import { jstWallClock, timetableSources } from './exact-walk-candidates';

export interface PackRide {
  readonly from: string;
  readonly to: string;
  readonly dep: Date;
  readonly arr: Date;
}

export interface PackRideAnswer {
  readonly ride: PackRide | null;
  readonly sources: TimetableSource[];
}

export function parsePackRide(body: JsonMap): PackRideAnswer | null {
  if (!('ride' in body)) return null;
  const raw = body['ride'];
  if (raw === null) return { ride: null, sources: timetableSources(body) };
  if (!isRecord(raw)) return null;
  const { from, to, boardAt, alightAt } = raw;
  if (typeof from !== 'string' || typeof to !== 'string') return null;
  const dep = jstWallClock(boardAt);
  const arr = jstWallClock(alightAt);
  if (dep === null || arr === null) return null;
  if (arr.getTime() < dep.getTime()) return null;
  return { ride: { from, to, dep, arr }, sources: timetableSources(body) };
}
