import { configDefaults, defineConfig } from "vitest/config";

// 既定の `npm test`（ユニットテスト）ではエミュレータを必要とする
// Firestore ルールテストを除外する。ルールテストは `npm run test:rules`
// （firebase emulators:exec 経由）で実行する。
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, "test/firestore-rules.test.ts"],
  },
});
