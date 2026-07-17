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

// vi.mock はホイストされるため、参照する mock 関数・クラスは vi.hoisted で
// 先に生成する。MockAgent は https.Agent はモジュール読込時（トップレベル）に
// `new https.Agent(...)` されるため、request 同様にコンストラクト可能な
// スタブが必要（issue #307）。実際の keepAlive 挙動は検証対象ではなく、
// 渡されたオプションを保持するだけでよい。
const { httpsRequestMock, verifyTokenMock, MockAgent } = vi.hoisted(() => ({
  httpsRequestMock: vi.fn(),
  verifyTokenMock: vi.fn(),
  MockAgent: class MockAgent {
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
    }
  },
}));

// MockAgent は vi.hoisted 内のクラス式のためコンストラクタ型の値であり、
// そのままではインスタンス型として使えない。型参照用に別名を用意する。
type MockAgentInstance = InstanceType<typeof MockAgent>;

vi.mock("https", () => ({
  default: { request: httpsRequestMock, Agent: MockAgent },
  request: httpsRequestMock,
  Agent: MockAgent,
}));

vi.mock("firebase-admin/app-check", () => ({
  getAppCheck: () => ({ verifyToken: verifyTokenMock }),
}));

import {
  checkRateLimit,
  googleWalkMatrixProxy,
  googleWalkProxy,
  MAX_RESPONSE_BYTES,
  navitimeProxy,
  placesProxy,
  resetRateLimit,
} from "../src/index";
import { resetUpstreamCache } from "../src/upstream-cache";

// https.request をモックし、指定 JSON ボディ・ステータスで応答を擬似する。
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

// 上流応答を擬似しつつ、ハンドラが req.write した送信ボディ（JSON 文字列）を
// 捕捉する。POST 本文（locationBias など）を検証するために使う。
function mockUpstreamCapture(body: unknown): { sent(): unknown } {
  let written = "";
  httpsRequestMock.mockImplementation(
    (_url: string, _opts: unknown, cb: (r: EventEmitter) => void) => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = 200;
      cb(res);
      process.nextTick(() => {
        res.emit("data", Buffer.from(JSON.stringify(body)));
        res.emit("end");
      });
      return {
        on: vi.fn(),
        write: (chunk: string) => {
          written += chunk;
        },
        end: vi.fn(),
      };
    }
  );
  return {
    sent: () => (written ? JSON.parse(written) : undefined),
  };
}

// タイムアウト/サイズ超過検証用の擬似リクエスト。https.request の返り値を
// EventEmitter とし、destroy(err) が error イベントを発火する挙動を再現する
// （本番の req.destroy と同じく error 経由で reject させるため）。
// reusedSocket は stale ソケットリトライ（issue #307）検証用。既定 false は
// 「新規ソケット」を表し、既存のタイムアウト/サイズ超過テストの挙動を変えない。
function makeMockReq(reusedSocket = false): EventEmitter & {
  write: (c: string) => void;
  end: () => void;
  destroy: (e?: Error) => void;
  reusedSocket: boolean;
} {
  const req = new EventEmitter() as EventEmitter & {
    write: (c: string) => void;
    end: () => void;
    destroy: (e?: Error) => void;
    reusedSocket: boolean;
  };
  req.reusedSocket = reusedSocket;
  req.write = () => {};
  req.end = () => {};
  req.destroy = (e?: Error) => {
    process.nextTick(() => req.emit("error", e ?? new Error("destroyed")));
  };
  return req;
}

// 上流無応答をシミュレートする。レスポンスコールバックを呼ばず、timeout を発火。
function mockUpstreamTimeout(): void {
  httpsRequestMock.mockImplementation(() => {
    const req = makeMockReq();
    process.nextTick(() => req.emit("timeout"));
    return req;
  });
}

