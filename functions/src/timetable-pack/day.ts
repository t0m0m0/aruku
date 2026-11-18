import { compileColumns, transferNeighbors, type StationKey } from '../exact-scan';
import type { ScanDay } from '../exact-walk-max';
import { PACK_GROUPS, type PackGroup } from './feeds';
import { keepsCall, tripsOnDate, type TimetablePack } from './pack';

const TRANSFER_RADIUS_SEC = 10 * 60;

export interface DayBuildTimings {
  extractMs: number;
  compileMs: number;
  neighborsMs: number;
}

export function buildScanDay(
  packs: ReadonlyMap<PackGroup, TimetablePack>,
  serviceDate: string,
  now: () => number,
): { day: ScanDay; timings: DayBuildTimings } {
  const start = now();
  const parts = PACK_GROUPS.flatMap((group) => {
    const pack = packs.get(group);
    return pack === undefined ? [] : [{ pack, onDate: tripsOnDate(pack, serviceDate) }];
  });

  let tripCount = 0;
  let callCount = 0;
  for (const { pack, onDate } of parts) {
    tripCount += onDate.length;
    for (const { packTrip, shift } of onDate) {
      const trip = pack.trips[packTrip];
      for (let i = 0; i < trip.stops.length; i++) if (keepsCall(trip, i, shift)) callCount++;
    }
  }
  const stops: ScanDay['stops'][number][] = [];
  const stations: StationKey[] = [];
  const feeds: ScanDay['feeds'][number][] = [];
  const trips = new Array<{ route: string; headsign: string | null }>(tripCount);
  const tripStart = new Int32Array(tripCount);
  const tripLength = new Int32Array(tripCount);
  const callStop = new Int32Array(callCount);
  const callArr = new Int32Array(callCount);
  const callDep = new Int32Array(callCount);
  const callBoard = new Uint8Array(callCount);
  const callAlight = new Uint8Array(callCount);
  let t = 0;
  let k = 0;
  for (const { pack, onDate } of parts) {
    const offset = stops.length;
    const feedOffset = feeds.length;
    for (const stop of pack.stops) {
      stops.push(stop);
      stations.push({ feed: stop.feed + feedOffset, station: stop.station });
    }
    for (const { packTrip, shift } of onDate) {
      const trip = pack.trips[packTrip];
      trips[t] = { route: trip.route, headsign: trip.headsign };
      tripStart[t] = k;
      for (let i = 0; i < trip.stops.length; i++) {
        if (!keepsCall(trip, i, shift)) continue;
        callStop[k] = trip.stops[i] + offset;
        callArr[k] = trip.arr[i] - shift;
        callDep[k] = trip.dep[i] - shift;
        callBoard[k] = trip.board[i];
        callAlight[k] = trip.alight[i];
        k++;
      }
      tripLength[t] = k - tripStart[t];
      t++;
    }
    for (const { id, fetchedAt } of pack.feeds) feeds.push({ id, fetchedAt });
  }
  const extracted = now();
  const compiled = compileColumns({
    stopLat: Float64Array.from(stops, (s) => s.lat),
    stopLng: Float64Array.from(stops, (s) => s.lng),
    trips,
    tripStart,
    tripLength,
    callStop,
    callArr,
    callDep,
    callBoard,
    callAlight,
  });
  const compiledAt = now();
  const neighbors = transferNeighbors(compiled, stations, { maxWalkSec: TRANSFER_RADIUS_SEC });
  const done = now();
  return {
    day: { compiled, neighbors, stops, feeds },
    timings: {
      extractMs: extracted - start,
      compileMs: compiledAt - extracted,
      neighborsMs: done - compiledAt,
    },
  };
}
