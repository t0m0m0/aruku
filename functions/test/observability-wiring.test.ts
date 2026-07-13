import { EventEmitter } from "events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HttpsFunction, Request } from "firebase-functions/v2/https";
import type { Response } from "express";

// vi.mock はホイストされるため、参照する mock 関数は vi.hoisted で先に生成する。
// メトリクス呼び出しそのもの（引数の形）を検証したいので、metrics モジュールを
// まるごとモックし、実際の logger 出力は metrics.test.ts 側で担保する。
const {
  httpsRequestMock,
  verifyTokenMock,
  runTransactionMock,
  logRequestOutcomeMock,
  logAppCheckDeniedMock,
  logRateLimitMock,
} = vi.hoisted(() => ({
  httpsRequestMock: vi.fn(),
  verifyTokenMock: vi.fn(),
  runTransactionMock: vi.fn(),
  logRequestOutcomeMock: vi.fn(),
  logAppCheckDeniedMock: vi.fn(),
  logRateLimitMock: vi.fn(),
}));

vi.mock("https", () => ({
  default: { request: httpsRequestMock },
  request: httpsRequestMock,
}));

vi.mock("firebase-admin/app-check", () => ({
  getAppCheck: () => ({ verifyToken: verifyTokenMock }),
}));

vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({
    collection: () => ({ doc: (id: string) => ({ id }) }),
    runTransaction: runTransactionMock,
  }),
  Timestamp: { fromMillis: (ms: number) => ({ _millis: ms }) },
}));

vi.mock("../src/metrics", () => ({
  logRequestOutcome: logRequestOutcomeMock,
  logAppCheckDenied: logAppCheckDeniedMock,
  logRateLimit: logRateLimitMock,
}));

import {
  checkRateLimitFirestore,
  checkRateLimitInMemory,
  resetRateLimit,
} from "../src/rate-limiter";
import {
  googleWalkMatrixProxy,
  googleWalkProxy,
  navitimeProxy,
  resetRateLimit as resetRateLimitFromIndex,
  verifyAppCheck,
} from "../src/index";

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
  ip?: string;
  method?: string;
}) {
  return {
    method: opts.method ?? "GET",
    query: opts.query ?? {},
    headers: {} as Record<string, string | undefined>,
    header: (name: string) =>
      name === "X-Firebase-AppCheck" ? opts.token : undefined,
    ip: opts.ip ?? "127.0.0.1",
  };
}

async function invokeHandler(
  handler: HttpsFunction,
  req: ReturnType<typeof makeReq>,
  res: CapturedRes
): Promise<void> {
  await handler(req as unknown as Request, res as unknown as Response);
}

function mockUpstream(body: unknown, statusCode = 200): void {
  httpsRequestMock.mockImplementation(
    (_url: string, _opts: unknown, cb: (r: EventEmitter) => void) => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = statusCode;
      cb(res);
      process.nextTick(() => {
        res.emit("data", Buffer.from(JSON.stringify(body)));
        res.emit("end");
      });
      return { on: vi.fn(), write: vi.fn(), end: vi.fn() };
    }
  );
}

function makeMockReq(): EventEmitter & {
  write: (c: string) => void;
  end: () => void;
  destroy: (e?: Error) => void;
} {
  const req = new EventEmitter() as EventEmitter & {
    write: (c: string) => void;
    end: () => void;
    destroy: (e?: Error) => void;
  };
  req.write = () => {};
  req.end = () => {};
  req.destroy = (e?: Error) => {
    process.nextTick(() => req.emit("error", e ?? new Error("destroyed")));
  };
  return req;
}

function mockUpstreamTimeout(): void {
  httpsRequestMock.mockImplementation(() => {
    const req = makeMockReq();
    process.nextTick(() => req.emit("timeout"));
    return req;
  });
}

