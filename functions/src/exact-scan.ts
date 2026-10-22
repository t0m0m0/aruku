// 1回乗車（徒歩→乗車→徒歩）で、締切までに目的地へ着ける中で徒歩が最大になる
// 「乗車駅・便・降車駅」を、時刻表を走査して厳密に求める（#458・epic #456）。
//
// 呼び出し側（#459）は次の順に使う:
//   1. pickStopsToMeasure: 直線の徒歩で全便を走査し、実測する駅を選ぶ
//   2. 選んだ駅の徒歩を Google マトリクスで実測する
//   3. bestRides: 実測値で走査し直し、徒歩最大の候補を返す

export interface LatLng {
  lat: number;
  lng: number;
}

export interface TimetableStop extends LatLng {
  name: string;
}

/** 便が1つの駅に止まる1回分。時刻は運行日の0時からの秒。 */
export interface StopCall {
  stop: number;
  arr: number;
  dep: number;
  canBoard: boolean;
  canAlight: boolean;
}

export interface TimetableTrip {
  route: string;
  headsign: string | null;
  /** 停車順。通過駅は含めない。 */
  calls: StopCall[];
}

export interface Timetable {
  stops: TimetableStop[];
  trips: TimetableTrip[];
}

export interface CompiledTimetable {
  readonly stopCount: number;
  readonly tripCount: number;
  readonly stopLat: Float64Array;
  readonly stopLng: Float64Array;
  readonly trips: ReadonlyArray<Pick<TimetableTrip, "route" | "headsign">>;
  readonly tripStart: Int32Array;
  readonly tripLength: Int32Array;
  readonly callStop: Int32Array;
  readonly callArr: Int32Array;
  readonly callDep: Int32Array;
  readonly callBoard: Uint8Array;
  readonly callAlight: Uint8Array;
  /** 駅ごとの「乗車できる発車」。departureStart[s]〜departureStart[s+1] が駅 s の分で、発車時刻の昇順。 */
  readonly departureStart: Int32Array;
  readonly departureTrip: Int32Array;
  readonly departurePos: Int32Array;
  readonly departureAt: Int32Array;
}

export interface ScanQuery {
  origin: LatLng;
  goal: LatLng;
  /** 運行日の0時からの秒。 */
  departAt: number;
  budgetMin: number;
}

/** 実測した徒歩の秒数。access は出発地→駅、egress は駅→目的地。 */
export interface MeasuredWalks {
  access: ReadonlyMap<number, number>;
  egress: ReadonlyMap<number, number>;
}

export interface Ride {
  trip: number;
  board: number;
  alight: number;
  boardAt: number;
  alightAt: number;
  accessSec: number;
  egressSec: number;
  walkSec: number;
}

// packages/engine の walkMetersPerMinute と同じ値。import しないのは、デプロイされるのが
// functions/ の中身だけで、エンジンのパッケージを参照できないため。
export const WALK_METERS_PER_MINUTE = 80;
const EARTH_RADIUS_M = 6371008.8;

export function compileTimetable(tt: Timetable): CompiledTimetable {
  const stopCount = tt.stops.length;
  const tripCount = tt.trips.length;
  let callCount = 0;
  for (const trip of tt.trips) callCount += trip.calls.length;

  const tripStart = new Int32Array(tripCount);
  const tripLength = new Int32Array(tripCount);
  const callStop = new Int32Array(callCount);
  const callArr = new Int32Array(callCount);
  const callDep = new Int32Array(callCount);
  const callBoard = new Uint8Array(callCount);
  const callAlight = new Uint8Array(callCount);
  const departureCount = new Int32Array(stopCount + 1);
  let k = 0;
  tt.trips.forEach((trip, i) => {
    tripStart[i] = k;
    tripLength[i] = trip.calls.length;
    for (const c of trip.calls) {
      callStop[k] = c.stop;
      callArr[k] = c.arr;
      callDep[k] = c.dep;
      callBoard[k] = c.canBoard ? 1 : 0;
      callAlight[k] = c.canAlight ? 1 : 0;
      if (c.canBoard) departureCount[c.stop + 1]++;
      k++;
    }
  });

  const departureStart = new Int32Array(stopCount + 1);
  for (let s = 0; s < stopCount; s++) {
    departureStart[s + 1] = departureStart[s] + departureCount[s + 1];
  }
  const total = departureStart[stopCount];
  const order: { trip: number; pos: number; at: number }[][] = Array.from(
    { length: stopCount },
    () => [],
  );
  for (let trip = 0; trip < tripCount; trip++) {
    for (let pos = 0; pos < tripLength[trip]; pos++) {
      const c = tripStart[trip] + pos;
      if (callBoard[c]) order[callStop[c]].push({ trip, pos, at: callDep[c] });
    }
  }
  const departureTrip = new Int32Array(total);
  const departurePos = new Int32Array(total);
  const departureAt = new Int32Array(total);
  for (let s = 0; s < stopCount; s++) {
    order[s].sort((a, b) => a.at - b.at);
    order[s].forEach((d, j) => {
      const i = departureStart[s] + j;
      departureTrip[i] = d.trip;
      departurePos[i] = d.pos;
      departureAt[i] = d.at;
    });
  }

  return {
    stopCount,
    tripCount,
    stopLat: Float64Array.from(tt.stops, (s) => s.lat),
    stopLng: Float64Array.from(tt.stops, (s) => s.lng),
    trips: tt.trips.map(({ route, headsign }) => ({ route, headsign })),
    tripStart,
    tripLength,
    callStop,
    callArr,
    callDep,
    callBoard,
    callAlight,
    departureStart,
    departureTrip,
    departurePos,
    departureAt,
  };
}

