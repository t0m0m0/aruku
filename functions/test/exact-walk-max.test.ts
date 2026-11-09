import { describe, expect, it, vi } from "vitest";

import {
  bestJourneys,
  compileTimetable,
  transferNeighbors,
  type LatLng,
  type StationKey,
  type StopCall,
  type Timetable,
} from "../src/exact-scan";
import {
  EXACT_WALK_MAX_ELEMENTS,
  findExactWalkMax,
  parseExactWalkMaxQuery,
  toServiceTime,
  type ExactWalkMaxDeps,
  type ExactWalkMaxRequest,
  type MatrixElement,
  type ScanDay,
} from "../src/exact-walk-max";

// exact-walk-max.ts からの呼び出しだけを数える。pickStopsToMeasure がモジュール内で呼ぶ
// bestJourneys はこの差し替えを通らない。
vi.mock("../src/exact-scan", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/exact-scan")>();
  return { ...actual, bestJourneys: vi.fn(actual.bestJourneys) };
});

const EARTH_RADIUS_KM = 6371.0088;
const pointAtKm = (km: number): LatLng => ({
  lat: 35 + (km / EARTH_RADIUS_KM) * (180 / Math.PI),
  lng: 139.7,
});
const t = (hh: number, mm: number): number => hh * 3600 + mm * 60;

const call = (stop: number, at: number): StopCall => ({
  stop,
  arr: at,
  dep: at,
  canBoard: true,
  canAlight: true,
});

const timetable = (stopKms: number[], trips: StopCall[][]): Timetable => ({
  stops: stopKms.map((km, i) => ({ name: `S${i}`, ...pointAtKm(km) })),
  trips: trips.map((calls, i) => ({ route: `R${i}`, headsign: `H${i}`, calls })),
});

const FEEDS = [{ id: "Toei", fetchedAt: "2026-10-22T19:23:00.000Z" }];

// 実測は直線どおり（80 m/分）として、要素ごとに秒と距離を返すマトリクス。
function straightMatrix(): ExactWalkMaxDeps["measure"] & { calls: [LatLng[], LatLng[]][] } {
  const calls: [LatLng[], LatLng[]][] = [];
  const fn = async (origins: LatLng[], destinations: LatLng[]): Promise<MatrixElement[]> => {
    calls.push([origins, destinations]);
    const out: MatrixElement[] = [];
    origins.forEach((o, oi) =>
      destinations.forEach((d, di) => {
        const meters = (Math.abs(o.lat - d.lat) * Math.PI * EARTH_RADIUS_KM * 1000) / 180;
        out.push({
          originIndex: oi,
          destinationIndex: di,
          durationSec: Math.round((meters / 80) * 60),
          distanceMeters: Math.round(meters),
        });
      }),
    );
    return out;
  };
  return Object.assign(fn, { calls });
}

// stations を渡さなければ、stop はどれも別の駅。
function scanDay(tt: Timetable, stations?: StationKey[]): ScanDay {
  const compiled = compileTimetable(tt);
  const keys = stations ?? tt.stops.map((_, i) => ({ feed: 0, station: i }));
  return {
    compiled,
    neighbors: transferNeighbors(compiled, keys, { maxWalkSec: 600 }),
    stops: tt.stops,
    feeds: FEEDS,
  };
}

function depsFor(
  tt: Timetable,
  measure = straightMatrix(),
  stations?: StationKey[],
): ExactWalkMaxDeps {
  return { day: async () => scanDay(tt, stations), measure };
}

// 2026-10-23 10:00 JST
const request = (budgetMin = 180, transfers = false): ExactWalkMaxRequest => ({
  origin: pointAtKm(0),
  goal: pointAtKm(20),
  departAt: new Date("2026-10-23T01:00:00Z"),
  budgetMin,
  transfers,
});

