// パッケージ・層の境界の検査（#519）。`npm --prefix functions run lint:deps` で走る。
//
// dependency-cruiser は functions に入れている。engine / web の typescript@7.0 は
// コンパイラの JS API を持たず、dependency-cruiser が .ts を読めない（対応は 7.1 から）。
// functions の typescript@5 を借りて、ここから3パッケージをまとめて走査する。
const path = require("node:path");

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "engine-not-to-apps-or-functions",
      comment:
        "経路エンジンは web からも functions からも使われる側。逆向きに依存すると両者の都合がエンジンへ漏れる。",
      severity: "error",
      from: { path: "^packages/engine/" },
      to: { path: "^(apps|functions)/" },
    },
    {
      name: "web-production-not-to-bench",
      comment:
        "src/bench/ は開発時の計測画面で、本番のルート表にも配信物にも入らない。本番コードから import すると配信物へ混ざる。",
      severity: "error",
      from: { path: "^apps/web/src/(?!bench/)" },
      to: { path: "^apps/web/src/bench/" },
    },
    {
      name: "no-circular",
      comment:
        "型だけの import の循環も禁じる。実行時には消えるが、片方を値の import に変えた途端に初期化順の問題になる。",
      severity: "error",
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    baseDir: __dirname,
    // functions/test/fixtures/dependency-rules は上の規則が落ちることを確かめるための違反の見本。
    exclude: { path: "^functions/test/fixtures/" },
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    // web の `@/*`・`@aruku/engine/*` を解決するため。engine と functions は paths を持たない。
    tsConfig: { fileName: path.join(__dirname, "apps/web/tsconfig.json") },
  },
};
