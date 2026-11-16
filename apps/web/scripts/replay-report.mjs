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
const [aPath, bPath] = args;
if (aPath === undefined || bPath === undefined || (labels !== null && labels.length !== 2)) {
  console.error('usage: node scripts/replay-report.mjs <a.jsonl> <b.jsonl> [--labels a,b]');
  process.exit(2);
}

const readJsonl = (path) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line));

const a = readJsonl(aPath);
const b = readJsonl(bPath);
process.stdout.write(
  replayReport(a, b, {
    a: labels?.[0] ?? a[0]?.label ?? 'A',
    b: labels?.[1] ?? b[0]?.label ?? 'B',
  }),
);
