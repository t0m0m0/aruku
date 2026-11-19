import { GeoPoint } from '@aruku/engine/models/geo-point';
import { haversineKm } from '@aruku/engine/services/hybrid-route-selector';
import { dateTime } from '@aruku/engine/time';

import type { BenchRecord, BenchRide } from './bench-record';

export type VerifyVerdict = 'sameTrip' | 'departureOnly' | 'missing' | 'noBoard';

export interface VerifyResult {
  pair: string;
  slot: string;
  ratio: number;
  line: string | null;
  from: string;
  to: string;
  dep: string | null;
  arr: string | null;
  verdict: VerifyVerdict | null;
  matchedLine: string | null;
  seen: string[];
  error: string | null;
}

export type VerifiableRide = BenchRide & {
  fromLat: number;
  fromLng: number;
  toLat: number;
  toLng: number;
  dep: string;
  arr: string;
};

function isVerifiable(ride: BenchRide): ride is VerifiableRide {
  return (
    ride.fromLat !== null &&
    ride.fromLng !== null &&
    ride.toLat !== null &&
    ride.toLng !== null &&
    ride.dep !== null &&
    ride.arr !== null
  );
}

export interface RideToVerify {
  record: BenchRecord;
  ride: VerifiableRide;
}

export interface BoardStation {
  id: string;
  feedId: string;
  name: string;
  lat: number;
  lng: number;
}

export interface BoardDeparture {
  tripId: string;
  routeName: string;
  headsign: string;
  departureSecs: number;
}

const boardLookBehindMin = 2;

const seenAheadMin = 5;

const arrivalToleranceMin = 2;

const sameStationKm = 0.5;

export function ridesToVerify(records: readonly BenchRecord[], limit: number): RideToVerify[] {
  const eligible: RideToVerify[] = [];
  for (const record of records) {
    const rides = record.plan?.rides ?? [];
    const ride = rides[0];
    if (record.metrics?.['exactWon'] !== 1 || rides.length !== 1) continue;
    if (!isVerifiable(ride)) continue;
    eligible.push({ record, ride });
  }
  const picked: RideToVerify[] = [];
  const seenPairs = new Set<string>();
  for (const e of eligible) {
    if (picked.length >= limit) break;
    if (seenPairs.has(e.record.pair)) continue;
    seenPairs.add(e.record.pair);
    picked.push(e);
  }
  for (const e of eligible) {
    if (picked.length >= limit) break;
    if (!picked.includes(e)) picked.push(e);
  }
  return picked;
}

export interface VerifyDeps {
  findStations(name: string): Promise<BoardStation[]>;
  fetchDepartures(stationId: string, date: string, time: string): Promise<BoardDeparture[] | null>;
  write(result: VerifyResult): void;
  shouldStop(): boolean;
}

export async function runVerify(picked: readonly RideToVerify[], deps: VerifyDeps): Promise<void> {
  for (const { record, ride } of picked) {
    if (deps.shouldStop()) return;
    const base = {
      pair: record.pair,
      slot: record.slot,
      ratio: record.ratio,
      line: ride.line,
      from: ride.from,
      to: ride.to,
      dep: ride.dep,
      arr: ride.arr,
    };
    try {
      deps.write({ ...base, ...(await verifyRide(ride, deps)), error: null });
    } catch (error) {
      deps.write({
        ...base,
        verdict: null,
        matchedLine: null,
        seen: [],
        error: String(error),
      });
    }
  }
}

async function verifyRide(
  ride: VerifiableRide,
  deps: VerifyDeps,
): Promise<{ verdict: VerifyVerdict; matchedLine: string | null; seen: string[] }> {
  const dep = parseWallClock(ride.dep);
  const arr = parseWallClock(ride.arr);
  const boardingNamesakes = sameStations(
    await deps.findStations(ride.from),
    ride.from,
    new GeoPoint(ride.fromLat, ride.fromLng),
  );
  const seen: string[] = [];
  if (boardingNamesakes.length === 0) return { verdict: 'noBoard', matchedLine: null, seen };
  const alighting = sameStations(
    await deps.findStations(ride.to),
    ride.to,
    new GeoPoint(ride.toLat, ride.toLng),
  );
  const boarding = boardingNamesakes.filter((s) => alighting.some((a) => a.feedId === s.feedId));
  let anyBoard = false;
  let departedOnly: BoardDeparture | null = null;
  for (const station of boarding) {
    const board = await deps.fetchDepartures(
      station.id,
      ymd(dep),
      hm(addMinutes(dep, -boardLookBehindMin)),
    );
    if (board === null) continue;
    anyBoard = true;
    for (const d of board) {
      const offset = minuteOf(d) - minuteOfDay(dep);
      const label = `${hmSecs(d.departureSecs)} ${departureLine(d)}`;
      if (offset >= -boardLookBehindMin && offset <= seenAheadMin && !seen.includes(label))
        seen.push(label);
    }
    const sameMinute = board.filter((d) => minuteOf(d) === minuteOfDay(dep));
    if (sameMinute.length === 0) continue;
    for (const alightingStation of alighting.filter((s) => s.feedId === station.feedId)) {
      const alightingBoard = await deps.fetchDepartures(
        alightingStation.id,
        ymd(arr),
        hm(addMinutes(arr, -arrivalToleranceMin)),
      );
      const same = sameMinute.find((d) =>
        (alightingBoard ?? []).some(
          (a) =>
            a.tripId === d.tripId &&
            Math.abs(minuteOf(a) - minuteOfDay(arr)) <= arrivalToleranceMin,
        ),
      );
      if (same !== undefined)
        return { verdict: 'sameTrip', matchedLine: departureLine(same), seen };
    }
    departedOnly ??= sameMinute[0];
  }
  if (departedOnly !== null) {
    return { verdict: 'departureOnly', matchedLine: departureLine(departedOnly), seen };
  }
  return { verdict: anyBoard ? 'missing' : 'noBoard', matchedLine: null, seen };
}

function sameStations(
  stations: readonly BoardStation[],
  name: string,
  at: GeoPoint,
): BoardStation[] {
  return stations
    .filter((s) => sameStationName(s.name, name))
    .map((s) => ({ s, km: haversineKm(at, new GeoPoint(s.lat, s.lng)) }))
    .filter(({ km }) => km <= sameStationKm)
    .sort((a, b) => a.km - b.km)
    .map(({ s }) => s);
}

function sameStationName(a: string, b: string): boolean {
  return normalizeStationName(a) !== '' && normalizeStationName(a) === normalizeStationName(b);
}

function normalizeStationName(name: string): string {
  return name
    .replace(/[（(].*?[)）]/g, '')
    .replace(/\s+(?=[A-Za-z\u00C0-\u024F]).*$/, '')
    .trim()
    .replace(/駅$/, '');
}

const departureLine = (d: BoardDeparture): string => `${d.routeName} ${d.headsign}`.trim();

const minuteOf = (d: BoardDeparture): number => Math.floor(d.departureSecs / 60);

const minuteOfDay = (d: Date): number => d.getHours() * 60 + d.getMinutes();

const addMinutes = (d: Date, minutes: number): Date =>
  dateTime(d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes() + minutes);

const pad = (n: number): string => String(n).padStart(2, '0');

const ymd = (d: Date): string => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;

const hm = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const hmSecs = (secs: number): string =>
  `${pad(Math.floor(secs / 3600))}:${pad(Math.floor(secs / 60) % 60)}`;

export function parseWallClock(s: string): Date {
  const [date, time] = s.split('T');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return dateTime(y, mo, d, h, mi);
}