// stale keep-alive ソケット検証用（issue #307）。1回目の呼び出しは
// reusedSocket=<firstReusedSocket> の擬似リクエストが、レスポンスヘッダ受信前に
// 生の（UpstreamError でない）ネットワークエラーで失敗する。2回目の呼び出しが
// 発生した場合は正常応答を返す。実際に何回 https.request が呼ばれたかは
// httpsRequestMock.mock.calls.length で検証する。
function mockUpstreamStaleSocketThenSuccess(
  body: unknown,
  firstReusedSocket: boolean
): void {
  let callCount = 0;
  httpsRequestMock.mockImplementation(
    (_url: string, _opts: unknown, cb: (r: EventEmitter) => void) => {
      callCount += 1;
      if (callCount === 1) {
        const req = makeMockReq(firstReusedSocket);
        process.nextTick(() => {
          const err = new Error("socket hang up") as NodeJS.ErrnoException;
          err.code = "ECONNRESET";
          req.emit("error", err);
        });
        return req;
      }
      const req = makeMockReq(false);
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = 200;
      cb(res);
      process.nextTick(() => {
        res.emit("data", Buffer.from(JSON.stringify(body)));
        res.emit("end");
      });
      return req;
    }
  );
}

// 指定バイト数のボディを 1 チャンクで流す上流をシミュレートする（end は発火せず、
// サイズ超過時のハンドラ側 destroy に委ねる）。
function mockUpstreamBytes(bytes: number): void {
  httpsRequestMock.mockImplementation(
    (_url: string, _opts: unknown, cb: (r: EventEmitter) => void) => {
      const req = makeMockReq();
      const res = new EventEmitter();
      cb(res);
      process.nextTick(() => {
        res.emit("data", Buffer.alloc(bytes));
      });
      return req;
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
    resetUpstreamCache();
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

  it("googleWalkMatrixProxy: 要素配列の正常応答はそのまま透過する", async () => {
    const payload = [
      { originIndex: 0, destinationIndex: 0, duration: "600s", distanceMeters: 800 },
    ];
    mockUpstream(payload);
    const res = makeRes();
    await invokeHandler(
      googleWalkMatrixProxy,
      makeReq({
        query: { origins: "35.7,139.7", destinations: "35.6,139.7;35.65,139.72" },
      }),
      res
    );
    expect(res.statusCode).toBeUndefined();
    expect(res.body).toEqual(payload);
  });

  it("googleWalkMatrixProxy: error かつ配列でない応答は 502 で返す", async () => {
    mockUpstream({ error: { code: 403, status: "PERMISSION_DENIED" } });
    const res = makeRes();
    await invokeHandler(
      googleWalkMatrixProxy,
      makeReq({ query: { origins: "35.7,139.7", destinations: "35.6,139.7" } }),
      res
    );
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({
      error: { code: 403, status: "PERMISSION_DENIED" },
    });
  });

  it("googleWalkMatrixProxy: error を含まない非配列応答も 502 で返す", async () => {
    // 想定外の応答（配列でなく error も無い）。「成功＝配列」の不変条件をプロキシ側で
    // 担保し、非配列の 200 をクライアントへ漏らさない。
    mockUpstream({ unexpected: true });
    const res = makeRes();
    await invokeHandler(
      googleWalkMatrixProxy,
      makeReq({ query: { origins: "35.7,139.7", destinations: "35.6,139.7" } }),
      res
    );
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ unexpected: true });
  });

  it("googleWalkMatrixProxy: パラメータ欠落は 400 で上流を呼ばない", async () => {
    const res = makeRes();
    await invokeHandler(
      googleWalkMatrixProxy,
      makeReq({ query: { origins: "35.7,139.7" } }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("googleWalkMatrixProxy: 要素数上限超過は 400 で上流を呼ばない", async () => {
    // origins 6 × destinations 6 = 36 > 25（上限）。上流を呼ばず拒否する。
    const six = (base: number) =>
      Array.from({ length: 6 }, (_, i) => `35.${base}${i},139.7`).join(";");
    const res = makeRes();
    await invokeHandler(
      googleWalkMatrixProxy,
      makeReq({ query: { origins: six(1), destinations: six(2) } }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("placesProxy autocomplete: lat/lon を locationBias（円）として上流へ送る", async () => {
    const cap = mockUpstreamCapture({ suggestions: [] });
    const res = makeRes();
    await invokeHandler(
      placesProxy,
      makeReq({
        query: { action: "autocomplete", input: "マクドナルド", lat: "35.66", lon: "139.7" },
      }),
      res
    );
    expect(cap.sent()).toMatchObject({
      input: "マクドナルド",
      languageCode: "ja",
      includedRegionCodes: ["jp"],
      locationBias: {
        circle: {
          center: { latitude: 35.66, longitude: 139.7 },
          radius: 50000,
        },
      },
    });
    // 応答は変換層（toLegacyAutocomplete）を通る。
    expect(res.body).toEqual({ status: "ZERO_RESULTS", predictions: [] });
  });

  it("placesProxy autocomplete: lat/lon を origin として送る（距離取得・#146 C案）", async () => {
    const cap = mockUpstreamCapture({ suggestions: [] });
    const res = makeRes();
    await invokeHandler(
      placesProxy,
      makeReq({
        query: { action: "autocomplete", input: "マクドナルド", lat: "35.66", lon: "139.7" },
      }),
      res
    );
    expect(cap.sent()).toMatchObject({
      origin: { latitude: 35.66, longitude: 139.7 },
    });
  });

  it("placesProxy autocomplete: lat/lon 欠落時は origin を付けない", async () => {
    const cap = mockUpstreamCapture({ suggestions: [] });
    const res = makeRes();
    await invokeHandler(
      placesProxy,
      makeReq({ query: { action: "autocomplete", input: "渋谷" } }),
      res
    );
    expect(cap.sent()).not.toHaveProperty("origin");
  });

  it("placesProxy autocomplete: radius 指定は上限 50000 にクランプする", async () => {
    const cap = mockUpstreamCapture({ suggestions: [] });
    const res = makeRes();
    await invokeHandler(
      placesProxy,
      makeReq({
        query: { action: "autocomplete", input: "x", lat: "35", lon: "139", radius: "999999" },
      }),
      res
    );
    expect((cap.sent() as { locationBias: { circle: { radius: number } } })
      .locationBias.circle.radius).toBe(50000);
  });

  it("placesProxy autocomplete: lat/lon 欠落時は locationBias を付けない", async () => {
    const cap = mockUpstreamCapture({ suggestions: [] });
    const res = makeRes();
    await invokeHandler(
      placesProxy,
      makeReq({ query: { action: "autocomplete", input: "渋谷" } }),
      res
    );
    expect(cap.sent()).not.toHaveProperty("locationBias");
  });

  it("placesProxy autocomplete: input 欠落は 400 で上流を呼ばない", async () => {
    const res = makeRes();
    await invokeHandler(
      placesProxy,
      makeReq({ query: { action: "autocomplete" } }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("placesProxy details: location を変換し result.geometry へ畳む", async () => {
    mockUpstream({ location: { latitude: 35.658, longitude: 139.701 } });
    const res = makeRes();
    await invokeHandler(
      placesProxy,
      makeReq({ query: { action: "details", place_id: "id_x" } }),
      res
    );
    expect(res.body).toEqual({
      status: "OK",
      result: { geometry: { location: { lat: 35.658, lng: 139.701 } } },
    });
  });

  it("placesProxy details: place_id 欠落は 400 で上流を呼ばない", async () => {
    const res = makeRes();
    await invokeHandler(
      placesProxy,
      makeReq({ query: { action: "details" } }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("placesProxy: 未知の action は 400 で上流を呼ばない", async () => {
    const res = makeRes();
    await invokeHandler(
      placesProxy,
      makeReq({ query: { action: "bogus" } }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });

  it("レート制限超過時は 429 を返し上流を呼ばない", async () => {
    // 同一 IP で上限(30)まで消費しておき、ハンドラ到達時に 429 とする。
    // エミュレータ扱いのためインメモリ実装にディスパッチされる。
    for (let i = 0; i < 30; i++) await checkRateLimit("9.9.9.9");
    const res = makeRes();
    await invokeHandler(
      navitimeProxy,
      makeReq({
        query: { start: "1,1", goal: "2,2", start_time: "t" },
        ip: "9.9.9.9",
      }),
      res
    );
    expect(res.statusCode).toBe(429);
    expect(httpsRequestMock).not.toHaveBeenCalled();
  });
});

describe("ハンドラ統合（タイムアウト・信頼性ガード / issue #157）", () => {
  const original = process.env.FUNCTIONS_EMULATOR;

  beforeEach(() => {
    resetRateLimit();
    resetUpstreamCache();
    httpsRequestMock.mockReset();
    process.env.FUNCTIONS_EMULATOR = "true";
  });

  afterEach(() => {
    if (original === undefined) delete process.env.FUNCTIONS_EMULATOR;
    else process.env.FUNCTIONS_EMULATOR = original;
  });

  it("https.request にタイムアウトオプションを渡す", async () => {
    mockUpstreamTimeout();
    const res = makeRes();
    await invokeHandler(
      navitimeProxy,
      makeReq({ query: { start: "1,1", goal: "2,2", start_time: "t" } }),
      res
    );
    const opts = httpsRequestMock.mock.calls[0][1] as { timeout?: number };
    expect(opts.timeout).toBe(10000);
  });

  it("https.request に keepAlive:true の共有 Agent を渡す（issue #307）", async () => {
    mockUpstream({ items: [{ summary: {} }] });
    const res = makeRes();
    await invokeHandler(
      navitimeProxy,
      makeReq({ query: { start: "1,1", goal: "2,2", start_time: "t" } }),
      res
    );
    const opts = httpsRequestMock.mock.calls[0][1] as {
      agent?: MockAgentInstance;
    };
    expect(opts.agent).toBeInstanceOf(MockAgent);
    expect(opts.agent?.options.keepAlive).toBe(true);
  });

  it("複数回の呼び出しで同一の Agent インスタンスを再利用する", async () => {
    mockUpstream({ items: [{ summary: {} }] });
    await invokeHandler(
      navitimeProxy,
      makeReq({ query: { start: "1,1", goal: "2,2", start_time: "t" } }),
      makeRes()
    );
    mockUpstream({ items: [{ summary: {} }] });
    await invokeHandler(
      navitimeProxy,
      makeReq({ query: { start: "3,3", goal: "4,4", start_time: "t" } }),
      makeRes()
    );
    const firstAgent = (
      httpsRequestMock.mock.calls[0][1] as { agent?: MockAgentInstance }
    ).agent;
    const secondAgent = (
      httpsRequestMock.mock.calls[1][1] as { agent?: MockAgentInstance }
    ).agent;
    expect(firstAgent).toBe(secondAgent);
  });

  it("GET かつ再利用ソケットでの生ネットワークエラーは1回だけ再試行して成功させる（issue #307）", async () => {
    const payload = { items: [{ summary: {} }] };
    mockUpstreamStaleSocketThenSuccess(payload, true);
    const res = makeRes();
    await invokeHandler(
      navitimeProxy,
      makeReq({ query: { start: "1,1", goal: "2,2", start_time: "t" } }),
      res
    );
    expect(httpsRequestMock).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBeUndefined();
    expect(res.body).toEqual(payload);
  });

  it("新規ソケット（reusedSocket=false）での生ネットワークエラーは再試行せず 502 を返す", async () => {
    mockUpstreamStaleSocketThenSuccess({ items: [{ summary: {} }] }, false);
    const res = makeRes();
    await invokeHandler(
      navitimeProxy,
      makeReq({ query: { start: "1,1", goal: "2,2", start_time: "t" } }),
      res
    );
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: "upstream error" });
  });

  it("POST（非冪等扱い）は再利用ソケットでの生ネットワークエラーでも再試行せず 502 を返す", async () => {
    // placesProxy の autocomplete は上流へ POST で問い合わせる唯一の GET
    // エンドポイント。再試行ガードが method で正しく絞れているかを見る。
    mockUpstreamStaleSocketThenSuccess({ suggestions: [] }, true);
    const res = makeRes();
    await invokeHandler(
      placesProxy,
      makeReq({ query: { action: "autocomplete", input: "shibuya" } }),
      res
    );
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: "upstream error" });
  });

  it("navitimeProxy: 上流無応答（timeout）は 504 を返す", async () => {
    mockUpstreamTimeout();
    const res = makeRes();
    await invokeHandler(
      navitimeProxy,
      makeReq({ query: { start: "1,1", goal: "2,2", start_time: "t" } }),
      res
    );
    expect(res.statusCode).toBe(504);
    expect(res.body).toEqual({ error: "upstream timeout" });
  });

  it("googleWalkProxy: 上流無応答（timeout）は 504 を返す", async () => {
    mockUpstreamTimeout();
    const res = makeRes();
    await invokeHandler(
      googleWalkProxy,
      makeReq({ query: { start: "35.7,139.7", goal: "35.6,139.7" } }),
      res
    );
    expect(res.statusCode).toBe(504);
    expect(res.body).toEqual({ error: "upstream timeout" });
  });

  it("navitimeProxy: レスポンスサイズ上限超過は破棄して 502 を返す", async () => {
    mockUpstreamBytes(MAX_RESPONSE_BYTES + 1);
    const res = makeRes();
    await invokeHandler(
      navitimeProxy,
      makeReq({ query: { start: "1,1", goal: "2,2", start_time: "t" } }),
      res
    );
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: "upstream error" });
  });

  it("navitimeProxy: 上限以内のサイズは破棄しない（正常透過）", async () => {
    // 上限ちょうどのボディ（有効な JSON）は破棄されず、通常処理される。
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

  it("navitimeProxy: 上流が非2xxならボディ形状に依らず 502 で上流ボディを返す", async () => {
    // RapidAPI が 429（items あり得ない）を返す想定。ステータス一次判定で 502。
    mockUpstream({ message: "Too many requests" }, 429);
    const res = makeRes();
    await invokeHandler(
      navitimeProxy,
      makeReq({ query: { start: "1,1", goal: "2,2", start_time: "t" } }),
      res
    );
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ message: "Too many requests" });
  });

  it("googleWalkProxy: 上流 403（PERMISSION_DENIED）は 502 で返す", async () => {
    mockUpstream({ error: { code: 403, status: "PERMISSION_DENIED" } }, 403);
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

  it("placesProxy: 上流が非2xxなら変換せず 502 を返す", async () => {
    // 従来は places がエラーボディを変換層へ渡していた。ステータス判定で 502 化する。
    mockUpstream({ error: { status: "INVALID_ARGUMENT" } }, 400);
    const res = makeRes();
    await invokeHandler(
      placesProxy,
      makeReq({ query: { action: "details", place_id: "id_x" } }),
      res
    );
    expect(res.statusCode).toBe(502);
    expect(res.body).toEqual({ error: { status: "INVALID_ARGUMENT" } });
  });
});

describe("ハンドラ統合（App Check 401）", () => {
  const original = process.env.FUNCTIONS_EMULATOR;

  beforeEach(() => {
    resetRateLimit();
    resetUpstreamCache();
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

describe("CORS プリフライト（OPTIONS）", () => {
  const handlers: [string, HttpsFunction][] = [
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

// 上流応答を手動で解決させる擬似。cb は同期で呼び（requestJsonNew が data/end
// リスナを張る）、finish() を呼ぶまで応答を保留する。single-flight の相乗り
// （複数 caller が in-flight 中に到達したか）を決定的に検証するために使う。
function mockUpstreamManual(): { finish: (body: unknown, status?: number) => void } {
  let emitter: (EventEmitter & { statusCode: number }) | null = null;
  httpsRequestMock.mockImplementation(
    (_url: string, _opts: unknown, cb: (r: EventEmitter) => void) => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number };
      res.statusCode = 200;
      emitter = res;
      cb(res);
      return { on: vi.fn(), write: vi.fn(), end: vi.fn() };
    }
  );
  return {
    finish: (body, status = 200) => {
      if (!emitter) throw new Error("upstream not started");
      emitter.statusCode = status;
      emitter.emit("data", Buffer.from(JSON.stringify(body)));
      emitter.emit("end");
    },
  };
}

// 保留中の全マイクロタスク/nextTick を流し切る（macrotask 境界まで待つ）。
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("ハンドラ統合（重複排除 / issue #274）", () => {
  const original = process.env.FUNCTIONS_EMULATOR;

  beforeEach(() => {
    resetRateLimit();
    resetUpstreamCache();
    httpsRequestMock.mockReset();
    process.env.FUNCTIONS_EMULATOR = "true";
  });

  afterEach(() => {
    if (original === undefined) delete process.env.FUNCTIONS_EMULATOR;
    else process.env.FUNCTIONS_EMULATOR = original;
  });

  it("googleWalkProxy: 同一パラメータの並行リクエストは上流を1回に集約する（single-flight）", async () => {
    const upstream = mockUpstreamManual();
    const q = { start: "35.7,139.7", goal: "35.6,139.7" };
    const res1 = makeRes();
    const res2 = makeRes();

    const p1 = invokeHandler(googleWalkProxy, makeReq({ query: q }), res1);
    const p2 = invokeHandler(googleWalkProxy, makeReq({ query: q }), res2);

    // 両ハンドラが in-flight に到達するまで待つ。上流はまだ解決していない。
    await flush();
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);

    upstream.finish({ routes: [{ distanceMeters: 100 }] });
    await Promise.all([p1, p2]);

    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    expect(res1.body).toEqual({ routes: [{ distanceMeters: 100 }] });
    expect(res2.body).toEqual({ routes: [{ distanceMeters: 100 }] });
  });

  it("googleWalkProxy: 同一パラメータの逐次リクエストは TTL 内で上流を1回に集約する", async () => {
    mockUpstream({ routes: [{ distanceMeters: 100 }] });
    const q = { start: "35.7,139.7", goal: "35.6,139.7" };

    const res1 = makeRes();
    await invokeHandler(googleWalkProxy, makeReq({ query: q }), res1);
    const res2 = makeRes();
    await invokeHandler(googleWalkProxy, makeReq({ query: q }), res2);

    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    expect(res2.body).toEqual({ routes: [{ distanceMeters: 100 }] });
  });

  it("googleWalkProxy: 丸め桁以下の座標差は同一キーに集約する", async () => {
    mockUpstream({ routes: [{ distanceMeters: 100 }] });
    // 6桁目のみ異なる（丸め粒度 5 桁 ≈ 1m 以下）。
    const res1 = makeRes();
    await invokeHandler(
      googleWalkProxy,
      makeReq({ query: { start: "35.700001,139.7", goal: "35.6,139.7" } }),
      res1
    );
    const res2 = makeRes();
    await invokeHandler(
      googleWalkProxy,
      makeReq({ query: { start: "35.700002,139.7", goal: "35.6,139.7" } }),
      res2
    );
    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
  });

  it("googleWalkProxy: 異なる座標は別々に上流を呼ぶ", async () => {
    mockUpstream({ routes: [{ distanceMeters: 100 }] });
    const res1 = makeRes();
    await invokeHandler(
      googleWalkProxy,
      makeReq({ query: { start: "35.7,139.7", goal: "35.6,139.7" } }),
      res1
    );
    const res2 = makeRes();
    await invokeHandler(
      googleWalkProxy,
      makeReq({ query: { start: "35.8,139.7", goal: "35.6,139.7" } }),
      res2
    );
    expect(httpsRequestMock).toHaveBeenCalledTimes(2);
  });

  it("googleWalkProxy: 上流失敗は集約せず、次の同一リクエストで再度呼ぶ", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockUpstream({ error: { code: 403 } }, 403);
    const q = { start: "35.7,139.7", goal: "35.6,139.7" };

    const res1 = makeRes();
    await invokeHandler(googleWalkProxy, makeReq({ query: q }), res1);
    expect(res1.statusCode).toBe(502);

    const res2 = makeRes();
    await invokeHandler(googleWalkProxy, makeReq({ query: q }), res2);
    expect(res2.statusCode).toBe(502);

    expect(httpsRequestMock).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });

  it("googleWalkMatrixProxy: 同一パラメータの逐次リクエストは上流を1回に集約する", async () => {
    const payload = [
      { originIndex: 0, destinationIndex: 0, duration: "600s", distanceMeters: 800 },
    ];
    mockUpstream(payload);
    const q = { origins: "35.7,139.7", destinations: "35.6,139.7;35.65,139.72" };

    const res1 = makeRes();
    await invokeHandler(googleWalkMatrixProxy, makeReq({ query: q }), res1);
    const res2 = makeRes();
    await invokeHandler(googleWalkMatrixProxy, makeReq({ query: q }), res2);

    expect(httpsRequestMock).toHaveBeenCalledTimes(1);
    expect(res2.body).toEqual(payload);
  });

  it("navitimeProxy: 重複排除の対象外（同一パラメータでも毎回上流を呼ぶ）", async () => {
    mockUpstream({ items: [{ summary: {} }] });
    const q = { start: "1,1", goal: "2,2", start_time: "t" };

    const res1 = makeRes();
    await invokeHandler(navitimeProxy, makeReq({ query: q }), res1);
    const res2 = makeRes();
    await invokeHandler(navitimeProxy, makeReq({ query: q }), res2);

    expect(httpsRequestMock).toHaveBeenCalledTimes(2);
  });
});
