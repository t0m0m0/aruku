import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpsError, type Request } from "firebase-functions/v2/https";

// vi.mock はホイストされるため、参照する mock 関数は vi.hoisted で先に生成する。
const { incrementSearchUsageMock, checkRateLimitMock } = vi.hoisted(() => ({
  incrementSearchUsageMock: vi.fn(),
  checkRateLimitMock: vi.fn(),
}));

vi.mock("../src/usage-tracker", () => ({
  incrementSearchUsage: incrementSearchUsageMock,
}));

vi.mock("../src/rate-limiter", async () => {
  const actual = await vi.importActual<typeof import("../src/rate-limiter")>(
    "../src/rate-limiter"
  );
  return { ...actual, checkRateLimit: checkRateLimitMock };
});

import { recordSearchUsage } from "../src/index";

// CallableFunction.run() はトークン検証（App Check・Auth ヘッダ）を経由せず
// ハンドラを直接呼ぶ（テスト専用 API）。ここでは request.auth の有無で分岐する
// ハンドラ自身のロジックのみを検証する。App Check の実強制（enforceAppCheck）は
// フレームワーク側の責務でありユニットテストの対象外
// （project_appcheck_invoker.md の教訓通り、実機での403確認は別途必要）。
function callableRequest(auth?: { uid: string }) {
  return {
    data: {},
    auth: auth
      ? { uid: auth.uid, token: {} as unknown }
      : undefined,
    rawRequest: {} as unknown as Request,
  };
}

describe("recordSearchUsage", () => {
  beforeEach(() => {
    incrementSearchUsageMock.mockReset();
    incrementSearchUsageMock.mockResolvedValue(undefined);
    checkRateLimitMock.mockReset();
    checkRateLimitMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("未認証（auth無し）は unauthenticated エラーを投げ、加算しない", async () => {
    let caught: unknown;
    try {
      await recordSearchUsage.run(callableRequest(undefined));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpsError);
    expect((caught as HttpsError).code).toBe("unauthenticated");
    expect(incrementSearchUsageMock).not.toHaveBeenCalled();
  });

  it("認証済みなら本人のuidでincrementSearchUsageを呼び ok:true を返す", async () => {
    const result = await recordSearchUsage.run(callableRequest({ uid: "uid1" }));
    expect(incrementSearchUsageMock).toHaveBeenCalledWith("uid1");
    expect(checkRateLimitMock).toHaveBeenCalledWith(
      expect.stringContaining("uid1"),
      expect.any(Number)
    );
    expect(result).toEqual({ ok: true });
  });

  it("uid単位のレート上限を超えると resource-exhausted を投げ、加算しない（#238 コストDoS対策）", async () => {
    checkRateLimitMock.mockResolvedValue(false);
    let caught: unknown;
    try {
      await recordSearchUsage.run(callableRequest({ uid: "uid1" }));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpsError);
    expect((caught as HttpsError).code).toBe("resource-exhausted");
    expect(incrementSearchUsageMock).not.toHaveBeenCalled();
  });
});
