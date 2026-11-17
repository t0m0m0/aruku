// 再生ハーネス（#504）で回した2つの版の JSONL を突き合わせ、Markdown を標準出力へ出す。
//
//   node scripts/replay-report.mjs main.jsonl head.jsonl [--labels main,head]
//
// 集計の本体は src/bench/replay/replay-report.ts で、Node の型除去でそのまま読む
// （ab-report.mjs と同じ）。

import { readFileSync } from 'node:fs';

import { replayReport } from '../src/bench/replay/replay-report.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--labels');
const labels = at < 0 ? null : args.splice(at, 2)[1]?.split(',');
const aPath = args.at(0);
const bPath = args.at(1);
if (aPath === undefined || bPath === undefined || (labels !== null && labels.length !== 2)) {
  console.error('usage: node scripts/replay-report.mjs <a.jsonl> <b.jsonl> [--labels a,b]');
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

/** @param {unknown[]} rows */
const labelOf = (rows) => {
  const first = rows[0];
  const label =
    typeof first === 'object' && first !== null && 'label' in first ? first.label : null;
  return typeof label === 'string' ? label : undefined;
};

const a = readJsonl(aPath);
const b = readJsonl(bPath);
process.stdout.write(
  replayReport(a, b, {
    a: labels?.[0] ?? labelOf(a) ?? 'A',
    b: labels?.[1] ?? labelOf(b) ?? 'B',
  }),
);
