import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { EventEmitter } from "events";

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
  status(code: number): CapturedRes;
  json(b: unknown): CapturedRes;
  send(b?: unknown): CapturedRes;
  set(...args: unknown[]): CapturedRes;
}

function makeRes(): CapturedRes {
  const res: CapturedRes = {
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
    set() {
      return this;
    },
  };
  return res;
}

function makeReq(opts: {
  query?: Record<string, string>;
  token?: string;
  forwardedFor?: string;
}) {
  const headers: Record<string, string | undefined> = {};
  if (opts.forwardedFor) headers["x-forwarded-for"] = opts.forwardedFor;
  return {
    method: "GET",
    query: opts.query ?? {},
    headers,
    header: (name: string) =>
      name === "X-Firebase-AppCheck" ? opts.token : undefined,
    ip: "127.0.0.1",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyReq = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRes = any;

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
    await (navitimeProxy as AnyRes)(
      makeReq({ query: { start: "1,1", goal: "2,2", start_time: "t" } }) as AnyReq,
      res as AnyRes
    );
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ message: "Too many requests" });
  });

  it("navitimeProxy: items を含む正常応答はそのまま透過する", async () => {
    const payload = { items: [{ summary: {} }] };
    mockUpstream(payload);
    const res = makeRes();
    await (navitimeProxy as AnyRes)(
      makeReq({ query: { start: "1,1", goal: "2,2", start_time: "t" } }) as AnyReq,
      res as AnyRes
    );
    expect(res.statusCode).toBeUndefined();
    expect(res.body).toEqual(payload);
  });

  it("navitimeProxy: 必須パラメータ欠落は 400 で上流を呼ばない", async () => {
    const res = makeRes();
    await (navitimeProxy as AnyRes)(
      makeReq({ query: { start: "1,1" } }) as AnyReq,
      res as AnyRes
    );
    expect(res.statusCode).toBe(400);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("googleWalkProxy: error かつ routes 無しは 502 で返す", async () => {
    mockUpstream({ error: { code: 403, status: "PERMISSION_DENIED" } });
    const res = makeRes();
    await (googleWalkProxy as AnyRes)(
      makeReq({ query: { start: "35.7,139.7", goal: "35.6,139.7" } }) as AnyReq,
      res as AnyRes
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
    await (googleWalkProxy as AnyRes)(
      makeReq({ query: { start: "35.7,139.7", goal: "35.6,139.7" } }) as AnyReq,
      res as AnyRes
    );
    expect(res.statusCode).toBeUndefined();
    expect(res.body).toEqual(payload);
  });

  it("googleWalkProxy: 不正な座標は 400 で上流を呼ばない", async () => {
    const res = makeRes();
    await (googleWalkProxy as AnyRes)(
      makeReq({ query: { start: "not-a-coord", goal: "35.6,139.7" } }) as AnyReq,
      res as AnyRes
    );
    expect(res.statusCode).toBe(400);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("レート制限超過時は 429 を返し上流を呼ばない", async () => {
    // 同一 IP で上限(30)まで消費しておき、ハンドラ到達時に 429 とする。
    for (let i = 0; i < 30; i++) checkRateLimit("9.9.9.9");
    const res = makeRes();
    await (navitimeProxy as AnyRes)(
      makeReq({
        query: { start: "1,1", goal: "2,2", start_time: "t" },
        forwardedFor: "9.9.9.9",
      }) as AnyReq,
      res as AnyRes
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
    await (navitimeProxy as AnyRes)(
      makeReq({ query: { start: "1,1", goal: "2,2", start_time: "t" } }) as AnyReq,
      res as AnyRes
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "App Check token missing" });
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("無効なトークン時は 401 を返し上流を呼ばない", async () => {
    verifyTokenMock.mockRejectedValue(new Error("invalid"));
    const res = makeRes();
    await (googleWalkProxy as AnyRes)(
      makeReq({
        query: { start: "35.7,139.7", goal: "35.6,139.7" },
        token: "bad",
      }) as AnyReq,
      res as AnyRes
    );
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "App Check token invalid" });
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });
});
