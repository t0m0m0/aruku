import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { EventEmitter } from "events";
import type { HttpsFunction, Request } from "firebase-functions/v2/https";
import type { Response } from "express";

// vi.mock はホイストされるため、参照する mock 関数は vi.hoisted で先に生成する。
const { httpsRequestMock, verifyTokenMock } = vi.hoisted(() => ({
  httpsRequestMock: vi.fn(),
  verifyTokenMock: vi.fn(),
}));

vi.mock("https", () => ({
  default: { request: httpsRequestMock },
  request: httpsRequestMock,
}));

vi.mock("firebase-admin/app-check", () => ({
  getAppCheck: () => ({ verifyToken: verifyTokenMock }),
}));

import {
  checkRateLimit,
  googleWalkProxy,
  navitimeProxy,
  placesProxy,
  resetRateLimit,
} from "../src/index";

// https.request をモックし、指定 JSON ボディを返すレスポンスを擬似する。
function mockUpstream(body: unknown): void {
  httpsRequestMock.mockImplementation(
    (_url: string, _opts: unknown, cb: (r: EventEmitter) => void) => {
      const res = new EventEmitter();
      cb(res);
      process.nextTick(() => {
        res.emit("data", Buffer.from(JSON.stringify(body)));
        res.emit("end");
      });
      return { on: vi.fn(), write: vi.fn(), end: vi.fn() };
    }
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
  const res: CapturedRes = {
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
  return res;
}

function makeReq(opts: {
  query?: Record<string, string>;
  token?: string;
  forwardedFor?: string;
  method?: string;
}) {
  const headers: Record<string, string | undefined> = {};
  if (opts.forwardedFor) headers["x-forwarded-for"] = opts.forwardedFor;
  return {
    method: opts.method ?? "GET",
    query: opts.query ?? {},
    headers,
    header: (name: string) =>
      name === "X-Firebase-AppCheck" ? opts.token : undefined,
    ip: "127.0.0.1",
  };
}

// onRequest ハンドラ（HttpsFunction）を最小フェイクの req/res で起動する。
// フェイクはハンドラが参照するプロパティのみを備えた意図的な部分実装のため、
// 実型への変換はこのヘルパー内の 1 箇所に閉じ込める。
async function invokeHandler(
  handler: HttpsFunction,
  req: ReturnType<typeof makeReq>,
  res: CapturedRes
): Promise<void> {
  await handler(req as unknown as Request, res as unknown as Response);
}

describe("ハンドラ統合（502 分岐・透過）", () => {
  const original = process.env.FUNCTIONS_EMULATOR;

  beforeEach(() => {
    resetRateLimit();
    httpsRequestMock.mockReset();
    // エミュレータ扱いで App Check 検証をスキップし、上流応答の分岐に集中する。
    process.env.FUNCTIONS_EMULATOR = "true";
  });

  afterEach(() => {
    if (original === undefined) delete process.env.FUNCTIONS_EMULATOR;
    else process.env.FUNCTIONS_EMULATOR = original;
  });

  it("navitimeProxy: message かつ items 無しは 502 で返す", async () => {
    mockUpstream({ message: "Too many requests" });
    const res = makeRes();
    await invokeHandler(
      navitimeProxy,
      makeReq({ query: { start: "1,1", goal: "2,2", start_time: "t" } }),
      res
    );
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ message: "Too many requests" });
  });

  it("navitimeProxy: items を含む正常応答はそのまま透過する", async () => {
    const payload = { items: [{ summary: {} }] };
    mockUpstream(payload);
    const res = makeRes();
    await invokeHandler(
      navitimeProxy,
      makeReq({ query: { start: "1,1", goal: "2,2", start_time: "t" } }),
      res
    );
    expect(res.statusCode).toBeUndefined();
    expect(res.body).toEqual(payload);
  });

  it("navitimeProxy: 必須パラメータ欠落は 400 で上流を呼ばない", async () => {
    const res = makeRes();
    await invokeHandler(navitimeProxy, makeReq({ query: { start: "1,1" } }), res);
    expect(res.statusCode).toBe(400);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("googleWalkProxy: error かつ routes 無しは 502 で返す", async () => {
    mockUpstream({ error: { code: 403, status: "PERMISSION_DENIED" } });
    const res = makeRes();
    await invokeHandler(
      googleWalkProxy,
      makeReq({ query: { start: "35.7,139.7", goal: "35.6,139.7" } }),
      res
    );
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({
      error: { code: 403, status: "PERMISSION_DENIED" },
    });
  });

  it("googleWalkProxy: routes を含む正常応答はそのまま透過する", async () => {
    const payload = { routes: [{ distanceMeters: 100 }] };
    mockUpstream(payload);
    const res = makeRes();
    await invokeHandler(
      googleWalkProxy,
      makeReq({ query: { start: "35.7,139.7", goal: "35.6,139.7" } }),
      res
    );
    expect(res.statusCode).toBeUndefined();
    expect(res.body).toEqual(payload);
  });

  it("googleWalkProxy: 不正な座標は 400 で上流を呼ばない", async () => {
    const res = makeRes();
    await invokeHandler(
      googleWalkProxy,
      makeReq({ query: { start: "not-a-coord", goal: "35.6,139.7" } }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("レート制限超過時は 429 を返し上流を呼ばない", async () => {
    // 同一 IP で上限(30)まで消費しておき、ハンドラ到達時に 429 とする。
    for (let i = 0; i < 30; i++) checkRateLimit("9.9.9.9");
    const res = makeRes();
    await invokeHandler(
      navitimeProxy,
      makeReq({
        query: { start: "1,1", goal: "2,2", start_time: "t" },
        forwardedFor: "9.9.9.9",
      }),
      res
    );
    expect(res.statusCode).toBe(429);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });
});

describe("ハンドラ統合（App Check 401）", () => {
  const original = process.env.FUNCTIONS_EMULATOR;

  beforeEach(() => {
    resetRateLimit();
    httpsRequestMock.mockReset();
    verifyTokenMock.mockReset();
    // 非エミュレータで App Check 検証を有効にする。
    delete process.env.FUNCTIONS_EMULATOR;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.FUNCTIONS_EMULATOR;
    else process.env.FUNCTIONS_EMULATOR = original;
  });

  it("トークン欠落時は 401 を返し上流を呼ばない", async () => {
    const res = makeRes();
    await invokeHandler(
      navitimeProxy,
      makeReq({ query: { start: "1,1", goal: "2,2", start_time: "t" } }),
      res
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "App Check token missing" });
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("無効なトークン時は 401 を返し上流を呼ばない", async () => {
    verifyTokenMock.mockRejectedValue(new Error("invalid"));
    const res = makeRes();
    await invokeHandler(
      googleWalkProxy,
      makeReq({
        query: { start: "35.7,139.7", goal: "35.6,139.7" },
        token: "bad",
      }),
      res
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "App Check token invalid" });
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });
});

describe("placesProxy（action 分岐・変換透過）", () => {
  const original = process.env.FUNCTIONS_EMULATOR;

  beforeEach(() => {
    resetRateLimit();
    httpsRequestMock.mockReset();
    // エミュレータ扱いで App Check をスキップし、action 分岐に集中する。
    process.env.FUNCTIONS_EMULATOR = "true";
  });

  afterEach(() => {
    if (original === undefined) delete process.env.FUNCTIONS_EMULATOR;
    else process.env.FUNCTIONS_EMULATOR = original;
  });

  it("autocomplete: input 欠落は 400 で上流を呼ばない", async () => {
    const res = makeRes();
    await invokeHandler(
      placesProxy,
      makeReq({ query: { action: "autocomplete" } }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "input is required" });
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("autocomplete: suggestions をレガシー predictions へ変換して返す", async () => {
    mockUpstream({
      suggestions: [
        {
          placePrediction: {
            placeId: "place-123",
            text: { text: "東京駅" },
            structuredFormat: {
              mainText: { text: "東京駅" },
              secondaryText: { text: "東京都千代田区" },
            },
          },
        },
      ],
    });
    const res = makeRes();
    await invokeHandler(
      placesProxy,
      makeReq({ query: { action: "autocomplete", input: "東京" } }),
      res
    );
    expect(res.statusCode).toBeUndefined();
    expect(res.body).toEqual({
      status: "OK",
      predictions: [
        {
          place_id: "place-123",
          description: "東京駅",
          terms: [{ value: "東京駅" }, { value: "東京都千代田区" }],
        },
      ],
    });
  });

  it("details: place_id 欠落は 400 で上流を呼ばない", async () => {
    const res = makeRes();
    await invokeHandler(
      placesProxy,
      makeReq({ query: { action: "details" } }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: "place_id is required" });
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("details: location をレガシー result へ変換して返す", async () => {
    mockUpstream({ location: { latitude: 35.681, longitude: 139.767 } });
    const res = makeRes();
    await invokeHandler(
      placesProxy,
      makeReq({ query: { action: "details", place_id: "place-123" } }),
      res
    );
    expect(res.statusCode).toBeUndefined();
    expect(res.body).toEqual({
      status: "OK",
      result: { geometry: { location: { lat: 35.681, lng: 139.767 } } },
    });
  });

  it("未知の action は 400 で上流を呼ばない", async () => {
    const res = makeRes();
    await invokeHandler(
      placesProxy,
      makeReq({ query: { action: "unknown" } }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: "action must be autocomplete or details",
    });
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });
});

describe("CORS プリフライト（OPTIONS）", () => {
  const handlers: [string, HttpsFunction][] = [
    ["placesProxy", placesProxy],
    ["navitimeProxy", navitimeProxy],
    ["googleWalkProxy", googleWalkProxy],
  ];

  beforeEach(() => {
    httpsRequestMock.mockReset();
  });

  it.each(handlers)(
    "%s: OPTIONS は 204 と CORS ヘッダを返し上流を呼ばない",
    async (_name, handler) => {
      const res = makeRes();
      await invokeHandler(handler, makeReq({ method: "OPTIONS" }), res);
      expect(res.statusCode).toBe(204);
      expect(res.body).toBe("");
      expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
      expect(res.headers["Access-Control-Allow-Methods"]).toBe("GET");
      expect(res.headers["Access-Control-Allow-Headers"]).toBe(
        "Content-Type, X-Firebase-AppCheck"
      );
      expect(httpsRequestMock).not.toHaveBeenCalled();
    }
  );
});
