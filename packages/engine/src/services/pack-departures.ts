import { isRecord, type JsonMap } from '../json';

export interface PackDeparture {
  readonly route: string;
  readonly from: string;
  readonly to: string;
  readonly dep: Date;
  readonly arr: Date;
}

export interface PackLeg {
  readonly departures: readonly PackDeparture[];
  readonly truncated: boolean;
}

export function parsePackLegs(body: JsonMap, count: number): PackLeg[] | null {
  const legs = body['legs'];
  if (!Array.isArray(legs) || legs.length !== count) return null;
  const out: PackLeg[] = [];
  for (const leg of legs) {
    if (!isRecord(leg) || !Array.isArray(leg['departures'])) return null;
    const departures: PackDeparture[] = [];
    for (const d of leg['departures']) {
      const parsed = parseDeparture(d);
      if (parsed === null) return null;
      departures.push(parsed);
    }
    out.push({ departures, truncated: leg['truncated'] === true });
  }
  return out;
}

function parseDeparture(d: unknown): PackDeparture | null {
  if (!isRecord(d)) return null;
  const { route, from, to, boardAt, alightAt } = d;
  if (typeof route !== 'string' || typeof from !== 'string' || typeof to !== 'string') return null;
  if (typeof boardAt !== 'string' || typeof alightAt !== 'string') return null;
  const dep = new Date(boardAt);
  const arr = new Date(alightAt);
  if (Number.isNaN(dep.getTime()) || Number.isNaN(arr.getTime())) return null;
  if (arr.getTime() < dep.getTime()) return null;
  return { route, from, to, dep, arr };
}

export function pickPackDeparture(
  leg: PackLeg,
  boardAt: Date,
  line: string | null,
): PackDeparture | null {
  let best: PackDeparture | null = null;
  for (const d of leg.departures) {
    if (d.dep.getTime() < boardAt.getTime() || !isSameLine(d.route, line)) continue;
    if (
      best === null ||
      d.arr.getTime() < best.arr.getTime() ||
      (d.arr.getTime() === best.arr.getTime() && d.dep.getTime() < best.dep.getTime())
    ) {
      best = d;
    }
  }
  if (best === null || !leg.truncated) return best;
  const last = leg.departures[leg.departures.length - 1];
  return best.arr.getTime() <= last.dep.getTime() ? best : null;
}

function isSameLine(route: string, line: string | null): boolean {
  if (line === null || line.trim() === '') return true;
  const a = route.replace(/\s/g, '');
  const b = line.replace(/\s/g, '');
  if (a === '') return false;
  return a.includes(b) || b.includes(a);
}
