import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock はホイストされるため、参照する mock 関数は vi.hoisted で先に生成する。
const { infoMock, warnMock, errorMock } = vi.hoisted(() => ({
  infoMock: vi.fn(),
  warnMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock("firebase-functions", () => ({
  logger: { info: infoMock, warn: warnMock, error: errorMock },
}));

import { logAppCheckDenied, logRateLimit, logRequestOutcome } from "../src/metrics";

describe("logRequestOutcome", () => {
  beforeEach(() => {
    infoMock.mockReset();
    warnMock.mockReset();
    errorMock.mockReset();
  });

  it("成功時は event=search_request で info ログを出す", () => {
    logRequestOutcome({
      endpoint: "navitimeProxy",
      upstream: "navitime",
      status: "success",
      latencyMs: 123,
      httpStatus: 200,
    });
    expect(infoMock).toHaveBeenCalledWith("search_request", {
      event: "search_request",
      endpoint: "navitimeProxy",
      upstream: "navitime",
      status: "success",
      latencyMs: 123,
      httpStatus: 200,
    });
    expect(errorMock).not.toHaveBeenCalled();
  });

  it("失敗時は event=search_request で error ログを出す", () => {
    logRequestOutcome({
      endpoint: "googleWalkProxy",
      upstream: "routes-walk",
      status: "failure",
      latencyMs: 456,
      httpStatus: 502,
    });
    expect(errorMock).toHaveBeenCalledWith("search_request", {
      event: "search_request",
      endpoint: "googleWalkProxy",
      upstream: "routes-walk",
      status: "failure",
      latencyMs: 456,
      httpStatus: 502,
    });
    expect(infoMock).not.toHaveBeenCalled();
  });

  it("httpStatus=429 のとき rateLimited:true を付与する（429 を判別可能にする契約）", () => {
    logRequestOutcome({
      endpoint: "navitimeProxy",
      upstream: "navitime",
      status: "failure",
      latencyMs: 10,
      httpStatus: 429,
    });
    expect(errorMock).toHaveBeenCalledWith("search_request", expect.objectContaining({
      httpStatus: 429,
      rateLimited: true,
    }));
  });

  it("httpStatus 未指定（例: 上流ネットワークエラー）でも rateLimited を含めない", () => {
    logRequestOutcome({
      endpoint: "navitimeProxy",
      upstream: "navitime",
      status: "failure",
      latencyMs: 10,
    });
    const payload = errorMock.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("httpStatus");
    expect(payload).not.toHaveProperty("rateLimited");
  });

  it("semanticFailure=true（200+エラーボディ）は failure ペイロードに含める", () => {
    logRequestOutcome({
      endpoint: "navitimeProxy",
      upstream: "navitime",
      status: "failure",
      latencyMs: 10,
      httpStatus: 200,
      semanticFailure: true,
    });
    expect(errorMock).toHaveBeenCalledWith("search_request", expect.objectContaining({
      status: "failure",
      httpStatus: 200,
      semanticFailure: true,
    }));
  });

  it("semanticFailure 未指定なら payload に semanticFailure を含めない", () => {
    logRequestOutcome({
      endpoint: "navitimeProxy",
      upstream: "navitime",
      status: "success",
      latencyMs: 10,
      httpStatus: 200,
    });
    const payload = infoMock.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("semanticFailure");
  });
});

describe("logAppCheckDenied", () => {
  beforeEach(() => {
    infoMock.mockReset();
    warnMock.mockReset();
    errorMock.mockReset();
  });

  it("event=app_check_denied で warn ログを出す", () => {
    logAppCheckDenied({ endpoint: "placesProxy", reason: "missing" });
    expect(warnMock).toHaveBeenCalledWith("app_check_denied", {
      event: "app_check_denied",
      endpoint: "placesProxy",
      reason: "missing",
    });
  });

  it("reason=replayed（リプレイ検知）も記録できる", () => {
    logAppCheckDenied({ endpoint: "googleWalkMatrixProxy", reason: "replayed" });
    expect(warnMock).toHaveBeenCalledWith("app_check_denied", {
      event: "app_check_denied",
      endpoint: "googleWalkMatrixProxy",
      reason: "replayed",
    });
  });
});

describe("logRateLimit", () => {
  beforeEach(() => {
    infoMock.mockReset();
    warnMock.mockReset();
    errorMock.mockReset();
  });

  it("decision=fail-open は error ログを出す（Firestore 障害の検知用）", () => {
    logRateLimit({ decision: "fail-open" });
    expect(errorMock).toHaveBeenCalledWith("rate_limit", {
      event: "rate_limit",
      decision: "fail-open",
    });
  });

  it("decision=blocked は warn ログを出す", () => {
    logRateLimit({ decision: "blocked" });
    expect(warnMock).toHaveBeenCalledWith("rate_limit", {
      event: "rate_limit",
      decision: "blocked",
    });
  });

  it("decision=allowed は info ログを出す（型としては許容、通常は呼び出されない）", () => {
    logRateLimit({ decision: "allowed" });
    expect(infoMock).toHaveBeenCalledWith("rate_limit", {
      event: "rate_limit",
      decision: "allowed",
    });
  });
});
