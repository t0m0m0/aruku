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
});
