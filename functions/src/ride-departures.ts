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

export const RIDE_DEPARTURES_MAX_LEGS = 8;
export const RIDE_DEPARTURES_MAX_PER_LEG = 40;
const MAX_UNTIL_MIN = 24 * 60;
const STOP_MATCH_RADIUS_M = 300;
const EARTH_RADIUS_M = 6371008.8;

export interface RideLeg {
  board: LatLng;
  alight: LatLng;
  fromMin: number;
}

export interface RideDeparturesRequest {
  departAt: Date;
  untilMin: number;
  legs: RideLeg[];
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

export interface RideLegDepartures {
  departures: RideDeparture[];
  truncated: boolean;
}

export interface RideDeparturesResponse {
  legs: RideLegDepartures[];
  feeds: FeedFetchedAt[];
}

type Query = Record<string, unknown>;

export function parseRideDeparturesQuery(
  query: Query,
  now: Date,
): RideDeparturesRequest | { error: string } {
  const param = (name: string): string | undefined => {
    const v = query[name];
    return typeof v === 'string' ? v : undefined;
  };
  const departAt = parseInstant(param('departAt'));
  if (departAt === null) {
    return { error: 'departAt is required as ISO 8601 with a UTC offset' };
  }
  if (!isDepartAtInRange(departAt, now)) {
    return { error: 'departAt must be within 1 day before to 92 days after now' };
  }
  const untilMin = Number(param('untilMin'));
  if (!Number.isInteger(untilMin) || untilMin < 1 || untilMin > MAX_UNTIL_MIN) {
    return { error: `untilMin must be an integer in 1..${MAX_UNTIL_MIN}` };
  }
  const raw = param('legs') ?? '';
  const parts = raw === '' ? [] : raw.split(';');
  if (parts.length === 0 || parts.length > RIDE_DEPARTURES_MAX_LEGS) {
    return { error: `legs must have 1..${RIDE_DEPARTURES_MAX_LEGS} entries` };
  }
  const legs: RideLeg[] = [];
  for (const part of parts) {
    const leg = parseLeg(part, untilMin);
    if (leg === null) {
      return { error: "each leg must be 'boardLat,boardLng,alightLat,alightLng,fromMin'" };
    }
    legs.push(leg);
  }
  return { departAt, untilMin, legs };
}

function parseLeg(part: string, untilMin: number): RideLeg | null {
  const values = part.split(',');
  if (values.length !== 5) return null;
  const board = parsePoint(`${values[0]},${values[1]}`);
  const alight = parsePoint(`${values[2]},${values[3]}`);
  const fromMin = Number(values[4]);
  if (board === null || alight === null) return null;
  if (values[4].trim() === '' || !Number.isInteger(fromMin)) return null;
  if (fromMin < 0 || fromMin > untilMin) return null;
  return { board, alight, fromMin };
}

export async function findRideDepartures(
  req: RideDeparturesRequest,
  deps: RideDeparturesDeps,
): Promise<RideDeparturesResponse | null> {
  const { serviceDate, sec } = toServiceTime(req.departAt);
  const day = await deps.day(serviceDate);
  if (day === null) return null;
  const midnight = serviceMidnightMs(serviceDate);
  const untilSec = sec + req.untilMin * 60;
  const legs = req.legs.map((leg) =>
    legDepartures(day, leg, sec + leg.fromMin * 60, untilSec, midnight),
  );
  return { legs, feeds: day.feeds.map(({ id, fetchedAt }) => ({ id, fetchedAt })) };
}

function legDepartures(
  day: RideDeparturesDay,
  leg: RideLeg,
  fromSec: number,
  untilSec: number,
  midnight: number,
): RideLegDepartures {
  const ct = day.compiled;
  const boards = stopsNear(ct, leg.board);
  const alights = new Set(stopsNear(ct, leg.alight));
  const found: {
    boardAt: number;
    alightAt: number;
    trip: number;
    board: number;
    alight: number;
  }[] = [];
  for (const board of boards) {
    for (let i = ct.departureStart[board]; i < ct.departureStart[board + 1]; i++) {
      const boardAt = ct.departureAt[i];
      if (boardAt < fromSec) continue;
      if (boardAt > untilSec) break;
      const trip = ct.departureTrip[i];
      const start = ct.tripStart[trip];
      const end = start + ct.tripLength[trip];
      for (let c = start + ct.departurePos[i] + 1; c < end; c++) {
        if (ct.callAlight[c] === 1 && alights.has(ct.callStop[c])) {
          found.push({ boardAt, alightAt: ct.callArr[c], trip, board, alight: ct.callStop[c] });
          break;
        }
      }
    }
  }
  found.sort((a, b) => a.boardAt - b.boardAt || a.alightAt - b.alightAt || a.trip - b.trip);
  return {
    departures: found.slice(0, RIDE_DEPARTURES_MAX_PER_LEG).map((f) => ({
      route: ct.trips[f.trip].route,
      headsign: ct.trips[f.trip].headsign,
      from: day.stops[f.board].name,
      to: day.stops[f.alight].name,
      boardAt: formatJst(midnight + f.boardAt * 1000),
      alightAt: formatJst(midnight + f.alightAt * 1000),
    })),
    truncated: found.length > RIDE_DEPARTURES_MAX_PER_LEG,
  };
}

function stopsNear(ct: CompiledTimetable, p: LatLng): number[] {
  const out: number[] = [];
  for (let s = 0; s < ct.stopCount; s++) {
    if (metersBetween(p, ct.stopLat[s], ct.stopLng[s]) <= STOP_MATCH_RADIUS_M) out.push(s);
  }
  return out;
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
