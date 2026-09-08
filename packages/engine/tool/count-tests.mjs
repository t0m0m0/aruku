#!/usr/bin/env node
// 移植の網羅を機械で確かめる（#384 完了条件）。Dart 側のテスト件数と、移植後の
// vitest の件数をファイル単位で突き合わせる。

import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

/// Dart 側の実テスト件数。取り直す手順:
///
///   flutter test test/core/services/<name>_test.dart --reporter=json \
///     | grep '"type":"testStart"' | grep -vc 'loading '
///
/// `--reporter=json` の `testStart` にはファイルごとに `loading …_test.dart` という
/// 擬似テストが1件混ざる。数えると全ファイルで +1 され、6ファイルで 314 が 320 になる。
const EXPECTED = {
  'transit-route-service.test.ts': {
    dart: 'test/core/services/transit_route_service_test.dart',
    count: 112,
  },
  'hybrid-route-selector.test.ts': {
    dart: 'test/core/services/hybrid_route_selector_test.dart',
    count: 65,
  },
  'route-plan-builder.test.ts': {
    dart: 'test/core/services/route_plan_builder_test.dart',
    count: 35,
  },
  'transit-plan-parser.test.ts': {
    dart: 'test/core/services/transit_plan_parser_test.dart',
    count: 18,
  },
  'transit-api-client.test.ts': {
    dart: 'test/core/services/transit_api_client_test.dart',
    count: 36,
  },
  'route-diagnostics.test.ts': {
    dart: 'test/core/services/route_diagnostics_test.dart',
    count: 48,
  },
};

const listed = JSON.parse(
  execFileSync('npx', ['vitest', 'list', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
);

const actual = new Map();
for (const test of listed) {
  const file = basename(test.file);
  actual.set(file, (actual.get(file) ?? 0) + 1);
}

let expectedTotal = 0;
let actualTotal = 0;
let mismatched = 0;

console.log('file'.padEnd(32) + 'dart'.padStart(6) + 'vitest'.padStart(8) + '  ');
for (const [file, { count }] of Object.entries(EXPECTED)) {
  const got = actual.get(file) ?? 0;
  expectedTotal += count;
  actualTotal += got;
  const ok = got === count;
  if (!ok) mismatched++;
  console.log(
    file.padEnd(32) +
      String(count).padStart(6) +
      String(got).padStart(8) +
      (ok ? '  ok' : `  MISMATCH (${got - count > 0 ? '+' : ''}${got - count})`),
  );
}

// EXPECTED に無いファイルは移植対象外の混入。黙って総数へ足すと帳尻だけ合ってしまう。
for (const file of actual.keys()) {
  if (!(file in EXPECTED)) {
    mismatched++;
    console.log(`${file.padEnd(32)}${''.padStart(6)}${String(actual.get(file)).padStart(8)}  UNEXPECTED FILE`);
  }
}

console.log('-'.repeat(48));
console.log('total'.padEnd(32) + String(expectedTotal).padStart(6) + String(actualTotal).padStart(8));

if (mismatched > 0) {
  console.error(`\n${mismatched} file(s) do not match the Dart test count.`);
  process.exit(1);
}
console.log('\nall files match the Dart test count.');
