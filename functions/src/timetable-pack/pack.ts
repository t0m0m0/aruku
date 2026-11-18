import type { StopCall, Timetable } from '../exact-scan';
import { readCsv } from './csv';

export const PACK_FORMAT_VERSION = 1;

export type GtfsFileName =
  | 'stops.txt'
  | 'routes.txt'
  | 'trips.txt'
  | 'stop_times.txt'
  | 'calendar.txt'
  | 'calendar_dates.txt'
  | 'feed_info.txt';

export const GTFS_FILE_NAMES: readonly GtfsFileName[] = [
  'stops.txt',
  'routes.txt',
  'trips.txt',
  'stop_times.txt',
  'calendar.txt',
  'calendar_dates.txt',
  'feed_info.txt',
];

export type GtfsFiles = Partial<Record<GtfsFileName, string>>;

export interface FeedInput {
  id: string;
  fetchedAt: string;
  files: GtfsFiles;
  routeName?: (gtfsRouteName: string) => string;
}

export interface PackFeed {
  id: string;
  fetchedAt: string;
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
  dates: number[];
}

export interface PackTrip {
  feed: number;
  service: number;
  route: string;
  headsign: string | null;
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
  stops: PackStop[];
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
      version: feedVersion(input.files['feed_info.txt']),
    });
    addFeed(pack, feedIndex, input.files, input.routeName ?? ((name) => name));
  });
  groupStations(pack);
  return pack;
}

export function timetableForDate(pack: TimetablePack, serviceDate: string): DayTimetable {
  const onDate = tripsOnDate(pack, serviceDate);
  const trips: Timetable['trips'] = onDate.map(({ packTrip, shift }) => {
    const trip = pack.trips[packTrip];
    const calls = callsOf(trip, shift).filter((_, i) => keepsCall(trip, i, shift));
    return { route: trip.route, headsign: trip.headsign, calls };
  });
  const tripSources = onDate.map(({ packTrip, serviceDate }) => ({ packTrip, serviceDate }));
  return { stops: pack.stops, trips, tripSources };
}

export interface TripOnDate {
  packTrip: number;
  serviceDate: string;
  shift: number;
}

export function tripsOnDate(pack: TimetablePack, serviceDate: string): TripOnDate[] {
  const today = Number(serviceDate);
  const yesterday = shiftDate(today, -1);
  const runsOn = pack.services.map((s) => ({
    today: includesSorted(s.dates, today),
    yesterday: includesSorted(s.dates, yesterday),
  }));

  const onDate: TripOnDate[] = [];
  pack.trips.forEach((trip, packTrip) => {
    const runs = runsOn[trip.service];
    if (runs.today) onDate.push({ packTrip, serviceDate, shift: 0 });
    if (runs.yesterday) {
      let kept = 0;
      for (let i = 0; i < trip.stops.length; i++) if (keepsCall(trip, i, SECONDS_PER_DAY)) kept++;
      if (kept >= 2) {
        onDate.push({ packTrip, serviceDate: String(yesterday), shift: SECONDS_PER_DAY });
      }
    }
  });
  return onDate;
}

export function keepsCall(trip: PackTrip, i: number, shift: number): boolean {
  return shift === 0 || trip.dep[i] - shift >= 0;
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

interface TripMeta {
  route: string;
  headsign: string | null;
  block: string | null;
  service: number;
}

function addFeed(
  pack: TimetablePack,
  feed: number,
  files: GtfsFiles,
  routeName: (gtfsRouteName: string) => string,
): void {
  const stopsById = new Map<string, { name: string; lat: number; lng: number }>();
  readCsv(files['stops.txt'] ?? '', (get) => {
    stopsById.set(get('stop_id'), {
      name: get('stop_name'),
      lat: Number(get('stop_lat')),
      lng: Number(get('stop_lon')),
    });
  });

  const routeNames = new Map<string, string>();
  readCsv(files['routes.txt'] ?? '', (get) => {
    routeNames.set(get('route_id'), routeName(get('route_long_name') || get('route_short_name')));
  });

  const serviceIndex = new Map<string, number>();
  for (const [serviceId, dates] of resolveServiceDates(files)) {
    serviceIndex.set(serviceId, pack.services.length);
    pack.services.push({ dates });
  }

  const tripMeta = new Map<string, TripMeta>();
  readCsv(files['trips.txt'] ?? '', (get) => {
    const service = serviceIndex.get(get('service_id'));
    if (service === undefined) return;
    tripMeta.set(get('trip_id'), {
      route: routeNames.get(get('route_id')) ?? '',
      headsign: get('trip_headsign') || null,
      block: get('block_id') || null,
      service,
    });
  });

  const callsByTrip = new Map<
    string,
    {
      meta: TripMeta;
      calls: {
        seq: number;
        stopId: string;
        arr: number;
        dep: number;
        board: 0 | 1;
        alight: 0 | 1;
      }[];
    }
  >();
  readCsv(files['stop_times.txt'] ?? '', (get) => {
    const tripId = get('trip_id');
    const meta = tripMeta.get(tripId);
    if (meta === undefined) return;
    const board = canUse(get('pickup_type'));
    const alight = canUse(get('drop_off_type'));
    if (!board && !alight) return;
    const arrRaw = parseGtfsTime(get('arrival_time'));
    const depRaw = parseGtfsTime(get('departure_time'));
    if (arrRaw === undefined || depRaw === undefined) return;
    const arr = arrRaw ?? depRaw;
    const dep = depRaw ?? arrRaw;
    if (arr === null || dep === null) return;
    let entry = callsByTrip.get(tripId);
    if (entry === undefined) callsByTrip.set(tripId, (entry = { meta, calls: [] }));
    entry.calls.push({
      seq: Number(get('stop_sequence')),
      stopId: get('stop_id'),
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

  for (const { meta, calls: rawCalls } of callsByTrip.values()) {
    rawCalls.sort((a, b) => a.seq - b.seq);
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

function canUse(type: string): boolean {
  return type === '' || type === '0';
}

export function parseGtfsTime(value: string): number | null | undefined {
  const v = value.trim();
  if (v === '') return null;
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
    'sunday',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
  ];
  readCsv(files['calendar.txt'] ?? '', (get) => {
    const set = datesOf(get('service_id'));
    const runs = weekdayColumns.map((c) => get(c) === '1');
    const end = Number(get('end_date'));
    for (let d = Number(get('start_date')); d > 0 && d <= end; d = shiftDate(d, 1)) {
      if (runs[weekdayOf(d)]) set.add(d);
    }
  });
  readCsv(files['calendar_dates.txt'] ?? '', (get) => {
    const set = datesOf(get('service_id'));
    const d = Number(get('date'));
    if (get('exception_type') === '1') set.add(d);
    else if (get('exception_type') === '2') set.delete(d);
  });
  return new Map([...dates].map(([id, set]) => [id, [...set].sort((a, b) => a - b)]));
}

function feedVersion(text: string | undefined): string | null {
  let version: string | null = null;
  readCsv(text ?? '', (get) => {
    version ??= get('feed_version') || null;
  });
  return version;
}

function toUtcDate(yyyymmdd: number): Date {
  return new Date(
    Date.UTC(Math.floor(yyyymmdd / 10000), (Math.floor(yyyymmdd / 100) % 100) - 1, yyyymmdd % 100),
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