describe("search_request イベント配線（fetchUpstream 経由）", () => {
  const original = process.env.FUNCTIONS_EMULATOR;

  beforeEach(() => {
    resetRateLimitFromIndex();
    httpsRequestMock.mockReset();
    logRequestOutcomeMock.mockReset();
    process.env.FUNCTIONS_EMULATOR = "true";
  });

  afterEach(() => {
    if (original === undefined) delete process.env.FUNCTIONS_EMULATOR;
    else process.env.FUNCTIONS_EMULATOR = original;
  });

  it("上流成功時: endpoint/upstream/status=success/httpStatus/latencyMs を記録する", async () => {
    mockUpstream({ items: [{ summary: {} }] });
    const res = makeRes();
    await invokeHandler(
      navitimeProxy,
      makeReq({ query: { start: "1,1", goal: "2,2", start_time: "t" } }),
      res
    );
    expect(logRequestOutcomeMock).toHaveBeenCalledTimes(1);
    const call = logRequestOutcomeMock.mock.calls[0][0];
    expect(call).toMatchObject({
      endpoint: "navitimeProxy",
      upstream: "navitime",
      status: "success",
      httpStatus: 200,
    });
    expect(typeof call.latencyMs).toBe("number");
  });

  it("上流 429 応答: status=failure かつ httpStatus=429 を記録する（429 判別可能）", async () => {
    mockUpstream({ message: "Too many requests" }, 429);
    const res = makeRes();
    await invokeHandler(
      navitimeProxy,
      makeReq({ query: { start: "1,1", goal: "2,2", start_time: "t" } }),
      res
    );
    expect(logRequestOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "navitimeProxy",
        upstream: "navitime",
        status: "failure",
        httpStatus: 429,
      })
    );
  });

  it("上流タイムアウト: status=failure かつ httpStatus=504 を記録する", async () => {
    mockUpstreamTimeout();
    const res = makeRes();
    await invokeHandler(
      googleWalkProxy,
      makeReq({ query: { start: "35.7,139.7", goal: "35.6,139.7" } }),
      res
    );
    expect(logRequestOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "googleWalkProxy",
        upstream: "routes-walk",
        status: "failure",
        httpStatus: 504,
      })
    );
  });

  it("上流 403（Routes API 権限エラー）: status=failure かつ httpStatus=403 を記録する", async () => {
    mockUpstream({ error: { code: 403, status: "PERMISSION_DENIED" } }, 403);
    const res = makeRes();
    await invokeHandler(
      googleWalkProxy,
      makeReq({ query: { start: "35.7,139.7", goal: "35.6,139.7" } }),
      res
    );
    expect(logRequestOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "googleWalkProxy",
        upstream: "routes-walk",
        status: "failure",
        httpStatus: 403,
      })
    );
  });

  // 以下3ケースは上流が HTTP 200 でエラー形状のボディを返し、呼び出し側で 502 に
  // 変換されるパス。SLO 上も failure として1回だけ計上されることを固定する
  // （成功として記録される退行は、まさに検出したいクォータ/認証/スキーマ失敗を隠す）。
  it("navitimeProxy: 200+エラーボディ（message かつ items 無し）は failure(semanticFailure) として記録する", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockUpstream({ message: "You have exceeded the rate limit" });
    const res = makeRes();
    await invokeHandler(
      navitimeProxy,
      makeReq({ query: { start: "1,1", goal: "2,2", start_time: "t" } }),
      res
    );
    expect(res.statusCode).toBe(502);
    expect(logRequestOutcomeMock).toHaveBeenCalledTimes(1);
    expect(logRequestOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "navitimeProxy",
        upstream: "navitime",
        status: "failure",
        httpStatus: 200,
        semanticFailure: true,
      })
    );
    vi.restoreAllMocks();
  });

  it("googleWalkProxy: 200+エラーボディ（error かつ routes 無し）は failure(semanticFailure) として記録する", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockUpstream({ error: { code: 403, status: "PERMISSION_DENIED" } });
    const res = makeRes();
    await invokeHandler(
      googleWalkProxy,
      makeReq({ query: { start: "35.7,139.7", goal: "35.6,139.7" } }),
      res
    );
    expect(res.statusCode).toBe(502);
    expect(logRequestOutcomeMock).toHaveBeenCalledTimes(1);
    expect(logRequestOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "googleWalkProxy",
        upstream: "routes-walk",
        status: "failure",
        httpStatus: 200,
        semanticFailure: true,
      })
    );
    vi.restoreAllMocks();
  });

  it("googleWalkMatrixProxy: 200+非配列応答は failure(semanticFailure) として記録する", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockUpstream({ unexpected: true });
    const res = makeRes();
    await invokeHandler(
      googleWalkMatrixProxy,
      makeReq({ query: { origins: "35.7,139.7", destinations: "35.6,139.7" } }),
      res
    );
    expect(res.statusCode).toBe(502);
    expect(logRequestOutcomeMock).toHaveBeenCalledTimes(1);
    expect(logRequestOutcomeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "googleWalkMatrixProxy",
        upstream: "routes-matrix",
        status: "failure",
        httpStatus: 200,
        semanticFailure: true,
      })
    );
    vi.restoreAllMocks();
  });

  it("意味的にも有効な成功ボディは semanticFailure を含めず success として1回だけ記録する", async () => {
    mockUpstream({ routes: [{ distanceMeters: 100 }] });
    const res = makeRes();
    await invokeHandler(
      googleWalkProxy,
      makeReq({ query: { start: "35.7,139.7", goal: "35.6,139.7" } }),
      res
    );
    expect(logRequestOutcomeMock).toHaveBeenCalledTimes(1);
    const call = logRequestOutcomeMock.mock.calls[0][0];
    expect(call.status).toBe("success");
    expect(call).not.toHaveProperty("semanticFailure");
  });
});

