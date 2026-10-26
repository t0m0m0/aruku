import { describe, expect, it } from "vitest";

import {
  bestJourneys,
  bestRides,
  compileTimetable,
  transferNeighbors,
  type CompiledTimetable,
  type Journey,
  type LatLng,
  type MeasuredWalks,
  type ScanQuery,
  type StopCall,
  type Timetable,
  type TransferNeighbors,
} from "../src/exact-scan";

// 同じ経線上に km 単位で点を置く（exact-scan.test.ts と同じ）。2点の直線距離が km の差に一致する。
const EARTH_RADIUS_KM = 6371.0088;
const pointAtKm = (km: number): LatLng => ({
  lat: 35 + (km / EARTH_RADIUS_KM) * (180 / Math.PI),
  lng: 139.7,
});

const t = (hh: number, mm: number): number => hh * 3600 + mm * 60;
const min = (m: number): number => m * 60;

const call = (
  stop: number,
  at: number,
  flags: Partial<Pick<StopCall, "canBoard" | "canAlight">> = {},
): StopCall => ({
  stop,
  arr: at,
  dep: at,
  canBoard: flags.canBoard ?? true,
  canAlight: flags.canAlight ?? true,
});

const timetable = (stopKms: number[], trips: { calls: StopCall[] }[]): Timetable => ({
  stops: stopKms.map((km, i) => ({ name: `S${i}`, ...pointAtKm(km) })),
  trips: trips.map((trip, i) => ({ route: `R${i}`, headsign: null, calls: trip.calls })),
});

const measured = (
  access: Record<number, number>,
  egress: Record<number, number>,
): MeasuredWalks => ({
  access: new Map(Object.entries(access).map(([k, v]) => [Number(k), v])),
  egress: new Map(Object.entries(egress).map(([k, v]) => [Number(k), v])),
});

const query = (budgetMin: number, departAt = t(10, 0)): ScanQuery => ({
  origin: pointAtKm(-50),
  goal: pointAtKm(50),
  departAt,
  budgetMin,
});

/** 駅ごとに別のフィード・別の駅として扱う（同じ駅の乗換は自分自身の stop だけ）。 */
const separateStations = (n: number) => Array.from({ length: n }, (_, i) => ({ feed: 0, station: i }));

// 1 km = 750 秒。駅を km の位置で並べたとき、乗換の徒歩は km の差 × 750 秒になる。
const KM = 750;

const legsOf = (j: Journey) => j.legs.map((l) => [l.trip, l.board, l.alight]);

describe("transferNeighbors", () => {
  it("自分自身を徒歩0の同じ駅として先頭に入れる", () => {
    const ct = compileTimetable(timetable([0, 5], []));

    const n = transferNeighbors(ct, separateStations(2), { maxWalkSec: min(10) });

    expect(neighborsOf(n, 0)[0]).toEqual({ stop: 0, walkSec: 0, sameStation: true });
  });

  it("同じフィードの同じ駅の stop は、離れていても徒歩0の同じ駅として入れる", () => {
    const ct = compileTimetable(timetable([0, 0.3], []));

    const n = transferNeighbors(
      ct,
      [
        { feed: 0, station: 7 },
        { feed: 0, station: 7 },
      ],
      { maxWalkSec: min(10) },
    );

    expect(neighborsOf(n, 0)).toEqual([
      { stop: 0, walkSec: 0, sameStation: true },
      { stop: 1, walkSec: 0, sameStation: true },
    ]);
  });

  it("別のフィードの同じ駅は、同じ駅とせず直線の徒歩で入れる", () => {
    const ct = compileTimetable(timetable([0, 0.3], []));

    const n = transferNeighbors(
      ct,
      [
        { feed: 0, station: 7 },
        { feed: 1, station: 7 },
      ],
      { maxWalkSec: min(10) },
    );

    const [, other] = neighborsOf(n, 0);
    expect(other.stop).toBe(1);
    expect(other.sameStation).toBe(false);
    expect(other.walkSec).toBeCloseTo(0.3 * KM, 6);
  });

  it("直線の徒歩が半径を超える駅は入れず、半径ちょうどの駅は入れる", () => {
    // 10分 = 600秒 = 0.8 km
    const ct = compileTimetable(timetable([0, 0.8, 0.81], []));

    const n = transferNeighbors(ct, separateStations(3), { maxWalkSec: min(10) });

    expect(neighborsOf(n, 0).map((x) => x.stop)).toEqual([0, 1]);
  });

  it("徒歩の短い順に並べる", () => {
    const ct = compileTimetable(timetable([0, 0.6, -0.2, 0.4], []));

    const n = transferNeighbors(ct, separateStations(4), { maxWalkSec: min(10) });

    expect(neighborsOf(n, 0).map((x) => x.stop)).toEqual([0, 2, 3, 1]);
  });
});

