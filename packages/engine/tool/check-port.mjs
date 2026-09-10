#!/usr/bin/env node
// 移植の網羅と Phase 1 の期待状態を機械で確かめる（#384 完了条件）。
//
// 件数だけでは足りない。名前を照合しないと「1本消して1本足す」改名が素通りし、
// テスト名＝仕様書という前提（PORTING.md）が静かに崩れる（PR #389 レビュー指摘）。
// また、赤の内訳を見ないと「部分実装が緑のまま入る」ことを止められない——CI は
// vitest を直接は回さないので、その穴をここで塞ぐ（同レビュー P1）。

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
};

/// Phase 1 で**緑になってよい**テスト。データクラスのフィールド既定値だけを主張する
/// もので、実装したのがまさにそのフィールド宣言だから通る（PORTING.md）。
///
/// これを許可リストにするのは、緑の本数ではなく**どれが緑か**を固定するため。本数だけ
/// 見ると「1本実装して1本壊す」部分実装が素通りする。#385 で本体が入ったら、この
/// 許可リストごと [PHASE] を 'all-green' へ切り替える。
const PHASE = 'red-except-defaults';
const EXPECTED_GREEN = new Set([
  'BestEffortLedger 一度も縮退しなければすべて0',
  'board-search の徒歩推移（打ち切り判断の材料） board-search が走らなければ空',
  'RouteSearchMetrics.toLogLine board-search が起動しなければ探索系は 0・境界は -1（未探索の印）',
  'RouteSearchMetrics: 投機 board-search の空振り計上 (#341) 投機しただけで空振りしていなければ wasted は立たない',
  'RouteSearchMetrics: 投機 board-search の空振り計上 (#341) 投機していない検索は3フィールドとも既定のまま',
  'RouteSearchMetrics: 投機 board-search の空振り計上 (#341) BoardSearchStats.probes の既定は 0',
]);

const outputFile = join(tmpdir(), `aruku-engine-port-${process.pid}.json`);
try {
  // テストが赤い（＝Phase 1 の正常）と vitest は非ゼロで終わるので、終了コードは見ない。
  // 見るのは常に出力 JSON の中身。
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

const problems = [];
const actualByFile = new Map();
const passed = new Set();
const badFailures = [];
const disabled = [];

for (const suite of report.testResults ?? []) {
  const file = basename(suite.name);
  const names = actualByFile.get(file) ?? [];
  for (const test of suite.assertionResults ?? []) {
    names.push(test.fullName);
    if (test.status === 'passed') {
      passed.add(test.fullName);
    } else if (test.status === 'failed') {
      const message = (test.failureMessages ?? []).join('\n');
      if (!message.includes('NotImplementedError')) {
        badFailures.push([test.fullName, message.split('\n')[0]]);
      }
    } else {
      // `it.skip` / `it.todo` は名前が残るので**名前の照合を素通りする**。CI は素の
      // vitest 終了コードではなくこの検査を見ているので、ここで落とさないと無効化した
      // 仕様が緑で入る（PR #389 レビュー）。赤にできないテストは移植の失敗であって、
      // 黙らせる対象ではない（.claude/docs/testing.md「Never suppress failing tests」）。
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
  const missing = expected.filter((n) => !actual.includes(n));
  const extra = actual.filter((n) => !expected.includes(n));
  const ok = missing.length === 0 && extra.length === 0;
  console.log(
    tsFile.padEnd(32) +
      String(expected.length).padStart(6) +
      String(actual.length).padStart(8) +
      (ok ? '  ok' : `  MISMATCH (-${missing.length}/+${extra.length})`),
  );
  for (const n of missing) problems.push(`${tsFile}: 移植されていない: ${n}`);
  for (const n of extra) problems.push(`${tsFile}: Dart 側に無い名前: ${n}`);
}

// FILE_MAP に無いファイルは移植対象外の混入。黙って総数へ足すと帳尻だけ合ってしまう。
for (const file of actualByFile.keys()) {
  if (!(file in FILE_MAP)) {
    problems.push(`${file}: 移植対象外のテストファイルが混ざっている`);
  }
}

for (const [name, first] of badFailures) {
  problems.push(`未実装以外の理由で落ちている: ${name}\n    ${first}`);
}

for (const [name, status] of disabled) {
  problems.push(`実行されていない（status=${status}）: ${name}`);
}

if (PHASE === 'red-except-defaults') {
  for (const name of passed) {
    if (!EXPECTED_GREEN.has(name)) {
      problems.push(
        `Phase 1 で緑になってはいけないテストが通っている: ${name}\n` +
          '    本体を実装したなら #385 として出し、check-port.mjs の PHASE を切り替えること。',
      );
    }
  }
  for (const name of EXPECTED_GREEN) {
    if (!passed.has(name)) {
      problems.push(
        `既定値だけを主張するテストが赤い（移植が壊れている疑い）: ${name}`,
      );
    }
  }
}

console.log('-'.repeat(48));
const total = [...actualByFile.values()].reduce((a, v) => a + v.length, 0);
const dartTotal = Object.values(DART_NAMES).reduce((a, v) => a + v.length, 0);
console.log(
  'total'.padEnd(32) +
    String(dartTotal).padStart(6) +
    String(total).padStart(8) +
    `  (red ${total - passed.size - disabled.length} / green ${passed.size}` +
    `${disabled.length > 0 ? ` / disabled ${disabled.length}` : ''})`,
);

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log('\nported tests match the Dart suite name-for-name.');