describe("app_check_denied イベント配線（verifyAppCheck 経由）", () => {
  beforeEach(() => {
    logAppCheckDeniedMock.mockReset();
    verifyTokenMock.mockReset();
    delete process.env.FUNCTIONS_EMULATOR;
  });

  afterEach(() => {
    process.env.FUNCTIONS_EMULATOR = "true";
  });

  function makeCheckReq(token?: string) {
    return {
      header: (name: string) =>
        name === "X-Firebase-AppCheck" ? token : undefined,
    };
  }
  function makeCheckRes() {
    return {
      status(this: { code?: number }, code: number) {
        this.code = code;
        return this;
      },
      json() {
        return this;
      },
    };
  }

  it("トークン欠落: reason=missing で記録する", async () => {
    await verifyAppCheck(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeCheckReq() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeCheckRes() as any,
      { endpoint: "placesProxy" }
    );
    expect(logAppCheckDeniedMock).toHaveBeenCalledWith({
      endpoint: "placesProxy",
      reason: "missing",
    });
  });

  it("無効なトークン: reason=invalid で記録する", async () => {
    verifyTokenMock.mockRejectedValue(new Error("invalid"));
    await verifyAppCheck(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeCheckReq("bad") as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeCheckRes() as any,
      { endpoint: "navitimeProxy" }
    );
    expect(logAppCheckDeniedMock).toHaveBeenCalledWith({
      endpoint: "navitimeProxy",
      reason: "invalid",
    });
  });

  it("リプレイ検知: reason=replayed で記録する", async () => {
    verifyTokenMock.mockResolvedValue({ appId: "x", alreadyConsumed: true });
    await verifyAppCheck(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeCheckReq("replayed") as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeCheckRes() as any,
      { consume: true, endpoint: "googleWalkMatrixProxy" }
    );
    expect(logAppCheckDeniedMock).toHaveBeenCalledWith({
      endpoint: "googleWalkMatrixProxy",
      reason: "replayed",
    });
  });

  it("endpoint 未指定時は unknown にフォールバックする", async () => {
    await verifyAppCheck(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeCheckReq() as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeCheckRes() as any
    );
    expect(logAppCheckDeniedMock).toHaveBeenCalledWith({
      endpoint: "unknown",
      reason: "missing",
    });
  });

  it("検証成功時は記録しない", async () => {
    verifyTokenMock.mockResolvedValue({ appId: "x" });
    await verifyAppCheck(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeCheckReq("good") as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      makeCheckRes() as any,
      { endpoint: "placesProxy" }
    );
    expect(logAppCheckDeniedMock).not.toHaveBeenCalled();
  });
});

describe("rate_limit イベント配線（インメモリ実装）", () => {
  beforeEach(() => {
    resetRateLimit();
    logRateLimitMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRateLimit();
  });

  it("上限到達で decision=blocked を記録する", () => {
    for (let i = 0; i < 30; i++) checkRateLimitInMemory("1.1.1.1");
    expect(logRateLimitMock).not.toHaveBeenCalled();
    expect(checkRateLimitInMemory("1.1.1.1")).toBe(false);
    expect(logRateLimitMock).toHaveBeenCalledWith({ decision: "blocked" });
  });

  it("上限内では記録しない（allowed の高頻度ログを避ける設計）", () => {
    checkRateLimitInMemory("2.2.2.2");
    expect(logRateLimitMock).not.toHaveBeenCalled();
  });
});

describe("rate_limit イベント配線（Firestore 実装・フェイルオープン含む）", () => {
  let store: Map<string, { count: number; resetAt: number }>;

  beforeEach(() => {
    store = new Map();
    runTransactionMock.mockReset();
    logRateLimitMock.mockReset();
    runTransactionMock.mockImplementation(
      async (fn: (tx: unknown) => Promise<boolean>) => {
        const tx = {
          get: async (ref: { id: string }) => ({ data: () => store.get(ref.id) }),
          set: (
            ref: { id: string },
            data: { count: number; resetAt: number }
          ) => store.set(ref.id, { count: data.count, resetAt: data.resetAt }),
          update: (ref: { id: string }, data: { count: number }) => {
            const cur = store.get(ref.id);
            if (cur) store.set(ref.id, { ...cur, count: data.count });
          },
        };
        return fn(tx);
      }
    );
    vi.stubEnv("RATE_LIMIT_HMAC_KEY", "x".repeat(32));
    vi.stubEnv("FUNCTIONS_EMULATOR", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("上限到達で decision=blocked を記録する", async () => {
    for (let i = 0; i < 30; i++) await checkRateLimitFirestore("1.1.1.1");
    expect(logRateLimitMock).not.toHaveBeenCalled();
    expect(await checkRateLimitFirestore("1.1.1.1")).toBe(false);
    expect(logRateLimitMock).toHaveBeenCalledWith({ decision: "blocked" });
  });

  it("Firestore 障害時（フェイルオープン）は decision=fail-open を記録する", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    runTransactionMock.mockRejectedValueOnce(new Error("unavailable"));
    expect(await checkRateLimitFirestore("9.9.9.9")).toBe(true);
    expect(logRateLimitMock).toHaveBeenCalledWith({ decision: "fail-open" });
  });

  it("正常な許可では記録しない", async () => {
    await checkRateLimitFirestore("3.3.3.3");
    expect(logRateLimitMock).not.toHaveBeenCalled();
  });
});
