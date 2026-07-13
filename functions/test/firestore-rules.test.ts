import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

// エミュレータ起動は `npm run test:rules`（firebase emulators:exec 経由）で行う。
// FIRESTORE_EMULATOR_HOST が未設定ならエミュレータが立っていないので失敗させる。
const EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST;

const PROJECT_ID = "demo-aruku-rules";
const UID = "some-uid";

let testEnv: RulesTestEnvironment;

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

// Firestore はサーバ専用。クライアント SDK からの読み書きは、認証の有無や
// コレクションを問わず全面拒否されなければならない（Admin SDK はルールを
// バイパスするためレートリミッタ等の動作には影響しない）。
describe("firestore.rules サーバ専用（全面拒否）", () => {
  it("認証済みでも任意ドキュメントに書き込めない", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(setDoc(doc(db, "userSync", UID), { any: "value" }));
    await assertFails(setDoc(doc(db, "anything", "x"), { any: "value" }));
  });

  it("認証済みでも任意ドキュメントを読めない", async () => {
    const db = testEnv.authenticatedContext(UID).firestore();
    await assertFails(getDoc(doc(db, "userSync", UID)));
    await assertFails(getDoc(doc(db, "rateLimits", "x")));
  });

  it("未認証では任意ドキュメントに書き込めない", async () => {
    const db = testEnv.unauthenticatedContext().firestore();
    await assertFails(setDoc(doc(db, "anything", "x"), { any: "value" }));
  });
});

// このテストはエミュレータ前提。ホスト未設定なら明示的に気付けるようにする。
it("エミュレータが起動していること", () => {
  expect(EMULATOR_HOST, "FIRESTORE_EMULATOR_HOST 未設定: npm run test:rules で実行してください").toBeTruthy();
});
