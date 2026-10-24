import { describe, expect, it } from 'vitest';

import { RouteSegment, SegmentType } from '@aruku/engine/models/route-plan';
import { TransitOption } from '@aruku/engine/services/transit-plan-parser';
import { dateTime } from '@aruku/engine/time';

import type { BenchRecord, BenchRide } from '../../src/bench/bench-record';
import {
  matchRide,
  parseWallClock,
  ridesToVerify,
  runVerify,
  type VerifyResult,
} from '../../src/bench/ab-verify';

const ride: BenchRide = {
  type: 'train',
  line: 'JR山手線',
  from: '大崎',
  to: '神田',
  fromLat: 35.6197,
  fromLng: 139.7283,
  toLat: 35.6918,
  toLng: 139.7709,
  dep: '2026-10-27T12:40',
  arr: '2026-10-27T13:00',
};

const option = (dep: [number, number], arr: [number, number], line = '山手線'): TransitOption =>
  new TransitOption({
    from: 'a',
    to: 'b',
    corridors: [],
    segments: [
      new RouteSegment({ type: SegmentType.walk, fromName: 'a', toName: '大崎', minutes: 1 }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: '大崎',
        toName: '神田',
        minutes: 20,
        line,
        depTime: dateTime(2026, 10, 27, ...dep),
        arrTime: dateTime(2026, 10, 27, ...arr),
      }),
    ],
  });

describe('matchRide: 厳密走査の便が Transit API にも在るか', () => {
  it('発車が同じ分で到着が ±2分以内の電車があれば在る', () => {
    const m = matchRide(ride, [option([12, 45], [13, 5]), option([12, 40], [13, 1])]);
    expect(m.found).toBe(true);
    expect(m.matchedLine).toEqual('山手線');
  });

  it('発車がずれていれば在るとしない（近い便を拾って本物と取り違えない）', () => {
    const m = matchRide(ride, [option([12, 41], [13, 1])]);
    expect(m.found).toBe(false);
    expect(m.seen).toEqual(['12:41→13:01 山手線']);
  });

  it('到着が3分以上ずれていれば在るとしない', () => {
    expect(matchRide(ride, [option([12, 40], [13, 3])]).found).toBe(false);
  });
});

describe('ridesToVerify: 照合する経路を選ぶ', () => {
  const rec = (pair: string, exactWon: number, rides: BenchRide[] = [ride]): BenchRecord => ({
    pair,
    date: '2026-10-27',
    slot: '12:00',
    ratio: 1.5,
    standardMin: 40,
    budgetMin: 60,
    metrics: { exactWon },
    plan: { totalMin: 55, budgetMin: 60, walkMinutes: 40, withinBudget: true, missed: false, rides },
    error: null,
  });

  it('厳密走査が勝った1回乗車の経路だけを、上限まで OD が散るように選ぶ', () => {
    const picked = ridesToVerify(
      [rec('p1', 1), rec('p1', 1), rec('p2', 0), rec('p3', 1), rec('p4', 1, [ride, ride])],
      2,
    );
    expect(picked.map((p) => p.record.pair)).toEqual(['p1', 'p3']);
  });
});

describe('parseWallClock', () => {
  it('JSONL の壁時計を naive な Date に戻す', () => {
    expect(parseWallClock('2026-10-27T12:40')).toEqual(dateTime(2026, 10, 27, 12, 40));
  });
});

describe('runVerify', () => {
  const record: BenchRecord = {
    pair: 'p1',
    date: '2026-10-27',
    slot: '12:00',
    ratio: 1.5,
    standardMin: 40,
    budgetMin: 60,
    metrics: { exactWon: 1 },
    plan: { totalMin: 55, budgetMin: 60, walkMinutes: 40, withinBudget: true, missed: false, rides: [ride] },
    error: null,
  };

  it('乗車駅から降車駅を、その便の発車の少し前から引き直す', async () => {
    // ちょうど発車時刻で引くと、座標からホームまでの徒歩ぶん遅れて次の便が返り得る。
    const calls: string[] = [];
    const results: VerifyResult[] = [];
    await runVerify([{ record, ride }], {
      fetchOptions: async (from, to, at) => {
        calls.push(`${from.lat},${from.lng}→${to.lat},${to.lng}@${at.getHours()}:${at.getMinutes()}`);
        return [option([12, 40], [13, 0])];
      },
      write: (r) => results.push(r),
      shouldStop: () => false,
    });
    expect(calls).toEqual(['35.6197,139.7283→35.6918,139.7709@12:35']);
    expect(results[0]).toMatchObject({ pair: 'p1', found: true, error: null });
  });

  it('照会が失敗しても理由を書いて次へ進む', async () => {
    const results: VerifyResult[] = [];
    await runVerify([{ record, ride }, { record, ride }], {
      fetchOptions: async () => {
        throw new Error('HTTP 429');
      },
      write: (r) => results.push(r),
      shouldStop: () => false,
    });
    expect(results).toHaveLength(2);
    expect(results[0].found).toBe(false);
    expect(results[0].error).toContain('HTTP 429');
  });
});
