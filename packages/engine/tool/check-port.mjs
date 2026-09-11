#!/usr/bin/env node
// 移植の網羅を機械で確かめる（#384 完了条件 / #385 で本体を実装後）。
//
// 件数だけでは足りない。名前を照合しないと「1本消して1本足す」改名が素通りし、
// テスト名＝仕様書という前提（PORTING.md）が静かに崩れる（PR #389 レビュー指摘）。
//
// #385 で本体が入り全て緑になったので、赤の内訳の検査（未実装以外の理由で落ちていないか・
// 緑になってよいのは既定値だけを主張する6本か）は役目を終えた。CI は素の `vitest run` を
// 直接回すようになり、「落ちているテストがあるか」はそちらが答える。ここに残るのは
// **Dart 側と1対1か**——vitest だけでは決して分からない、移植の網羅そのもの。

import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';

/// 移植元（Dart）のテスト名。取り直す手順は PORTING.md「テスト名の突き合わせ」。
const DART_NAMES = JSON.parse(
  readFileSync(new URL('./dart-test-names.json', import.meta.url), 'utf8'),
);

const FILE_MAP = {
  'transit-route-service.test.ts': 'transit_route_service_test.dart',
  'hybrid-route-selector.test.ts': 'hybrid_route_selector_test.dart',
  'route-plan-builder.test.ts': 'route_plan_builder_test.dart',
  'transit-plan-parser.test.ts': 'transit_plan_parser_test.dart',
  'transit-api-client.test.ts': 'transit_api_client_test.dart',
  'route-diagnostics.test.ts': 'route_diagnostics_test.dart',
  'time-value.test.ts': 'time_value_test.dart',
  'frontier-stations.test.ts': 'frontier_stations_test.dart',
  'cancellation.test.ts': 'cancellation_test.dart',
  'search-deadline.test.ts': 'search_deadline_test.dart',
  'rail-line-names.test.ts': 'rail_line_names_test.dart',
  'search-scoped-route-service.test.ts': 'search_scoped_route_service_test.dart',
  'app-settings.test.ts': 'app_settings_test.dart',
};

const outputFile = join(tmpdir(), `aruku-engine-port-${process.pid}.json`);
try {
  // 終了コードは見ない。落ちたテストがあるかは CI の `npm test`（素の vitest run）が
  // 答える担当で、ここが見るのは出力 JSON に並ぶ**テスト名**だけ。両方をこのスクリプトの
  // 終了コードへ畳むと、名前の不一致とテストの失敗が同じ赤になって切り分けられない。
  execFileSync(
    'npx',
    ['vitest', 'run', '--reporter=json', `--outputFile=${outputFile}`],
    { encoding: 'utf8', stdio: 'ignore', maxBuffer: 64 * 1024 * 1024 },
  );
} catch {
  // 赤は想定内。
}

let report;
try {
  report = JSON.parse(readFileSync(outputFile, 'utf8'));
} finally {
  rmSync(outputFile, { force: true });
}

/// 名前の**多重度**つき差分。`includes` による集合比較だと、同じ名前を2本置いても
/// どちらの差分も空になり「1対1」を主張したまま件数だけ増える（PR #389 レビュー）。
function multisetDiff(expected, actual) {
  const count = (names) => {
    const m = new Map();
    for (const n of names) m.set(n, (m.get(n) ?? 0) + 1);
    return m;
  };
  const e = count(expected);
  const a = count(actual);
  const missing = [];
  const extra = [];
  for (const name of new Set([...e.keys(), ...a.keys()])) {
    const diff = (a.get(name) ?? 0) - (e.get(name) ?? 0);
    for (let i = 0; i < -diff; i++) missing.push(name);
    for (let i = 0; i < diff; i++) extra.push(name);
  }
  return { missing, extra };
}

const problems = [];
const actualByFile = new Map();
const passed = new Set();
const disabled = [];

for (const suite of report.testResults ?? []) {
  const file = basename(suite.name);
  const names = actualByFile.get(file) ?? [];
  for (const test of suite.assertionResults ?? []) {
    names.push(test.fullName);
    if (test.status === 'passed') {
      passed.add(test.fullName);
    } else if (test.status !== 'failed') {
      // `it.skip` / `it.todo` は名前が残るので**名前の照合を素通りする**。素の vitest も
      // skip を失敗にはしないので、ここで落とさないと無効化した仕様が緑で入る
      // （PR #389 レビュー）。赤にできないテストは移植の失敗であって、黙らせる対象では
      // ない（.claude/docs/testing.md「Never suppress failing tests」）。
      disabled.push([test.fullName, test.status]);
    }
  }
  actualByFile.set(file, names);
}

console.log(
  'file'.padEnd(32) + 'dart'.padStart(6) + 'vitest'.padStart(8) + '  name',
);
for (const [tsFile, dartFile] of Object.entries(FILE_MAP)) {
  const expected = DART_NAMES[dartFile] ?? [];
  const actual = actualByFile.get(tsFile) ?? [];
  const { missing, extra } = multisetDiff(expected, actual);
  const ok = missing.length === 0 && extra.length === 0;
  console.log(
    tsFile.padEnd(32) +
      String(expected.length).padStart(6) +
      String(actual.length).padStart(8) +
      (ok ? '  ok' : `  MISMATCH (-${missing.length}/+${extra.length})`),
  );
  for (const n of missing) problems.push(`${tsFile}: 移植されていない: ${n}`);
  for (const n of extra) {
    const duplicated = expected.includes(n);
    problems.push(
      duplicated
        ? `${tsFile}: 同じ名前のテストが重複している: ${n}`
        : `${tsFile}: Dart 側に無い名前: ${n}`,
    );
  }
}

// FILE_MAP に無いファイルは移植対象外の混入。黙って総数へ足すと帳尻だけ合ってしまう。
for (const file of actualByFile.keys()) {
  if (!(file in FILE_MAP)) {
    problems.push(`${file}: 移植対象外のテストファイルが混ざっている`);
  }
}

for (const [name, status] of disabled) {
  problems.push(`実行されていない（status=${status}）: ${name}`);
}

console.log('-'.repeat(48));
const total = [...actualByFile.values()].reduce((a, v) => a + v.length, 0);
const dartTotal = Object.values(DART_NAMES).reduce((a, v) => a + v.length, 0);
console.log(
  'total'.padEnd(32) +
    String(dartTotal).padStart(6) +
    String(total).padStart(8) +
    `  (green ${passed.size} / red ${total - passed.size - disabled.length}` +
    `${disabled.length > 0 ? ` / disabled ${disabled.length}` : ''})`,
);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nported tests match the Dart suite name-for-name.');
