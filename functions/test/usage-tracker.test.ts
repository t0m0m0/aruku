import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock はホイストされるため、参照する mock 関数は vi.hoisted で先に生成する。
const { runTransactionMock } = vi.hoisted(() => ({
  runTransactionMock: vi.fn(),
}));

// rate-limit-firestore.test.ts と同様、Firestore をインメモリで擬似する。
// runTransaction は get→set/update の実セマンティクスを再現する。
vi.mock("firebase-admin/firestore", () => ({
  getFirestore: () => ({
    collection: (_name: string) => ({
      doc: (uid: string) => ({
        collection: (_sub: string) => ({
          doc: (month: string) => ({ id: `${uid}/${month}` }),
        }),
      }),
    }),
    runTransaction: runTransactionMock,
  }),
  FieldValue: {
    increment: (n: number) => ({ _increment: n }),
  },
  Timestamp: {
    fromDate: (d: Date) => ({ _millis: d.getTime() }),
  },
}));

import { incrementSearchUsage, yyyyMmJst } from "../src/usage-tracker";

interface UsageDoc {
  searchCount: number;
  lastSearchAt: unknown;
  accountType: string;
}

let store: Map<string, UsageDoc>;

function installTransaction(): void {
  runTransactionMock.mockImplementation(
    async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        get: async (ref: { id: string }) => ({
          exists: store.has(ref.id),
          data: () => store.get(ref.id),
        }),
        set: (ref: { id: string }, data: UsageDoc) => store.set(ref.id, data),
        update: (
          ref: { id: string },
          data: { searchCount: { _increment: number }; lastSearchAt: unknown }
        ) => {
          const cur = store.get(ref.id);
          if (!cur) throw new Error("not found");
          store.set(ref.id, {
            ...cur,
            searchCount: cur.searchCount + data.searchCount._increment,
            lastSearchAt: data.lastSearchAt,
          });
        },
      };
      return fn(tx);
    }
  );
}

describe("incrementSearchUsage", () => {
  beforeEach(() => {
    store = new Map();
    runTransactionMock.mockReset();
    installTransaction();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("初回は searchCount=1, accountType=free でドキュメントを作成する", async () => {
    await incrementSearchUsage("uid1", new Date("2026-07-09T03:00:00Z"));
    const doc = store.get("uid1/202607");
    expect(doc?.searchCount).toBe(1);
    expect(doc?.accountType).toBe("free");
  });

  it("2回目以降はトランザクションで加算する", async () => {
    await incrementSearchUsage("uid1", new Date("2026-07-09T03:00:00Z"));
    await incrementSearchUsage("uid1", new Date("2026-07-09T04:00:00Z"));
    const doc = store.get("uid1/202607");
    expect(doc?.searchCount).toBe(2);
  });

  it("ユーザーが異なれば別ドキュメントに集計する", async () => {
    await incrementSearchUsage("uid1", new Date("2026-07-09T03:00:00Z"));
    await incrementSearchUsage("uid2", new Date("2026-07-09T03:00:00Z"));
    expect(store.get("uid1/202607")?.searchCount).toBe(1);
    expect(store.get("uid2/202607")?.searchCount).toBe(1);
  });

  it("月をまたぐと別ドキュメントに集計する", async () => {
    await incrementSearchUsage("uid1", new Date("2026-06-30T14:00:00Z")); // JST 23:00 6/30
    await incrementSearchUsage("uid1", new Date("2026-06-30T15:30:00Z")); // JST 00:30 7/1
    expect(store.get("uid1/202606")?.searchCount).toBe(1);
    expect(store.get("uid1/202607")?.searchCount).toBe(1);
  });
});

describe("yyyyMmJst", () => {
  it("UTC日付をJSTの年月(yyyyMM)へ変換する", () => {
    // 2026-06-30T15:30:00Z = 2026-07-01T00:30:00+09:00
    expect(yyyyMmJst(new Date("2026-06-30T15:30:00Z"))).toBe("202607");
    expect(yyyyMmJst(new Date("2026-06-30T14:59:00Z"))).toBe("202606");
  });
});
