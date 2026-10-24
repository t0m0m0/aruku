import { describe, expect, it } from 'vitest';

import { GeoPoint } from '@aruku/engine/models/geo-point';
import { RouteSegment, SegmentType } from '@aruku/engine/models/route-plan';
import { RouteSearchMetrics } from '@aruku/engine/services/route-diagnostics';
import { dateTime } from '@aruku/engine/time';

import { parseMetricsLine, summarizePlan } from '../../src/bench/bench-record';
import { planOf } from './fixtures';

describe('parseMetricsLine: 1行ログを集計できる値へ', () => {
  it('整数は数に、それ以外（列・番兵の -）は文字列のまま', () => {
    const m = new RouteSearchMetrics();
    m.walkA = 70;
    m.walkB = 86;
    m.exactCandidates = 2;
    const parsed = parseMetricsLine(m.toLogLine());
    expect(parsed['walkA']).toEqual(70);
    expect(parsed['walkB']).toEqual(86);
    expect(parsed['coveredBase']).toEqual(1);
    expect(parsed['collapseB']).toEqual(-1);
    expect(parsed['boardSearchWalkByRound']).toEqual('-');
  });
});

describe('summarizePlan: 照合と違反の検査に要る経路の要約', () => {
  const departureAt = dateTime(2026, 10, 27, 12, 0);
  const walk = (minutes: number): RouteSegment =>
    new RouteSegment({ type: SegmentType.walk, fromName: 'a', toName: 'b', minutes });
  const ride = new RouteSegment({
    type: SegmentType.train,
    fromName: '大崎',
    toName: '神田',
    minutes: 20,
    line: 'JR山手線',
    depTime: dateTime(2026, 10, 27, 12, 40),
    arrTime: dateTime(2026, 10, 27, 13, 0),
    polyline: [new GeoPoint(35.6197, 139.7283), new GeoPoint(35.6918, 139.7709)],
  });

  it('徒歩・予算内か・乗り遅れか・乗車区間（駅の座標と JST の発着）を出す', () => {
    const s = summarizePlan(planOf([walk(40), ride, walk(30)], 90, 100), departureAt);
    expect(s.walkMinutes).toEqual(70);
    expect(s.withinBudget).toBe(true);
    expect(s.missed).toBe(false);
    expect(s.rides).toEqual([
      {
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
      },
    ]);
  });

  it('駅に着く前に発車する便は missed、締切を越えれば予算外', () => {
    const s = summarizePlan(planOf([walk(45), ride, walk(30)], 105, 100), departureAt);
    expect(s.missed).toBe(true);
    expect(s.withinBudget).toBe(false);
  });
});
