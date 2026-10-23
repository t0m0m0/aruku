// 厳密走査（exact-scan.ts）を1回の検索として回し、exactWalkMax の応答を組み立てる（#459・epic #456）。
// IO（パックの読み込み・Google マトリクス）は deps で受け、ここは HTTP を知らない。

import {
  bestRides,
  pickStopsToMeasure,
  type CompiledTimetable,
  type LatLng,
  type Ride,
  type TimetableStop,
} from "./exact-scan";

const MAX_STOPS_PER_SIDE = 12;
/** 1検索で Google マトリクスに投げる要素数の上限（出発地→乗車候補 ＋ 降車候補→目的地）。 */
export const EXACT_WALK_MAX_ELEMENTS = MAX_STOPS_PER_SIDE * 2;
const MAX_CANDIDATES = 5;
const MAX_BUDGET_MIN = 24 * 60;

const JST_OFFSET_MS = 9 * 3600 * 1000;

export interface ExactWalkMaxRequest {
  origin: LatLng;
  goal: LatLng;
  departAt: Date;
  budgetMin: number;
}

export interface MatrixElement {
  originIndex: number;
  destinationIndex: number;
  durationSec: number;
  distanceMeters: number;
}

export interface ScanDay {
  compiled: CompiledTimetable;
  stops: readonly TimetableStop[];
  feeds: readonly FeedFetchedAt[];
}

export interface FeedFetchedAt {
  id: string;
  /** ISO 8601。基本ライセンスで表示が要る「取得日時」。 */
  fetchedAt: string;
}

export interface ExactWalkMaxDeps {
  /** 運行日（YYYYMMDD）の時刻表。読めるパックが1つも無ければ null。 */
  day: (serviceDate: string) => Promise<ScanDay | null>;
  /** 徒歩の実測。経路の無い要素は返さなくてよい。 */
  measure: (origins: LatLng[], destinations: LatLng[]) => Promise<MatrixElement[]>;
}

export interface Walk {
  durationSec: number;
  distanceMeters: number;
}

export interface ExactWalkCandidate {
  board: TimetableStop;
  alight: TimetableStop;
  route: string;
  headsign: string | null;
  boardAt: string;
  alightAt: string;
  /** 乗車駅から降車駅までの停車駅の座標（両端を含む）。 */
  stops: LatLng[];
  accessWalk: Walk;
  egressWalk: Walk;
}

export interface ExactWalkMaxResponse {
  candidates: ExactWalkCandidate[];
  feeds: FeedFetchedAt[];
  stats: {
    tripsScanned: number;
    elementsMeasured: number;
    /** 実測する駅を片側 12 駅で打ち切ったか。 */
    truncated: boolean;
  };
}

type Query = Record<string, string | undefined>;

export function parseExactWalkMaxQuery(query: Query): ExactWalkMaxRequest | { error: string } {
  const origin = parsePoint(query["origin"]);
  const goal = parsePoint(query["goal"]);
  if (origin === null || goal === null) {
    return { error: "origin and goal are required as 'lat,lng'" };
  }
  const departAt = parseInstant(query["departAt"]);
  if (departAt === null) {
    return { error: "departAt is required as ISO 8601 with a UTC offset" };
  }
  const budgetMin = Number(query["budgetMin"]);
  if (!Number.isInteger(budgetMin) || budgetMin < 1 || budgetMin > MAX_BUDGET_MIN) {
    return { error: `budgetMin must be an integer in 1..${MAX_BUDGET_MIN}` };
  }
  return { origin, goal, departAt, budgetMin };
}

function parsePoint(value: string | undefined): LatLng | null {
  const parts = (value ?? "").split(",");
  if (parts.length !== 2 || parts.some((p) => p.trim() === "")) return null;
  const [lat, lng] = parts.map(Number);
  if (!(Math.abs(lat) <= 90) || !(Math.abs(lng) <= 180)) return null;
  return { lat, lng };
}

