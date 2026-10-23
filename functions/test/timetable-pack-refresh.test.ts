import { gunzipSync } from "node:zlib";

import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { ODPT_FEEDS, packObjectPath, type OdptFeed } from "../src/timetable-pack/feeds";
import type { TimetablePack } from "../src/timetable-pack/pack";
import {
  refreshTimetablePacks,
  type RefreshDeps,
} from "../src/timetable-pack/refresh";

const CENTER_KEY = "center-secret-value";
const CHALLENGE_KEY = "challenge-secret-value";

const gtfsZip = (stopName: string): Uint8Array =>
  zipSync({
    "stops.txt": strToU8(
      `stop_id,stop_name,stop_lat,stop_lon\nA,${stopName},35.0,139.7\nB,${stopName}2,35.01,139.7\n`,
    ),
    "routes.txt": strToU8("route_id,route_long_name\nR,線\n"),
    "trips.txt": strToU8("route_id,service_id,trip_id\nR,S,T\n"),
    "stop_times.txt": strToU8(
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nT,10:00:00,10:00:00,A,1\nT,10:05:00,10:05:00,B,2\n",
    ),
    "calendar_dates.txt": strToU8("service_id,date,exception_type\nS,20261023,1\n"),
  });

const FEEDS: OdptFeed[] = [
  { id: "JR", url: "https://challenge.example/JR.zip", key: "ODPT_CHALLENGE_KEY", group: "challenge" },
  { id: "Keio", url: "https://challenge.example/Keio.zip", key: "ODPT_CHALLENGE_KEY", group: "challenge" },
  { id: "Metro", url: "https://center.example/Metro.zip", key: "ODPT_CENTER_KEY", group: "permanent" },
  { id: "Toei", url: "https://public.example/Toei.zip", key: null, group: "permanent" },
];

interface Harness {
  deps: RefreshDeps;
  requested: string[];
  uploads: Map<string, Uint8Array>;
  logs: Record<string, unknown>[];
}

const harness = (
  respond: (url: string) => Response | Promise<Response> = (url) =>
    new Response(gtfsZip(new URL(url).pathname.slice(1, -4))),
  keys: RefreshDeps["keys"] = { ODPT_CENTER_KEY: CENTER_KEY, ODPT_CHALLENGE_KEY: CHALLENGE_KEY },
): Harness => {
  const requested: string[] = [];
  const uploads = new Map<string, Uint8Array>();
  const logs: Record<string, unknown>[] = [];
  return {
    requested,
    uploads,
    logs,
    deps: {
      fetch: async (input) => {
        const url = String(input);
        requested.push(url);
        return respond(url);
      },
      keys,
      now: () => new Date("2026-10-23T19:00:00.000Z"),
      upload: async (path, bytes) => {
        uploads.set(path, bytes);
      },
      log: (event) => logs.push(event),
    },
  };
};

const unpack = (bytes: Uint8Array): TimetablePack => JSON.parse(gunzipSync(bytes).toString());