describe("parseExactWalkMaxQuery", () => {
  const valid = {
    origin: "35.56,139.71",
    goal: "35.71,139.77",
    departAt: "2026-10-23T10:00:00+09:00",
    budgetMin: "180",
  };

  it("正しい入力を座標・出発時刻・予算に読む", () => {
    expect(parseExactWalkMaxQuery(valid)).toEqual({
      origin: { lat: 35.56, lng: 139.71 },
      goal: { lat: 35.71, lng: 139.77 },
      departAt: new Date("2026-10-23T01:00:00Z"),
      budgetMin: 180,
      transfers: false,
    });
  });

  it.each([
    ["1", true],
    ["0", false],
  ])("transfers=%s は乗換つきの候補を%sとして読む", (value, expected) => {
    expect(parseExactWalkMaxQuery({ ...valid, transfers: value })).toMatchObject({
      transfers: expected,
    });
  });

  it.each([
    ["origin が無い", { ...valid, origin: undefined }],
    ["goal が 'lat,lng' でない", { ...valid, goal: "35.71" }],
    ["緯度が範囲外", { ...valid, origin: "91,139.71" }],
    ["経度が範囲外", { ...valid, goal: "35.71,181" }],
    ["departAt が読めない", { ...valid, departAt: "tomorrow" }],
    ["departAt に時差が無い", { ...valid, departAt: "2026-10-23T10:00:00" }],
    ["budgetMin が整数でない", { ...valid, budgetMin: "12.5" }],
    ["budgetMin が0", { ...valid, budgetMin: "0" }],
    ["budgetMin が1日を超える", { ...valid, budgetMin: "1441" }],
    ["同じパラメータが2回渡された", { ...valid, origin: ["35.56,139.71", "35.57,139.71"] }],
    ["transfers が 0/1 でない", { ...valid, transfers: "true" }],
    ["transfers が空", { ...valid, transfers: "" }],
    ["transfers が2回渡された", { ...valid, transfers: ["1", "1"] }],
  ])("%s入力は拒否する", (_name, query) => {
    expect(parseExactWalkMaxQuery(query)).toHaveProperty("error");
  });
});

describe("toServiceTime", () => {
  it("JST の日付を運行日にし、その0時からの秒を返す", () => {
    expect(toServiceTime(new Date("2026-10-23T01:00:00Z"))).toEqual({
      serviceDate: "20261023",
      sec: t(10, 0),
    });
  });

  it("UTC では前日でも、JST で日付が変わっていれば JST の日付を運行日にする", () => {
    expect(toServiceTime(new Date("2026-10-22T15:30:00Z"))).toEqual({
      serviceDate: "20261023",
      sec: t(0, 30),
    });
  });
});

