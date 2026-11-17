// 厳密走査の A/B 計測（#462）の JSONL を集計して Markdown を標準出力へ出す。
//
//   node scripts/ab-report.mjs aruku-ab-2026-10-27.jsonl [aruku-ab-verify-2026-10-27.jsonl]
//
// JSONL は開発時だけのベンチ画面（/bench.html）が保存する。集計の本体は
// src/bench/ab-report.ts で、Node の型除去でそのまま読む（tsx 等を足さないため）。

import { readFileSync } from 'node:fs';

import { abReport } from '../src/bench/ab-report.ts';

const [recordsPath, verifyPath] = process.argv.slice(2);
if (recordsPath === undefined) {
  console.error('usage: node scripts/ab-report.mjs <records.jsonl> [verify.jsonl]');
  process.exit(2);
}

// 行の形は確かめない。読むのは自分のベンチが書いた JSONL で、集計側の型（BenchRecord 等）を
// 実行時に検査し直す型述語を持つ益が、開発時だけの集計に見合わない。
/**
 * @param {string} line
 * @returns {unknown}
 */
const parseLine = (line) => JSON.parse(line);

/** @param {string} path */
const readJsonl = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map(parseLine);

process.stdout.write(
  abReport(readJsonl(recordsPath), verifyPath === undefined ? [] : readJsonl(verifyPath)),
);