describe("bestJourneys", () => {
  it("乗換1回のほうが徒歩が長ければ、乗換1回の経路を返す", () => {
    // 駅0 →(便0)→ 駅1、0.4 km 歩いて駅2 →(便1)→ 駅3
    const ct = compileTimetable(
      timetable(
        [0, 10, 10.4, 20],
        [
          { calls: [call(0, t(10, 20)), call(1, t(10, 40))] },
          { calls: [call(2, t(10, 50)), call(3, t(11, 10))] },
        ],
      ),
    );
    const n = transferNeighbors(ct, separateStations(4), { maxWalkSec: min(10) });

    const [best] = bestJourneys(ct, query(120), measured({ 0: min(10) }, { 1: min(5), 3: min(10) }), n);

    expect(legsOf(best)).toEqual([
      [0, 0, 1],
      [1, 2, 3],
    ]);
    expect(best.transferSec).toBeCloseTo(0.4 * KM, 6);
    expect(best.walkSec).toBeCloseTo(min(20) + 0.4 * KM, 6);
    expect(best.arriveAt).toBe(t(11, 20));
  });

  it("乗換の徒歩のあとで2本目が発車済みなら、その乗換は使わない", () => {
    // 駅1着 10:40、駅2まで 0.4 km = 5分。2本目は 10:44 発で間に合わない
    const ct = compileTimetable(
      timetable(
        [0, 10, 10.4, 20],
        [
          { calls: [call(0, t(10, 20)), call(1, t(10, 40))] },
          { calls: [call(2, t(10, 44)), call(3, t(11, 10))] },
        ],
      ),
    );
    const n = transferNeighbors(ct, separateStations(4), { maxWalkSec: min(10) });

    const journeys = bestJourneys(ct, query(120), measured({ 0: min(10) }, { 1: min(5), 3: min(10) }), n);

    expect(journeys.map(legsOf)).toEqual([[[0, 0, 1]]]);
  });

  it("同じ駅の乗換は徒歩0とし、最小乗換時間に満たない接続は使わない", () => {
    // 駅1着 10:40。最小乗換 180 秒なので 10:42:59 発には乗れず、10:43 発には乗れる
    const ct = compileTimetable(
      timetable(
        [0, 10, 20],
        [
          { calls: [call(0, t(10, 20)), call(1, t(10, 40))] },
          { calls: [call(1, t(10, 43) - 1), call(2, t(11, 0))] },
          { calls: [call(1, t(10, 43)), call(2, t(11, 5))] },
        ],
      ),
    );
    const n = transferNeighbors(ct, separateStations(3), { maxWalkSec: min(10) });

    const journeys = bestJourneys(ct, query(120), measured({ 0: min(10) }, { 2: min(10) }), n, {
      minTransferSec: 180,
    });

    expect(journeys.map(legsOf)).toEqual([
      [
        [0, 0, 1],
        [2, 1, 2],
      ],
    ]);
    expect(journeys[0].transferSec).toBe(0);
    expect(journeys[0].walkSec).toBe(min(20));
  });

  it("別の駅へ歩いて乗り換えるときは最小乗換時間を課さず、到着＋乗換の徒歩ちょうどに発車する便に乗れる", () => {
    // 駅1着 10:40、駅2まで 0.4 km = 300 秒。10:45 ちょうどに発つ便に乗れる
    const ct = compileTimetable(
      timetable(
        [0, 10, 10.4, 20],
        [
          { calls: [call(0, t(10, 20)), call(1, t(10, 40))] },
          { calls: [call(2, t(10, 45)), call(3, t(11, 10))] },
        ],
      ),
    );
    const n = transferNeighbors(ct, separateStations(4), { maxWalkSec: min(10) });

    const [best] = bestJourneys(ct, query(120), measured({ 0: min(10) }, { 3: min(10) }), n, {
      minTransferSec: 180,
    });

    expect(legsOf(best)).toEqual([
      [0, 0, 1],
      [1, 2, 3],
    ]);
  });

  it("同じ駅に戻ってくる便（B → C → B）で、B から乗って C で降りて乗り換える経路を返す", () => {
    // 便0: 駅0 → 駅1 → 駅0。戻った駅0で降りる方が徒歩は長い（30分）が、駅0から乗って駅0では降りられない
    const ct = compileTimetable(
      timetable(
        [0, 10, 20],
        [
          { calls: [call(0, t(10, 20)), call(1, t(10, 30)), call(0, t(10, 40))] },
          { calls: [call(1, t(10, 50)), call(2, t(11, 0))] },
        ],
      ),
    );
    const n = transferNeighbors(ct, separateStations(3), { maxWalkSec: min(10) });

    const journeys = bestJourneys(ct, query(120), measured({ 0: min(10) }, { 0: min(30), 2: min(10) }), n);

    expect(journeys.map(legsOf)).toEqual([
      [
        [0, 0, 1],
        [1, 1, 2],
      ],
    ]);
  });

  it("同じ駅の乗換が最小乗換時間で締切に間に合わなくても、それより遠い近傍への歩く乗換は見る", () => {
    // 締切 10:50。駅1着 10:40 で、同じ駅の乗換は 11分待つので間に合わない。駅2へ 150 秒歩けば
    // 10:43 発に乗れて、駅3で降りて 5分歩くと 10:50 ちょうど
    const ct = compileTimetable(
      timetable(
        [0, 10, 10.2, 20],
        [
          { calls: [call(0, t(10, 20)), call(1, t(10, 40))] },
          { calls: [call(2, t(10, 43)), call(3, t(10, 45))] },
        ],
      ),
    );
    const n = transferNeighbors(ct, separateStations(4), { maxWalkSec: min(10) });

    const journeys = bestJourneys(ct, query(50), measured({ 0: min(10) }, { 3: min(5) }), n, {
      minTransferSec: min(11),
    });

    expect(journeys.map(legsOf)).toEqual([
      [
        [0, 0, 1],
        [1, 2, 3],
      ],
    ]);
  });

  it("2本目に1本目と同じ便は使わない", () => {
    // 便0 は駅1に 10:30 着・10:35 発で止まり続ける。降りて同じ便に乗り直す組は作らない
    const ct = compileTimetable(
      timetable(
        [0, 10, 20],
        [
          {
            calls: [
              call(0, t(10, 20)),
              { stop: 1, arr: t(10, 30), dep: t(10, 35), canBoard: true, canAlight: true },
              call(2, t(10, 50)),
            ],
          },
        ],
      ),
    );
    const n = transferNeighbors(ct, separateStations(3), { maxWalkSec: min(10) });

    const journeys = bestJourneys(ct, query(120), measured({ 0: min(10) }, { 2: min(10) }), n, {
      minTransferSec: 60,
    });

    expect(journeys.map(legsOf)).toEqual([[[0, 0, 2]]]);
  });

  it("乗れる駅が1つだけでも、降車や乗換の組が違う候補を上位 k 本まで返す", () => {
    const ct = compileTimetable(
      timetable(
        [0, 8, 10, 10.3, 20],
        [
          { calls: [call(0, t(10, 10)), call(1, t(10, 20)), call(2, t(10, 30))] },
          { calls: [call(3, t(10, 45)), call(4, t(11, 0))] },
        ],
      ),
    );
    const n = transferNeighbors(ct, separateStations(5), { maxWalkSec: min(10) });

    const journeys = bestJourneys(
      ct,
      query(120),
      measured({ 0: min(10) }, { 1: min(30), 2: min(20), 4: min(20) }),
      n,
      { k: 3 },
    );

    expect(journeys.map(legsOf)).toEqual([
      [[0, 0, 1]],
      [
        [0, 0, 2],
        [1, 3, 4],
      ],
      [[0, 0, 2]],
    ]);
  });

  it("出発側の徒歩が長く、先で稼げる徒歩だけでは k 番目に届かない枝でも、合計で届くなら上位 k 本に入れる", () => {
    // 駅0（出発側 10分）から乗ると先は 10.5分（乗換 2.5分 ＋ 目的地側 8分）。駅3（出発側 0分）から
    // 乗ると先は 15分。合計は 20.5分 と 15分 で、先の値だけで比べると駅0の枝を切ってしまう
    const ct = compileTimetable(
      timetable(
        [0, 10, 10.2, 1, 20, 22],
        [
          { calls: [call(0, t(10, 20)), call(1, t(10, 40))] },
          { calls: [call(2, t(10, 50)), call(5, t(11, 10))] },
          { calls: [call(3, t(10, 5)), call(4, t(10, 30))] },
        ],
      ),
    );
    const n = transferNeighbors(ct, separateStations(6), { maxWalkSec: min(10) });

    const journeys = bestJourneys(
      ct,
      query(120),
      measured({ 0: min(10), 3: 0 }, { 4: min(15), 5: min(8), 1: min(1) }),
      n,
      { k: 1 },
    );

    expect(journeys.map(legsOf)).toEqual([
      [
        [0, 0, 1],
        [1, 2, 5],
      ],
    ]);
  });

  it("乗れない停車では2本目に乗らず、降りられない停車では1本目を降りない", () => {
    const ct = compileTimetable(
      timetable(
        // 駅1と駅2は近傍の半径（0.8 km）より離す
        [0, 10, 12, 20],
        [
          {
            calls: [call(0, t(10, 20)), call(1, t(10, 40), { canAlight: false }), call(2, t(10, 42))],
          },
          { calls: [call(1, t(10, 50)), call(3, t(11, 10))] },
          { calls: [call(2, t(10, 50), { canBoard: false }), call(3, t(11, 10))] },
        ],
      ),
    );
    const n = transferNeighbors(ct, separateStations(4), { maxWalkSec: min(10) });

    const journeys = bestJourneys(ct, query(120), measured({ 0: min(10) }, { 3: min(10) }), n);

    expect(journeys).toEqual([]);
  });

  it("目的地への到着が締切ちょうどの経路は使い、1秒でも過ぎる経路は使わない", () => {
    // 締切 11:00。2本目を 10:50 に降りて 10分歩くと 11:00 ちょうど
    const build = (alightAt: number) =>
      compileTimetable(
        timetable(
          [0, 10, 20],
          [
            { calls: [call(0, t(10, 10)), call(1, t(10, 20))] },
            { calls: [call(1, t(10, 30)), call(2, alightAt)] },
          ],
        ),
      );
    const run = (ct: CompiledTimetable) =>
      bestJourneys(ct, query(60), measured({ 0: min(5) }, { 2: min(10) }), transferNeighbors(ct, separateStations(3), { maxWalkSec: min(10) }));

    expect(run(build(t(10, 50))).map(legsOf)).toEqual([
      [
        [0, 0, 1],
        [1, 1, 2],
      ],
    ]);
    expect(run(build(t(10, 50) + 1))).toEqual([]);
  });

  it("徒歩が同じなら目的地への到着が早いほうを、それも同じなら乗換が少ないほうを先に並べる", () => {
    // 3本とも徒歩 20分。便0 は駅3へ直通で 11:00 着、乗換は 11:00 着（便1→便2）、便3 は駅2へ直通で 10:55 着
    const ct = compileTimetable(
      timetable(
        [0, 10, 20, 20.5],
        [
          { calls: [call(0, t(10, 20)), call(3, t(10, 50))] },
          { calls: [call(0, t(10, 15)), call(1, t(10, 25))] },
          { calls: [call(1, t(10, 30)), call(2, t(10, 50))] },
          { calls: [call(0, t(10, 25)), call(2, t(10, 45))] },
        ],
      ),
    );
    const n = transferNeighbors(ct, separateStations(4), { maxWalkSec: min(10) });

    const journeys = bestJourneys(ct, query(120), measured({ 0: min(10) }, { 2: min(10), 3: min(10) }), n, {
      k: 5,
      minTransferSec: 60,
    });

    expect(journeys.map(legsOf)).toEqual([
      [[3, 0, 2]],
      [[0, 0, 3]],
      [
        [1, 0, 1],
        [2, 1, 2],
      ],
    ]);
  });

  it("乗換の近傍を渡さなければ、上位 k 本は bestRides と並びまで一致する", () => {
    const random = mulberry32(474);
    for (let trial = 0; trial < 300; trial++) {
      const { ct, q, walks } = randomCase(random);

      const rides = bestRides(ct, q, walks, { k: 5 });
      const journeys = bestJourneys(ct, q, walks, null, { k: 5 });

      expect(journeys.map((j) => j.legs.length)).toEqual(rides.map(() => 1));
      expect(
        journeys.map((j) => ({
          trip: j.legs[0].trip,
          board: j.legs[0].board,
          alight: j.legs[0].alight,
          boardAt: j.legs[0].boardAt,
          alightAt: j.legs[0].alightAt,
          accessSec: j.accessSec,
          egressSec: j.egressSec,
          walkSec: j.walkSec,
        })),
      ).toEqual(rides);
    }
  });

  it("小さな乱数の時刻表で、全ての組を総当たりした上位 k 本と一致する", () => {
    const random = mulberry32(456);
    let withTransfer = 0;
    for (let trial = 0; trial < 1500; trial++) {
      const { ct, q, walks, stations } = randomCase(random);
      const n = transferNeighbors(ct, stations, { maxWalkSec: 200 + random() * 1500 });
      const minTransferSec = Math.floor(random() * 300);
      const k = 1 + Math.floor(random() * 6);

      const expected = bruteForce(ct, q, walks, n, { k, minTransferSec });
      const actual = bestJourneys(ct, q, walks, n, { k, minTransferSec });

      expect(actual).toEqual(expected);
      if (expected.some((j) => j.legs.length === 2)) withTransfer++;
    }
    // 乱数の作りが乗換を含む答えをほとんど作らないと、この照合は乗換の側を検査しない
    expect(withTransfer).toBeGreaterThan(300);
  });
});