// 時差の無い時刻は受けない。サーバ（UTC）とブラウザ（JST）で読み方が変わり、9時間ずれた運行日を引くため。
function parseInstant(value: string | undefined): Date | null {
  if (value === undefined || !/(Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/**
 * JST の日付を運行日（YYYYMMDD）とし、その0時からの秒を返す。
 *
 * 締切が翌日に掛かっても翌日の運行日の便は引かない。翌日の便が出るのは始発（4時台）以降で、
 * そこまで予算が届く検索は終電後に歩き通すものしか無いため。
 */
export function toServiceTime(at: Date): { serviceDate: string; sec: number } {
  const jst = new Date(at.getTime() + JST_OFFSET_MS);
  const serviceDate =
    String(jst.getUTCFullYear()) + pad2(jst.getUTCMonth() + 1) + pad2(jst.getUTCDate());
  const sec = jst.getUTCHours() * 3600 + jst.getUTCMinutes() * 60 + jst.getUTCSeconds();
  return { serviceDate, sec };
}

/** 厳密走査で徒歩最大の候補を返す。読めるパックが無ければ null。 */
export async function findExactWalkMax(
  req: ExactWalkMaxRequest,
  deps: ExactWalkMaxDeps,
): Promise<ExactWalkMaxResponse | null> {
  const { serviceDate, sec } = toServiceTime(req.departAt);
  const day = await deps.day(serviceDate);
  if (day === null) return null;
  const { compiled: ct } = day;
  const q = { origin: req.origin, goal: req.goal, departAt: sec, budgetMin: req.budgetMin };

  const picked = pickStopsToMeasure(ct, q, { maxPerSide: MAX_STOPS_PER_SIDE });
  const stats = {
    tripsScanned: picked.tripsScanned,
    elementsMeasured: picked.boards.length + picked.alights.length,
    truncated: picked.truncated,
  };
  const feeds = day.feeds.map(({ id, fetchedAt }) => ({ id, fetchedAt }));
  if (picked.boards.length === 0 || picked.alights.length === 0) {
    return { candidates: [], feeds, stats: { ...stats, elementsMeasured: 0 } };
  }

  const coordOf = (s: number): LatLng => ({ lat: ct.stopLat[s], lng: ct.stopLng[s] });
  const [accessRows, egressRows] = await Promise.all([
    deps.measure([req.origin], picked.boards.map(coordOf)),
    deps.measure(picked.alights.map(coordOf), [req.goal]),
  ]);
  const access = walksByStop(accessRows, picked.boards, (e) => e.destinationIndex);
  const egress = walksByStop(egressRows, picked.alights, (e) => e.originIndex);

  const rides = bestRides(
    ct,
    q,
    {
      access: new Map([...access].map(([s, w]) => [s, w.durationSec])),
      egress: new Map([...egress].map(([s, w]) => [s, w.durationSec])),
    },
    { k: MAX_CANDIDATES },
  );
  const midnight = serviceMidnightMs(serviceDate);
  const candidates = rides.map((ride) => ({
    board: stationOf(day.stops[ride.board]),
    alight: stationOf(day.stops[ride.alight]),
    route: ct.trips[ride.trip].route,
    headsign: ct.trips[ride.trip].headsign,
    boardAt: formatJst(midnight + ride.boardAt * 1000),
    alightAt: formatJst(midnight + ride.alightAt * 1000),
    stops: rideStops(ct, ride).map(coordOf),
    accessWalk: access.get(ride.board)!,
    egressWalk: egress.get(ride.alight)!,
  }));
  return { candidates, feeds, stats };
}

// パックの駅は feed・station の添字も持つ。応答に載せるものは列挙して選ぶ。
function stationOf({ name, lat, lng }: TimetableStop): TimetableStop {
  return { name, lat, lng };
}

function walksByStop(
  rows: readonly MatrixElement[],
  stops: readonly number[],
  indexOf: (e: MatrixElement) => number,
): Map<number, Walk> {
  const out = new Map<number, Walk>();
  for (const e of rows) {
    const stop = stops[indexOf(e)];
    if (stop === undefined || !Number.isFinite(e.durationSec)) continue;
    out.set(stop, { durationSec: e.durationSec, distanceMeters: e.distanceMeters });
  }
  return out;
}

/** 乗車から降車までの停車駅。同じ駅に戻る便があるので、駅ではなく発着時刻で位置を決める。 */
function rideStops(ct: CompiledTimetable, ride: Ride): number[] {
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
  return String(n).padStart(2, "0");
}
