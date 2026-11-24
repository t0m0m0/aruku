import { describe, expect, it } from 'vitest';

import type { BenchRide } from '../../../src/bench/bench-record';
import {
  compareRuns,
  replayReport,
  type ReplayRecord,
} from '../../../src/bench/replay/replay-report';

const ride = (line: string): BenchRide => ({
  type: 'train',
  line,
  from: 'A',
  to: 'B',
  fromLat: 35,
  fromLng: 139,
  toLat: 35.1,
  toLng: 139.1,
  dep: '2026-11-16T12:05',
  arr: '2026-11-16T12:20',
});

const record = (
  pair: string,
  ratio: number,
  totalMs: number,
  opts: {
    walk?: number;
    line?: string;
    guidance?: number;
    error?: string;
    byPurpose?: Record<string, number>;
  } = {},
): ReplayRecord => ({
  label: 'x',
  pair,
  date: '2026-11-16',
  slot: '12:00',
  ratio,
  standardMin: 30,
  budgetMin: 36,
  metrics:
    opts.error !== undefined
      ? null
      : { totalMs, guidanceCalls: opts.guidance ?? 10, ...opts.byPurpose },
  plan:
    opts.error !== undefined
      ? null
      : {
          totalMin: 30,
          budgetMin: 36,
          walkMinutes: opts.walk ?? 10,
          withinBudget: true,
          missed: false,
          rides: [ride(opts.line ?? '東海道線')],
        },
  error: opts.error ?? null,
  refetchLimitHits: 0,
  misses: 0,
});

describe('compareRuns', () => {
  it('組・出発時刻・倍率で突き合わせ、両方にある検索だけを比べる', () => {
    const a = [record('p', 1.2, 10_000), record('q', 1.2, 20_000)];
    const b = [record('p', 1.2, 8_000)];

    const rows = compareRuns(a, b);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pair: 'p', ratio: 1.2, totalMsA: 10_000, totalMsB: 8_000 });
  });

  it('徒歩分と乗車区間が同じなら同じ経路とみなす', () => {
    const rows = compareRuns(
      [record('p', 1.2, 1), record('q', 1.2, 1), record('r', 1.2, 1)],
      [
        record('p', 1.2, 2),
        record('q', 1.2, 2, { walk: 12 }),
        record('r', 1.2, 2, { line: '京急本線' }),
      ],
    );

    expect(rows.map((r) => r.sameRoute)).toEqual([true, false, false]);
  });

  it('どちらかがエラーなら経路は同じとみなさない', () => {
    const rows = compareRuns([record('p', 1.2, 1)], [record('p', 1.2, 1, { error: 'boom' })]);
    expect(rows[0].sameRoute).toBe(false);
    expect(rows[0].totalMsB).toBeNull();
  });
});

