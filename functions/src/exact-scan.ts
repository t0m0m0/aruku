// 1回乗車（徒歩→乗車→徒歩）で、締切までに目的地へ着ける中で徒歩が最大になる
// 「乗車駅・便・降車駅」を、時刻表を走査して厳密に求める（#458・epic #456）。
//
// 呼び出し側（#459）は次の順に使う:
//   1. pickStopsToMeasure: 直線の徒歩で全便を走査し、実測する駅を選ぶ
//   2. 選んだ駅の徒歩を Google マトリクスで実測する
//   3. bestRides: 実測値で走査し直し、徒歩最大の候補を返す
//
// bestJourneys は乗換1回（徒歩→乗車→徒歩→乗車→徒歩）まで広げた実験版（#474・
// docs/notes/exact-scan-one-transfer.md）。exactWalkMax にはまだ配線していない。

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

export interface StopsToMeasure {
  boards: number[];
  alights: number[];
  /** 締切までに乗れる発車があり、1パス目で走査した便の数。 */
  tripsScanned: number;
  /** 組の上位から拾える駅が maxPerSide を超え、どちらかの側で駅を落としたか。 */
  truncated: boolean;
}

/**
 * 直線の徒歩（実際の徒歩の下限）で全便を走査し、Google マトリクスで実測する駅を選ぶ。
 * 乗車側・降車側とも最大 maxPerSide 駅。
 */
