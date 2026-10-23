import { describe, expect, it, vi } from "vitest";

import { compileTimetable, type LatLng, type StopCall, type Timetable } from "../src/exact-scan";
import {
  EXACT_WALK_MAX_ELEMENTS,
  findExactWalkMax,
  parseExactWalkMaxQuery,
  toServiceTime,
  type ExactWalkMaxDeps,
  type ExactWalkMaxRequest,
  type MatrixElement,
} from "../src/exact-walk-max";

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

function depsFor(tt: Timetable, measure = straightMatrix()): ExactWalkMaxDeps {
  return {
    day: async () => ({ compiled: compileTimetable(tt), stops: tt.stops, feeds: FEEDS }),
    measure,
  };
}

// 2026-10-23 10:00 JST
const request = (budgetMin = 180): ExactWalkMaxRequest => ({
  origin: pointAtKm(0),
  goal: pointAtKm(20),
  departAt: new Date("2026-10-23T01:00:00Z"),
  budgetMin,
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
      day: async () => ({ compiled: compileTimetable(tt3), stops: tt3.stops, feeds: FEEDS }),
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
});
