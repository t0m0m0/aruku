import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock はホイストされるため、参照する mock 関数は vi.hoisted で先に生成する。
const { runTransactionMock, logRateLimitMock } = vi.hoisted(() => ({
  runTransactionMock: vi.fn(),
  logRateLimitMock: vi.fn(),
}));

vi.mock("../src/metrics", () => ({ logRateLimit: logRateLimitMock }));

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
    logRateLimitMock.mockReset();
    installTransaction();
    // 本番相当では十分な長さの HMAC 鍵が必須。テストは有効な鍵を注入する。
    vi.stubEnv("RATE_LIMIT_HMAC_KEY", "x".repeat(32));
    vi.stubEnv("FUNCTIONS_EMULATOR", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
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

  it("scope が違えば同じ IP でも別の文書で数える", async () => {
    for (let i = 0; i < 30; i++) await checkRateLimitFirestore("3.3.3.4");
    expect(await checkRateLimitFirestore("3.3.3.4")).toBe(false);
    expect(await checkRateLimitFirestore("3.3.3.4", 30, "exactWalkMax")).toBe(true);
    expect(store.size).toBe(2);
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
    // 複数回呼んでも同一 ID へ写像され、ドキュメントは増えずカウントだけ進む。
    for (let i = 0; i < 5; i++) {
      expect(await checkRateLimitFirestore(ipv6)).toBe(true);
    }
    expect(store.size).toBe(1);
    expect([...store.values()][0].count).toBe(5);
  });

  it("Firestore 例外時はフェイルオープン(true)し、ログを残す", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    runTransactionMock.mockRejectedValueOnce(new Error("unavailable"));
    expect(await checkRateLimitFirestore("6.6.6.6")).toBe(true);
    expect(errSpy).toHaveBeenCalled();
  });

  it("生 IP は文書 ID に現れず、HMAC-SHA256 ダイジェストで不可逆化される", async () => {
    await checkRateLimitFirestore("203.0.113.7");
    const ids = [...store.keys()];
    expect(ids).toHaveLength(1);
    expect(ids[0]).not.toContain("203.0.113.7");
    expect(ids[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("文書 ID は鍵付き HMAC-SHA256 の既知ベクトルと一致する（鍵なし SHA-256 への退行を反証）", async () => {
    // 鍵とUTC日付を含めた既知ベクトルと突き合わせ、「鍵付き」であることを直接保証する。
    // 鍵なし SHA-256(day+ip) や鍵の合成違いはこの一致で確実に赤くなる。
    vi.stubEnv("RATE_LIMIT_HMAC_KEY", "k".repeat(32));
    vi.spyOn(Date, "now").mockReturnValue(0); // 1970-01-01 (UTC)
    await checkRateLimitFirestore("198.51.100.9");
    const expected = createHmac("sha256", `${"k".repeat(32)}:1970-01-01`)
      .update("198.51.100.9")
      .digest("hex");
    expect([...store.keys()][0]).toBe(expected);
  });

  it("同一 IP は同日中は同一の文書 ID へ写像される", async () => {
    vi.spyOn(Date, "now").mockReturnValue(0);
    for (let i = 0; i < 3; i++) await checkRateLimitFirestore("9.9.9.9");
    expect(store.size).toBe(1);
    expect([...store.values()][0].count).toBe(3);
  });

  it("日付(UTC)が変わると同一 IP でも別の文書 ID になる（日次ローテーション）", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(0); // 1970-01-01
    await checkRateLimitFirestore("8.8.8.8");
    nowSpy.mockReturnValue(86_400_000); // 1970-01-02
    await checkRateLimitFirestore("8.8.8.8");
    expect(store.size).toBe(2);
  });

  it("UTC 日付境界では前日 resetAt が未来でも新文書でカウンタが再開する（許容トレードオフ）", async () => {
    const dayMs = 86_400_000;
    // 1970-01-01 23:59:30 に上限まで消費（resetAt = 翌日 00:00:30）。
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(dayMs - 30_000);
    for (let i = 0; i < 30; i++) await checkRateLimitFirestore("10.0.0.1");
    expect(await checkRateLimitFirestore("10.0.0.1")).toBe(false);
    // 1970-01-02 00:00:00。前日 resetAt(00:00:30) より前だが day が変わり新文書＝再び通過。
    nowSpy.mockReturnValue(dayMs);
    expect(await checkRateLimitFirestore("10.0.0.1")).toBe(true);
    expect(store.size).toBe(2); // 前日文書と新文書が併存し、境界期間は許容量が最大2倍
  });

  it("本番相当で鍵が未設定なら、逆引き可能な文書を書かずフェイルオープンする", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("RATE_LIMIT_HMAC_KEY", "");
    // フェイルオープン（通過）しつつ、生 IP 相関可能なドキュメントは一切書かない。
    expect(await checkRateLimitFirestore("7.7.7.7")).toBe(true);
    expect(store.size).toBe(0);
    expect(errSpy).toHaveBeenCalled();
  });

  it("本番相当で鍵が短すぎる（弱鍵）なら受理せずフェイルオープンする", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("RATE_LIMIT_HMAC_KEY", "short");
    expect(await checkRateLimitFirestore("7.7.7.8")).toBe(true);
    expect(store.size).toBe(0);
  });

  describe("同時に来た判定の合流", () => {
    // 1本目のトランザクションを止め、その間に残りの判定を積ませる。
    function holdFirstTransaction(): () => void {
      const run = runTransactionMock.getMockImplementation()!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      runTransactionMock.mockImplementationOnce(async (fn: unknown) => {
        await gate;
        return run(fn);
      });
      return release;
    }

    function parallelChecks(n: number, limit?: number): Promise<boolean>[] {
      return Array.from({ length: n }, () =>
        checkRateLimitFirestore("7.7.7.7", limit)
      );
    }

    it("同じ文書への14並列は、実行中の1本と残りをまとめた1本のトランザクションになる", async () => {
      const release = holdFirstTransaction();
      const checks = parallelChecks(14, 90);
      release();

      expect(await Promise.all(checks)).toEqual(Array(14).fill(true));
      expect(runTransactionMock).toHaveBeenCalledTimes(2);
      expect([...store.values()][0].count).toBe(14);
    });

    it("並列でも上限ちょうどで止まり、先に来た判定から許可する", async () => {
      const results = await Promise.all(parallelChecks(31));

      expect(results.slice(0, 30)).toEqual(Array(30).fill(true));
      expect(results[30]).toBe(false);
      expect([...store.values()][0].count).toBe(30);
    });

    it("まとめた判定は、それぞれ自分の上限で判定する", async () => {
      await Promise.all(parallelChecks(29, 90));
      const release = holdFirstTransaction();
      const holder = checkRateLimitFirestore("7.7.7.7", 90);
      const batch = [
        checkRateLimitFirestore("7.7.7.7", 30),
        checkRateLimitFirestore("7.7.7.7", 90),
      ];
      release();
      await holder;

      expect(await Promise.all(batch)).toEqual([false, true]);
      expect([...store.values()][0].count).toBe(31);
    });

    it("トランザクションが再試行されても二重に数えない", async () => {
      const run = runTransactionMock.getMockImplementation()!;
      runTransactionMock.mockImplementation(
        async (fn: (tx: unknown) => Promise<unknown>) => {
          await fn({
            get: async (ref: { id: string }) => ({
              data: () => store.get(ref.id),
            }),
            set: () => {},
            update: () => {},
          });
          return run(fn);
        }
      );

      await Promise.all(parallelChecks(5));

      expect([...store.values()][0].count).toBe(5);
    });

    it("まとめたトランザクションが失敗すると全件がフェイルオープンし、次の判定は通常どおり数える", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const release = holdFirstTransaction();
      const holder = checkRateLimitFirestore("7.7.7.7");
      const batch = parallelChecks(3);
      runTransactionMock.mockRejectedValueOnce(new Error("unavailable"));
      release();
      await holder;

      expect(await Promise.all(batch)).toEqual([true, true, true]);
      expect(
        logRateLimitMock.mock.calls.filter(
          ([p]) => p.decision === "fail-open"
        )
      ).toHaveLength(3);

      expect(await checkRateLimitFirestore("7.7.7.7")).toBe(true);
      expect([...store.values()][0].count).toBe(2);
    });

    it("拒否のログは、拒否したリクエスト1件につき1回出す", async () => {
      await Promise.all(parallelChecks(32));

      expect(logRateLimitMock.mock.calls).toEqual([
        [{ decision: "blocked" }],
        [{ decision: "blocked" }],
      ]);
    });

    it("別の文書への判定は、実行中のトランザクションを待たない", async () => {
      const release = holdFirstTransaction();
      const held = checkRateLimitFirestore("7.7.7.7");

      expect(await checkRateLimitFirestore("8.8.8.8")).toBe(true);

      release();
      expect(await held).toBe(true);
    });
  });
});
