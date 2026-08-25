import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock はホイストされるため、参照する mock 関数は vi.hoisted で先に生成する。
const { verifyTokenMock } = vi.hoisted(() => ({ verifyTokenMock: vi.fn() }));

vi.mock("firebase-admin/app-check", () => ({
  getAppCheck: () => ({ verifyToken: verifyTokenMock }),
}));

import { shouldConsumeAppCheckToken, verifyAppCheck } from "../src/index";

interface FakeRes {
  statusCode?: number;
  body?: unknown;
  status(code: number): FakeRes;
  json(b: unknown): FakeRes;
}

function makeRes(): FakeRes {
  return {
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
  };
}

function makeReq(token?: string) {
  return {
    header: (name: string) =>
      name === "X-Firebase-AppCheck" ? token : undefined,
  };
}

describe("verifyAppCheck", () => {
  const original = process.env.FUNCTIONS_EMULATOR;

  beforeEach(() => {
    verifyTokenMock.mockReset();
    delete process.env.FUNCTIONS_EMULATOR;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.FUNCTIONS_EMULATOR;
    else process.env.FUNCTIONS_EMULATOR = original;
  });

  it("エミュレータでは検証をスキップして true を返す", async () => {
    process.env.FUNCTIONS_EMULATOR = "true";
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = await verifyAppCheck(makeReq() as any, res as any);
    expect(ok).toBe(true);
    expect(verifyTokenMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBeUndefined();
  });

  it("トークン欠落時は 401 を返して false", async () => {
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = await verifyAppCheck(makeReq(undefined) as any, res as any);
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "App Check token missing" });
    expect(verifyTokenMock).not.toHaveBeenCalled();
  });

  it("無効なトークンは 401 を返して false", async () => {
    verifyTokenMock.mockRejectedValue(new Error("invalid"));
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = await verifyAppCheck(makeReq("bad-token") as any, res as any);
    expect(ok).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: "App Check token invalid" });
    expect(verifyTokenMock).toHaveBeenCalledWith("bad-token");
  });

  it("有効なトークンは true を返し、レスポンスを書かない", async () => {
    verifyTokenMock.mockResolvedValue({ appId: "x" });
    const res = makeRes();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ok = await verifyAppCheck(makeReq("good-token") as any, res as any);
    expect(ok).toBe(true);
    expect(res.statusCode).toBeUndefined();
    expect(verifyTokenMock).toHaveBeenCalledWith("good-token");
  });

  describe("consume（リプレイ保護, issue #155・#366）", () => {
    const originalConsume = process.env.APP_CHECK_CONSUME_ENDPOINTS;

    afterEach(() => {
      if (originalConsume === undefined)
        delete process.env.APP_CHECK_CONSUME_ENDPOINTS;
      else process.env.APP_CHECK_CONSUME_ENDPOINTS = originalConsume;
    });

    it("対象エンドポイントでは verifyToken に { consume: true } を渡す", async () => {
      verifyTokenMock.mockResolvedValue({ appId: "x", alreadyConsumed: false });
      const res = makeRes();
      const ok = await verifyAppCheck(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeReq("fresh-token") as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res as any,
        { endpoint: "placesProxy" }
      );
      expect(ok).toBe(true);
      expect(res.statusCode).toBeUndefined();
      expect(verifyTokenMock).toHaveBeenCalledWith("fresh-token", {
        consume: true,
      });
    });

    it("対象エンドポイントの alreadyConsumed:true は 401 でリプレイ拒否する", async () => {
      verifyTokenMock.mockResolvedValue({ appId: "x", alreadyConsumed: true });
      const res = makeRes();
      const ok = await verifyAppCheck(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeReq("replayed-token") as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res as any,
        { endpoint: "googleWalkMatrixProxy" }
      );
      expect(ok).toBe(false);
      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: "App Check token already consumed" });
    });

    // 対象外では alreadyConsumed を見ない。標準トークンの正当な再利用と区別できず、
    // 見れば 2 回目以降の正常な要求を落とす。
    it("対象外エンドポイントは単一引数で検証し alreadyConsumed を無視する", async () => {
      verifyTokenMock.mockResolvedValue({ appId: "x", alreadyConsumed: true });
      const res = makeRes();
      const ok = await verifyAppCheck(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        makeReq("std-token") as any,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res as any,
        { endpoint: "googleWalkProxy" }
      );
      expect(ok).toBe(true);
      expect(res.statusCode).toBeUndefined();
      expect(verifyTokenMock).toHaveBeenCalledWith("std-token");
    });

    it("endpoint 未指定は consume しない（対象集合に含まれないため）", async () => {
      verifyTokenMock.mockResolvedValue({ appId: "x", alreadyConsumed: true });
      const res = makeRes();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ok = await verifyAppCheck(makeReq("t") as any, res as any);
      expect(ok).toBe(true);
      expect(verifyTokenMock).toHaveBeenCalledWith("t");
    });
  });

  describe("shouldConsumeAppCheckToken", () => {
    const originalConsume = process.env.APP_CHECK_CONSUME_ENDPOINTS;

    afterEach(() => {
      if (originalConsume === undefined)
        delete process.env.APP_CHECK_CONSUME_ENDPOINTS;
      else process.env.APP_CHECK_CONSUME_ENDPOINTS = originalConsume;
    });

    it("未設定なら placesProxy と googleWalkMatrixProxy が既定の対象", () => {
      delete process.env.APP_CHECK_CONSUME_ENDPOINTS;
      expect(shouldConsumeAppCheckToken("placesProxy")).toBe(true);
      expect(shouldConsumeAppCheckToken("googleWalkMatrixProxy")).toBe(true);
      expect(shouldConsumeAppCheckToken("googleWalkProxy")).toBe(false);
    });

    it("設定があれば列挙されたものだけが対象になる", () => {
      process.env.APP_CHECK_CONSUME_ENDPOINTS =
        "googleWalkProxy , googleWalkMatrixProxy";
      expect(shouldConsumeAppCheckToken("googleWalkProxy")).toBe(true);
      expect(shouldConsumeAppCheckToken("googleWalkMatrixProxy")).toBe(true);
      // 既定に入っていても列挙から漏れれば対象外——設定は加算ではなく置換。
      expect(shouldConsumeAppCheckToken("placesProxy")).toBe(false);
    });

    it("空文字列は全停止（未設定＝既定とは区別する）", () => {
      process.env.APP_CHECK_CONSUME_ENDPOINTS = "";
      expect(shouldConsumeAppCheckToken("placesProxy")).toBe(false);
      expect(shouldConsumeAppCheckToken("googleWalkMatrixProxy")).toBe(false);
    });
  });
});
