import { defineConfig } from "vitest/config";

// Firestore セキュリティルール専用の vitest 設定。
// firebase emulators:exec 配下で起動し、Firestore エミュレータへ接続する。
export default defineConfig({
  test: {
    include: ["test/firestore-rules.test.ts"],
    testTimeout: 15000,
    hookTimeout: 30000,
    // ルールテストは単一エミュレータを共有するため直列実行する。
    fileParallelism: false,
  },
});
