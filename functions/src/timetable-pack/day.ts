// 読み込んだ全グループのパックから、運行日1日ぶんの走査用の時刻表を組み立てる（#459・#487）。

import { compileTimetable, transferNeighbors, type StationKey, type Timetable } from "../exact-scan";
import type { ScanDay } from "../exact-walk-max";
import { PACK_GROUPS, type PackGroup } from "./feeds";
import { timetableForDate, type TimetablePack } from "./pack";

// 乗換の近傍の半径。A/B の計測（#474）で「勝った割合」と enrich で落ちる割合を見て決めるまでの値。
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
  const tt: Timetable = { stops: [], trips: [] };
  const stations: StationKey[] = [];
  const feeds: ScanDay["feeds"][number][] = [];
  for (const group of PACK_GROUPS) {
    const pack = packs.get(group);
    if (pack === undefined) continue;
    const day = timetableForDate(pack, serviceDate);
    const offset = tt.stops.length;
    // feed も station もパックごとに0から振られる。同じ駅の判定は feed が同じことを含むので、
    // feed をずらせば別のパックの駅は重ならず、station までずらす必要は無い。
    const feedOffset = feeds.length;
    for (const stop of day.stops) {
      tt.stops.push(stop);
      stations.push({ feed: stop.feed + feedOffset, station: stop.station });
    }
    for (const trip of day.trips) {
      tt.trips.push({ ...trip, calls: trip.calls.map((c) => ({ ...c, stop: c.stop + offset })) });
    }
    for (const { id, fetchedAt } of pack.feeds) feeds.push({ id, fetchedAt });
  }
  const extracted = now();
  const compiled = compileTimetable(tt);
  const compiledAt = now();
  const neighbors = transferNeighbors(compiled, stations, { maxWalkSec: TRANSFER_RADIUS_SEC });
  const done = now();
  return {
    day: { compiled, neighbors, stops: tt.stops, feeds },
    timings: {
      extractMs: extracted - start,
      compileMs: compiledAt - extracted,
      neighborsMs: done - compiledAt,
    },
  };
}