interface Neighbor {
  stop: number;
  walkSec: number;
  sameStation: boolean;
}

function neighborsOf(n: TransferNeighbors, s: number): Neighbor[] {
  const out: Neighbor[] = [];
  for (let i = n.start[s]; i < n.start[s + 1]; i++) {
    out.push({ stop: n.stop[i], walkSec: n.walkSec[i], sameStation: n.sameStation[i] === 1 });
  }
  return out;
}

// 小さく速い決定的な乱数（テストの再現のため）。
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function randomCase(random: () => number) {
  const int = (lo: number, hi: number) => lo + Math.floor(random() * (hi - lo + 1));
  const stopCount = int(3, 9);
  // 乗換の近傍に入るよう、駅を 3 km の中に詰める（1 km = 750 秒）
  const stopKms = Array.from({ length: stopCount }, () => random() * 3);
  const stations = Array.from({ length: stopCount }, () => ({ feed: int(0, 1), station: int(0, 3) }));
  const trips = Array.from({ length: int(1, 14) }, () => {
    const length = int(2, 6);
    let at = t(10, 0) + int(-10, 60) * 60;
    return {
      calls: Array.from({ length }, () => {
        const arr = at;
        const dep = arr + int(0, 2) * 60;
        at = dep + int(1, 15) * 60;
        return {
          stop: int(0, stopCount - 1),
          arr,
          dep,
          canBoard: random() < 0.85,
          canAlight: random() < 0.85,
        };
      }),
    };
  });
  const ct = compileTimetable(timetable(stopKms, trips));
  // 徒歩は小数の乱数にして、bestRides と並べ方の決まりが違う同点を作らない
  const pick = () => {
    const m = new Map<number, number>();
    for (let s = 0; s < stopCount; s++) if (random() < 0.6) m.set(s, random() * 1800);
    return m;
  };
  const walks: MeasuredWalks = { access: pick(), egress: pick() };
  return { ct, q: query(int(20, 150)), walks, stations };
}

