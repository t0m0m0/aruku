// exactWalkMax が検索に使う時刻表を、Cloud Storage の時刻表パックから用意する（#459・epic #456）。
// パックの読み込みと読み直し、運行日ごとの時刻表のキャッシュを受け持つ。パックの復元は decode.ts、
// 運行日の組み立ては day.ts。

import type { ScanDay } from "../exact-walk-max";
import { buildScanDay } from "./day";
import { decodePack } from "./decode";
import { PACK_GROUPS, packObjectPath, type PackGroup } from "./feeds";
import type { TimetablePack } from "./pack";

export interface PackLoadDeps {
  /** オブジェクトの中身。オブジェクトが無ければ null。 */
  read: (path: string) => Promise<Uint8Array | null>;
  log: (event: Record<string, unknown>) => void;
  now: () => number;
  /** 運行日を組み立てた直後のヒープ（バイト）。省略すればログに載せない。 */
  heapUsed?: () => number;
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
  // 運行日の時刻表を、組み立てたパックと同じ読み込みに持たせる。読み直すと読み込みごと替わるので、
  // 読み直しの前に組み立てた日には構造上届かない。
  days: Map<string, ScanDay | null>;
}

/** 運行日（YYYYMMDD）の時刻表を返す関数を作る。読めるパックが1つも無ければ null を返す。 */
export function createScanDaySource(
  deps: PackLoadDeps,
): (serviceDate: string) => Promise<ScanDay | null> {
  let loaded: Loaded | null = null;
  let loading: Promise<Loaded> | null = null;

  const current = async (): Promise<Loaded> => {
    if (loaded !== null && deps.now() < loaded.reloadAt) return loaded;
    loading ??= loadPacks(deps, loaded?.packs ?? new Map())
      .then((next) => {
        loaded = next;
        return next;
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  };

  return async (serviceDate) => {
    const { packs, days } = await current();
    const cached = days.get(serviceDate);
    if (cached !== undefined) return cached;
    // 組み立ては同期で、await を挟まずにキャッシュへ入れる。同時に届いた同じ運行日の要求は
    // ここを1つずつ通るので、2つ目以降はキャッシュに当たり、組み立ては1回で済む。
    const day = packs.size === 0 ? null : buildDay(packs, serviceDate, deps);
    days.set(serviceDate, day);
    if (days.size > COMPILED_DAYS_KEPT) days.delete(days.keys().next().value!);
    return day;
  };
}

function buildDay(
  packs: ReadonlyMap<PackGroup, TimetablePack>,
  serviceDate: string,
  deps: PackLoadDeps,
): ScanDay {
  const { day, timings } = buildScanDay(packs, serviceDate, deps.now);
  deps.log({
    event: "timetable_day_compile",
    serviceDate,
    trips: day.compiled.tripCount,
    totalMs: timings.extractMs + timings.compileMs + timings.neighborsMs,
    ...timings,
    ...(deps.heapUsed === undefined ? {} : { heapUsedMB: Math.round(deps.heapUsed() / 1048576) }),
  });
  return day;
}

async function loadPacks(
  deps: PackLoadDeps,
  previous: ReadonlyMap<PackGroup, TimetablePack>,
): Promise<Loaded> {
  const packs = new Map<PackGroup, TimetablePack>();
  let failed = false;
  await Promise.all(
    PACK_GROUPS.map(async (group) => {
      const result = await readPack(deps, group);
      if (result.status === "success") {
        packs.set(group, result.pack);
        const { pack, ...timings } = result;
        deps.log({ event: "timetable_pack_load", group, ...timings, trips: pack.trips.length });
        return;
      }
      deps.log({ event: "timetable_pack_load", group, ...result });
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
    days: new Map(),
  };
}

type ReadResult =
  | {
      status: "success";
      pack: TimetablePack;
      bytes: number;
      loadMs: number;
      readMs: number;
      gunzipMs: number;
      parseMs: number;
    }
  | { status: "missing"; loadMs: number; readMs: number }
  | { status: "failure"; reason: "read"; loadMs: number; readMs: number }
  | {
      status: "failure";
      reason: "format";
      loadMs: number;
      readMs: number;
      gunzipMs: number;
      parseMs: number;
    };

async function readPack(deps: PackLoadDeps, group: PackGroup): Promise<ReadResult> {
  const start = deps.now();
  let gzipped: Uint8Array | null;
  try {
    gzipped = await deps.read(packObjectPath(group));
  } catch {
    const readMs = deps.now() - start;
    return { status: "failure", reason: "read", loadMs: readMs, readMs };
  }
  const readMs = deps.now() - start;
  if (gzipped === null) return { status: "missing", loadMs: readMs, readMs };
  // 解凍と解析は同期なので、もう一方のグループの同期処理が割り込まない。一方 readMs は、読込の完了後も
  // もう一方の解凍・解析が終わるまで再開できず、その待ちを含み得る。工程に分けて出すのはそのため。
  const decoded = decodePack(gzipped, deps.now);
  const loadMs = readMs + decoded.gunzipMs + decoded.parseMs;
  if (decoded.status === "failure") return { ...decoded, loadMs, readMs };
  return { ...decoded, bytes: gzipped.byteLength, loadMs, readMs };
}
