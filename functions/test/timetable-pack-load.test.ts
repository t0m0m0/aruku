import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  compileTimetable,
  transferNeighbors,
  type StationKey,
  type Timetable,
} from "../src/exact-scan";
import type { ScanDay } from "../src/exact-walk-max";
import { packObjectPath, type PackGroup } from "../src/timetable-pack/feeds";
import { createScanDaySource, type PackLoadDeps } from "../src/timetable-pack/load";
import { PACK_FORMAT_VERSION, timetableForDate, type TimetablePack } from "../src/timetable-pack/pack";

const SERVICE_DATE = "20261023";

// 駅2つ・便1本だけのパック。駅名にフィード名を入れ、どのパックの駅かを見分ける。
const pack = (feedId: string, fetchedAt = "2026-10-22T19:23:00.000Z"): TimetablePack => ({
  format: PACK_FORMAT_VERSION,
  feeds: [{ id: feedId, fetchedAt, version: null }],
  stations: [],
  stops: [
    { name: `${feedId}-A`, lat: 35.0, lng: 139.7, feed: 0, station: 0 },
    { name: `${feedId}-B`, lat: 35.1, lng: 139.7, feed: 0, station: 1 },
  ],
  services: [{ dates: [Number(SERVICE_DATE)] }],
  trips: [
    {
      feed: 0,
      service: 0,
      route: `${feedId}線`,
      headsign: null,
      block: null,
      stops: [0, 1],
      arr: [36000, 36600],
      dep: [36000, 36600],
      board: [1, 1],
      alight: [1, 1],
    },
  ],
});

const gz = (p: unknown): Uint8Array => gzipSync(JSON.stringify(p));

interface Harness {
  deps: PackLoadDeps;
  reads: string[];
  logs: Record<string, unknown>[];
  objects: Map<string, Uint8Array | Error>;
  clock: { now: number };
}

const harness = (objects: Partial<Record<PackGroup, Uint8Array | Error>>): Harness => {
  const map = new Map<string, Uint8Array | Error>();
  for (const [group, body] of Object.entries(objects)) {
    map.set(packObjectPath(group as PackGroup), body);
  }
  const reads: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const clock = { now: 0 };
  return {
    reads,
    logs,
    objects: map,
    clock,
    deps: {
      read: async (path) => {
        reads.push(path);
        const body = map.get(path);
        if (body instanceof Error) throw body;
        return body ?? null;
      },
      log: (event) => logs.push(event),
      now: () => clock.now,
    },
  };
};

