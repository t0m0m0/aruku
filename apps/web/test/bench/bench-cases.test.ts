import { describe, expect, it } from 'vitest';

import { RouteSegment, SegmentType } from '@aruku/engine/models/route-plan';
import { TransitOption } from '@aruku/engine/services/transit-plan-parser';
import { dateTime } from '@aruku/engine/time';

import {
  budgetFor,
  dayOffsetBetween,
  nextWeekday,
  standardTotalMin,
  timeValuesFor,
} from '../../src/bench/bench-cases';
import { benchPairs } from '../../src/bench/od-pairs';

const departureAt = dateTime(2026, 10, 27, 12, 0);

const walk = (minutes: number): RouteSegment =>
  new RouteSegment({ type: SegmentType.walk, fromName: 'a', toName: 'b', minutes });

const train = (dep: [number, number], arr: [number, number]): RouteSegment =>
  new RouteSegment({
    type: SegmentType.train,
    fromName: 'A駅',
    toName: 'B駅',
    minutes: (arr[0] - dep[0]) * 60 + (arr[1] - dep[1]),
    depTime: dateTime(2026, 10, 27, ...dep),
    arrTime: dateTime(2026, 10, 27, ...arr),
  });

const option = (...segments: RouteSegment[]): TransitOption =>
  new TransitOption({ from: '出発', to: '到着', segments, corridors: [] });

describe('standardTotalMin: ふつうの乗換ルートの所要（予算の基準）', () => {
  it('電車に乗る option のうち到着が最も早いものの所要', () => {
    const slow = option(walk(5), train([12, 10], [12, 50]), walk(5));
    const fast = option(walk(5), train([12, 8], [12, 30]), walk(5));
    expect(standardTotalMin([slow, fast], departureAt)).toEqual(35);
  });

  it('全徒歩の option は基準にしない', () => {
    const allWalk = option(walk(20));
    const ride = option(walk(5), train([12, 10], [12, 40]), walk(5));
    expect(standardTotalMin([allWalk, ride], departureAt)).toEqual(45);
  });

  it('出発時刻から乗れない（乗り遅れる）option は基準にしない', () => {
    const missed = option(walk(10), train([12, 5], [12, 15]), walk(5));
    const ride = option(walk(5), train([12, 10], [12, 40]), walk(5));
    expect(standardTotalMin([missed, ride], departureAt)).toEqual(45);
  });

  it('基準にできる option が無ければ null', () => {
    expect(standardTotalMin([option(walk(20))], departureAt)).toBeNull();
  });
});

describe('budgetFor: ふつうの所要に対する割合の予算', () => {
  it('+20%・+50%・+100% を分へ切り上げる', () => {
    expect(budgetFor(35, 1.2)).toEqual(42);
    expect(budgetFor(41, 1.2)).toEqual(50);
    expect(budgetFor(41, 1.5)).toEqual(62);
    expect(budgetFor(41, 2)).toEqual(82);
  });
});

describe('timeValuesFor: 出発と締切の時刻', () => {
  it('締切は出発＋予算で、日を跨げば dateOffset が進む', () => {
    const { departure, arrival } = timeValuesFor(1, { h: 22, m: 0 }, 150);
    expect([departure.h, departure.m, departure.dateOffset]).toEqual([22, 0, 1]);
    expect([arrival.h, arrival.m, arrival.dateOffset]).toEqual([0, 30, 2]);
  });
});

describe('走らせる日', () => {
  it('既定は翌日以降で最も近い平日', () => {
    expect(nextWeekday(dateTime(2026, 10, 23, 15, 0))).toEqual(dateTime(2026, 10, 26)); // 金→月
    expect(nextWeekday(dateTime(2026, 10, 26, 9, 0))).toEqual(dateTime(2026, 10, 27)); // 月→火
  });

  it('今日からの日数', () => {
    expect(dayOffsetBetween(dateTime(2026, 10, 24, 23, 0), dateTime(2026, 10, 27))).toEqual(3);
  });
});

describe('OD の組', () => {
  it('約20組で、id が重複しない', () => {
    expect(benchPairs.length).toBeGreaterThanOrEqual(18);
    expect(new Set(benchPairs.map((p) => p.id)).size).toEqual(benchPairs.length);
  });

  it('座標はどれも首都圏の範囲にある', () => {
    for (const p of benchPairs) {
      for (const pt of [p.origin, p.destination]) {
        expect(pt.lat, p.id).toBeGreaterThan(35.2);
        expect(pt.lat, p.id).toBeLessThan(36.1);
        expect(pt.lng, p.id).toBeGreaterThan(139.2);
        expect(pt.lng, p.id).toBeLessThan(140.1);
      }
    }
  });
});
