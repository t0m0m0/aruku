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
  it("req.ip（プラットフォームが解決した実接続元 IP）を採用する", () => {
    const req = makeReq({ ip: "198.51.100.2" });
    expect(clientIp(req)).toBe("198.51.100.2");
  });

  it("偽装された X-Forwarded-For 先頭値は無視し req.ip を採用する", () => {
    // 攻撃者が任意の先頭値を差し込んでも、レート制限キーは req.ip のまま。
    const req = makeReq({
      forwardedFor: "1.2.3.4, 70.41.3.18",
      ip: "198.51.100.2",
    });
    expect(clientIp(req)).toBe("198.51.100.2");
  });

  it("X-Forwarded-For が配列でも req.ip を優先する", () => {
    const req = makeReq({
      forwardedFor: ["1.2.3.4", "10.0.0.1"],
      ip: "198.51.100.2",
    });
    expect(clientIp(req)).toBe("198.51.100.2");
  });

  it("req.ip が無ければ 'unknown'（偽装可能な XFF にはフォールバックしない）", () => {
    const req = makeReq({ forwardedFor: "1.2.3.4, 70.41.3.18" });
    expect(clientIp(req)).toBe("unknown");
  });

  it("req.ip も XFF も無ければ 'unknown'", () => {
    const req = makeReq({});
    expect(clientIp(req)).toBe("unknown");
  });
});
