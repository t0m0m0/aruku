import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock はホイストされるため、参照する mock 関数は vi.hoisted で先に生成する。
const { runTransactionMock } = vi.hoisted(() => ({
  runTransactionMock: vi.fn(),
}));

// Firestore をインメモリストアで擬似する。runTransaction は本物の
// トランザクション意味論（get→set/update）を再現し、リミッタの判定ロジックを
// 実際に走らせる。Timestamp.fromMillis は素通しのスタブ。
vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({
    collection: (_name: string) => ({
      doc: (id: string) => ({ id }),
    }),
    runTransaction: runTransactionMock,
  }),
  Timestamp: {
    fromMillis: (ms: number) => ({ _millis: ms }),
  },
}));

import {
  checkRateLimitFirestore,
} from "../src/rate-limiter";

// ドキュメント ID をキーにしたインメモリのストア。
let store: Map<string, { count: number; resetAt: number }>;

function installTransaction(): void {
  runTransactionMock.mockImplementation(
    async (fn: (tx: unknown) => Promise<boolean>) => {
      const tx = {
        get: async (ref: { id: string }) => ({
          data: () => store.get(ref.id),
        }),
        set: (ref: { id: string }, data: { count: number; resetAt: number }) =>
          store.set(ref.id, { count: data.count, resetAt: data.resetAt }),
        update: (ref: { id: string }, data: { count: number }) => {
          const cur = store.get(ref.id);
          if (cur) store.set(ref.id, { ...cur, count: data.count });
        },
      };
      return fn(tx);
    }
  );
}

describe("checkRateLimitFirestore", () => {
  beforeEach(() => {
    store = new Map();
    runTransactionMock.mockReset();
    installTransaction();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("既定上限(30)までは true、31回目で false", async () => {
    for (let i = 0; i < 30; i++) {
      expect(await checkRateLimitFirestore("1.1.1.1")).toBe(true);
    }
    expect(await checkRateLimitFirestore("1.1.1.1")).toBe(false);
  });

  it("WALK 上限(90)までは true、91回目で false", async () => {
    for (let i = 0; i < 90; i++) {
      expect(await checkRateLimitFirestore("2.2.2.2", 90)).toBe(true);
    }
    expect(await checkRateLimitFirestore("2.2.2.2", 90)).toBe(false);
  });

  it("IP ごとにカウントは独立する", async () => {
    for (let i = 0; i < 30; i++) await checkRateLimitFirestore("3.3.3.3");
    expect(await checkRateLimitFirestore("3.3.3.3")).toBe(false);
    expect(await checkRateLimitFirestore("4.4.4.4")).toBe(true);
  });

  it("ウィンドウ(60秒)経過後はカウントがリセットされる", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0);
    for (let i = 0; i < 30; i++) await checkRateLimitFirestore("5.5.5.5");
    expect(await checkRateLimitFirestore("5.5.5.5")).toBe(false);

    nowSpy.mockReturnValue(60_001);
    expect(await checkRateLimitFirestore("5.5.5.5")).toBe(true);
  });

  it("IPv6 アドレスもドキュメント ID として扱える", async () => {
    const ipv6 = "2001:db8::1";
    expect(await checkRateLimitFirestore(ipv6)).toBe(true);
    // 同一 IP として継続カウントされる。
    expect(store.size).toBe(1);
  });

  it("Firestore 例外時はフェイルオープン(true)し、ログを残す", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    runTransactionMock.mockRejectedValueOnce(new Error("unavailable"));
    expect(await checkRateLimitFirestore("6.6.6.6")).toBe(true);
    expect(errSpy).toHaveBeenCalled();
  });
});
