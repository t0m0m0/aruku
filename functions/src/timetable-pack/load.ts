// exactWalkMax が検索に使う時刻表を、Cloud Storage の時刻表パックから用意する（#459・epic #456）。

import { gunzipSync } from "node:zlib";

import { compileTimetable, type Timetable } from "../exact-scan";
import type { ScanDay } from "../exact-walk-max";
import { PACK_GROUPS, packObjectPath, type PackGroup } from "./feeds";
import { PACK_FORMAT_VERSION, timetableForDate, type TimetablePack } from "./pack";

export interface PackLoadDeps {
  /** オブジェクトの中身。オブジェクトが無ければ null。 */
  read: (path: string) => Promise<Uint8Array | null>;
  log: (event: Record<string, unknown>) => void;
  now: () => number;
}

// パックは毎日 4:23（JST）に作り直される。読み直しを要求の外（バックグラウンド）で
// 走らせないのは、Cloud Functions が要求の外で CPU を絞り、読み直しが終わらないまま残るため。
const RELOAD_AFTER_MS = 6 * 3600 * 1000;
// 読めなかったグループがあるときは、6時間を待たずに読み直す。待つと、Storage が戻った後も
// そのインスタンスはグループを欠いたまま（全グループなら 503 のまま）になる。
const RETRY_AFTER_FAILURE_MS = 60 * 1000;
// 0時の前後は2つの運行日の検索が混ざるので2日分持つ。それより多く持たないのはメモリのため。
const COMPILED_DAYS_KEPT = 2;

interface Loaded {
  reloadAt: number;
  packs: ReadonlyMap<PackGroup, TimetablePack>;
}

/** 運行日（YYYYMMDD）の時刻表を返す関数を作る。読めるパックが1つも無ければ null を返す。 */
export function createScanDaySource(
  deps: PackLoadDeps,
): (serviceDate: string) => Promise<ScanDay | null> {
  let loaded: Loaded | null = null;
  let loading: Promise<Loaded> | null = null;
  let days = new Map<string, ScanDay | null>();

  const current = async (): Promise<Loaded> => {
    if (loaded !== null && deps.now() < loaded.reloadAt) return loaded;
    loading ??= loadPacks(deps, loaded?.packs ?? new Map())
      .then((next) => {
        loaded = next;
        days = new Map();
        return next;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  };

  return async (serviceDate) => {
    const { packs } = await current();
    const cached = days.get(serviceDate);
    if (cached !== undefined) return cached;
    const day = buildDay(packs, serviceDate, deps);
    days.set(serviceDate, day);
    if (days.size > COMPILED_DAYS_KEPT) days.delete(days.keys().next().value!);
    return day;
  };
}

async function loadPacks(
  deps: PackLoadDeps,
  previous: ReadonlyMap<PackGroup, TimetablePack>,
): Promise<Loaded> {
  const packs = new Map<PackGroup, TimetablePack>();
  let failed = false;
  await Promise.all(
    PACK_GROUPS.map(async (group) => {
      const start = deps.now();
      const result = await readPack(deps, group);
      const loadMs = deps.now() - start;
      if (result.status === "success") {
        packs.set(group, result.pack);
        deps.log({
          event: "timetable_pack_load",
          group,
          status: "success",
          bytes: result.bytes,
          trips: result.pack.trips.length,
          loadMs,
        });
        return;
      }
      deps.log({ event: "timetable_pack_load", group, loadMs, ...result });
      if (result.status === "failure") failed = true;
      // 無いグループは前のパックも捨てる。チャレンジ限定データは期限（2027-03-12）で
      // オブジェクトを消す（#463）ので、温まったインスタンスに残しておくと消した後も検索に使い続ける。
      const kept = previous.get(group);
      if (result.status === "failure" && kept !== undefined) packs.set(group, kept);
    }),
  );
  return {
    reloadAt: deps.now() + (failed ? RETRY_AFTER_FAILURE_MS : RELOAD_AFTER_MS),
    packs,
  };
}

type ReadResult =
  | { status: "success"; pack: TimetablePack; bytes: number }
  | { status: "missing" }
  | { status: "failure"; reason: "read" | "format" };

async function readPack(deps: PackLoadDeps, group: PackGroup): Promise<ReadResult> {
  let gzipped: Uint8Array | null;
  try {
    gzipped = await deps.read(packObjectPath(group));
  } catch {
    return { status: "failure", reason: "read" };
  }
  if (gzipped === null) return { status: "missing" };
  let pack: TimetablePack;
  try {
    pack = JSON.parse(gunzipSync(gzipped).toString("utf8")) as TimetablePack;
  } catch {
    return { status: "failure", reason: "format" };
  }
  if (pack.format !== PACK_FORMAT_VERSION) return { status: "failure", reason: "format" };
  return { status: "success", pack, bytes: gzipped.byteLength };
}

function buildDay(
  packs: ReadonlyMap<PackGroup, TimetablePack>,
  serviceDate: string,
  deps: PackLoadDeps,
): ScanDay | null {
  if (packs.size === 0) return null;
  const start = deps.now();
  const tt: Timetable = { stops: [], trips: [] };
  const feeds: ScanDay["feeds"][number][] = [];
  for (const group of PACK_GROUPS) {
    const pack = packs.get(group);
    if (pack === undefined) continue;
    const day = timetableForDate(pack, serviceDate);
    const offset = tt.stops.length;
    for (const stop of day.stops) tt.stops.push(stop);
    for (const trip of day.trips) {
      tt.trips.push({ ...trip, calls: trip.calls.map((c) => ({ ...c, stop: c.stop + offset })) });
    }
    for (const { id, fetchedAt } of pack.feeds) feeds.push({ id, fetchedAt });
  }
  const compiled = compileTimetable(tt);
  deps.log({
    event: "timetable_day_compile",
    serviceDate,
    trips: compiled.tripCount,
    compileMs: deps.now() - start,
  });
  return { compiled, stops: tt.stops, feeds };
}