describe("refreshTimetablePacks", () => {
  it("ライセンスのグループごとに1つのパックを作り、別々のオブジェクトに置く", async () => {
    const h = harness();
    await refreshTimetablePacks(h.deps, FEEDS);
    expect([...h.uploads.keys()].sort()).toEqual([
      packObjectPath("challenge"),
      packObjectPath("permanent"),
    ]);
    expect(unpack(h.uploads.get(packObjectPath("challenge"))!).feeds.map((f) => f.id)).toEqual([
      "JR",
      "Keio",
    ]);
    expect(unpack(h.uploads.get(packObjectPath("permanent"))!).feeds.map((f) => f.id)).toEqual([
      "Metro",
      "Toei",
    ]);
  });

  it("チャレンジ限定と恒久のパスが、取得元で分かれている（期限後に消す範囲）", () => {
    expect(packObjectPath("challenge")).not.toBe(packObjectPath("permanent"));
    expect(packObjectPath("challenge").startsWith("challenge/")).toBe(true);
  });

  it("フィードごとに、そのフィードのキーを acl:consumerKey で付け、キー不要のフィードには付けない", async () => {
    const h = harness();
    await refreshTimetablePacks(h.deps, FEEDS);
    expect(h.requested.sort()).toEqual([
      `https://center.example/Metro.zip?acl:consumerKey=${CENTER_KEY}`,
      `https://challenge.example/JR.zip?acl:consumerKey=${CHALLENGE_KEY}`,
      `https://challenge.example/Keio.zip?acl:consumerKey=${CHALLENGE_KEY}`,
      "https://public.example/Toei.zip",
    ]);
  });

  it("取得日時をフィードごとにパックへ残す", async () => {
    const h = harness();
    await refreshTimetablePacks(h.deps, FEEDS);
    const pack = unpack(h.uploads.get(packObjectPath("permanent"))!);
    expect(pack.feeds[0].fetchedAt).toBe("2026-10-23T19:00:00.000Z");
  });

  it("グループの中で1つでも取得に失敗したら、そのグループは上書きしない（前回のパックを残す）", async () => {
    const h = harness((url) =>
      url.includes("Keio")
        ? new Response("Forbidden", { status: 403 })
        : new Response(gtfsZip("X")),
    );
    const results = await refreshTimetablePacks(h.deps, FEEDS);
    expect([...h.uploads.keys()]).toEqual([packObjectPath("permanent")]);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "challenge", status: "skipped", failedFeeds: ["Keio"] }),
        expect.objectContaining({ group: "permanent", status: "uploaded" }),
      ]),
    );
  });

  it("zip でない応答（エラーページなど）も取得の失敗として扱う", async () => {
    const h = harness((url) =>
      url.includes("Metro") ? new Response("<html>maintenance</html>") : new Response(gtfsZip("X")),
    );
    const results = await refreshTimetablePacks(h.deps, FEEDS);
    expect(h.uploads.has(packObjectPath("permanent"))).toBe(false);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "permanent", status: "skipped", failedFeeds: ["Metro"] }),
      ]),
    );
  });

  it("便が1本も取れないフィード（中身が見出しだけなど）も失敗として扱い、グループを上書きしない", async () => {
    const empty = zipSync({
      "stops.txt": strToU8("stop_id,stop_name,stop_lat,stop_lon\n"),
      "routes.txt": strToU8("route_id\n"),
      "trips.txt": strToU8("route_id,service_id,trip_id\n"),
      "stop_times.txt": strToU8("trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"),
      "calendar_dates.txt": strToU8("service_id,date,exception_type\n"),
    });
    const h = harness((url) =>
      url.includes("Toei") ? new Response(empty) : new Response(gtfsZip("X")),
    );
    const results = await refreshTimetablePacks(h.deps, FEEDS);
    expect(h.uploads.has(packObjectPath("permanent"))).toBe(false);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "permanent", status: "skipped", failedFeeds: ["Toei"] }),
      ]),
    );
  });

  it("キーが無いフィードは取りに行かずに失敗にする", async () => {
    const h = harness(undefined, { ODPT_CENTER_KEY: CENTER_KEY });
    const results = await refreshTimetablePacks(h.deps, FEEDS);
    expect(h.requested.some((u) => u.includes("challenge.example"))).toBe(false);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "challenge", status: "skipped", failedFeeds: ["JR", "Keio"] }),
      ]),
    );
  });

  it("失敗してもログ・結果にキーの値も URL も出さない", async () => {
    const h = harness((url) => {
      if (url.includes("JR")) throw new TypeError(`fetch failed: ${url}`);
      return new Response(`denied ${url}`, { status: 401 });
    });
    const results = await refreshTimetablePacks(h.deps, FEEDS);
    const written = JSON.stringify({ results, logs: h.logs });
    expect(written).not.toContain(CENTER_KEY);
    expect(written).not.toContain(CHALLENGE_KEY);
    expect(written).not.toContain("example");
    expect(h.logs.length).toBeGreaterThan(0);
  });

  it("失敗したフィードの HTTP ステータスをログに残す", async () => {
    const h = harness((url) =>
      url.includes("Keio") ? new Response("", { status: 503 }) : new Response(gtfsZip("X")),
    );
    await refreshTimetablePacks(h.deps, FEEDS);
    expect(h.logs).toContainEqual(
      expect.objectContaining({ event: "timetable_feed_fetch", feed: "Keio", httpStatus: 503 }),
    );
  });
});

describe("ODPT_FEEDS", () => {
  it("9フィードを、#456 の表どおりのキーとグループに割り当てる", () => {
    expect(ODPT_FEEDS.map(({ id, key, group }) => `${id}:${key}:${group}`)).toEqual([
      "JR-East:ODPT_CHALLENGE_KEY:challenge",
      "Keio:ODPT_CHALLENGE_KEY:challenge",
      "Tobu:ODPT_CHALLENGE_KEY:challenge",
      "Sotetsu:ODPT_CHALLENGE_KEY:challenge",
      "TokyoMetro:ODPT_CENTER_KEY:permanent",
      "MIR:ODPT_CENTER_KEY:permanent",
      "TWR:ODPT_CENTER_KEY:permanent",
      "TamaMonorail:ODPT_CENTER_KEY:permanent",
      "Toei:null:permanent",
    ]);
  });

  it("チャレンジのキーは api-challenge にだけ送る", () => {
    for (const f of ODPT_FEEDS) {
      expect(f.key === "ODPT_CHALLENGE_KEY").toBe(new URL(f.url).host === "api-challenge.odpt.org");
    }
  });
});
