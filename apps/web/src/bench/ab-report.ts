// 厳密走査の A/B 計測（#462）の JSONL を集計し、issue に貼る Markdown にする。
//
// import は型だけにしてある。scripts/ab-report.mjs が Node の型除去でこのファイルを
// そのまま読むため——値の import を足すと、拡張子なしの解決ができずに落ちる。

import type { VerifyResult } from './ab-verify';
import type { BenchRecord } from './bench-record';

export interface AbSummary {
  total: number;
  errors: number;
  /// 時刻表の路線で1回乗車が成立した検索（`coveredBase=1`）。徒歩の増分の分母。
  covered: number;
  improved: number;
  exactWon: number;
  gainMedian: number | null;
  /// 改善した検索だけの増分の中央値。
  gainMedianImproved: number | null;
  gainMax: number | null;
  violations: number;
  exactWonViolations: number;
  totalMsAMedian: number | null;
  totalMsAP90: number | null;
  totalMsBEstMedian: number | null;
  totalMsBEstP90: number | null;
  exactMsMedian: number | null;
  exactMsP90: number | null;
  /// A では崩壊したが B では崩壊しない検索（board-search が要らなくなった）。
  collapseResolved: number;
}

export function median(xs: readonly number[]): number | null {
  return quantile(xs, 0.5);
}

