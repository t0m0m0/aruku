import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, setDoc } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// エミュレータ起動は `npm run test:rules`（firebase emulators:exec 経由）で行う。
// FIRESTORE_EMULATOR_HOST が未設定ならエミュレータが立っていないので失敗させる。
const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST;

const PROJECT_ID = "demo-aruku-rules";
const OWNER = "owner-uid";
const OTHER = "other-uid";

let testEnv: RulesTestEnvironment;

/** ルールを満たす正常な同期ドキュメント。各テストはここから逸脱を作る。 */
function validSyncData(): Record<string, unknown> {
  return {
    updatedAt: "2026-07-03T00:00:00.000Z",
    settings: { notificationsEnabled: true },
    favorites: [{ name: "home" }],
    recents: [{ name: "cafe" }],
    recentOrigins: [{ name: "office" }],
    activity: [{ date: "2026-07-03", steps: 1000 }],
  };
}

/** 指定 uid の認証済みコンテキストで userSync/{uid} 参照を得る。 */
function ownerDoc(env: RulesTestEnvironment, uid: string) {
  const db = env.authenticatedContext(uid).firestore();
  return doc(db, "userSync", uid);
}

beforeAll(async () => {
  const host = EMULATOR_HOST ?? "127.0.0.1:8085";
  const [emulatorHost, emulatorPort] = host.split(":");
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: readFileSync(resolve(__dirname, "../../firestore.rules"), "utf8"),
      host: emulatorHost,
      port: Number(emulatorPort),
    },
  });
});

afterAll(async () => {
  await testEnv?.cleanup();
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

describe("firestore.rules userSync", () => {
  describe("認可（本人一致）", () => {
    it("本人は自分のドキュメントを書き込める", async () => {
      await assertSucceeds(setDoc(ownerDoc(testEnv, OWNER), validSyncData()));
    });

    it("本人は自分のドキュメントを読める", async () => {
      // 事前にルールをバイパスして書き込んでおく。
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(
          doc(ctx.firestore(), "userSync", OWNER),
          validSyncData(),
        );
      });
      await assertSucceeds(getDoc(ownerDoc(testEnv, OWNER)));
    });

    it("他人のドキュメントは書き込めない", async () => {
      const db = testEnv.authenticatedContext(OTHER).firestore();
      await assertFails(
        setDoc(doc(db, "userSync", OWNER), validSyncData()),
      );
    });

    it("他人のドキュメントは読めない", async () => {
      const db = testEnv.authenticatedContext(OTHER).firestore();
      await assertFails(getDoc(doc(db, "userSync", OWNER)));
    });

    it("未認証では書き込めない", async () => {
      const db = testEnv.unauthenticatedContext().firestore();
      await assertFails(
        setDoc(doc(db, "userSync", OWNER), validSyncData()),
      );
    });
  });

  describe("スキーマ検証", () => {
    it("未知のトップレベルフィールドを拒否する", async () => {
      await assertFails(
        setDoc(ownerDoc(testEnv, OWNER), {
          ...validSyncData(),
          hacked: "x".repeat(1000),
        }),
      );
    });

    it("必須フィールド欠落（favorites なし）を拒否する", async () => {
      const data = validSyncData();
      delete data.favorites;
      await assertFails(setDoc(ownerDoc(testEnv, OWNER), data));
    });

    it("settings に未知のキーがあると拒否する", async () => {
      await assertFails(
        setDoc(ownerDoc(testEnv, OWNER), {
          ...validSyncData(),
          settings: { notificationsEnabled: true, evil: "x".repeat(1000) },
        }),
      );
    });

    it("updatedAt が文字列でないと拒否する", async () => {
      await assertFails(
        setDoc(ownerDoc(testEnv, OWNER), {
          ...validSyncData(),
          updatedAt: 12345,
        }),
      );
    });

    it("settings.notificationsEnabled が bool でないと拒否する", async () => {
      await assertFails(
        setDoc(ownerDoc(testEnv, OWNER), {
          ...validSyncData(),
          settings: { notificationsEnabled: "x".repeat(900000) },
        }),
      );
    });
  });

  describe("サイズ上限", () => {
    it("favorites が上限(100)超で拒否する", async () => {
      const favorites = Array.from({ length: 101 }, (_, i) => ({
        name: `p${i}`,
      }));
      await assertFails(
        setDoc(ownerDoc(testEnv, OWNER), { ...validSyncData(), favorites }),
      );
    });

    it("recents が上限(50)超で拒否する", async () => {
      const recents = Array.from({ length: 51 }, (_, i) => ({ name: `p${i}` }));
      await assertFails(
        setDoc(ownerDoc(testEnv, OWNER), { ...validSyncData(), recents }),
      );
    });

    it("activity が上限(800)超で拒否する", async () => {
      const activity = Array.from({ length: 801 }, (_, i) => ({
        date: "2026-07-03",
        steps: i,
      }));
      await assertFails(
        setDoc(ownerDoc(testEnv, OWNER), { ...validSyncData(), activity }),
      );
    });

    it("上限内（favorites=100）は許可する", async () => {
      const favorites = Array.from({ length: 100 }, (_, i) => ({
        name: `p${i}`,
      }));
      await assertSucceeds(
        setDoc(ownerDoc(testEnv, OWNER), { ...validSyncData(), favorites }),
      );
    });
  });

  describe("削除", () => {
    it("本人は自分のドキュメントを削除できる", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(
          doc(ctx.firestore(), "userSync", OWNER),
          validSyncData(),
        );
      });
      await assertSucceeds(deleteDoc(ownerDoc(testEnv, OWNER)));
    });
  });
});

// このテストはエミュレータ前提。ホスト未設定なら明示的に気付けるようにする。
it("エミュレータが起動していること", () => {
  expect(EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST 未設定: npm run test:rules で実行してください").toBeTruthy();
});
