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
  it("x-forwarded-for 文字列は先頭の IP を取り出して trim する", () => {
    const req = makeReq({ forwardedFor: "203.0.113.1, 70.41.3.18, 150.172.238.178" });
    expect(clientIp(req)).toBe("203.0.113.1");
  });

  it("x-forwarded-for 配列は先頭要素を trim して使う", () => {
    const req = makeReq({ forwardedFor: ["  198.51.100.5  ", "10.0.0.1"] });
    expect(clientIp(req)).toBe("198.51.100.5");
  });

  it("x-forwarded-for が無ければ req.ip にフォールバックする", () => {
    const req = makeReq({ ip: "198.51.100.2" });
    expect(clientIp(req)).toBe("198.51.100.2");
  });

  it("x-forwarded-for も req.ip も無ければ 'unknown'", () => {
    const req = makeReq({});
    expect(clientIp(req)).toBe("unknown");
  });
});