describe('replayReport', () => {
  it('検索ごとの表と、所要の中央値・平均・p90・照会本数の合計・経路の一致数を出す', () => {
    const a = [
      record('p', 1.2, 10_000, { guidance: 10 }),
      record('q', 1.2, 30_000, { guidance: 20 }),
    ];
    const b = [
      record('p', 1.2, 8_000, { guidance: 9 }),
      record('q', 1.2, 30_000, { walk: 5, guidance: 20 }),
    ];

    const md = replayReport(a, b, { a: 'main', b: '#503' });

    expect(md).toContain('| 組 | 出発 | 倍率 | main | #503 | 差 | guidance main→#503 | 経路 |');
    expect(md).toContain('| p | 12:00 | 1.2 | 10.0s | 8.0s | -2.0s | 10→9 | 同じ |');
    expect(md).toContain('| q | 12:00 | 1.2 | 30.0s | 30.0s | +0.0s | 20→20 | 違う |');
    expect(md).toContain('| 中央値 | 20.0s | 19.0s |');
    expect(md).toContain('| 平均 | 20.0s | 19.0s |');
    expect(md).toContain('| p90 | 28.0s | 27.8s |');
    expect(md).toContain('| guidance 合計 | 30 | 29 |');
    expect(md).toContain('経路が同じ: 1 / 2');
  });

  it('guidance の本数を用途別に合計して版ごとに並べる (#546)', () => {
    const purposes = (boarding: number, boardSearch: number) => ({
      guidanceInitial: 1,
      guidanceArrival: 1,
      guidanceBoarding: boarding,
      guidanceNames: 1,
      guidanceBoardSearch: boardSearch,
      guidanceBus: 0,
    });
    const md = replayReport(
      [
        record('p', 1.2, 1, { guidance: 6, byPurpose: purposes(3, 0) }),
        record('q', 1.2, 1, { guidance: 9, byPurpose: purposes(2, 4) }),
      ],
      [
        record('p', 1.2, 1, { guidance: 3, byPurpose: purposes(0, 0) }),
        record('q', 1.2, 1, { guidance: 7, byPurpose: purposes(0, 4) }),
      ],
      { a: 'main', b: 'head' },
    );

    expect(md).toContain('| guidance の用途 | main | head |');
    expect(md).toContain('| 初回照会 | 2 | 2 |');
    expect(md).toContain('| 到着時刻照会 | 2 | 2 |');
    expect(md).toContain('| 乗車時刻の確定 | 5 | 0 |');
    expect(md).toContain('| 駅名の補完 | 2 | 2 |');
    expect(md).toContain('| board-search | 4 | 4 |');
    expect(md).toContain('| バスの最終手段 | 0 | 0 |');
  });

  it('用途別の本数を持たない記録が 1 件でもあれば、その版の欄を — にする (#546)', () => {
    const counted = {
      guidance: 2,
      byPurpose: {
        guidanceInitial: 1,
        guidanceArrival: 1,
        guidanceBoarding: 0,
        guidanceNames: 0,
        guidanceBoardSearch: 0,
        guidanceBus: 0,
      },
    };
    const md = replayReport(
      [record('p', 1.2, 1), record('q', 1.2, 1, counted)],
      [record('p', 1.2, 1, counted), record('q', 1.2, 1, counted)],
      { a: 'old', b: 'new' },
    );

    expect(md).toContain('| 初回照会 | — | 2 |');
  });

  it('エラーで計測値を持たない検索は、用途別の合計から外す (#546)', () => {
    const counted = {
      guidance: 2,
      byPurpose: {
        guidanceInitial: 1,
        guidanceArrival: 1,
        guidanceBoarding: 0,
        guidanceNames: 0,
        guidanceBoardSearch: 0,
        guidanceBus: 0,
      },
    };
    const md = replayReport(
      [record('p', 1.2, 1, counted), record('q', 1.2, 1, { error: 'TIMEOUT' })],
      [record('p', 1.2, 1, counted), record('q', 1.2, 1, { error: 'TIMEOUT' })],
      { a: 'none', b: 'm3d' },
    );

    expect(md).toContain('| 初回照会 | 1 | 1 |');
  });

  it('全部の検索がエラーの版は、用途別の欄を 0 ではなく — にする (#546)', () => {
    const md = replayReport(
      [record('p', 1.2, 1, { error: 'TIMEOUT' })],
      [record('p', 1.2, 1, { error: 'TIMEOUT' })],
      { a: 'none', b: 'm3d' },
    );

    expect(md).toContain('| 初回照会 | — | — |');
  });

  it('経路が違う検索は、両方の徒歩分と乗車区間を書き出す', () => {
    const md = replayReport(
      [record('q', 2, 1, { walk: 26 })],
      [record('q', 2, 1, { walk: 24, line: '京急本線' })],
      { a: 'main', b: 'head' },
    );

    expect(md).toContain('- q 12:00 ×2: main 徒歩26分 東海道線 A>B → head 徒歩24分 京急本線 A>B');
  });
});
