import { describe, expect, it } from 'vitest';

import { abReport, median, summarize } from '../../src/bench/ab-report';
import type { BenchRecord } from '../../src/bench/bench-record';
import type { VerifyResult } from '../../src/bench/ab-verify';

const rec = (o: {
  pair?: string;
  ratio?: number;
  slot?: string;
  m?: Record<string, number>;
  within?: boolean;
  missed?: boolean;
  error?: string;
}): BenchRecord => ({
  pair: o.pair ?? 'p',
  date: '2026-10-27',
  slot: o.slot ?? '12:00',
  ratio: o.ratio ?? 1.5,
  standardMin: 40,
  budgetMin: 60,
  metrics:
    o.error === undefined
      ? {
          coveredBase: 1,
          walkA: 30,
          walkB: 30,
          exactWon: 0,
          collapse: 0,
          collapseB: 0,
          boardSearchMs: 0,
          totalMs: 10000,
          abMs: 0,
          exactMs: 500,
          ...o.m,
        }
      : null,
  plan:
    o.error === undefined
      ? {
          totalMin: 55,
          budgetMin: 60,
          walkMinutes: 30,
          withinBudget: o.within ?? true,
          missed: o.missed ?? false,
          rides: [],
        }
      : null,
  error: o.error ?? null,
});

describe('median', () => {
  it('偶数個は中央2つの平均、空は null', () => {
    expect(median([3, 1, 2])).toEqual(2);
    expect(median([4, 1, 2, 3])).toEqual(2.5);
    expect(median([])).toBeNull();
  });
});

describe('summarize: 完了条件の数字', () => {
  it('徒歩の増分は coveredBase の検索だけを分母にする', () => {
    const s = summarize([
      rec({ m: { walkB: 50, exactWon: 1 } }), // +20
      rec({ m: { walkB: 30 } }), // ±0
      rec({ m: { walkB: 40, exactWon: 1 } }), // +10
      rec({ m: { coveredBase: 0, walkB: 30 } }), // 分母外
    ]);
    expect(s.covered).toEqual(3);
    expect(s.improved).toEqual(2);
    expect(s.gainMedian).toEqual(10);
    expect(s.gainMedianImproved).toEqual(15);
    expect(s.gainMax).toEqual(20);
  });

  it('乗り遅れ・予算超過を数え、厳密走査が勝った検索の違反は別に数える', () => {
    const s = summarize([
      rec({ within: false }),
      rec({ missed: true, m: { exactWon: 1 } }),
      rec({}),
    ]);
    expect(s.violations).toEqual(2);
    expect(s.exactWonViolations).toEqual(1);
  });

  it("乗換つきの増分（walkB' − walkB）は transferCandidates>0 の検索だけを分母にする", () => {
    const s = summarize([
      rec({ m: { transferCandidates: 3, walkB: 30, walkBPrime: 42, transferWon: 1 } }), // +12
      rec({ m: { transferCandidates: 2, walkB: 30, walkBPrime: 30 } }), // ±0
      rec({ m: { coveredBase: 0, transferCandidates: 1, walkB: 30, walkBPrime: 36, transferWon: 1 } }), // +6
      rec({ m: { transferCandidates: 0, walkB: 30, walkBPrime: 30 } }), // 分母外
      rec({ m: { transferCandidates: -1, walkB: 30, walkBPrime: 30 } }), // 分母外
    ]);
    expect(s.transferCovered).toEqual(3);
    expect(s.transferImproved).toEqual(2);
    expect(s.transferWon).toEqual(2);
    expect(s.transferGainMedian).toEqual(6);
    expect(s.transferGainMedianImproved).toEqual(9);
    expect(s.transferGainMax).toEqual(12);
  });

  it('乗換つきの候補の数と enrich で落ちた数を足し上げる', () => {
    const s = summarize([
      rec({ m: { transferCandidates: 3, transferDropped: 1 } }),
      rec({ m: { transferCandidates: 2, transferDropped: 2 } }),
      rec({ m: { transferCandidates: -1, transferDropped: 0 } }),
    ]);
    expect(s.transferCandidatesTotal).toEqual(5);
    expect(s.transferDroppedTotal).toEqual(3);
  });

  it('乗換つきが勝った経路の違反は、1回乗車の厳密走査の違反と分けて数える', () => {
    // 返す経路は B' なので、B で厳密走査が勝っていても、確定経路が乗換つきなら乗換つきの違反
    const s = summarize([
      rec({ missed: true, m: { exactWon: 1, transferWon: 1 } }),
      rec({ within: false, m: { exactWon: 1 } }),
    ]);
    expect(s.violations).toEqual(2);
    expect(s.transferWonViolations).toEqual(1);
    expect(s.exactWonViolations).toEqual(1);
  });

  it("B' の指標が無い記録（#474 より前の JSONL）は、乗換つきの集計に入れない", () => {
    const s = summarize([rec({ m: { walkB: 50 } })]);
    expect(s.transferCovered).toEqual(0);
    expect(s.transferCandidatesTotal).toEqual(0);
    expect(s.transferGainMedian).toBeNull();
  });

  it('失敗した検索は数えるが、他の集計からは外す', () => {
    const s = summarize([rec({ error: 'boom' }), rec({})]);
    expect(s.total).toEqual(2);
    expect(s.errors).toEqual(1);
    expect(s.covered).toEqual(1);
  });

  it('A の所要は B の選び直しを引き、B の所要は崩壊が解けた検索の board-search を引いて推定する', () => {
    const s = summarize([
      rec({ m: { totalMs: 30000, abMs: 1000, collapse: 1, collapseB: 0, boardSearchMs: 20000 } }),
      rec({ m: { totalMs: 8000, abMs: 0 } }),
      rec({ m: { totalMs: 12000, abMs: 2000, collapse: 1, collapseB: 1, boardSearchMs: 5000 } }),
    ]);
    expect(s.totalMsAMedian).toEqual(10000); // 29000, 8000, 10000
    expect(s.totalMsBEstMedian).toEqual(9000); // 9000, 8000, 10000
    expect(s.collapseResolved).toEqual(1);
  });
});

