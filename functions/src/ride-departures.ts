import type { CompiledTimetable, LatLng, TimetableStop } from './exact-scan';
import {
  formatJst,
  isDepartAtInRange,
  parseInstant,
  parsePoint,
  serviceMidnightMs,
  toServiceTime,
  type FeedFetchedAt,
} from './exact-walk-max';

export const RIDE_LOOKAHEAD_MIN = 120;
const NAMED_STOP_RADIUS_M = 1000;
const UNNAMED_STOP_RADIUS_M = 300;
const MAX_TEXT_LENGTH = 64;
const EARTH_RADIUS_M = 6371008.8;

export interface RideDepartureRequest {
  at: Date;
  board: LatLng;
  alight: LatLng;
  boardName: string;
  alightName: string;
  line: string;
}

export interface RideDeparturesDay {
  compiled: CompiledTimetable;
  stops: readonly TimetableStop[];
  feeds: readonly FeedFetchedAt[];
}

export interface RideDeparturesDeps {
  day: (serviceDate: string) => Promise<RideDeparturesDay | null>;
}

export interface RideDeparture {
  route: string;
  headsign: string | null;
  from: string;
  to: string;
  boardAt: string;
  alightAt: string;
}

export interface RideDepartureResponse {
  ride: RideDeparture | null;
  feeds: FeedFetchedAt[];
}

type Query = Record<string, unknown>;

export function parseRideDepartureQuery(
  query: Query,
  now: Date,
): RideDepartureRequest | { error: string } {
  const param = (name: string): string | undefined => {
    const v = query[name];
    return typeof v === 'string' ? v : undefined;
  };
  const at = parseInstant(param('at'));
  if (at === null) return { error: 'at is required as ISO 8601 with a UTC offset' };
  if (!isDepartAtInRange(at, now)) {
    return { error: 'at must be within 1 day before to 92 days after now' };
  }
  const board = parsePoint(param('board'));
  const alight = parsePoint(param('alight'));
  if (board === null || alight === null) {
    return { error: "board and alight are required as 'lat,lng'" };
  }
  const line = param('line') ?? '';
  const boardName = param('boardName') ?? '';
  const alightName = param('alightName') ?? '';
  if (line.trim() === '' || line.length > MAX_TEXT_LENGTH) {
    return { error: `line is required and must be at most ${MAX_TEXT_LENGTH} characters` };
  }
  if (boardName.length > MAX_TEXT_LENGTH || alightName.length > MAX_TEXT_LENGTH) {
    return { error: `station names must be at most ${MAX_TEXT_LENGTH} characters` };
  }
  return { at, board, alight, boardName, alightName, line };
}

export async function findRideDeparture(
  req: RideDepartureRequest,
  deps: RideDeparturesDeps,
): Promise<RideDepartureResponse | null> {
  const { serviceDate, sec } = toServiceTime(req.at);
  const day = await deps.day(serviceDate);
  if (day === null) return null;
  const feeds = day.feeds.map(({ id, fetchedAt }) => ({ id, fetchedAt }));
  const ct = day.compiled;
  const untilSec = sec + RIDE_LOOKAHEAD_MIN * 60;
  const boards = stopsFor(day, req.board, req.boardName);
  const alights = new Set(stopsFor(day, req.alight, req.alightName));

  let best: { trip: number; board: number; alight: number; dep: number; arr: number } | null = null;
  for (const board of boards) {
    for (let i = ct.departureStart[board]; i < ct.departureStart[board + 1]; i++) {
      const dep = ct.departureAt[i];
      if (dep < sec) continue;
      if (dep > untilSec) break;
      const trip = ct.departureTrip[i];
      if (!isSameLine(ct.trips[trip].route, req.line)) continue;
      const start = ct.tripStart[trip];
      const end = start + ct.tripLength[trip];
      for (let c = start + ct.departurePos[i] + 1; c < end; c++) {
        if (ct.callAlight[c] !== 1 || !alights.has(ct.callStop[c])) continue;
        const arr = ct.callArr[c];
        if (best === null || arr < best.arr || (arr === best.arr && dep < best.dep)) {
          best = { trip, board, alight: ct.callStop[c], dep, arr };
        }
        break;
      }
    }
  }
  if (best === null || best.arr > untilSec) return { ride: null, feeds };

  const midnight = serviceMidnightMs(serviceDate);
  return {
    ride: {
      route: ct.trips[best.trip].route,
      headsign: ct.trips[best.trip].headsign,
      from: day.stops[best.board].name,
      to: day.stops[best.alight].name,
      boardAt: formatJst(midnight + best.dep * 1000),
      alightAt: formatJst(midnight + best.arr * 1000),
    },
    feeds,
  };
}

function stopsFor(day: RideDeparturesDay, p: LatLng, name: string): number[] {
  const ct = day.compiled;
  const wanted = normalizeStationName(name);
  const radius = wanted === '' ? UNNAMED_STOP_RADIUS_M : NAMED_STOP_RADIUS_M;
  const out: number[] = [];
  for (let s = 0; s < ct.stopCount; s++) {
    if (metersBetween(p, ct.stopLat[s], ct.stopLng[s]) > radius) continue;
    if (wanted !== '' && normalizeStationName(day.stops[s].name) !== wanted) continue;
    out.push(s);
  }
  return out;
}

function normalizeStationName(name: string): string {
  return name
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s/g, '')
    .replace(/駅$/, '');
}

function isSameLine(route: string, line: string): boolean {
  const a = route.replace(/\s/g, '');
  const b = line.replace(/\s/g, '');
  if (a === '' || b === '') return false;
  return a === b || b.endsWith(a) || a.endsWith(b);
}

function metersBetween(p: LatLng, lat: number, lng: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat - p.lat) * toRad;
  const dLng = (lng - p.lng) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(p.lat * toRad) * Math.cos(lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
