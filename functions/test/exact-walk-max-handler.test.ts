import { gzipSync } from "node:zlib";
import { EventEmitter } from "events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpsFunction, Request } from "firebase-functions/v2/https";
import type { Response } from "express";

import { PACK_FORMAT_VERSION, type TimetablePack } from "../src/timetable-pack/pack";

const { httpsRequestMock, verifyTokenMock, downloadMock, MockAgent } = vi.hoisted(() => ({
  httpsRequestMock: vi.fn(),
  verifyTokenMock: vi.fn(),
  downloadMock: vi.fn(),
  MockAgent: class MockAgent {
    constructor(readonly options: Record<string, unknown>) {}
  },
}));

vi.mock("https", () => ({
  default: { request: httpsRequestMock, Agent: MockAgent },
  request: httpsRequestMock,
  Agent: MockAgent,
}));

vi.mock("firebase-admin/app-check", () => ({
  getAppCheck: () => ({ verifyToken: verifyTokenMock }),
}));

vi.mock("firebase-admin/storage", () => ({
  getStorage: () => ({
    bucket: () => ({ file: (path: string) => ({ download: () => downloadMock(path) }) }),
  }),
}));

import {
  exactWalkMax,
  resetExactWalkMaxPacks,
  resetRateLimit,
  toMatrixElement,
} from "../src/index";
import { resetUpstreamCache } from "../src/upstream-cache";

// 駅2つ（蒲田付近→神田付近）・便1本だけのパック。2026-10-23 10:30 発・10:50 着。
const PACK: TimetablePack = {
  format: PACK_FORMAT_VERSION,
  feeds: [{ id: "Toei", fetchedAt: "2026-10-22T19:23:00.000Z", version: null }],
  stations: [],
  stops: [
    { name: "A駅", lat: 35.57, lng: 139.71, feed: 0, station: 0 },
    { name: "B駅", lat: 35.69, lng: 139.77, feed: 0, station: 1 },
  ],
  services: [{ dates: [20261023] }],
  trips: [
    {
      feed: 0,
      service: 0,
      route: "テスト線",
      headsign: "B駅行",
      block: null,
      stops: [0, 1],
      arr: [37800, 39000],
      dep: [37800, 39000],
      board: [1, 1],
      alight: [1, 1],
    },
  ],
};

const QUERY = {
  origin: "35.56,139.71",
  goal: "35.70,139.77",
  departAt: "2026-10-23T10:00:00+09:00",
  budgetMin: "180",
};

function storageHas(pack: TimetablePack | null): void {
  downloadMock.mockImplementation(async (path: string) => {
    if (pack === null || !path.startsWith("permanent/")) {
      throw Object.assign(new Error("No such object"), { code: 404 });
    }
    return [gzipSync(JSON.stringify(pack))];
  });
}

// Routes API の computeRouteMatrix。添字が0の要素は Google と同じく originIndex/destinationIndex を省く。
function matrixResponds(body: unknown, statusCode = 200): void {
  httpsRequestMock.mockImplementation(
    (_url: string, _opts: unknown, cb: (r: EventEmitter) => void) => {
      const res = Object.assign(new EventEmitter(), { statusCode });
      cb(res);
      process.nextTick(() => {
        res.emit("data", Buffer.from(JSON.stringify(body)));
        res.emit("end");
      });
      return { on: vi.fn(), write: vi.fn(), end: vi.fn() };
    },
  );
}

interface CapturedRes {
  statusCode?: number;
  body?: unknown;
  headers: Record<string, string>;
  status(code: number): CapturedRes;
  json(b: unknown): CapturedRes;
  send(b?: unknown): CapturedRes;
  set(name: string, value?: string): CapturedRes;
}

function makeRes(): CapturedRes {
  return {
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
    set(name, value) {
      if (value !== undefined) this.headers[name] = value;
      return this;
    },
  };
}

async function invoke(
  query: Record<string, string>,
  opts: { token?: string } = {},
): Promise<CapturedRes> {
  const req = {
    method: "GET",
    query,
    headers: {},
    header: (name: string) => (name.toLowerCase() === "x-firebase-appcheck" ? opts.token : undefined),
    ip: "127.0.0.1",
  };
  const res = makeRes();
  await (exactWalkMax as HttpsFunction)(req as unknown as Request, res as unknown as Response);
  return res;
}

