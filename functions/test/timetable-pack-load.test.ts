import { gzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { packObjectPath, type PackGroup } from "../src/timetable-pack/feeds";
import { createScanDaySource, type PackLoadDeps } from "../src/timetable-pack/load";
import { PACK_FORMAT_VERSION, type TimetablePack } from "../src/timetable-pack/pack";

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
