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
const STOP_RADIUS_M = 1000;
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
  const onLine = (trip: number) => isSameLine(ct.trips[trip].route, req.line);
  const boards = boardStops(day, req.board, req.boardName, sec, untilSec, onLine);
  const alightName = normalizeStationName(req.alightName);
  const alightOk = (stop: number): number | null => {
    const meters = metersBetween(req.alight, ct.stopLat[stop], ct.stopLng[stop]);
    if (meters > STOP_RADIUS_M) return null;
    if (alightName !== '' && normalizeStationName(day.stops[stop].name) !== alightName) return null;
    return meters;
  };

  let best: { trip: number; board: number; alight: number; dep: number; arr: number } | null = null;
  for (const board of boards) {
    for (let i = ct.departureStart[board]; i < ct.departureStart[board + 1]; i++) {
      const dep = ct.departureAt[i];
      if (dep < sec) continue;
      if (dep > untilSec) break;
      const trip = ct.departureTrip[i];
      if (!onLine(trip)) continue;
      const start = ct.tripStart[trip];
      const end = start + ct.tripLength[trip];
      let alight: { stop: number; arr: number; meters: number } | null = null;
      for (let c = start + ct.departurePos[i] + 1; c < end; c++) {
        if (ct.callAlight[c] !== 1) continue;
        const meters = alightOk(ct.callStop[c]);
        if (meters === null) continue;
        if (alight === null || meters < alight.meters) {
          alight = { stop: ct.callStop[c], arr: ct.callArr[c], meters };
        }
        if (alightName !== '') break;
      }
      if (alight === null) continue;
      const arr = alight.arr;
      if (best === null || arr < best.arr || (arr === best.arr && dep < best.dep)) {
        best = { trip, board, alight: alight.stop, dep, arr };
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

function boardStops(
  day: RideDeparturesDay,
  p: LatLng,
  name: string,
  sec: number,
  untilSec: number,
  onLine: (trip: number) => boolean,
): number[] {
  const ct = day.compiled;
  const wanted = normalizeStationName(name);
  const near: { stop: number; meters: number }[] = [];
  for (let s = 0; s < ct.stopCount; s++) {
    const meters = metersBetween(p, ct.stopLat[s], ct.stopLng[s]);
    if (meters > STOP_RADIUS_M) continue;
    if (wanted !== '' && normalizeStationName(day.stops[s].name) !== wanted) continue;
    near.push({ stop: s, meters });
  }
  if (wanted !== '') return near.map((n) => n.stop);
  const served = near.filter(({ stop }) => {
    for (let i = ct.departureStart[stop]; i < ct.departureStart[stop + 1]; i++) {
      if (ct.departureAt[i] > untilSec) break;
      if (ct.departureAt[i] >= sec && onLine(ct.departureTrip[i])) return true;
    }
    return false;
  });
  if (served.length === 0) return [];
  served.sort((a, b) => a.meters - b.meters);
  const nearestName = normalizeStationName(day.stops[served[0].stop].name);
  return served
    .filter(({ stop }) => normalizeStationName(day.stops[stop].name) === nearestName)
    .map(({ stop }) => stop);
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
