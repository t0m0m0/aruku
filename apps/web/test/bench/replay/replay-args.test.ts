import { describe, expect, it } from 'vitest';

import { benchBudgetRatios, benchSlots } from '../../../src/bench/bench-cases';
import { parseReplayArgs } from '../../../src/bench/replay/replay-args';

const required = ['--store', 'rec.json', '--out', 'out.jsonl', '--date', '2026-11-16'];

describe('parseReplayArgs', () => {
  it('既定は再生モードで、出発時刻と予算の倍率はブラウザのベンチと同じ', () => {
    const args = parseReplayArgs(required);

    expect(args.mode).toBe('replay');
    expect(args.store).toBe('rec.json');
    expect(args.out).toBe('out.jsonl');
    expect(args.slots).toEqual(benchSlots);
    expect(args.ratios).toEqual(benchBudgetRatios);
    expect(args.pairs).toBeNull();
    expect(args.refetchLimitMs).toBeNull();
    expect(args.urlLog).toBeNull();
    expect(args.label).toBe('replay');
  });

  it('出発日は壁時計の日付として固定する——実行日に依らず同じ照会 URL になる', () => {
    const { date } = parseReplayArgs(required);
    expect([date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours()]).toEqual([
      2026, 11, 16, 0,
    ]);
  });

  it('出発時刻・倍率・組・上限・URL ログ・ラベルを受け取る', () => {
    const args = parseReplayArgs([
      ...required,
      '--mode',
      'record',
      '--slots',
      '12:00,23:30',
      '--ratios',
      '0.8,1.2',
      '--pairs',
      '^yokohama-',
      '--refetch-limit-ms',
      '20000',
      '--url-log',
      'urls.jsonl',
      '--label',
      'head',
    ]);

    expect(args.mode).toBe('record');
    expect(args.slots).toEqual([
      { h: 12, m: 0 },
      { h: 23, m: 30 },
    ]);
    expect(args.ratios).toEqual([0.8, 1.2]);
    expect(args.pairs?.test('yokohama-kawasaki')).toBe(true);
    expect(args.pairs?.test('ebina-yokohama')).toBe(false);
    expect(args.refetchLimitMs).toBe(20000);
    expect(args.urlLog).toBe('urls.jsonl');
    expect(args.label).toBe('head');
  });

  it.each([
    ['録画ファイルが無い', ['--out', 'o', '--date', '2026-11-16']],
    ['出力先が無い', ['--store', 's', '--date', '2026-11-16']],
    ['出発日が無い', ['--store', 's', '--out', 'o']],
    ['出発日の形が違う', ['--store', 's', '--out', 'o', '--date', '2026/11/16']],
    ['存在しない日付', ['--store', 's', '--out', 'o', '--date', '2026-02-30']],
    ['モードが違う', [...required, '--mode', 'live']],
    ['出発時刻の形が違う', [...required, '--slots', '25:00']],
    ['倍率が数でない', [...required, '--ratios', '1.2,x']],
    ['上限が正の整数でない', [...required, '--refetch-limit-ms', '-1']],
    ['知らない引数', [...required, '--engine', 'x']],
    ['値の無い引数', [...required, '--label']],
  ])('%s なら投げる', (_, argv) => {
    expect(() => parseReplayArgs(argv)).toThrow();
  });
});