/**
 * 直線の徒歩（実際の徒歩の下限）で全便を走査し、Google マトリクスで実測する駅を選ぶ。
 * 乗車側・降車側とも最大 maxPerSide 駅。
 */
export function pickStopsToMeasure(
  ct: CompiledTimetable,
  q: ScanQuery,
  opts: { maxPerSide?: number } = {},
): { boards: number[]; alights: number[] } {
  const maxPerSide = opts.maxPerSide ?? 12;
  const access = new Float64Array(ct.stopCount);
  const egress = new Float64Array(ct.stopCount);
  for (let s = 0; s < ct.stopCount; s++) {
    access[s] = straightWalkSec(q.origin, ct.stopLat[s], ct.stopLng[s]);
    egress[s] = straightWalkSec(q.goal, ct.stopLat[s], ct.stopLng[s]);
  }

  // 乗車側と降車側を別々に「徒歩が長い順」で選ばないのは、同じ便で結べない駅ばかり
  // 残って2パス目が空振りするため（駅の多い JR で顕著。試作で解けた検索が 10%→21%）。
  // 便ごとの最良の組を徒歩の長い順に並べ、その上位から両側を拾う。
  const pairs = bestPairPerTrip(ct, q, access, egress).sort(
    (a, b) => b.walk - a.walk || a.trip - b.trip,
  );
  const boards: number[] = [];
  const alights: number[] = [];
  for (const p of pairs) {
    const b = ct.callStop[p.boardCall];
    const a = ct.callStop[p.alightCall];
    if (boards.length < maxPerSide && !boards.includes(b)) boards.push(b);
    if (alights.length < maxPerSide && !alights.includes(a)) alights.push(a);
    if (boards.length >= maxPerSide && alights.length >= maxPerSide) break;
  }
  return { boards, alights };
}

/**
 * 実測した徒歩で全便を走査し、徒歩最大の候補を上位 k 本返す。並びは徒歩の長い順、
 * 同じ徒歩なら目的地への到着が早い順。同じ乗車駅・降車駅の組は1本にまとめ、
 * 目的地への到着が最も早い便を残す。
 */
export function bestRides(
  ct: CompiledTimetable,
  q: ScanQuery,
  measured: MeasuredWalks,
  opts: { k?: number } = {},
): Ride[] {
  const k = opts.k ?? 5;
  const deadline = q.departAt + q.budgetMin * 60;
  const access = new Float64Array(ct.stopCount).fill(Infinity);
  const egress = new Float64Array(ct.stopCount).fill(Infinity);
  for (const [s, sec] of measured.access) access[s] = sec;
  for (const [s, sec] of measured.egress) egress[s] = sec;

  // pickStopsToMeasure のように便ごとの最良の1組だけを残すと、同じ便の2番手の組が
  // 上位 k 本から漏れる。全組を作っても、乗れる駅は実測した駅に限られるので数は小さい。
  const byPair = new Map<number, Ride>();
  const { trips, firstPos } = boardableTrips(ct, q, access);
  for (const trip of trips) {
    const start = ct.tripStart[trip];
    const end = start + ct.tripLength[trip];
    const boardCalls: number[] = [];
    for (let c = start + firstPos[trip]; c < end; c++) {
      const s = ct.callStop[c];
      if (ct.callAlight[c] && ct.callArr[c] + egress[s] <= deadline) {
        for (const b of boardCalls) {
          const board = ct.callStop[b];
          if (board === s) continue;
          const ride: Ride = {
            trip,
            board,
            alight: s,
            boardAt: ct.callDep[b],
            alightAt: ct.callArr[c],
            accessSec: access[board],
            egressSec: egress[s],
            walkSec: access[board] + egress[s],
          };
          const key = board * ct.stopCount + s;
          const prev = byPair.get(key);
          if (prev === undefined || compareRides(ride, prev) < 0) byPair.set(key, ride);
        }
      }
      if (
        ct.callBoard[c] &&
        q.departAt + access[s] <= ct.callDep[c] &&
        !boardCalls.some((b) => ct.callStop[b] === s)
      ) {
        boardCalls.push(c);
      }
    }
  }
  return [...byPair.values()].sort(compareRides).slice(0, k);
}

