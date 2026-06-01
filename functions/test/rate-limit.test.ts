import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  checkRateLimit,
  rateLimitMapSize,
  resetRateLimit,
} from "../src/index";

describe("checkRateLimit", () => {
  beforeEach(() => {
    resetRateLimit();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetRateLimit();
  });

  it("既定上限(30)までは true、31回目で false", () => {
    for (let i = 0; i < 30; i++) {
      expect(checkRateLimit("1.1.1.1")).toBe(true);
    }
    expect(checkRateLimit("1.1.1.1")).toBe(false);
  });

  it("WALK 上限(90)までは true、91回目で false", () => {
    for (let i = 0; i < 90; i++) {
      expect(checkRateLimit("2.2.2.2", 90)).toBe(true);
    }
    expect(checkRateLimit("2.2.2.2", 90)).toBe(false);
  });

  it("IP ごとにカウントは独立する", () => {
    for (let i = 0; i < 30; i++) checkRateLimit("3.3.3.3");
    expect(checkRateLimit("3.3.3.3")).toBe(false);
    // 別 IP は影響を受けない
    expect(checkRateLimit("4.4.4.4")).toBe(true);
  });

  it("ウィンドウ(60秒)経過後はカウントがリセットされる", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    for (let i = 0; i < 30; i++) checkRateLimit("5.5.5.5");
    expect(checkRateLimit("5.5.5.5")).toBe(false);

    // 60秒(=60_000ms)を超えて経過 → 新しいウィンドウ
    nowSpy.mockReturnValue(60_001);
    expect(checkRateLimit("5.5.5.5")).toBe(true);
  });

  it("マップが上限(1000)を超えると期限切れエントリを掃除する", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    // resetAt = 60_000 の期限切れ予定エントリを 1001 件作る
    for (let i = 0; i < 1001; i++) checkRateLimit(`ip-${i}`);
    expect(rateLimitMapSize()).toBe(1001);

    // 全エントリが期限切れになる時刻へ進めてから新規 IP で呼ぶと、
    // size > 1000 の掃除が走り期限切れエントリが削除される。
    nowSpy.mockReturnValue(60_001);
    expect(checkRateLimit("fresh")).toBe(true);
    expect(rateLimitMapSize()).toBe(1);
  });
});