describe('abReport', () => {
  const v = (verdict: VerifyResult['verdict']): VerifyResult => ({
    pair: 'p', slot: '12:00', ratio: 1.5, line: 'x', from: 'a', to: 'b', dep: 'd', arr: 'e',
    verdict, matchedLine: null, seen: [], error: null,
  });

  it('Markdown に完了条件の3項目と照合の結果を出す', () => {
    const verify: VerifyResult[] = [
      v('sameTrip'),
      v('sameTrip'),
      v('departureOnly'),
      v('missing'),
      v('noBoard'),
      { ...v(null), error: 'HTTP 429' },
    ];
    const md = abReport([rec({ m: { walkB: 50, exactWon: 1 } })], verify);
    expect(md).toContain('徒歩の増分');
    expect(md).toContain('乗り遅れ・予算超過');
    expect(md).toContain('totalMs');
    expect(md).toContain('同じ便: 2 / 6');
    expect(md).toContain('乗車駅の発車だけ一致: 1');
    expect(md).toContain('同じ分の便が無い: 1');
    expect(md).toContain('発車表なし: 1');
    expect(md).toContain('照会失敗: 1');
  });

  it("乗換つきの増分・勝った検索・enrich で落ちた割合を出す", () => {
    const md = abReport([
      rec({
        m: { transferCandidates: 4, transferDropped: 1, walkB: 30, walkBPrime: 42, transferWon: 1 },
        missed: true,
      }),
    ]);
    expect(md).toContain("walkB' − walkB");
    expect(md).toContain('| 全体 | 1 | 1（100%） | 12分 | 12分 | 12分 |');
    expect(md).toContain('乗換つきが勝った検索: 1 件');
    expect(md).toContain('enrich で落ちた乗換つきの候補: 1 / 4（25%）');
    expect(md).toContain('うち乗換つきが勝った経路: 1 件');
  });
});