describe("createScanDaySource", () => {
  it("両グループのパックを1つの時刻表に合わせ、便はそれぞれのパックの駅を指したままにする", async () => {
    const h = harness({ challenge: gz(pack("JR")), permanent: gz(pack("Toei")) });

    const day = (await createScanDaySource(h.deps)(SERVICE_DATE))!;

    expect(day.stops.map((s) => s.name)).toEqual(["JR-A", "JR-B", "Toei-A", "Toei-B"]);
    const routeOfStop = new Map<string, string>();
    for (let trip = 0; trip < day.compiled.tripCount; trip++) {
      const start = day.compiled.tripStart[trip];
      for (let c = start; c < start + day.compiled.tripLength[trip]; c++) {
        routeOfStop.set(day.stops[day.compiled.callStop[c]].name, day.compiled.trips[trip].route);
      }
    }
    expect(Object.fromEntries(routeOfStop)).toEqual({
      "JR-A": "JR線",
      "JR-B": "JR線",
      "Toei-A": "Toei線",
      "Toei-B": "Toei線",
    });
    expect(day.feeds).toEqual([
      { id: "JR", fetchedAt: "2026-10-22T19:23:00.000Z" },
      { id: "Toei", fetchedAt: "2026-10-22T19:23:00.000Z" },
    ]);
  });

  describe("乗換の近傍の表", () => {
    // 同じ座標の2つの stop を同じ駅（station 0）にしたパック。両方のパックが同じ番号を使う。
    const twoPlatforms = (feedId: string): TimetablePack => {
      const base = pack(feedId);
      return {
        ...base,
        stops: [
          { name: `${feedId}-1番線`, lat: 35.0, lng: 139.7, feed: 0, station: 0 },
          { name: `${feedId}-2番線`, lat: 35.0, lng: 139.7, feed: 0, station: 0 },
        ],
      };
    };

    const entry = (day: ScanDay, from: string, to: string) => {
      const index = (name: string) => day.stops.findIndex((s) => s.name === name);
      const { start, stop, walkSec, sameStation } = day.neighbors;
      for (let e = start[index(from)]; e < start[index(from) + 1]; e++) {
        if (stop[e] === index(to)) return { walkSec: walkSec[e], same: sameStation[e] === 1 };
      }
      return null;
    };

    it("同じパックの同じ駅は同じ駅の乗換になる", async () => {
      const h = harness({ permanent: gz(twoPlatforms("Toei")) });

      const day = (await createScanDaySource(h.deps)(SERVICE_DATE))!;

      expect(entry(day, "Toei-1番線", "Toei-2番線")).toEqual({ walkSec: 0, same: true });
    });

    it("パックごとに0から振られた番号が重なっても、別のパックの駅を同じ駅にしない", async () => {
      const h = harness({ challenge: gz(twoPlatforms("JR")), permanent: gz(twoPlatforms("Toei")) });

      const day = (await createScanDaySource(h.deps)(SERVICE_DATE))!;

      expect(entry(day, "JR-1番線", "Toei-1番線")).toEqual({ walkSec: 0, same: false });
    });

    it("歩いて10分を超える駅は近傍に入れない", async () => {
      const h = harness({ permanent: gz(pack("Toei")) });

      const day = (await createScanDaySource(h.deps)(SERVICE_DATE))!;

      expect(entry(day, "Toei-A", "Toei-B")).toBeNull();
    });
  });

  it("片方のグループのパックが無ければ、もう片方だけで引く", async () => {
    const h = harness({ permanent: gz(pack("Toei")) });

    const day = (await createScanDaySource(h.deps)(SERVICE_DATE))!;

    expect(day.feeds.map((f) => f.id)).toEqual(["Toei"]);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ event: "timetable_pack_load", group: "challenge", status: "missing" }),
    );
  });

  it("読めないパック・形式の違うパックは使わない", async () => {
    const h = harness({
      challenge: new Error("storage unavailable"),
      permanent: gz({ ...pack("Toei"), format: PACK_FORMAT_VERSION + 1 }),
    });

    expect(await createScanDaySource(h.deps)(SERVICE_DATE)).toBeNull();
    expect(h.logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "challenge", status: "failure", reason: "read" }),
        expect.objectContaining({ group: "permanent", status: "failure", reason: "format" }),
      ]),
    );
  });

  it("読み込みに掛かった時間とサイズをログに出す", async () => {
    const h = harness({ permanent: gz(pack("Toei")) });

    await createScanDaySource(h.deps)(SERVICE_DATE);

    expect(h.logs).toContainEqual(
      expect.objectContaining({
        event: "timetable_pack_load",
        group: "permanent",
        status: "success",
        bytes: expect.any(Number),
        trips: 1,
        loadMs: expect.any(Number),
      }),
    );
  });

  it("インスタンスが温まっている間は Storage を読み直さない", async () => {
    const h = harness({ challenge: gz(pack("JR")), permanent: gz(pack("Toei")) });
    const source = createScanDaySource(h.deps);

    await Promise.all([source(SERVICE_DATE), source(SERVICE_DATE), source("20261024")]);

    expect(h.reads).toHaveLength(2);
  });

  it("読み込みから6時間経つと読み直し、日次の更新を拾う", async () => {
    const h = harness({ permanent: gz(pack("Toei", "2026-10-22T19:23:00.000Z")) });
    const source = createScanDaySource(h.deps);
    await source(SERVICE_DATE);

    h.objects.set(packObjectPath("permanent"), gz(pack("Toei", "2026-10-23T19:23:00.000Z")));
    h.clock.now = 6 * 3600 * 1000;
    const day = (await source(SERVICE_DATE))!;

    expect(day.feeds).toEqual([{ id: "Toei", fetchedAt: "2026-10-23T19:23:00.000Z" }]);
  });

  it("読み直しに失敗したグループは、前に読めたパックを使い続ける", async () => {
    const h = harness({ permanent: gz(pack("Toei")) });
    const source = createScanDaySource(h.deps);
    await source(SERVICE_DATE);

    h.objects.set(packObjectPath("permanent"), new Error("storage unavailable"));
    h.clock.now = 6 * 3600 * 1000;
    const day = await source(SERVICE_DATE);

    expect(day?.feeds.map((f) => f.id)).toEqual(["Toei"]);
  });

  it("消されたグループのパックは、前に読めていても検索に使わない", async () => {
    const h = harness({ challenge: gz(pack("JR")), permanent: gz(pack("Toei")) });
    const source = createScanDaySource(h.deps);
    await source(SERVICE_DATE);

    h.objects.delete(packObjectPath("challenge"));
    h.clock.now = 6 * 3600 * 1000;
    const day = await source(SERVICE_DATE);

    expect(day?.feeds.map((f) => f.id)).toEqual(["Toei"]);
  });

  describe("運行日ごとの時刻表", () => {
    // 運行日の扱いを全部含むパック: 当日だけ走る便・前日の運行日から 24:00 を越える便・
    // 走らない便・乗車できない停車・同じ駅の2つの stop。
    const richPack = (feedId: string, lngShift: number): TimetablePack => ({
      format: PACK_FORMAT_VERSION,
      feeds: [{ id: feedId, fetchedAt: "2026-10-22T19:23:00.000Z", version: "v1" }],
      stations: [],
      stops: [
        { name: `${feedId}-A1`, lat: 35.0, lng: 139.7 + lngShift, feed: 0, station: 0 },
        { name: `${feedId}-A2`, lat: 35.0, lng: 139.7 + lngShift, feed: 0, station: 0 },
        { name: `${feedId}-B`, lat: 35.003, lng: 139.7 + lngShift, feed: 0, station: 1 },
        { name: `${feedId}-C`, lat: 35.05, lng: 139.7 + lngShift, feed: 0, station: 2 },
      ],
      services: [
        { dates: [20261022, 20261023] },
        { dates: [20261022] },
        { dates: [20261101] },
      ],
      trips: [
        {
          feed: 0,
          service: 0,
          route: `${feedId}本線`,
          headsign: "C",
          block: null,
          stops: [0, 2, 3],
          arr: [36000, 36300, 36900],
          dep: [36000, 36330, 36900],
          board: [1, 0, 1],
          alight: [1, 1, 1],
        },
        {
          feed: 0,
          service: 1,
          route: `${feedId}深夜線`,
          headsign: null,
          block: "b1",
          stops: [1, 2, 3],
          arr: [86000, 86700, 87300],
          dep: [86000, 86700, 87300],
          board: [1, 1, 1],
          alight: [1, 1, 1],
        },
        {
          feed: 0,
          service: 2,
          route: `${feedId}臨時線`,
          headsign: null,
          block: null,
          stops: [0, 3],
          arr: [40000, 41000],
          dep: [40000, 41000],
          board: [1, 1],
          alight: [1, 1],
        },
      ],
    });

    // パックを1つずつ切り出して素直に連結した時刻表。前処理を速くしても、これと同じ値を返す。
    const naiveDay = (packs: TimetablePack[], serviceDate: string) => {
      const tt: Timetable = { stops: [], trips: [] };
      const stations: StationKey[] = [];
      let feedOffset = 0;
      for (const p of packs) {
        const day = timetableForDate(p, serviceDate);
        const offset = tt.stops.length;
        for (const s of day.stops) {
          tt.stops.push(s);
          stations.push({ feed: s.feed + feedOffset, station: s.station });
        }
        for (const trip of day.trips) {
          tt.trips.push({ ...trip, calls: trip.calls.map((c) => ({ ...c, stop: c.stop + offset })) });
        }
        feedOffset += p.feeds.length;
      }
      const compiled = compileTimetable(tt);
      return {
        compiled,
        neighbors: transferNeighbors(compiled, stations, { maxWalkSec: 10 * 60 }),
        stops: tt.stops,
        feeds: packs.flatMap((p) => p.feeds.map(({ id, fetchedAt }) => ({ id, fetchedAt }))),
      };
    };

    it.each(["20261022", "20261023", "20261024", "20261101"])(
      "%s の時刻表は、パックを1つずつ切り出して連結したものと同じになる",
      async (serviceDate) => {
        const packs = [richPack("JR", 0), richPack("Toei", 0.001)];
        const h = harness({ challenge: gz(packs[0]), permanent: gz(packs[1]) });

        const day = await createScanDaySource(h.deps)(serviceDate);

        expect(day).toEqual(naiveDay(packs, serviceDate));
      },
    );

    it("同じ運行日を同時に引いても、組み立ては1回だけ", async () => {
      const h = harness({ challenge: gz(pack("JR")), permanent: gz(pack("Toei")) });
      const source = createScanDaySource(h.deps);

      const [a, b] = await Promise.all([source(SERVICE_DATE), source(SERVICE_DATE)]);

      expect(a).toBe(b);
      expect(h.logs.filter((e) => e.event === "timetable_day_compile")).toHaveLength(1);
    });

    it("2日分まで持ち、3日目を引くと一番古い日を組み立て直す", async () => {
      const h = harness({ permanent: gz(pack("Toei")) });
      const source = createScanDaySource(h.deps);
      const compiles = () =>
        h.logs.filter((e) => e.event === "timetable_day_compile").map((e) => e.serviceDate);

      const first = await source("20261023");
      expect(await source("20261023")).toBe(first);
      await source("20261024");
      await source("20261024");
      expect(compiles()).toEqual(["20261023", "20261024"]);

      await source("20261025");
      await source("20261024");
      await source("20261023");
      expect(compiles()).toEqual(["20261023", "20261024", "20261025", "20261023"]);
    });

    it("読み直した後は、読み直す前に組み立てた運行日も新しいパックで組み立て直す", async () => {
      const h = harness({ permanent: gz(pack("Toei", "2026-10-22T19:23:00.000Z")) });
      const source = createScanDaySource(h.deps);
      const before = await source(SERVICE_DATE);

      h.objects.set(packObjectPath("permanent"), gz(pack("Toei", "2026-10-23T19:23:00.000Z")));
      h.clock.now = 6 * 3600 * 1000;
      // 読み直しの最中に届いた要求も、古い日別の時刻表を返さない。
      const [during, after] = await Promise.all([source(SERVICE_DATE), source(SERVICE_DATE)]);

      expect(during).not.toBe(before);
      expect(after).toBe(during);
      expect(during?.feeds).toEqual([{ id: "Toei", fetchedAt: "2026-10-23T19:23:00.000Z" }]);
    });
  });

  it("読めなかったグループは6時間を待たず、1分経てば読み直す", async () => {
    const h = harness({ permanent: new Error("storage unavailable") });
    const source = createScanDaySource(h.deps);
    expect(await source(SERVICE_DATE)).toBeNull();

    h.objects.set(packObjectPath("permanent"), gz(pack("Toei")));
    h.clock.now = 59 * 1000;
    expect(await source(SERVICE_DATE)).toBeNull();
    h.clock.now = 60 * 1000;
    const day = await source(SERVICE_DATE);

    expect(day?.feeds.map((f) => f.id)).toEqual(["Toei"]);
  });
});
