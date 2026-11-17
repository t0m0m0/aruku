// 再生ハーネス（#504）で回した2つの版の JSONL を突き合わせ、issue に貼る Markdown にする。
//
// import は型だけにしてある。scripts/replay-report.mjs が Node の型除去でこのファイルを
// そのまま読むため（ab-report.ts と同じ事情）。

import type { BenchRecord } from '../bench-record';

export interface ReplayRecord extends BenchRecord {
  readonly label: string;
  /// その検索で、引き直しの上限の模擬がタイムアウトさせた照会の数。
  readonly refetchLimitHits: number;
  /// その検索で、録画に無く上流へ取りに行った照会の数。0 でない行は上流のばらつきを含む。
  readonly misses: number;
}

export interface ComparedRow {
  readonly pair: string;
  readonly slot: string;
  readonly ratio: number;
  readonly totalMsA: number | null;
  readonly totalMsB: number | null;
  readonly guidanceA: number | null;
  readonly guidanceB: number | null;
  readonly sameRoute: boolean;
  readonly a: ReplayRecord;
  readonly b: ReplayRecord;
}

const keyOf = (r: BenchRecord): string => `${r.pair}|${r.slot}|${r.ratio}`;

const metric = (r: BenchRecord, key: string): number | null => {
  const v = r.metrics?.[key];
  return typeof v === 'number' ? v : null;
};

const routeOf = (r: BenchRecord): string | null =>
  r.plan === null
    ? null
    : JSON.stringify([
        r.plan.walkMinutes,
        r.plan.rides.map((x) => [x.type, x.line, x.from, x.to, x.dep, x.arr]),
      ]);

/// 両方の JSONL にある検索だけを、[a] の並び順で返す。
export function compareRuns(a: readonly ReplayRecord[], b: readonly ReplayRecord[]): ComparedRow[] {
  const byKey = new Map(b.map((r) => [keyOf(r), r]));
  return a.flatMap((ra) => {
    const rb = byKey.get(keyOf(ra));
    if (rb === undefined) return [];
    const routeA = routeOf(ra);
    return [
      {
        pair: ra.pair,
        slot: ra.slot,
        ratio: ra.ratio,
        totalMsA: metric(ra, 'totalMs'),
        totalMsB: metric(rb, 'totalMs'),
        guidanceA: metric(ra, 'guidanceCalls'),
        guidanceB: metric(rb, 'guidanceCalls'),
        sameRoute: routeA !== null && routeA === routeOf(rb),
        a: ra,
        b: rb,
      },
    ];
  });
}

/// ab-report.ts の同名関数を import しないのは、値の import が Node の型除去で解決できない
/// ため（拡張子なしの相対 import）。
export function quantile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((x, y) => x - y);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const mean = (xs: readonly number[]): number | null =>
  xs.length === 0 ? null : xs.reduce((s, x) => s + x, 0) / xs.length;

const sec = (ms: number | null): string => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`);
const signedSec = (ms: number): string =>
  `${ms < 0 ? '-' : '+'}${(Math.abs(ms) / 1000).toFixed(1)}s`;
const present = (xs: readonly (number | null)[]): number[] =>
  xs.filter((x): x is number => x !== null);

const describeRoute = (r: BenchRecord): string =>
  r.plan === null
    ? `エラー（${r.error ?? '不明'}）`
    : `徒歩${r.plan.walkMinutes}分 ${r.plan.rides.map((x) => `${x.line ?? x.type} ${x.from}>${x.to}`).join('・') || '全徒歩'}`;

export function replayReport(
  a: readonly ReplayRecord[],
  b: readonly ReplayRecord[],
  labels: { a: string; b: string },
): string {
  const rows = compareRuns(a, b);
  const lines: string[] = [];
  lines.push(
    `| 組 | 出発 | 倍率 | ${labels.a} | ${labels.b} | 差 | guidance ${labels.a}→${labels.b} | 経路 |`,
  );
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    const diff =
      r.totalMsA !== null && r.totalMsB !== null ? signedSec(r.totalMsB - r.totalMsA) : '—';
    lines.push(
      `| ${r.pair} | ${r.slot} | ${r.ratio} | ${sec(r.totalMsA)} | ${sec(r.totalMsB)} | ${diff} | ` +
        `${r.guidanceA ?? '—'}→${r.guidanceB ?? '—'} | ${r.sameRoute ? '同じ' : '違う'} |`,
    );
  }

  const totalA = present(rows.map((r) => r.totalMsA));
  const totalB = present(rows.map((r) => r.totalMsB));
  const sum = (xs: readonly (number | null)[]): number => present(xs).reduce((s, x) => s + x, 0);
  lines.push('');
  lines.push(`| | ${labels.a} | ${labels.b} |`);
  lines.push('|---|---|---|');
  lines.push(`| 中央値 | ${sec(quantile(totalA, 0.5))} | ${sec(quantile(totalB, 0.5))} |`);
  lines.push(`| 平均 | ${sec(mean(totalA))} | ${sec(mean(totalB))} |`);
  lines.push(`| p90 | ${sec(quantile(totalA, 0.9))} | ${sec(quantile(totalB, 0.9))} |`);
  lines.push(
    `| guidance 合計 | ${sum(rows.map((r) => r.guidanceA))} | ${sum(rows.map((r) => r.guidanceB))} |`,
  );
  lines.push('');
  lines.push(`経路が同じ: ${rows.filter((r) => r.sameRoute).length} / ${rows.length}`);

  const misses = sum(rows.flatMap((r) => [r.a.misses, r.b.misses]));
  if (misses > 0) {
    lines.push(`録画外れ（上流のばらつきを含む）: ${misses} 本`);
  }

  const differing = rows.filter((r) => !r.sameRoute);
  if (differing.length > 0) {
    lines.push('');
    lines.push('経路が違う検索:');
    for (const r of differing) {
      lines.push(
        `- ${r.pair} ${r.slot} ×${r.ratio}: ${labels.a} ${describeRoute(r.a)} → ${labels.b} ${describeRoute(r.b)}`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}