function quantile(xs: readonly number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

const num = (m: Record<string, number | string>, key: string): number => {
  const v = m[key];
  return typeof v === 'number' ? v : Number.NaN;
};

export function summarize(records: readonly BenchRecord[]): AbSummary {
  const ok = records.filter((r) => r.error === null && r.metrics !== null && r.plan !== null);
  const gains: number[] = [];
  const totalA: number[] = [];
  const totalB: number[] = [];
  const exactMs: number[] = [];
  let covered = 0;
  let exactWon = 0;
  let violations = 0;
  let exactWonViolations = 0;
  let collapseResolved = 0;
  for (const r of ok) {
    const m = r.metrics!;
    const won = num(m, 'exactWon') === 1;
    if (won) exactWon++;
    const violated = !r.plan!.withinBudget || r.plan!.missed;
    if (violated) {
      violations++;
      if (won) exactWonViolations++;
    }
    const walkA = num(m, 'walkA');
    const walkB = num(m, 'walkB');
    if (num(m, 'coveredBase') === 1 && walkA >= 0 && walkB >= 0) {
      covered++;
      gains.push(walkB - walkA);
    }
    // A は必ず全工程を走るので、B の所要は同じ実行の中では測れない。崩壊が解けた検索で
    // 浮く board-search の時間を引いて推定する（§3.8 の collapseB）。
    const a = num(m, 'totalMs') - num(m, 'abMs');
    const resolved = num(m, 'collapse') === 1 && num(m, 'collapseB') === 0;
    if (resolved) collapseResolved++;
    if (Number.isFinite(a)) {
      totalA.push(a);
      totalB.push(resolved ? a - num(m, 'boardSearchMs') : a);
    }
    if (num(m, 'exactCalls') > 0) exactMs.push(num(m, 'exactMs'));
  }
  const improvedGains = gains.filter((g) => g > 0);
  return {
    total: records.length,
    errors: records.length - ok.length,
    covered,
    improved: improvedGains.length,
    exactWon,
    gainMedian: median(gains),
    gainMedianImproved: median(improvedGains),
    gainMax: gains.length === 0 ? null : Math.max(...gains),
    violations,
    exactWonViolations,
    totalMsAMedian: median(totalA),
    totalMsAP90: quantile(totalA, 0.9),
    totalMsBEstMedian: median(totalB),
    totalMsBEstP90: quantile(totalB, 0.9),
    exactMsMedian: median(exactMs),
    exactMsP90: quantile(exactMs, 0.9),
    collapseResolved,
  };
}

const fmt = (v: number | null, unit = ''): string =>
  v === null ? '—' : `${Math.round(v * 10) / 10}${unit}`;

const pct = (n: number, d: number): string =>
  d === 0 ? '—' : `${Math.round((n / d) * 1000) / 10}%`;

function gainRows(records: readonly BenchRecord[], keyOf: (r: BenchRecord) => string): string[] {
  const groups = new Map<string, BenchRecord[]>();
  for (const r of records) groups.set(keyOf(r), [...(groups.get(keyOf(r)) ?? []), r]);
  return [...groups.entries()].map(([key, rs]) => {
    const s = summarize(rs);
    return `| ${key} | ${s.covered} | ${s.improved}（${pct(s.improved, s.covered)}） | ${fmt(s.gainMedian, '分')} | ${fmt(s.gainMedianImproved, '分')} | ${fmt(s.gainMax, '分')} |`;
  });
}

export function abReport(
  records: readonly BenchRecord[],
  verify: readonly VerifyResult[] = [],
): string {
  const s = summarize(records);
  const header =
    '| 区分 | 対象（coveredBase） | 改善した検索 | 増分の中央値 | 改善した検索の中央値 | 最大 |\n' +
    '| --- | --- | --- | --- | --- | --- |';
  const lines = [
    '## 厳密走査の A/B（同じ実行の中）',
    '',
    `検索 ${s.total} 件（失敗・基準なし ${s.errors} 件）。厳密走査が勝った検索 ${s.exactWon} 件。`,
    '',
    '### 徒歩の増分（walkB − walkA）',
    '',
    header,
    `| 全体 | ${s.covered} | ${s.improved}（${pct(s.improved, s.covered)}） | ${fmt(s.gainMedian, '分')} | ${fmt(s.gainMedianImproved, '分')} | ${fmt(s.gainMax, '分')} |`,
    ...gainRows(records, (r) => `予算 ×${r.ratio}`),
    ...gainRows(records, (r) => `${r.slot} 発`),
    '',
    '### 乗り遅れ・予算超過（B の確定経路）',
    '',
    `- 全体: ${s.violations} 件（予算内の候補が無いときの best-effort 縮退を含む）`,
    `- うち厳密走査が勝った経路: ${s.exactWonViolations} 件`,
    '',
    '### 検索時間（totalMs）',
    '',
    '| | 中央値 | p90 |',
    '| --- | --- | --- |',
    `| A（厳密走査なし。B の厳密走査の待ちと選び直しを除く） | ${fmt(s.totalMsAMedian, 'ms')} | ${fmt(s.totalMsAP90, 'ms')} |`,
    `| B の推定（崩壊が解けた検索の board-search を除く） | ${fmt(s.totalMsBEstMedian, 'ms')} | ${fmt(s.totalMsBEstP90, 'ms')} |`,
    `| exactMs（guidance と並列） | ${fmt(s.exactMsMedian, 'ms')} | ${fmt(s.exactMsP90, 'ms')} |`,
    '',
    `崩壊が解けた検索（collapse=1 collapseB=0）: ${s.collapseResolved} 件。`,
  ];
  if (verify.length > 0) {
    const count = (verdict: VerifyResult['verdict']): number =>
      verify.filter((v) => v.error === null && v.verdict === verdict).length;
    lines.push(
      '',
      '### Transit API の発車表での照合',
      '',
      `厳密走査が勝った経路の便が、乗車駅と降車駅の発車表に同じ便で在った（同じ便: ${count('sameTrip')} / ${verify.length}）。`,
      '',
      `- 乗車駅の発車だけ一致: ${count('departureOnly')}（降車駅が終点だと、降車駅の発車表に載らない）`,
      `- 同じ分の便が無い: ${count('missing')}`,
      `- 発車表なし: ${count('noBoard')}（ODPT 由来のフィードは駅の発車表を公開しない）`,
      `- 照会失敗: ${verify.filter((v) => v.error !== null).length}`,
      '',
      '| OD | 時間帯 | 区間 | 便 | 結果 |',
      '| --- | --- | --- | --- | --- |',
      ...verify.map(
        (v) =>
          `| ${v.pair} | ${v.slot} ×${v.ratio} | ${v.from}→${v.to}（${v.line ?? ''}） | ${v.dep ?? ''}→${v.arr?.slice(11) ?? ''} | ${verdictCell(v)} |`,
      ),
    );
  }
  return `${lines.join('\n')}\n`;
}

function verdictCell(v: VerifyResult): string {
  if (v.error !== null) return `照会失敗: ${v.error}`;
  switch (v.verdict) {
    case 'sameTrip':
      return `同じ便（${v.matchedLine ?? ''}）`;
    case 'departureOnly':
      return `乗車駅の発車だけ一致（${v.matchedLine ?? ''}）`;
    case 'missing':
      return `無い（${v.seen.join(', ')}）`;
    case 'noBoard':
    case null:
      return '発車表なし';
  }
}
