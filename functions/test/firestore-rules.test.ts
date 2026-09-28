import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertFails,
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

let testEnv: RulesTestEnvironment;

/**
 * 旧 userSync ルールが受理していた形の同期ドキュメント。
 *
 * 拒否のテストに任意の値ではなくこれを使うのは、assertFails がスキーマ違反や
 * 評価エラーでも通ってしまうから。「受理されていた形でも拒否される」ことを
 * 見なければ、経路が閉じたことの証明にならない。
 */
function legacySyncData(): Record<string, unknown> {
  return {
    updatedAt: "2026-07-03T00:00:00.000Z",
    settings: {
      notificationsEnabled: true,
      weeklyGoalKm: 10,
      healthKitEnabled: false,
    },
    recents: [{ name: "cafe" }],
    recentOrigins: [{ name: "office" }],
    activity: [{ date: "2026-07-03", steps: 1000 }],
  };
}

function ownerDoc(env: RulesTestEnvironment, path: string, id: string) {
  const db = env.authenticatedContext(OWNER).firestore();
  return doc(db, path, id);
}

async function seed(path: string, id: string): Promise<void> {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), path, id), legacySyncData());
  });
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

describe("firestore.rules はクライアントからの読み書きを全面拒否する", () => {
  describe("userSync（#285 で同期を撤去し、#387 で経路を閉じた）", () => {
    it("本人でも自分のドキュメントを作成できない", async () => {
      await assertFails(
        setDoc(ownerDoc(testEnv, "userSync", OWNER), legacySyncData()),
      );
    });

    it("本人でも自分のドキュメントを読めない", async () => {
      await seed("userSync", OWNER);
      await assertFails(getDoc(ownerDoc(testEnv, "userSync", OWNER)));
    });

    it("本人でも自分のドキュメントを更新できない", async () => {
      await seed("userSync", OWNER);
      await assertFails(
        setDoc(ownerDoc(testEnv, "userSync", OWNER), legacySyncData()),
      );
    });

    it("本人でも自分のドキュメントを削除できない", async () => {
      await seed("userSync", OWNER);
      await assertFails(deleteDoc(ownerDoc(testEnv, "userSync", OWNER)));
    });

    it("未認証では読めない", async () => {
      await seed("userSync", OWNER);
      const db = testEnv.unauthenticatedContext().firestore();
      await assertFails(getDoc(doc(db, "userSync", OWNER)));
    });
  });

  describe("サーバ専用コレクション", () => {
    it("認証済みでも rateLimits を読めない", async () => {
      await seed("rateLimits", "some-bucket");
      await assertFails(getDoc(ownerDoc(testEnv, "rateLimits", "some-bucket")));
    });

    it("認証済みでも rateLimits へ書き込めない", async () => {
      await assertFails(
        setDoc(ownerDoc(testEnv, "rateLimits", "some-bucket"), { count: 0 }),
      );
    });

    it("認証済みでも任意のコレクションへ書き込めない", async () => {
      await assertFails(
        setDoc(ownerDoc(testEnv, "anything", OWNER), { any: "value" }),
      );
    });
  });
});

// このテストはエミュレータ前提。ホスト未設定なら明示的に気付けるようにする。
it("エミュレータが起動していること", () => {
  expect(EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST 未設定: npm run test:rules で実行してください").toBeTruthy();
});
