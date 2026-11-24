import { isRecord, type JsonMap } from '../json';
import type { TimetableSource } from '../models/route-plan';
import { timetableSources } from './exact-walk-candidates';

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
  if (typeof boardAt !== 'string' || typeof alightAt !== 'string') return null;
  const dep = new Date(boardAt);
  const arr = new Date(alightAt);
  if (Number.isNaN(dep.getTime()) || Number.isNaN(arr.getTime())) return null;
  if (arr.getTime() < dep.getTime()) return null;
  return { ride: { from, to, dep, arr }, sources: timetableSources(body) };
}
