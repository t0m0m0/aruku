// ODPT の GTFS（鉄道）を、厳密走査（exact-scan.ts）が読む時刻表パックに変換する（#457・epic #456）。
//
// パックは運行日をまたいだ全便を持ち、検索のたびに timetableForDate で
// その日の Timetable を切り出す。

import type { StopCall, Timetable } from "../exact-scan";
import { readCsv } from "./csv";

export const PACK_FORMAT_VERSION = 1;

export type GtfsFileName =
  | "stops.txt"
  | "routes.txt"
  | "trips.txt"
  | "stop_times.txt"
  | "calendar.txt"
  | "calendar_dates.txt"
  | "feed_info.txt";

export const GTFS_FILE_NAMES: readonly GtfsFileName[] = [
  "stops.txt",
  "routes.txt",
  "trips.txt",
  "stop_times.txt",
  "calendar.txt",
  "calendar_dates.txt",
  "feed_info.txt",
];

export type GtfsFiles = Partial<Record<GtfsFileName, string>>;

export interface FeedInput {
  id: string;
  /** ISO 8601。基本ライセンスで表示が要る「取得日時」。 */
  fetchedAt: string;
  files: GtfsFiles;
  /** GTFS の路線名を、パックに残す路線名へ写す（feeds.ts の OdptFeed.routeName）。 */
  routeName?: (gtfsRouteName: string) => string;
}

export interface PackFeed {
  id: string;
  fetchedAt: string;
  /** feed_info.txt の feed_version。 */
  version: string | null;
}

export interface PackStation {
  name: string;
  lat: number;
  lng: number;
}

export interface PackStop extends PackStation {
  feed: number;
  station: number;
}

export interface PackService {
  /** 走る日（YYYYMMDD）の昇順。 */
  dates: number[];
}

/** 停車列は駅・着・発・乗車可否・降車可否の列ごとの配列。時刻は運行日の0時からの秒。 */
export interface PackTrip {
  feed: number;
  service: number;
  route: string;
  headsign: string | null;
  /** 同じ車両の続き。今は便ごとに独立に扱い、値だけ残す。 */
  block: string | null;
  stops: number[];
  arr: number[];
  dep: number[];
  board: (0 | 1)[];
  alight: (0 | 1)[];
}

export interface TimetablePack {
  format: typeof PACK_FORMAT_VERSION;
  feeds: PackFeed[];
  stations: PackStation[];
  stops: PackStop[];
  services: PackService[];
  trips: PackTrip[];
}

export interface DayTimetable extends Timetable {
  /** trips と同じ並びで、元になったパックの便と、その便の運行日（YYYYMMDD）。 */
  tripSources: { packTrip: number; serviceDate: string }[];
}

const SECONDS_PER_DAY = 86400;
const SAME_STATION_MAX_METERS = 500;

export function buildTimetablePack(feeds: readonly FeedInput[]): TimetablePack {
  const pack: TimetablePack = {
    format: PACK_FORMAT_VERSION,
    feeds: [],
    stations: [],
    stops: [],
    services: [],
    trips: [],
  };
  feeds.forEach((input, feedIndex) => {
    pack.feeds.push({
      id: input.id,
      fetchedAt: input.fetchedAt,
      version: feedVersion(input.files["feed_info.txt"]),
    });
    addFeed(pack, feedIndex, input.files, input.routeName ?? ((name) => name));
  });
  groupStations(pack);
  return pack;
}

/** serviceDate（YYYYMMDD）の0時を起点にした、その日に乗れる便の時刻表。 */
export function timetableForDate(pack: TimetablePack, serviceDate: string): DayTimetable {
  const today = Number(serviceDate);
  const yesterday = shiftDate(today, -1);
  const runsOn = pack.services.map((s) => ({
    today: includesSorted(s.dates, today),
    yesterday: includesSorted(s.dates, yesterday),
  }));

  const trips: Timetable["trips"] = [];
  const tripSources: DayTimetable["tripSources"] = [];
  pack.trips.forEach((trip, packTrip) => {
    const runs = runsOn[trip.service];
    if (runs.today) {
      trips.push({ route: trip.route, headsign: trip.headsign, calls: callsOf(trip, 0) });
      tripSources.push({ packTrip, serviceDate });
    }
    if (runs.yesterday) {
      // 前日の運行日の便は、24:00 を越えた部分だけが当日の検索に掛かる。
      const calls = callsOf(trip, SECONDS_PER_DAY).filter((c) => c.dep >= 0);
      if (calls.length >= 2) {
        trips.push({ route: trip.route, headsign: trip.headsign, calls });
        tripSources.push({ packTrip, serviceDate: String(yesterday) });
      }
    }
  });
  return { stops: pack.stops, trips, tripSources };
}

