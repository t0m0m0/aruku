// mini-tokyo-3d（https://github.com/nagix/mini-tokyo-3d）の data/ の時刻表を、
// 時刻表パックの入力（GTFS の各ファイル）へ変換する（#511・epic #510）。
//
// パックを直接組まず GTFS の文字列を経るのは、駅のまとめ・運行日・便の切り出しを
// ODPT と同じ buildTimetablePack に任せ、パックの形式も読み込みも変えずに済ませるため。

import { isRecord } from '../json';
import { runsSaturdayHolidaySchedule } from './japanese-holidays';
import type { FeedInput } from './pack';

export interface M3dStation {
  id: string;
  /** [経度, 緯度]。地図の外の駅（常磐線の大津港など、2026-11 時点で 27 駅）は持たない。 */
  coord?: [number, number];
  title: { ja: string };
}

export interface M3dRailway {
  id: string;
  title: { ja: string };
  stations: string[];
}

/** 停車1回。a は着・d は発（"HH:MM"）。0時を過ぎた時刻は "00:10" のように書かれる。 */
export interface M3dCall {
  s: string;
  a?: string;
  d?: string;
}

export interface M3dTrain {
  /** `<t>.<カレンダー>`。1本の列車を分けて書いたものは、さらに `.<番号>` が付く。 */
  id: string;
  t: string;
  r: string;
  /** 行先の駅。 */
  ds?: string[];
  tt: M3dCall[];
}

export interface MiniTokyo3dFeedInput {
  /** railways の ID の先頭（"Tokyu" など）。 */
  operator: string;
  stations: readonly M3dStation[];
  railways: readonly M3dRailway[];
  trains: readonly M3dTrain[];
  /** 走らせる運行日（YYYYMMDD）。平日・土休日のどちらのダイヤかは日付から決める。 */
  dates: readonly number[];
  commit: string;
  fetchedAt: string;
}

const CALENDARS = ['Weekday', 'SaturdayHoliday'] as const;
type Calendar = (typeof CALENDARS)[number];

// 終電は 1 時台まで、始発は 4 時台から（2026-11 時点の対象事業者）。
const LAST_HOUR_OF_SERVICE_DAY = 3;

/** stations.json を読む。形の違う要素が1つでもあれば null。 */
export function parseM3dStations(raw: unknown): M3dStation[] | null {
  return allOf(raw, isM3dStation);
}

/** railways.json を読む。形の違う要素が1つでもあれば null。 */
export function parseM3dRailways(raw: unknown): M3dRailway[] | null {
  return allOf(raw, isM3dRailway);
}

/** train-timetables/*.json を読む。形の違う要素が1つでもあれば null。 */
export function parseM3dTrains(raw: unknown): M3dTrain[] | null {
  return allOf(raw, isM3dTrain);
}

// 形の違う要素を読み飛ばさないのは、駅や便が欠けたまま組んだパックで前回分を上書きしないため。
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

/** 停車ごとの着・発を運行日の0時からの秒で返す。読めない時刻があれば null。 */
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

// 時刻表の表記は 0 時で一周するので、0〜2 時台はその運行日の 24〜26 時台として読む。
// 時刻だけで決めず直前の停車とも比べるのは、日付をまたぐ列車が 3 時を越えて走っても
// 時刻が戻らないようにするため。
function afterPrevious(clock: number, previous: number): number {
  let t = clock < LAST_HOUR_OF_SERVICE_DAY * 3600 ? clock + 86400 : clock;
  while (t < previous) t += 86400;
  return t;
}

/** "HH:MM" を秒にする。読めない値は undefined。 */
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
  const field = (v: string) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [columns, ...rows].map((r) => r.map(field).join(',')).join('\n') + '\n';
}
