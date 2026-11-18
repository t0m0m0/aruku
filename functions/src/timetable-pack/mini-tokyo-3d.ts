import { isRecord } from '../json';
import { runsSaturdayHolidaySchedule } from './japanese-holidays';
import type { FeedInput } from './pack';

export interface M3dStation {
  id: string;
  coord?: [number, number];
  title: { ja: string };
}

export interface M3dRailway {
  id: string;
  title: { ja: string };
  stations: string[];
}

export interface M3dCall {
  s: string;
  a?: string;
  d?: string;
}

export interface M3dTrain {
  id: string;
  t: string;
  r: string;
  ds?: string[];
  tt: M3dCall[];
}

export interface MiniTokyo3dFeedInput {
  operator: string;
  stations: readonly M3dStation[];
  railways: readonly M3dRailway[];
  trains: readonly M3dTrain[];
  dates: readonly number[];
  commit: string;
  fetchedAt: string;
}

const CALENDARS = ['Weekday', 'SaturdayHoliday'] as const;
type Calendar = (typeof CALENDARS)[number];

const LAST_HOUR_OF_SERVICE_DAY = 3;

export function parseM3dStations(raw: unknown): M3dStation[] | null {
  return allOf(raw, isM3dStation);
}

export function parseM3dRailways(raw: unknown): M3dRailway[] | null {
  return allOf(raw, isM3dRailway);
}

export function parseM3dTrains(raw: unknown): M3dTrain[] | null {
  return allOf(raw, isM3dTrain);
}

function allOf<T>(raw: unknown, is: (value: unknown) => value is T): T[] | null {
  return Array.isArray(raw) && raw.every(is) ? raw : null;
}

const isString = (value: unknown): value is string => typeof value === 'string';

function isJaTitle(value: unknown): value is { ja: string } {
  return isRecord(value) && isString(value['ja']);
}

function isM3dStation(value: unknown): value is M3dStation {
  if (!isRecord(value)) return false;
  const { id, coord, title } = value;
  return (
    isString(id) &&
    (coord === undefined ||
      (Array.isArray(coord) && typeof coord[0] === 'number' && typeof coord[1] === 'number')) &&
    isJaTitle(title)
  );
}

function isM3dRailway(value: unknown): value is M3dRailway {
  if (!isRecord(value)) return false;
  const { id, title, stations } = value;
  return isString(id) && isJaTitle(title) && Array.isArray(stations) && stations.every(isString);
}

function isM3dCall(value: unknown): value is M3dCall {
  if (!isRecord(value)) return false;
  const { s, a, d } = value;
  return isString(s) && (a === undefined || isString(a)) && (d === undefined || isString(d));
}

function isM3dTrain(value: unknown): value is M3dTrain {
  if (!isRecord(value)) return false;
  const { id, t, r, ds, tt } = value;
  return (
    isString(id) &&
    isString(t) &&
    isString(r) &&
    (ds === undefined || (Array.isArray(ds) && ds.every(isString))) &&
    Array.isArray(tt) &&
    tt.every(isM3dCall)
  );
}

export function timetableFileOf(railwayId: string): string {
  return `${railwayId.toLowerCase().replace(/-/g, '').replace('.', '-')}.json`;
}

export function railwaysOf(
  railways: readonly M3dRailway[],
  operators: readonly string[],
): M3dRailway[] {
  const wanted = new Set(operators);
  return railways.filter((r) => wanted.has(r.id.slice(0, r.id.indexOf('.'))));
}

export function miniTokyo3dFeed(input: MiniTokyo3dFeedInput): FeedInput {
  const stationsById = new Map(input.stations.map((s) => [s.id, s]));
  const usedStops = new Map<string, { name: string; coord: [number, number] }>();
  const routes = new Map<string, string>();
  const trips: string[][] = [];
  const stopTimes: string[][] = [];

  for (const train of input.trains) {
    const calendar = calendarOf(train);
    if (calendar === null) continue;
    const times = serviceDayTimes(train.tt);
    if (times === null) continue;
    const railway = input.railways.find((r) => r.id === train.r);
    routes.set(train.r, railway?.title.ja ?? '');
    const destination = train.ds?.[0];
    trips.push([
      train.r,
      calendar,
      train.id,
      destination === undefined ? '' : (stationsById.get(destination)?.title.ja ?? ''),
    ]);
    train.tt.forEach((call, i) => {
      const station = stationsById.get(call.s);
      if (station?.coord === undefined) return;
      usedStops.set(call.s, { name: station.title.ja, coord: station.coord });
      const { arr, dep } = times[i];
      stopTimes.push([train.id, gtfsTime(arr), gtfsTime(dep), call.s, String(i + 1)]);
    });
  }

  const calendarDates: string[][] = input.dates.map((date) => [
    runsSaturdayHolidaySchedule(date) ? 'SaturdayHoliday' : 'Weekday',
    String(date),
    '1',
  ]);

  return {
    id: `mini-tokyo-3d/${input.operator}`,
    fetchedAt: input.fetchedAt,
    files: {
      'stops.txt': csv(
        ['stop_id', 'stop_name', 'stop_lat', 'stop_lon'],
        [...usedStops].map(([id, s]) => [id, s.name, String(s.coord[1]), String(s.coord[0])]),
      ),
      'routes.txt': csv(['route_id', 'route_long_name'], [...routes]),
      'trips.txt': csv(['route_id', 'service_id', 'trip_id', 'trip_headsign'], trips),
      'stop_times.txt': csv(
        ['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence'],
        stopTimes,
      ),
      'calendar_dates.txt': csv(['service_id', 'date', 'exception_type'], calendarDates),
      'feed_info.txt': csv(['feed_version'], [[input.commit]]),
    },
  };
}

function calendarOf(train: M3dTrain): Calendar | null {
  const name = train.id.slice(train.t.length + 1).split('.')[0];
  return CALENDARS.find((calendar) => calendar === name) ?? null;
}

function serviceDayTimes(calls: readonly M3dCall[]): { arr: number; dep: number }[] | null {
  const result: { arr: number; dep: number }[] = [];
  let previous = -Infinity;
  for (const call of calls) {
    const arrRaw = call.a === undefined ? null : clockSeconds(call.a);
    const depRaw = call.d === undefined ? null : clockSeconds(call.d);
    if (arrRaw === undefined || depRaw === undefined) return null;
    const known = arrRaw ?? depRaw;
    if (known === null) return null;
    const arr = afterPrevious(known, previous);
    const dep = afterPrevious(depRaw ?? known, arr);
    result.push({ arr, dep });
    previous = dep;
  }
  return result;
}

function afterPrevious(clock: number, previous: number): number {
  let t = clock < LAST_HOUR_OF_SERVICE_DAY * 3600 ? clock + 86400 : clock;
  while (t < previous) t += 86400;
  return t;
}

function clockSeconds(value: string): number | undefined {
  const m = /^(\d{2}):([0-5]\d)$/.exec(value);
  if (m === null) return undefined;
  return Number(m[1]) * 3600 + Number(m[2]) * 60;
}

function gtfsTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:00`;
}

function csv(columns: readonly string[], rows: readonly (readonly string[])[]): string {
  return [columns, ...rows].map((r) => r.map(csvField).join(',')).join('\n') + '\n';
}

function csvField(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
