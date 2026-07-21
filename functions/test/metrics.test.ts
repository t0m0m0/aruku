import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock はホイストされるため、参照する mock 関数は vi.hoisted で先に生成する。
const { infoMock, warnMock, errorMock, writeMock } = vi.hoisted(() => ({
  infoMock: vi.fn(),
  warnMock: vi.fn(),
  errorMock: vi.fn(),
  writeMock: vi.fn(),
}));

vi.mock("firebase-functions", () => ({
  logger: { info: infoMock, warn: warnMock, error: errorMock, write: writeMock },
}));

import {
  logAppCheckDenied,
  logRateLimit,
  logRequestLatency,
  logRequestOutcome,
} from "../src/metrics";

describe("logRequestOutcome", () => {
  beforeEach(() => {
    infoMock.mockReset();
    warnMock.mockReset();
    errorMock.mockReset();
    writeMock.mockReset();
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
    expect(writeMock).not.toHaveBeenCalled();
  });

  // logger.error は payload だけを渡すと Error スタックを合成してメッセージに
  // 埋め込み、Cloud Error Reporting が例外として拾ってしまう（firebase-functions
  // logger/index.ts の entryFromArgs 実装）。指標専用の失敗イベントで実エラーを
  // 埋もれさせないよう、severity だけ ERROR にした LogEntry を write で直接出す。
  it("失敗時は logger.write に severity=ERROR の LogEntry を渡す（Error Reporting 汚染防止）", () => {
    logRequestOutcome({
      endpoint: "googleWalkProxy",
      upstream: "routes-walk",
      status: "failure",
      latencyMs: 456,
      httpStatus: 502,
    });
    expect(writeMock).toHaveBeenCalledWith({
      severity: "ERROR",
      message: "search_request",
      event: "search_request",
      endpoint: "googleWalkProxy",
      upstream: "routes-walk",
      status: "failure",
      latencyMs: 456,
      httpStatus: 502,
    });
    expect(infoMock).not.toHaveBeenCalled();
    expect(errorMock).not.toHaveBeenCalled();
  });

  it("httpStatus=429 のとき rateLimited:true を付与する（429 を判別可能にする契約）", () => {
    logRequestOutcome({
      endpoint: "navitimeProxy",
      upstream: "navitime",
      status: "failure",
      latencyMs: 10,
      httpStatus: 429,
    });
    expect(writeMock).toHaveBeenCalledWith(expect.objectContaining({
      httpStatus: 429,
      rateLimited: true,
    }));
    expect(errorMock).not.toHaveBeenCalled();
  });

  it("httpStatus 未指定（例: 上流ネットワークエラー）でも rateLimited を含めない", () => {
    logRequestOutcome({
      endpoint: "navitimeProxy",
      upstream: "navitime",
      status: "failure",
      latencyMs: 10,
    });
    const payload = writeMock.mock.calls[0][0] as Record<string, unknown>;
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
    expect(writeMock).toHaveBeenCalledWith(expect.objectContaining({
      status: "failure",
      httpStatus: 200,
      semanticFailure: true,
    }));
    expect(errorMock).not.toHaveBeenCalled();
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

describe("logRequestLatency", () => {
  beforeEach(() => {
    infoMock.mockReset();
    warnMock.mockReset();
    errorMock.mockReset();
    writeMock.mockReset();
  });

  it("event=request_latency で info ログを出す（search_request とは別イベント）", () => {
    logRequestLatency({
      endpoint: "googleWalkMatrixProxy",
      totalLatencyMs: 87,
      httpStatus: 200,
    });
    expect(infoMock).toHaveBeenCalledWith("request_latency", {
      event: "request_latency",
      endpoint: "googleWalkMatrixProxy",
      totalLatencyMs: 87,
      httpStatus: 200,
    });
    // search_request の計上（#274）を汚さない: 上流区間 latencyMs は出さない。
    const payload = infoMock.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.event).toBe("request_latency");
    expect(payload).not.toHaveProperty("latencyMs");
    expect(writeMock).not.toHaveBeenCalled();
    expect(errorMock).not.toHaveBeenCalled();
  });

  it("失敗ステータスでも info で出す（レイテンシは情報イベント・Error Reporting を汚さない）", () => {
    logRequestLatency({
      endpoint: "navitimeProxy",
      totalLatencyMs: 5,
      httpStatus: 502,
    });
    expect(infoMock).toHaveBeenCalledWith(
      "request_latency",
      expect.objectContaining({ httpStatus: 502, totalLatencyMs: 5 })
    );
    expect(writeMock).not.toHaveBeenCalled();
    expect(errorMock).not.toHaveBeenCalled();
  });
});

describe("logAppCheckDenied", () => {
  beforeEach(() => {
    infoMock.mockReset();
    warnMock.mockReset();
    errorMock.mockReset();
    writeMock.mockReset();
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
    writeMock.mockReset();
  });

  it("decision=fail-open は logger.write に severity=ERROR の LogEntry を渡す（Error Reporting 汚染防止）", () => {
    logRateLimit({ decision: "fail-open", reason: "transient" });
    expect(writeMock).toHaveBeenCalledWith({
      severity: "ERROR",
      message: "rate_limit",
      event: "rate_limit",
      decision: "fail-open",
      reason: "transient",
    });
    expect(errorMock).not.toHaveBeenCalled();
  });

  it("reason=config は jsonPayload.reason に出て、恒久的な設定不備を一過性と切り分けられる", () => {
    logRateLimit({ decision: "fail-open", reason: "config" });
    expect(writeMock).toHaveBeenCalledWith({
      severity: "ERROR",
      message: "rate_limit",
      event: "rate_limit",
      decision: "fail-open",
      reason: "config",
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