describe("findExactWalkMax", () => {
  const tt = timetable([2, 18], [[call(0, t(10, 30)), call(1, t(10, 50))]]);

  it("候補に駅・路線・行先・実発着時刻・停車駅の座標・実測の徒歩を載せる", async () => {
    const body = await findExactWalkMax(request(), depsFor(tt));

    expect(body.candidates).toEqual([
      {
        board: { name: "S0", ...pointAtKm(2) },
        alight: { name: "S1", ...pointAtKm(18) },
        route: "R0",
        headsign: "H0",
        boardAt: "2026-10-23T10:30:00+09:00",
        alightAt: "2026-10-23T10:50:00+09:00",
        stops: [pointAtKm(2), pointAtKm(18)],
        accessWalk: { durationSec: 1500, distanceMeters: 2000 },
        egressWalk: { durationSec: 1500, distanceMeters: 2000 },
      },
    ]);
  });

  it("応答は候補・フィードの取得日時・統計だけで、時刻表そのものを含まない", async () => {
    const body = await findExactWalkMax(request(), depsFor(tt));

    expect(Object.keys(body).sort()).toEqual(["candidates", "feeds", "stats"]);
    expect(body.feeds).toEqual(FEEDS);
    expect(body.stats).toEqual({ tripsScanned: 1, elementsMeasured: 2, truncated: false });
  });

  it("停車駅の座標は乗車駅から降車駅までに限り、時刻を付けない", async () => {
    const tt3 = timetable(
      [1, 2, 10, 18, 19],
      [[call(0, t(10, 20)), call(1, t(10, 30)), call(2, t(10, 40)), call(3, t(10, 50)), call(4, t(11, 0))]],
    );
    // 駅0・駅4の実測を返さず、駅1（2km）で乗って駅2（10km）で降りる組を徒歩最大にする。
    // 乗車駅より前の駅0、降車駅より後の駅3・駅4の座標は載せない
    const measure = straightMatrix();
    const deps: ExactWalkMaxDeps = {
      day: async () => scanDay(tt3),
      measure: async (o, d) =>
        (await measure(o, d)).filter((e) => {
          const p = o.length === 1 ? d[e.destinationIndex] : o[e.originIndex];
          return p.lat !== pointAtKm(1).lat && p.lat !== pointAtKm(19).lat;
        }),
    };

    const [best] = (await findExactWalkMax(request(), deps)).candidates;

    expect(best.stops).toEqual([pointAtKm(2), pointAtKm(10)]);
  });

  it("マトリクスは出発地→乗車候補と降車候補→目的地の2本で、合わせて上限の要素数以下", async () => {
    const kms = Array.from({ length: 30 }, (_, i) => 1 + i * 0.1);
    const goalSide = Array.from({ length: 30 }, (_, i) => 15 + i * 0.1);
    const trips = kms.map((km, i) => [call(i, t(10, 30) + i * 60), call(30 + i, t(11, 30) + i * 60)]);
    const big = timetable([...kms, ...goalSide], trips);
    const measure = straightMatrix();

    const body = await findExactWalkMax(request(), depsFor(big, measure));

    expect(measure.calls).toHaveLength(2);
    const [[o1, d1], [o2, d2]] = measure.calls;
    expect(o1).toEqual([request().origin]);
    expect(d2).toEqual([request().goal]);
    expect(o1.length * d1.length + o2.length * d2.length).toBeLessThanOrEqual(EXACT_WALK_MAX_ELEMENTS);
    expect(EXACT_WALK_MAX_ELEMENTS).toBe(24);
    expect(body.stats.truncated).toBe(true);
    expect(body.stats.elementsMeasured).toBe(24);
  });

  it("乗れる便が無ければマトリクスを呼ばず、空の候補を返す", async () => {
    const measure = straightMatrix();

    const body = await findExactWalkMax(request(10), depsFor(tt, measure));

    expect(measure.calls).toHaveLength(0);
    expect(body.candidates).toEqual([]);
    expect(body.stats).toEqual({ tripsScanned: 0, elementsMeasured: 0, truncated: false });
  });

  it("実測で経路が返らなかった駅では乗り降りしない", async () => {
    const deps: ExactWalkMaxDeps = { ...depsFor(tt), measure: async () => [] };

    expect((await findExactWalkMax(request(), deps)).candidates).toEqual([]);
  });

  it("パックが無ければ null を返す", async () => {
    const deps: ExactWalkMaxDeps = { ...depsFor(tt), day: async () => null };

    expect(await findExactWalkMax(request(), deps)).toBeNull();
  });

  it("実測の失敗はそのまま投げる（呼び出し側が 502/504 にする）", async () => {
    const error = new Error("upstream");
    const deps: ExactWalkMaxDeps = { ...depsFor(tt), measure: vi.fn().mockRejectedValue(error) };

    await expect(findExactWalkMax(request(), deps)).rejects.toBe(error);
  });

  describe("乗換つきの候補", () => {
    // 駅0（2 km）→ 途中の駅1 → 駅2（10 km）、0.1 km 歩いて駅3（10.1 km）→ 駅4（17 km）
    const walkTransfer = timetable(
      [2, 6, 10, 10.1, 17],
      [
        [call(0, t(10, 30)), call(1, t(10, 40)), call(2, t(10, 50))],
        [call(3, t(11, 0)), call(4, t(11, 20))],
      ],
    );

    it("両方の乗車の駅・路線・実発着時刻・停車駅と、直線の乗換の徒歩を載せる", async () => {
      const body = await findExactWalkMax(request(120, true), depsFor(walkTransfer));

      expect(body.transferCandidates).toEqual([
        {
          legs: [
            {
              board: { name: "S0", ...pointAtKm(2) },
              alight: { name: "S2", ...pointAtKm(10) },
              route: "R0",
              headsign: "H0",
              boardAt: "2026-10-23T10:30:00+09:00",
              alightAt: "2026-10-23T10:50:00+09:00",
              stops: [pointAtKm(2), pointAtKm(6), pointAtKm(10)],
            },
            {
              board: { name: "S3", ...pointAtKm(10.1) },
              alight: { name: "S4", ...pointAtKm(17) },
              route: "R1",
              headsign: "H1",
              boardAt: "2026-10-23T11:00:00+09:00",
              alightAt: "2026-10-23T11:20:00+09:00",
              stops: [pointAtKm(10.1), pointAtKm(17)],
            },
          ],
          accessWalk: { durationSec: 1500, distanceMeters: 2000 },
          transferWalk: { durationSec: 75, distanceMeters: 100 },
          sameStation: false,
          egressWalk: { durationSec: 2250, distanceMeters: 3000 },
        },
      ]);
    });

    it("実測するのは最初の乗車駅と最後の降車駅で、乗換の駅は測らない", async () => {
      const measure = straightMatrix();

      await findExactWalkMax(request(120, true), depsFor(walkTransfer, measure));

      expect(measure.calls).toEqual([
        [[request().origin], [pointAtKm(2)]],
        [[pointAtKm(17)], [request().goal]],
      ]);
    });

    it("1回乗車の候補は candidates のまま、乗換つきと混ざらない", async () => {
      // 予算 180 分なら駅2で降りて歩く1回乗車も成り立ち、徒歩はそちらのほうが長い
      const body = await findExactWalkMax(request(180, true), depsFor(walkTransfer));

      expect(body.candidates.map((c) => [c.board.name, c.alight.name])).toEqual([["S0", "S2"]]);
      expect(body.candidates[0]).not.toHaveProperty("legs");
      expect(body.transferCandidates.map((c) => c.legs.map((l) => l.board.name))).toEqual([
        ["S0", "S3"],
      ]);
    });

    it("同じ駅の乗換は sameStation を立て、徒歩を0にする", async () => {
      const sameStop = timetable(
        [2, 10, 17],
        [
          [call(0, t(10, 30)), call(1, t(10, 50))],
          [call(1, t(11, 0)), call(2, t(11, 20))],
        ],
      );

      const body = await findExactWalkMax(request(120, true), depsFor(sameStop));

      expect(body.transferCandidates).toHaveLength(1);
      expect(body.transferCandidates[0]).toMatchObject({
        transferWalk: { durationSec: 0, distanceMeters: 0 },
        sameStation: true,
      });
    });

    it("別の駅への乗換は、直線の徒歩が0でも sameStation を立てない", async () => {
      // 駅1と駅2は同じ座標の別のフィードの駅
      const sameSpot = timetable(
        [2, 10, 10, 17],
        [
          [call(0, t(10, 30)), call(1, t(10, 50))],
          [call(2, t(11, 0)), call(3, t(11, 20))],
        ],
      );
      const stations = [
        { feed: 0, station: 0 },
        { feed: 0, station: 1 },
        { feed: 1, station: 1 },
        { feed: 1, station: 2 },
      ];

      const body = await findExactWalkMax(
        request(120, true),
        depsFor(sameSpot, straightMatrix(), stations),
      );

      expect(body.transferCandidates).toHaveLength(1);
      expect(body.transferCandidates[0]).toMatchObject({
        transferWalk: { durationSec: 0, distanceMeters: 0 },
        sameStation: false,
      });
    });

    it("乗れる便が無ければ空の配列を返す", async () => {
      const body = await findExactWalkMax(request(10, true), depsFor(walkTransfer));

      expect(body.transferCandidates).toEqual([]);
    });

    describe("要求しないとき", () => {
      it("乗換つきの候補を走査せず、応答に transferCandidates を載せない", async () => {
        vi.mocked(bestJourneys).mockClear();

        const body = await findExactWalkMax(request(180, false), depsFor(walkTransfer));

        expect(bestJourneys).not.toHaveBeenCalled();
        expect(body).not.toHaveProperty("transferCandidates");
      });

      it("1回乗車の候補・実測する駅・統計は、要求したときと並びまで同じ", async () => {
        const without = straightMatrix();
        const withTransfers = straightMatrix();

        const a = await findExactWalkMax(request(180, false), depsFor(walkTransfer, without));
        const b = await findExactWalkMax(request(180, true), depsFor(walkTransfer, withTransfers));

        expect(a.candidates).toEqual(b.candidates);
        expect(a.stats).toEqual(b.stats);
        expect(without.calls).toEqual(withTransfers.calls);
      });

      it("乗れる便が無くても transferCandidates を載せない", async () => {
        const body = await findExactWalkMax(request(10, false), depsFor(walkTransfer));

        expect(body).not.toHaveProperty("transferCandidates");
      });
    });
  });

  describe("工程ごとの計測", () => {
    const tt = timetable(
      [2, 10, 10.1, 17],
      [
        [call(0, t(10, 30)), call(1, t(10, 50))],
        [call(2, t(11, 0)), call(3, t(11, 20))],
      ],
    );
    const stagesOf = async (req: ExactWalkMaxRequest): Promise<string[]> => {
      const stages: string[] = [];
      await findExactWalkMax(req, {
        ...depsFor(tt),
        timed: (stage, run) => {
          stages.push(stage);
          return run();
        },
      });
      return stages;
    };

    it("実測する駅の選定・1回乗車の走査・乗換つきの走査を別々に測る", async () => {
      expect(await stagesOf(request(180, true))).toEqual(["pick", "rides", "journeys"]);
    });

    it("乗換つきを要求しなければ、その走査は測らない", async () => {
      expect(await stagesOf(request(180, false))).toEqual(["pick", "rides"]);
    });
  });
});