function callsOf(trip: PackTrip, shift: number): StopCall[] {
  return trip.stops.map((stop, i) => ({
    stop,
    arr: trip.arr[i] - shift,
    dep: trip.dep[i] - shift,
    canBoard: trip.board[i] === 1,
    canAlight: trip.alight[i] === 1,
  }));
}

function addFeed(
  pack: TimetablePack,
  feed: number,
  files: GtfsFiles,
  routeName: (gtfsRouteName: string) => string,
): void {
  const stopsById = new Map<string, { name: string; lat: number; lng: number }>();
  readCsv(files["stops.txt"] ?? "", (get) => {
    stopsById.set(get("stop_id"), {
      name: get("stop_name"),
      lat: Number(get("stop_lat")),
      lng: Number(get("stop_lon")),
    });
  });

  const routeNames = new Map<string, string>();
  readCsv(files["routes.txt"] ?? "", (get) => {
    routeNames.set(get("route_id"), routeName(get("route_long_name") || get("route_short_name")));
  });

  const serviceIndex = new Map<string, number>();
  for (const [serviceId, dates] of resolveServiceDates(files)) {
    serviceIndex.set(serviceId, pack.services.length);
    pack.services.push({ dates });
  }

  const tripMeta = new Map<
    string,
    { route: string; headsign: string | null; block: string | null; service: number }
  >();
  readCsv(files["trips.txt"] ?? "", (get) => {
    const service = serviceIndex.get(get("service_id"));
    if (service === undefined) return;
    tripMeta.set(get("trip_id"), {
      route: routeNames.get(get("route_id")) ?? "",
      headsign: get("trip_headsign") || null,
      block: get("block_id") || null,
      service,
    });
  });

  const callsByTrip = new Map<
    string,
    { seq: number; stopId: string; arr: number; dep: number; board: 0 | 1; alight: 0 | 1 }[]
  >();
  readCsv(files["stop_times.txt"] ?? "", (get) => {
    const tripId = get("trip_id");
    if (!tripMeta.has(tripId)) return;
    const board = canUse(get("pickup_type"));
    const alight = canUse(get("drop_off_type"));
    if (!board && !alight) return;
    const arrRaw = parseGtfsTime(get("arrival_time"));
    const depRaw = parseGtfsTime(get("departure_time"));
    // 片方だけ壊れている（空欄でなく読めない）行は、もう片方で埋めずに外す。
    if (arrRaw === undefined || depRaw === undefined) return;
    const arr = arrRaw ?? depRaw;
    const dep = depRaw ?? arrRaw;
    if (arr === null || dep === null) return;
    let calls = callsByTrip.get(tripId);
    if (calls === undefined) callsByTrip.set(tripId, (calls = []));
    calls.push({
      seq: Number(get("stop_sequence")),
      stopId: get("stop_id"),
      arr,
      dep,
      board: board ? 1 : 0,
      alight: alight ? 1 : 0,
    });
  });

  const stopIndex = new Map<string, number>();
  const indexOfStop = (stopId: string): number | undefined => {
    const known = stopIndex.get(stopId);
    if (known !== undefined) return known;
    const s = stopsById.get(stopId);
    if (s === undefined || !Number.isFinite(s.lat) || !Number.isFinite(s.lng)) return undefined;
    const index = pack.stops.length;
    pack.stops.push({ ...s, feed, station: -1 });
    stopIndex.set(stopId, index);
    return index;
  };

  for (const [tripId, rawCalls] of callsByTrip) {
    rawCalls.sort((a, b) => a.seq - b.seq);
    const meta = tripMeta.get(tripId)!;
    const trip: PackTrip = {
      feed,
      service: meta.service,
      route: meta.route,
      headsign: meta.headsign,
      block: meta.block,
      stops: [],
      arr: [],
      dep: [],
      board: [],
      alight: [],
    };
    for (const c of rawCalls) {
      const stop = indexOfStop(c.stopId);
      if (stop === undefined) continue;
      trip.stops.push(stop);
      trip.arr.push(c.arr);
      trip.dep.push(c.dep);
      trip.board.push(c.board);
      trip.alight.push(c.alight);
    }
    if (trip.stops.length >= 2) pack.trips.push(trip);
  }
}

