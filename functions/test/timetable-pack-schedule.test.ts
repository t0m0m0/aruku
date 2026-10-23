import { describe, expect, it } from "vitest";

import { refreshTimetablePacks } from "../src/index";

// __endpoint は firebase-functions の非公開 API（region.test.ts と同じ前提）。
// SDK 更新で落ちたら、まず __endpoint の形を確かめる。
interface ScheduledEndpoint {
  region?: string[];
  scheduleTrigger?: { schedule?: string; timeZone?: string };
  secretEnvironmentVariables?: { key: string }[];
  availableMemoryMb?: number;
  timeoutSeconds?: number;
  maxInstances?: number;
}
const endpoint = (refreshTimetablePacks as unknown as { __endpoint: ScheduledEndpoint })
  .__endpoint;

describe("refreshTimetablePacks（定期関数）", () => {
  it("毎日、日本時間の早朝に動く（基本ライセンスの「更新通知から1週間以内」に追いつく）", () => {
    expect(endpoint.scheduleTrigger?.timeZone).toBe("Asia/Tokyo");
    expect(endpoint.scheduleTrigger?.schedule).toMatch(/^\d+ [0-5] \* \* \*$/);
  });

  it("ODPT の2つのキーを Secret Manager から受け取る", () => {
    expect(endpoint.secretEnvironmentVariables?.map((s) => s.key).sort()).toEqual([
      "ODPT_CENTER_KEY",
      "ODPT_CHALLENGE_KEY",
    ]);
  });

  it("9フィードの展開に足りるメモリと時間を取り、同時には1つしか動かさない", () => {
    expect(endpoint.availableMemoryMb).toBeGreaterThanOrEqual(2048);
    expect(endpoint.timeoutSeconds).toBeGreaterThanOrEqual(540);
    expect(endpoint.maxInstances).toBe(1);
  });

  it("asia-northeast1 にデプロイされる", () => {
    expect(endpoint.region).toEqual(["asia-northeast1"]);
  });
});