export function pickStopsToMeasure(
  ct: CompiledTimetable,
  q: ScanQuery,
  opts: { maxPerSide?: number } = {},
): StopsToMeasure {
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
  const { pairs, tripsScanned } = bestPairPerTrip(ct, q, access, egress);
  pairs.sort((a, b) => b.walk - a.walk || a.trip - b.trip);
  const boards = new Set<number>();
  const alights = new Set<number>();
  for (const p of pairs) {
    boards.add(ct.callStop[p.boardCall]);
    alights.add(ct.callStop[p.alightCall]);
  }
  return {
    boards: [...boards].slice(0, maxPerSide),
    alights: [...alights].slice(0, maxPerSide),
    tripsScanned,
    truncated: boards.size > maxPerSide || alights.size > maxPerSide,
  };
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

/** 駅の所属。同じフィードで同じ station の stop は、同じ駅として乗り換える。 */
export interface StationKey {
  feed: number;
  station: number;
}

/**
 * 駅 a から乗り換えられる駅（a 自身を含む）。start[a]〜start[a+1] が駅 a の分で、徒歩の短い順。
 * 同じ駅の stop は徒歩0で先頭に入る。
 */
export interface TransferNeighbors {
  readonly start: Int32Array;
  readonly stop: Int32Array;
  readonly walkSec: Float64Array;
  /** 同じ駅への乗換。徒歩0の代わりに、最小乗換時間を待つ。 */
  readonly sameStation: Uint8Array;
}

/**
 * 乗換の近傍の表を作る。同じ駅（stations が同じフィード・同じ station）の stop は徒歩0、
 * それ以外は直線の徒歩が maxWalkSec 以下の stop を入れる。
 *
 * 会社をまたぐ同名駅を同じ駅にしないのは、同じ駅の乗換には徒歩区間が無く、enrich が実測できないため。
 * 歩く乗換にしておけば、伸びた徒歩で2本目に乗り遅れる経路を firstMissedTransit が落とせる。
 */
export function transferNeighbors(
  ct: CompiledTimetable,
  stations: readonly StationKey[],
  opts: { maxWalkSec: number },
): TransferNeighbors {
  const n = ct.stopCount;
  const lists: { stop: number; walkSec: number; same: boolean }[][] = Array.from(
    { length: n },
    () => [],
  );
  const sameKey = (s: number) => `${stations[s].feed}:${stations[s].station}`;
  const members = new Map<string, number[]>();
  for (let s = 0; s < n; s++) {
    const key = sameKey(s);
    const list = members.get(key);
    if (list === undefined) members.set(key, [s]);
    else list.push(s);
  }
  for (const group of members.values()) {
    for (const a of group) for (const b of group) lists[a].push({ stop: b, walkSec: 0, same: true });
  }

  const maxMeters = (opts.maxWalkSec / 60) * WALK_METERS_PER_MINUTE;
  const maxLatDeg = (maxMeters / EARTH_RADIUS_M) * (180 / Math.PI);
  const byLat = Array.from({ length: n }, (_, s) => s).sort(
    (a, b) => ct.stopLat[a] - ct.stopLat[b],
  );
  for (let i = 0; i < n; i++) {
    const a = byLat[i];
    for (let j = i + 1; j < n && ct.stopLat[byLat[j]] - ct.stopLat[a] <= maxLatDeg; j++) {
      const b = byLat[j];
      if (sameKey(a) === sameKey(b)) continue;
      // 秒に丸めないと、直線距離の浮動小数の誤差で「到着＋徒歩ちょうど」に発つ便を落とす。
      const walkSec = Math.round(
        straightWalkSec({ lat: ct.stopLat[a], lng: ct.stopLng[a] }, ct.stopLat[b], ct.stopLng[b]),
      );
      if (walkSec > opts.maxWalkSec) continue;
      lists[a].push({ stop: b, walkSec, same: false });
      lists[b].push({ stop: a, walkSec, same: false });
    }
  }

  const start = new Int32Array(n + 1);
  for (let s = 0; s < n; s++) start[s + 1] = start[s] + lists[s].length;
  const stop = new Int32Array(start[n]);
  const walkSec = new Float64Array(start[n]);
  const sameStation = new Uint8Array(start[n]);
  for (let s = 0; s < n; s++) {
    lists[s].sort(
      (x, y) => x.walkSec - y.walkSec || Number(y.same) - Number(x.same) || x.stop - y.stop,
    );
    lists[s].forEach((e, i) => {
      stop[start[s] + i] = e.stop;
      walkSec[start[s] + i] = e.walkSec;
      sameStation[start[s] + i] = e.same ? 1 : 0;
    });
  }
  return { start, stop, walkSec, sameStation };
}

/** どのフィードにも transfers.txt が無いので、同じ駅の乗換に課す最小乗換時間はここで決める（#474）。 */
export const DEFAULT_MIN_TRANSFER_SEC = 180;

export interface JourneyLeg {
  trip: number;
  board: number;
  alight: number;
  boardAt: number;
  alightAt: number;
}

/** 乗換0回か1回の経路。transferSec は乗換の徒歩（同じ駅の乗換と乗換0回は 0）。 */
export interface Journey {
  legs: JourneyLeg[];
  accessSec: number;
  transferSec: number;
  egressSec: number;
  walkSec: number;
  /** 目的地への到着。運行日の0時からの秒。 */
  arriveAt: number;
}

interface ScanScratch {
  stamp: number;
  tripV0: Int32Array;
  tripV1: Int32Array;
  stopP0: Int32Array;
  callV0: Float64Array;
  callV1: Float64Array;
  depP0: Float64Array;
  /** 駅ごとの、締切より後の最初の発車の添字。depP0 はそこより手前だけが有効。 */
  stopP0End: Int32Array;
}

// 検索ごとに作り直すと、時刻表の停車の数だけの配列を毎回確保することになる。
// bestJourneys は同期で走るので、同じ時刻表の検索どうしで共有しても混ざらない。
const scratchOf = new WeakMap<CompiledTimetable, ScanScratch>();

function scratchFor(ct: CompiledTimetable): ScanScratch {
  let s = scratchOf.get(ct);
  if (s === undefined) {
    const callCount = ct.callStop.length;
    s = {
      stamp: 0,
      tripV0: new Int32Array(ct.tripCount),
      tripV1: new Int32Array(ct.tripCount),
      stopP0: new Int32Array(ct.stopCount),
      callV0: new Float64Array(callCount),
      callV1: new Float64Array(callCount),
      depP0: new Float64Array(ct.departureAt.length),
      stopP0End: new Int32Array(ct.stopCount),
    };
    scratchOf.set(ct, s);
  }
  s.stamp++;
  return s;
}

// 上界は「ここまでの徒歩 ＋ 先の最大」の順に、経路の徒歩は区間の順に足すので、浮動小数では
// 同じ値が 1 ulp ずれ得る。ずれで k 番目と同じ徒歩の枝を切らないよう、余裕を持たせて比べる。
const PRUNE_SLACK_SEC = 1e-6;

/**
 * 実測した徒歩で、乗換1回までの徒歩最大の経路を上位 k 本返す。並びは徒歩の長い順、
 * 同じ徒歩なら目的地への到着が早い順、それも同じなら乗換の少ない順。乗換0回は
 * （乗車駅, 降車駅）、乗換1回は（乗車駅, 降車駅, 乗換先, 降車駅）ごとに1本にまとめる。
 *
 * 乗換の徒歩は neighbors の値（直線）を使う。neighbors が null なら乗換0回だけを返す。
 */
export function bestJourneys(
  ct: CompiledTimetable,
  q: ScanQuery,
  measured: MeasuredWalks,
  neighbors: TransferNeighbors | null,
  opts: { k?: number; minTransferSec?: number } = {},
): Journey[] {
  const k = opts.k ?? 5;
  const minTransferSec = opts.minTransferSec ?? DEFAULT_MIN_TRANSFER_SEC;
  const deadline = q.departAt + q.budgetMin * 60;
  const access = new Float64Array(ct.stopCount).fill(Infinity);
  const egress = new Float64Array(ct.stopCount).fill(Infinity);
  for (const [s, sec] of measured.access) access[s] = sec;
  for (const [s, sec] of measured.egress) egress[s] = sec;
  const sc = scratchFor(ct);
  const callOf = (i: number) => ct.tripStart[ct.departureTrip[i]] + ct.departurePos[i];
  const departuresEnd = (s: number) =>
    upperBound(ct.departureAt, ct.departureStart[s], ct.departureStart[s + 1], deadline);

  // 設計メモの V0: 停車 c に乗っている状態から、後ろで降りて目的地へ歩くときに稼げる徒歩の最大。
  const ensureTripV0 = (trip: number): void => {
    if (sc.tripV0[trip] === sc.stamp) return;
    sc.tripV0[trip] = sc.stamp;
    const top = new TopTwo();
    for (let c = ct.tripStart[trip] + ct.tripLength[trip] - 1; c >= ct.tripStart[trip]; c--) {
      const s = ct.callStop[c];
      sc.callV0[c] = top.excluding(s);
      if (ct.callAlight[c] && ct.callArr[c] + egress[s] <= deadline) top.offer(egress[s], s);
    }
  };

  // 設計メモの P0: 駅の発車列の後ろからの V0 の累積の最大。
  const ensureStopP0 = (s: number): void => {
    if (sc.stopP0[s] === sc.stamp) return;
    sc.stopP0[s] = sc.stamp;
    const lo = lowerBound(ct.departureAt, ct.departureStart[s], ct.departureStart[s + 1], q.departAt);
    const hi = departuresEnd(s);
    sc.stopP0End[s] = hi;
    let best = -Infinity;
    for (let i = hi - 1; i >= lo; i--) {
      ensureTripV0(ct.departureTrip[i]);
      best = Math.max(best, sc.callV0[callOf(i)]);
      sc.depP0[i] = best;
    }
  };

  const best0 = (s: number, at: number): number => {
    ensureStopP0(s);
    const i = lowerBound(ct.departureAt, ct.departureStart[s], sc.stopP0End[s], at);
    return i < sc.stopP0End[s] ? sc.depP0[i] : -Infinity;
  };

  // 設計メモの V1: 停車 c に乗っている状態から、後ろで降りて、目的地へ歩くか乗り換えるかで稼げる徒歩の最大。
  const ensureTripV1 = (trip: number): void => {
    if (sc.tripV1[trip] === sc.stamp) return;
    sc.tripV1[trip] = sc.stamp;
    const top = new TopTwo();
    for (let c = ct.tripStart[trip] + ct.tripLength[trip] - 1; c >= ct.tripStart[trip]; c--) {
      const s = ct.callStop[c];
      sc.callV1[c] = top.excluding(s);
      if (!ct.callAlight[c]) continue;
      const arr = ct.callArr[c];
      let w = arr + egress[s] <= deadline ? egress[s] : -Infinity;
      if (neighbors !== null) {
        for (let e = neighbors.start[s]; e < neighbors.start[s + 1]; e++) {
          const f = neighbors.walkSec[e];
          if (arr + f > deadline) break;
          const ready = arr + f + (neighbors.sameStation[e] ? minTransferSec : 0);
          w = Math.max(w, f + best0(neighbors.stop[e], ready));
        }
      }
      if (w > -Infinity) top.offer(w, s);
    }
  };

  // 上位 k 本の分枝限定。閾値は、見つけた組の徒歩のうち k 番目。
  const found = new Map<string, Journey>();
  const topWalks: number[] = [];
  const threshold = () => (topWalks.length < k ? -Infinity : topWalks[k - 1] - PRUNE_SLACK_SEC);
  const offer = (j: Journey): void => {
    if (j.walkSec < threshold()) return;
    const key = j.legs.map((l) => `${l.board}-${l.alight}`).join("/");
    const prev = found.get(key);
    if (prev === undefined) {
      found.set(key, j);
      topWalks.push(j.walkSec);
      topWalks.sort((a, b) => b - a);
      topWalks.length = Math.min(topWalks.length, k);
    } else if (compareJourneys(j, prev) < 0) {
      found.set(key, j);
    }
  };
  if (k <= 0) return [];

  const boards: { stop: number; lo: number; hi: number; bound: number }[] = [];
  for (let b = 0; b < ct.stopCount; b++) {
    if (!(q.departAt + access[b] <= deadline)) continue;
    const lo = lowerBound(
      ct.departureAt,
      ct.departureStart[b],
      ct.departureStart[b + 1],
      q.departAt + access[b],
    );
    const hi = departuresEnd(b);
    let best1 = -Infinity;
    for (let i = lo; i < hi; i++) {
      ensureTripV1(ct.departureTrip[i]);
      best1 = Math.max(best1, sc.callV1[callOf(i)]);
    }
    if (best1 > -Infinity) boards.push({ stop: b, lo, hi, bound: access[b] + best1 });
  }
  boards.sort((x, y) => y.bound - x.bound || x.stop - y.stop);

  for (const board of boards) {
    if (board.bound < threshold()) break;
    const b = board.stop;
    const accessSec = access[b];
    const departures: { call: number; trip: number; bound: number }[] = [];
    for (let i = board.lo; i < board.hi; i++) {
      const call = callOf(i);
      if (sc.callV1[call] === -Infinity) continue;
      departures.push({ call, trip: ct.departureTrip[i], bound: accessSec + sc.callV1[call] });
    }
    departures.sort((x, y) => y.bound - x.bound || x.call - y.call);

    for (const dep of departures) {
      if (dep.bound < threshold()) break;
      const t1 = dep.trip;
      const end1 = ct.tripStart[t1] + ct.tripLength[t1];
      const transfers: {
        leg1: JourneyLeg;
        to: number;
        walkSec: number;
        ready: number;
        bound: number;
      }[] = [];
      for (let j = dep.call + 1; j < end1; j++) {
        const a1 = ct.callStop[j];
        if (!ct.callAlight[j] || a1 === b) continue;
        const arr = ct.callArr[j];
        const leg1: JourneyLeg = {
          trip: t1,
          board: b,
          alight: a1,
          boardAt: ct.callDep[dep.call],
          alightAt: arr,
        };
        if (arr + egress[a1] <= deadline) {
          offer({
            legs: [leg1],
            accessSec,
            transferSec: 0,
            egressSec: egress[a1],
            walkSec: accessSec + egress[a1],
            arriveAt: arr + egress[a1],
          });
        }
        if (neighbors === null) continue;
        for (let e = neighbors.start[a1]; e < neighbors.start[a1 + 1]; e++) {
          const f = neighbors.walkSec[e];
          if (arr + f > deadline) break;
          const ready = arr + f + (neighbors.sameStation[e] ? minTransferSec : 0);
          const to = neighbors.stop[e];
          const bound = accessSec + f + best0(to, ready);
          if (bound > -Infinity && bound >= threshold()) transfers.push({ leg1, to, walkSec: f, ready, bound });
        }
      }
      transfers.sort((x, y) => y.bound - x.bound);

      for (const tr of transfers) {
        if (tr.bound < threshold()) break;
        const s2 = tr.to;
        const hi = sc.stopP0End[s2];
        for (
          let i = lowerBound(ct.departureAt, ct.departureStart[s2], hi, tr.ready);
          i < hi;
          i++
        ) {
          const t2 = ct.departureTrip[i];
          const c2 = callOf(i);
          if (t2 === t1 || accessSec + tr.walkSec + sc.callV0[c2] < threshold()) continue;
          const end2 = ct.tripStart[t2] + ct.tripLength[t2];
          for (let j2 = c2 + 1; j2 < end2; j2++) {
            const a2 = ct.callStop[j2];
            const arr2 = ct.callArr[j2];
            if (!ct.callAlight[j2] || a2 === s2 || !(arr2 + egress[a2] <= deadline)) continue;
            offer({
              legs: [
                tr.leg1,
                { trip: t2, board: s2, alight: a2, boardAt: ct.callDep[c2], alightAt: arr2 },
              ],
              accessSec,
              transferSec: tr.walkSec,
              egressSec: egress[a2],
              walkSec: accessSec + tr.walkSec + egress[a2],
              arriveAt: arr2 + egress[a2],
            });
          }
        }
      }
    }
  }
  return [...found.values()].sort(compareJourneys).slice(0, k);
}

/**
 * 降車駅が互いに違う上位2つの徒歩。乗った駅と同じ駅では降りないので、1位がその駅なら2位を使う。
 *
 * 1つだけでも上界としては正しい（大きく出るだけ）。分枝限定は経路を組み立てて乗った駅での降車を
 * 弾くので、答えは変わらない。2つ持つのは、B → C → B と回る便で2回目の B の値が上界に混ざり、
 * 枝が切れなくなるのを避けるため。
 */
class TopTwo {
  private v1 = -Infinity;
  private s1 = -1;
  private v2 = -Infinity;
  private s2 = -1;

  offer(value: number, stop: number): void {
    if (stop === this.s1) {
      this.v1 = Math.max(this.v1, value);
    } else if (stop === this.s2) {
      this.v2 = Math.max(this.v2, value);
      if (this.v2 > this.v1) {
        [this.v1, this.s1, this.v2, this.s2] = [this.v2, this.s2, this.v1, this.s1];
      }
    } else if (value > this.v1) {
      [this.v2, this.s2] = [this.v1, this.s1];
      [this.v1, this.s1] = [value, stop];
    } else if (value > this.v2) {
      [this.v2, this.s2] = [value, stop];
    }
  }

  excluding(stop: number): number {
    return this.s1 !== stop ? this.v1 : this.v2;
  }
}

function compareJourneys(a: Journey, b: Journey): number {
  const d = b.walkSec - a.walkSec || a.arriveAt - b.arriveAt || a.legs.length - b.legs.length;
  if (d !== 0) return d;
  for (let i = 0; i < a.legs.length; i++) {
    const x = a.legs[i];
    const y = b.legs[i];
    const e =
      x.trip - y.trip ||
      x.boardAt - y.boardAt ||
      x.alightAt - y.alightAt ||
      x.board - y.board ||
      x.alight - y.alight;
    if (e !== 0) return e;
  }
  return 0;
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
): { pairs: TripPair[]; tripsScanned: number } {
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
  return { pairs, tripsScanned: trips.length };
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

function upperBound(arr: Int32Array, lo: number, hi: number, value: number): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (arr[mid] <= value) lo = mid + 1;
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