// 要予約（2・3）を乗降できる扱いにしないのは、検索の結果として電話予約が要る駅を
// 案内できないため。鉄道のフィードでは使われていない。
function canUse(type: string): boolean {
  return type === "" || type === "0";
}

/**
 * "H:MM:SS" を運行日の0時からの秒にする。空欄は null、読めない値は undefined。
 * 空欄を 0 と読むと「00:00 着」になり、締切に必ず間に合う降車駅に化ける（#343 と同じ種類）。
 */
export function parseGtfsTime(value: string): number | null | undefined {
  const v = value.trim();
  if (v === "") return null;
  const m = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/.exec(v);
  if (m === null) return undefined;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function resolveServiceDates(files: GtfsFiles): Map<string, number[]> {
  const dates = new Map<string, Set<number>>();
  const datesOf = (serviceId: string) => {
    let set = dates.get(serviceId);
    if (set === undefined) dates.set(serviceId, (set = new Set()));
    return set;
  };
  const weekdayColumns = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
  ];
  readCsv(files["calendar.txt"] ?? "", (get) => {
    const set = datesOf(get("service_id"));
    const runs = weekdayColumns.map((c) => get(c) === "1");
    const end = Number(get("end_date"));
    for (let d = Number(get("start_date")); d > 0 && d <= end; d = shiftDate(d, 1)) {
      if (runs[weekdayOf(d)]) set.add(d);
    }
  });
  readCsv(files["calendar_dates.txt"] ?? "", (get) => {
    const set = datesOf(get("service_id"));
    const d = Number(get("date"));
    if (get("exception_type") === "1") set.add(d);
    else if (get("exception_type") === "2") set.delete(d);
  });
  return new Map([...dates].map(([id, set]) => [id, [...set].sort((a, b) => a - b)]));
}

function feedVersion(text: string | undefined): string | null {
  let version: string | null = null;
  readCsv(text ?? "", (get) => {
    version ??= get("feed_version") || null;
  });
  return version;
}

function toUtcDate(yyyymmdd: number): Date {
  return new Date(
    Date.UTC(Math.floor(yyyymmdd / 10000), Math.floor(yyyymmdd / 100) % 100 - 1, yyyymmdd % 100),
  );
}

function shiftDate(yyyymmdd: number, days: number): number {
  const d = toUtcDate(yyyymmdd);
  d.setUTCDate(d.getUTCDate() + days);
  return d.getUTCFullYear() * 10000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

function weekdayOf(yyyymmdd: number): number {
  return toUtcDate(yyyymmdd).getUTCDay();
}

function includesSorted(sorted: readonly number[], value: number): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return sorted[lo] === value;
}

/**
 * 同じ名前で 500m 以内の stop を1つの駅にまとめる（表示用）。
 * JR の stop_id は路線ごとで、東京駅だけで10個ある。
 */
function groupStations(pack: TimetablePack): void {
  const parent = pack.stops.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const byName = new Map<string, number[]>();
  pack.stops.forEach((s, i) => {
    const list = byName.get(s.name);
    if (list === undefined) byName.set(s.name, [i]);
    else list.push(i);
  });
  for (const members of byName.values()) {
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        const sa = pack.stops[members[a]];
        const sb = pack.stops[members[b]];
        if (metersBetween(sa, sb) <= SAME_STATION_MAX_METERS) {
          parent[find(members[a])] = find(members[b]);
        }
      }
    }
  }

  const stationOfRoot = new Map<number, number>();
  const sums: { lat: number; lng: number; n: number }[] = [];
  pack.stops.forEach((s, i) => {
    const root = find(i);
    let station = stationOfRoot.get(root);
    if (station === undefined) {
      station = pack.stations.length;
      stationOfRoot.set(root, station);
      pack.stations.push({ name: s.name, lat: 0, lng: 0 });
      sums.push({ lat: 0, lng: 0, n: 0 });
    }
    s.station = station;
    sums[station].lat += s.lat;
    sums[station].lng += s.lng;
    sums[station].n++;
  });
  pack.stations.forEach((st, i) => {
    st.lat = sums[i].lat / sums[i].n;
    st.lng = sums[i].lng / sums[i].n;
  });
}

function metersBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}
