import {
  bestJourneys,
  bestRides,
  pickStopsToMeasure,
  WALK_METERS_PER_MINUTE,
  type CompiledTimetable,
  type JourneyLeg,
  type LatLng,
  type TimetableStop,
  type TransferNeighbors,
} from './exact-scan';

const MAX_STOPS_PER_SIDE = 12;
export const EXACT_WALK_MAX_ELEMENTS = MAX_STOPS_PER_SIDE * 2;
const MAX_CANDIDATES = 5;
const MAX_BUDGET_MIN = 24 * 60;

const DAY_MS = 24 * 3600 * 1000;
const DEPART_AT_MAX_AHEAD_MS = 92 * DAY_MS;
const DEPART_AT_MAX_BEHIND_MS = DAY_MS;

const JST_OFFSET_MS = 9 * 3600 * 1000;

export interface ExactWalkMaxRequest {
  origin: LatLng;
  goal: LatLng;
  departAt: Date;
  budgetMin: number;
  transfers: boolean;
}

export interface MatrixElement {
  originIndex: number;
  destinationIndex: number;
  durationSec: number;
  distanceMeters: number;
}

export interface ScanDay {
  compiled: CompiledTimetable;
  neighbors: TransferNeighbors;
  stops: readonly TimetableStop[];
  feeds: readonly FeedFetchedAt[];
}

export interface FeedFetchedAt {
  id: string;
  fetchedAt: string;
}

export interface ExactWalkMaxDeps {
  day: (serviceDate: string) => Promise<ScanDay | null>;
  measure: (origins: LatLng[], destinations: LatLng[]) => Promise<MatrixElement[]>;
  timed?: <T>(stage: ScanStage, run: () => T) => T;
}

export type ScanStage = 'pick' | 'rides' | 'journeys';

export interface Walk {
  durationSec: number;
  distanceMeters: number;
}

export interface ExactWalkRide {
  board: TimetableStop;
  alight: TimetableStop;
  route: string;
  headsign: string | null;
  boardAt: string;
  alightAt: string;
  stops: LatLng[];
}

export interface ExactWalkCandidate extends ExactWalkRide {
  accessWalk: Walk;
  egressWalk: Walk;
}

export interface ExactWalkTransferCandidate {
  legs: ExactWalkRide[];
  accessWalk: Walk;
  transferWalk: Walk;
  sameStation: boolean;
  egressWalk: Walk;
}

export interface ExactWalkMaxResponse {
  candidates: ExactWalkCandidate[];
  transferCandidates?: ExactWalkTransferCandidate[];
  feeds: FeedFetchedAt[];
  stats: {
    tripsScanned: number;
    elementsMeasured: number;
    truncated: boolean;
  };
}

type Query = Record<string, unknown>;

export function parseExactWalkMaxQuery(
  query: Query,
  now: Date,
): ExactWalkMaxRequest | { error: string } {
  const param = (name: string): string | undefined => {
    const v = query[name];
    return typeof v === 'string' ? v : undefined;
  };
  const origin = parsePoint(param('origin'));
  const goal = parsePoint(param('goal'));
  if (origin === null || goal === null) {
    return { error: "origin and goal are required as 'lat,lng'" };
  }
  const departAt = parseInstant(param('departAt'));
  if (departAt === null) {
    return { error: 'departAt is required as ISO 8601 with a UTC offset' };
  }
  const ahead = departAt.getTime() - now.getTime();
  if (ahead < -DEPART_AT_MAX_BEHIND_MS || ahead > DEPART_AT_MAX_AHEAD_MS) {
    return { error: 'departAt must be within 1 day before to 92 days after now' };
  }
  const budgetMin = Number(param('budgetMin'));
  if (!Number.isInteger(budgetMin) || budgetMin < 1 || budgetMin > MAX_BUDGET_MIN) {
    return { error: `budgetMin must be an integer in 1..${MAX_BUDGET_MIN}` };
  }
  const transfers = parseFlag(query['transfers']);
  if (transfers === null) {
    return { error: 'transfers must be 0 or 1' };
  }
  return { origin, goal, departAt, budgetMin, transfers };
}

function parseFlag(value: unknown): boolean | null {
  if (value === undefined || value === '0') return false;
  if (value === '1') return true;
  return null;
}