describe("exactWalkMax", () => {
  beforeEach(() => {
    resetRateLimit();
    resetUpstreamCache();
    resetExactWalkMaxPacks();
    httpsRequestMock.mockReset();
    verifyTokenMock.mockReset();
    downloadMock.mockReset();
    vi.stubEnv("FUNCTIONS_EMULATOR", "true");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("App Check のトークンが無ければ 401 を返し、パックもマトリクスも読まない", async () => {
    vi.stubEnv("FUNCTIONS_EMULATOR", "");
    storageHas(PACK);

    const res = await invoke(QUERY);

    expect(res.statusCode).toBe(401);
    expect(downloadMock).not.toHaveBeenCalled();
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("トークンを使い捨てとして検証する（リプレイ保護）", async () => {
    vi.stubEnv("FUNCTIONS_EMULATOR", "");
    verifyTokenMock.mockResolvedValue({ alreadyConsumed: true });

    const res = await invoke(QUERY, { token: "t" });

    expect(verifyTokenMock).toHaveBeenCalledWith("t", { consume: true });
    expect(res.statusCode).toBe(401);
  });

  it.each([
    ["origin が無い", { ...QUERY, origin: "" }],
    ["departAt に時差が無い", { ...QUERY, departAt: "2026-10-23T10:00:00" }],
    ["budgetMin が0", { ...QUERY, budgetMin: "0" }],
  ])("%s入力は 400 を返し、上流を呼ばない", async (_name, query) => {
    storageHas(PACK);

    const res = await invoke(query);

    expect(res.statusCode).toBe(400);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("候補・フィードの取得日時・統計を返し、時刻表そのものは返さない", async () => {
    storageHas(PACK);
    matrixResponds([{ duration: "900s", distanceMeters: 1200 }]);

    const res = await invoke(QUERY);

    expect(res.statusCode).toBeUndefined();
    expect(res.body).toEqual({
      candidates: [
        {
          board: { name: "A駅", lat: 35.57, lng: 139.71 },
          alight: { name: "B駅", lat: 35.69, lng: 139.77 },
          route: "テスト線",
          headsign: "B駅行",
          boardAt: "2026-10-23T10:30:00+09:00",
          alightAt: "2026-10-23T10:50:00+09:00",
          stops: [
            { lat: 35.57, lng: 139.71 },
            { lat: 35.69, lng: 139.77 },
          ],
          accessWalk: { durationSec: 900, distanceMeters: 1200 },
          egressWalk: { durationSec: 900, distanceMeters: 1200 },
        },
      ],
      feeds: [{ id: "Toei", fetchedAt: "2026-10-22T19:23:00.000Z" }],
      stats: { tripsScanned: 1, elementsMeasured: 2, truncated: false },
    });
    expect(httpsRequestMock).toHaveBeenCalledTimes(2);
  });

  it("読めるパックが無ければ 503 を返し、マトリクスを呼ばない", async () => {
    storageHas(null);

    const res = await invoke(QUERY);

    expect(res.statusCode).toBe(503);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("マトリクスが失敗したら 502 を返す", async () => {
    storageHas(PACK);
    matrixResponds({ error: { code: 403, status: "PERMISSION_DENIED" } }, 403);

    const res = await invoke(QUERY);

    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: "upstream error" });
  });

  it("マトリクスが無応答なら 504 を返す", async () => {
    storageHas(PACK);
    httpsRequestMock.mockImplementation(() => {
      const req = Object.assign(new EventEmitter(), {
        write: vi.fn(),
        end: vi.fn(),
        destroy: (e?: Error) => process.nextTick(() => req.emit("error", e)),
      });
      process.nextTick(() => req.emit("timeout"));
      return req;
    });

    const res = await invoke(QUERY);

    expect(res.statusCode).toBe(504);
  });
});

describe("toMatrixElement", () => {
  it("所要時間・距離・添字を読む", () => {
    expect(
      toMatrixElement({ originIndex: 2, destinationIndex: 3, duration: "754s", distanceMeters: 980 }),
    ).toEqual([{ originIndex: 2, destinationIndex: 3, durationSec: 754, distanceMeters: 980 }]);
  });

  it("省かれた添字と距離は 0 と読む（proto3 は 0 のフィールドを出さない）", () => {
    expect(toMatrixElement({ duration: "0s" })).toEqual([
      { originIndex: 0, destinationIndex: 0, durationSec: 0, distanceMeters: 0 },
    ]);
  });

  it("経路の無い要素（duration が無い）は捨てる", () => {
    expect(toMatrixElement({ originIndex: 1, condition: "ROUTE_NOT_FOUND" })).toEqual([]);
    expect(toMatrixElement(null)).toEqual([]);
  });
});
