import { describe, expect, it } from "vitest";
import { Request } from "firebase-functions/v2/https";

import { clientIp } from "../src/index";

function makeReq(opts: {
  forwardedFor?: string | string[];
  ip?: string;
}): Request {
  const headers: Record<string, string | string[] | undefined> = {};
  if (opts.forwardedFor !== undefined) {
    headers["x-forwarded-for"] = opts.forwardedFor;
  }
  return { headers, ip: opts.ip } as unknown as Request;
}

describe("clientIp", () => {
  it("X-Forwarded-For の右端（基盤が追記した実接続元 IP）を採用する", () => {
    // gen2 直アクセスでは基盤が実 IP を最後の要素として追記する。
    const req = makeReq({ forwardedFor: "198.51.100.2" });
    expect(clientIp(req)).toBe("198.51.100.2");
  });

  it("偽装された XFF 先頭値は無視し、右端の基盤追記 IP を採用する", () => {
    // 攻撃者が先頭に任意値を prepend しても、基盤は実 IP を右端に足すため
    // 右端はインフラ制御のまま。レート制限キーは偽装できない。
    const req = makeReq({ forwardedFor: "1.2.3.4, 70.41.3.18, 198.51.100.2" });
    expect(clientIp(req)).toBe("198.51.100.2");
  });

  it("攻撃者が毎回別の先頭値を送ってもキーは同一（バイパス不可）の回帰", () => {
    const a = makeReq({ forwardedFor: "1.1.1.1, 198.51.100.2" });
    const b = makeReq({ forwardedFor: "9.9.9.9, 198.51.100.2" });
    expect(clientIp(a)).toBe(clientIp(b));
  });

  it("req.ip（trust proxy=true では偽装可能な最左端）は信頼源にしない", () => {
    // XFF がある限り req.ip は無視され、右端が採用される。
    const req = makeReq({
      forwardedFor: "1.2.3.4, 198.51.100.2",
      ip: "1.2.3.4",
    });
    expect(clientIp(req)).toBe("198.51.100.2");
  });

  it("XFF が配列でも右端要素を採用する", () => {
    const req = makeReq({ forwardedFor: ["1.2.3.4", "198.51.100.2"] });
    expect(clientIp(req)).toBe("198.51.100.2");
  });

  it("末尾カンマ等で空要素が混じっても右端の実 IP を採用する", () => {
    const req = makeReq({ forwardedFor: "1.2.3.4, 198.51.100.2, " });
    expect(clientIp(req)).toBe("198.51.100.2");
  });

  it("XFF が無ければ req.ip（この分岐では実ソケット peer に等しい）へ戻す", () => {
    const req = makeReq({ ip: "198.51.100.2" });
    expect(clientIp(req)).toBe("198.51.100.2");
  });

  it("XFF も req.ip も無ければ 'unknown'", () => {
    const req = makeReq({});
    expect(clientIp(req)).toBe("unknown");
  });
});
