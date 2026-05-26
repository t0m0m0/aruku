import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock はホイストされるため、参照する mock 関数は vi.hoisted で先に生成する。
const { verifyTokenMock } = vi.hoisted(() => ({ verifyTokenMock: vi.fn() }));

vi.mock("firebase-admin/app-check", () => ({
  getAppCheck: () => ({ verifyToken: verifyTokenMock }),
}));

import { verifyAppCheck } from "../src/index";

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
});