/** 全ての「乗車駅・便・降車駅（・乗換先・便・降車駅）」を作り、同じ駅の組ごとに最良の1本を残す。 */
function bruteForce(
  ct: CompiledTimetable,
  q: ScanQuery,
  walks: MeasuredWalks,
  n: TransferNeighbors,
  opts: { k: number; minTransferSec: number },
): Journey[] {
  const deadline = q.departAt + q.budgetMin * 60;
  const callsOf = (trip: number) => {
    const out = [];
    for (let c = ct.tripStart[trip]; c < ct.tripStart[trip] + ct.tripLength[trip]; c++) out.push(c);
    return out;
  };
  const best = new Map<string, Journey>();
  const keep = (j: Journey) => {
    const key = j.legs.map((l) => `${l.board}-${l.alight}`).join("/");
    const prev = best.get(key);
    if (prev === undefined || compare(j, prev) < 0) best.set(key, j);
  };
  for (let t1 = 0; t1 < ct.tripCount; t1++) {
    const calls1 = callsOf(t1);
    calls1.forEach((c1, i1) => {
      const b1 = ct.callStop[c1];
      const access = walks.access.get(b1);
      if (access === undefined || !ct.callBoard[c1] || q.departAt + access > ct.callDep[c1]) return;
      for (const j1 of calls1.slice(i1 + 1)) {
        const a1 = ct.callStop[j1];
        if (a1 === b1 || !ct.callAlight[j1]) continue;
        const leg1 = { trip: t1, board: b1, alight: a1, boardAt: ct.callDep[c1], alightAt: ct.callArr[j1] };
        const egress1 = walks.egress.get(a1);
        if (egress1 !== undefined && ct.callArr[j1] + egress1 <= deadline) {
          keep({
            legs: [leg1],
            accessSec: access,
            transferSec: 0,
            egressSec: egress1,
            walkSec: access + egress1,
            arriveAt: ct.callArr[j1] + egress1,
          });
        }
        for (const nb of neighborsOf(n, a1)) {
          const ready = ct.callArr[j1] + nb.walkSec + (nb.sameStation ? opts.minTransferSec : 0);
          for (let t2 = 0; t2 < ct.tripCount; t2++) {
            if (t2 === t1) continue;
            const calls2 = callsOf(t2);
            calls2.forEach((c2, i2) => {
              if (ct.callStop[c2] !== nb.stop || !ct.callBoard[c2] || ct.callDep[c2] < ready) return;
              for (const j2 of calls2.slice(i2 + 1)) {
                const a2 = ct.callStop[j2];
                const egress = walks.egress.get(a2);
                if (a2 === nb.stop || !ct.callAlight[j2] || egress === undefined) continue;
                if (ct.callArr[j2] + egress > deadline) continue;
                keep({
                  legs: [
                    leg1,
                    { trip: t2, board: nb.stop, alight: a2, boardAt: ct.callDep[c2], alightAt: ct.callArr[j2] },
                  ],
                  accessSec: access,
                  transferSec: nb.walkSec,
                  egressSec: egress,
                  walkSec: access + nb.walkSec + egress,
                  arriveAt: ct.callArr[j2] + egress,
                });
              }
            });
          }
        }
      }
    });
  }
  return [...best.values()].sort(compare).slice(0, opts.k);
}

// 設計メモの同点の扱い（徒歩が長い → 到着が早い → 乗換が少ない）のあとは、決定的に並べるための順。
function compare(a: Journey, b: Journey): number {
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