function compareRides(a: Ride, b: Ride): number {
  return (
    b.walkSec - a.walkSec ||
    a.alightAt + a.egressSec - (b.alightAt + b.egressSec) ||
    a.trip - b.trip
  );
}

interface TripPair {
  trip: number;
  boardCall: number;
  alightCall: number;
  walk: number;
}

/**
 * 便ごとに、乗れる駅で乗り、降りられる別の駅で降りる組のうち徒歩最大の1組を返す。
 * access/egress は駅ごとの徒歩の秒数で、Infinity の駅は使わない。
 */
function bestPairPerTrip(
  ct: CompiledTimetable,
  q: ScanQuery,
  access: Float64Array,
  egress: Float64Array,
): TripPair[] {
  const deadline = q.departAt + q.budgetMin * 60;
  const { trips, firstPos } = boardableTrips(ct, q, access);

  const pairs: TripPair[] = [];
  for (const trip of trips) {
    const start = ct.tripStart[trip];
    const end = start + ct.tripLength[trip];
    // 徒歩最大の乗車と、それと駅の違う乗車の中で徒歩最大のもの。同じ駅に戻ってくる便で、
    // 降車駅が最大の乗車駅と同じでも、別の駅からの乗車を候補に残すため2つ持つ。
    let best = -1;
    let runnerUp = -1;
    let found: TripPair | null = null;
    for (let c = start + firstPos[trip]; c < end; c++) {
      const s = ct.callStop[c];
      if (ct.callAlight[c] && ct.callArr[c] + egress[s] <= deadline) {
        const board = best >= 0 && ct.callStop[best] !== s ? best : runnerUp;
        if (board >= 0) {
          const walk = access[ct.callStop[board]] + egress[s];
          if (found === null || walk > found.walk) {
            found = { trip, boardCall: board, alightCall: c, walk };
          }
        }
      }
      if (ct.callBoard[c] && q.departAt + access[s] <= ct.callDep[c]) {
        if (best < 0 || access[s] > access[ct.callStop[best]]) {
          runnerUp = best;
          best = c;
        } else if (
          ct.callStop[best] !== s &&
          (runnerUp < 0 || access[s] > access[ct.callStop[runnerUp]])
        ) {
          runnerUp = c;
        }
      }
    }
    if (found !== null) pairs.push(found);
  }
  return pairs;
}

/** 締切までに乗れる発車がある便と、便ごとに乗れる最初の停車位置。 */
function boardableTrips(
  ct: CompiledTimetable,
  q: ScanQuery,
  access: Float64Array,
): { trips: number[]; firstPos: Int32Array } {
  const deadline = q.departAt + q.budgetMin * 60;
  const firstPos = new Int32Array(ct.tripCount).fill(-1);
  const touched: number[] = [];
  for (let s = 0; s < ct.stopCount; s++) {
    const earliest = q.departAt + access[s];
    if (!(earliest <= deadline)) continue;
    const end = ct.departureStart[s + 1];
    for (
      let i = lowerBound(ct.departureAt, ct.departureStart[s], end, earliest);
      i < end && ct.departureAt[i] <= deadline;
      i++
    ) {
      const trip = ct.departureTrip[i];
      const pos = ct.departurePos[i];
      if (firstPos[trip] === -1) touched.push(trip);
      if (firstPos[trip] === -1 || pos < firstPos[trip]) firstPos[trip] = pos;
    }
  }
  return { trips: touched, firstPos };
}

function lowerBound(arr: Int32Array, lo: number, hi: number, value: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function straightWalkSec(p: LatLng, lat: number, lng: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat - p.lat) * toRad;
  const dLng = (lng - p.lng) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(p.lat * toRad) * Math.cos(lat * toRad) * Math.sin(dLng / 2) ** 2;
  const meters = 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
  return (meters / WALK_METERS_PER_MINUTE) * 60;
}
