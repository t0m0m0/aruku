import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { cruise, type ICruiseResult } from "dependency-cruiser";
import extractDepcruiseConfig from "dependency-cruiser/config-utl/extract-depcruise-config";
import extractTSConfig from "dependency-cruiser/config-utl/extract-ts-config";

// リポジトリの実物の規則（ルートの .dependency-cruiser.cjs）を、違反を仕込んだ小さな
// リポジトリの写し（fixtures/dependency-rules）へ当てる。実リポジトリは違反ゼロが
// 正しい状態なので、規則が効いていることはそこでは確かめられない。
const repoRoot = join(__dirname, "..", "..");
const fixtureRoot = join(__dirname, "fixtures", "dependency-rules");
const fixtureTsConfig = join(fixtureRoot, "apps", "web", "tsconfig.json");

interface Violation {
  readonly rule: string;
  readonly from: string;
  readonly to: string;
}

async function cruiseFixture(): Promise<readonly Violation[]> {
  const config = await extractDepcruiseConfig(
    join(repoRoot, ".dependency-cruiser.cjs")
  );
  const result = await cruise(
    ["packages", "apps", "functions"],
    {
      ...config.options,
      validate: true,
      ruleSet: config,
      baseDir: fixtureRoot,
      tsConfig: { fileName: fixtureTsConfig },
    },
    undefined,
    { tsConfig: extractTSConfig(fixtureTsConfig) }
  );
  const output = result.output as ICruiseResult;
  return output.summary.violations.map((v) => ({
    rule: v.rule.name,
    from: v.from,
    to: v.to,
  }));
}

describe("依存ルール（dependency-cruiser）", () => {
  let violations: readonly Violation[];

  beforeAll(async () => {
    violations = await cruiseFixture();
  });

  const rulesOf = (from: string): string[] =>
    violations.filter((v) => v.from === from).map((v) => v.rule);

  it("engine が apps/web を import すると違反になる", () => {
    expect(violations).toContainEqual({
      rule: "engine-not-to-apps-or-functions",
      from: "packages/engine/src/imports-web.ts",
      to: "apps/web/src/screen.ts",
    });
  });

  it("engine が functions を import すると違反になる", () => {
    expect(violations).toContainEqual({
      rule: "engine-not-to-apps-or-functions",
      from: "packages/engine/src/imports-functions.ts",
      to: "functions/src/handler.ts",
    });
  });

  it("web の本番コードが bench を（エイリアス経由でも）import すると違反になる", () => {
    expect(violations).toContainEqual({
      rule: "web-production-not-to-bench",
      from: "apps/web/src/imports-bench.ts",
      to: "apps/web/src/bench/runner.ts",
    });
  });

  it("bench 自身とテストが bench を import するのは違反にならない", () => {
    expect(rulesOf("apps/web/src/bench/runner.ts")).toEqual([]);
    expect(rulesOf("apps/web/test/bench/runner-check.ts")).toEqual([]);
  });

  it("型だけの import を含む循環も違反になる", () => {
    // 循環は1周につき1件だけ、どちらかの辺から報告される。
    const cycles = violations.filter((v) => v.rule === "no-circular");
    expect(cycles).toHaveLength(1);
    expect([cycles[0]?.from, cycles[0]?.to].sort()).toEqual([
      "functions/src/cycle-a.ts",
      "functions/src/cycle-b.ts",
    ]);
  });

  it("仕込んだ違反のほかには何も報告しない", () => {
    expect(violations.map((v) => v.rule).sort()).toEqual([
      "engine-not-to-apps-or-functions",
      "engine-not-to-apps-or-functions",
      "no-circular",
      "web-production-not-to-bench",
    ]);
  });
});