function parsePoint(value: string | undefined): LatLng | null {
  const parts = (value ?? '').split(',');
  if (parts.length !== 2 || parts.some((p) => p.trim() === '')) return null;
  const [lat, lng] = parts.map(Number);
  if (!(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) return null;
  return { lat, lng };
}

function parseInstant(value: string | undefined): Date | null {
  if (value === undefined || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

export function toServiceTime(at: Date): { serviceDate: string; sec: number } {
  const jst = new Date(at.getTime() + JST_OFFSET_MS);
  const serviceDate =
    String(jst.getUTCFullYear()) + pad2(jst.getUTCMonth() + 1) + pad2(jst.getUTCDate());
  const sec = jst.getUTCHours() * 3600 + jst.getUTCMinutes() * 60 + jst.getUTCSeconds();
  return { serviceDate, sec };
}

export async function findExactWalkMax(
  req: ExactWalkMaxRequest,
  deps: ExactWalkMaxDeps,
): Promise<ExactWalkMaxResponse | null> {
  const { serviceDate, sec } = toServiceTime(req.departAt);
  const day = await deps.day(serviceDate);
  if (day === null) return null;
  const { compiled: ct, neighbors } = day;
  const q = { origin: req.origin, goal: req.goal, departAt: sec, budgetMin: req.budgetMin };
  const timed = deps.timed ?? ((_stage, run) => run());

  const picked = timed('pick', () =>
    pickStopsToMeasure(ct, q, { maxPerSide: MAX_STOPS_PER_SIDE, neighbors }),
  );
  const stats = {
    tripsScanned: picked.tripsScanned,
    elementsMeasured: picked.boards.length + picked.alights.length,
    truncated: picked.truncated,
  };
  const feeds = day.feeds.map(({ id, fetchedAt }) => ({ id, fetchedAt }));
  if (picked.boards.length === 0 || picked.alights.length === 0) {
    return {
      candidates: [],
      ...(req.transfers ? { transferCandidates: [] } : {}),
      feeds,
      stats: { ...stats, elementsMeasured: 0 },
    };
  }

  const coordOf = (s: number): LatLng => ({ lat: ct.stopLat[s], lng: ct.stopLng[s] });
  const [accessRows, egressRows] = await Promise.all([
    deps.measure([req.origin], picked.boards.map(coordOf)),
    deps.measure(picked.alights.map(coordOf), [req.goal]),
  ]);
  const access = walksByStop(accessRows, picked.boards, (e) => e.destinationIndex);
  const egress = walksByStop(egressRows, picked.alights, (e) => e.originIndex);

  const measured = {
    access: new Map([...access].map(([s, w]) => [s, w.durationSec])),
    egress: new Map([...egress].map(([s, w]) => [s, w.durationSec])),
  };
  const midnight = serviceMidnightMs(serviceDate);
  const rideOf = (leg: JourneyLeg): ExactWalkRide => ({
    board: stationOf(day.stops[leg.board]),
    alight: stationOf(day.stops[leg.alight]),
    route: ct.trips[leg.trip].route,
    headsign: ct.trips[leg.trip].headsign,
    boardAt: formatJst(midnight + leg.boardAt * 1000),
    alightAt: formatJst(midnight + leg.alightAt * 1000),
    stops: rideStops(ct, leg).map(coordOf),
  });
  const candidates = timed('rides', () =>
    bestRides(ct, q, measured, { k: MAX_CANDIDATES }),
  ).flatMap((ride) => {
    const accessWalk = access.get(ride.board);
    const egressWalk = egress.get(ride.alight);
    if (accessWalk === undefined || egressWalk === undefined) return [];
    return [{ ...rideOf(ride), accessWalk, egressWalk }];
  });
  if (!req.transfers) return { candidates, feeds, stats };

  const journeys = timed('journeys', () =>
    bestJourneys(ct, q, measured, neighbors, { k: MAX_CANDIDATES, transfersOnly: true }),
  );
  const transferCandidates = journeys.flatMap(({ legs: [first, second], transferSec }) => {
    const accessWalk = access.get(first.board);
    const egressWalk = egress.get(second.alight);
    if (accessWalk === undefined || egressWalk === undefined) return [];
    return [
      {
        legs: [rideOf(first), rideOf(second)],
        accessWalk,
        transferWalk: {
          durationSec: transferSec,
          distanceMeters: Math.round((transferSec / 60) * WALK_METERS_PER_MINUTE),
        },
        sameStation: isSameStation(neighbors, first.alight, second.board),
        egressWalk,
      },
    ];
  });
  return { candidates, transferCandidates, feeds, stats };
}

function isSameStation(n: TransferNeighbors, from: number, to: number): boolean {
  for (let e = n.start[from]; e < n.start[from + 1]; e++) {
    if (n.stop[e] === to) return n.sameStation[e] === 1;
  }
  return false;
}

function stationOf({ name, lat, lng }: TimetableStop): TimetableStop {
  return { name, lat, lng };
}

function isIndexOf(xs: readonly unknown[], i: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < xs.length;
}

function walksByStop(
  rows: readonly MatrixElement[],
  stops: readonly number[],
  indexOf: (e: MatrixElement) => number,
): Map<number, Walk> {
  const out = new Map<number, Walk>();
  for (const e of rows) {
    const at = indexOf(e);
    if (!isIndexOf(stops, at) || !Number.isFinite(e.durationSec)) continue;
    out.set(stops[at], { durationSec: e.durationSec, distanceMeters: e.distanceMeters });
  }
  return out;
}

function rideStops(ct: CompiledTimetable, ride: JourneyLeg): number[] {
  const start = ct.tripStart[ride.trip];
  const end = start + ct.tripLength[ride.trip];
  let c = start;
  while (c < end && !(ct.callStop[c] === ride.board && ct.callDep[c] === ride.boardAt)) c++;
  const out: number[] = [];
  for (; c < end; c++) {
    out.push(ct.callStop[c]);
    if (out.length > 1 && ct.callStop[c] === ride.alight && ct.callArr[c] === ride.alightAt) break;
  }
  return out;
}

function serviceMidnightMs(serviceDate: string): number {
  const y = Number(serviceDate.slice(0, 4));
  const m = Number(serviceDate.slice(4, 6));
  const d = Number(serviceDate.slice(6, 8));
  return Date.UTC(y, m - 1, d) - JST_OFFSET_MS;
}

function formatJst(ms: number): string {
  const jst = new Date(ms + JST_OFFSET_MS);
  return (
    `${jst.getUTCFullYear()}-${pad2(jst.getUTCMonth() + 1)}-${pad2(jst.getUTCDate())}` +
    `T${pad2(jst.getUTCHours())}:${pad2(jst.getUTCMinutes())}:${pad2(jst.getUTCSeconds())}+09:00`
  );
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
