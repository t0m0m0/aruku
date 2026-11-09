import { describe, expect, it } from 'vitest';

import { GeoPoint } from '../../src/models/geo-point';
import {
  applyWalkMatrixRows,
  planAccessWalkMatrix,
  walkCacheKey,
  type WalkMatrixRequest,
} from '../../src/services/access-walk-matrix';

const origin = new GeoPoint(35.0, 139.0);
const goal = new GeoPoint(35.0, 139.1);
const stop = (i: number): GeoPoint => new GeoPoint(35.01, 139.001 * (i + 1));
const stops = (n: number, from = 0): GeoPoint[] =>
  Array.from({ length: n }, (_, i) => stop(from + i));

const nothingMeasured = (): boolean => false;

/// 要求群が実際に測る有向レッグのキーを、重複も残して並べる。
const requestedKeys = (requests: readonly WalkMatrixRequest[]): string[] =>
  requests.flatMap((r) =>
    r.origins.flatMap((o) => r.dests.map((d) => walkCacheKey(o, d))),
  );

const elementsOf = (r: WalkMatrixRequest): number =>
  r.origins.length * r.dests.length;

describe('planAccessWalkMatrix: 検索単位の集約 (#485)', () => {
  it('複数の路線が共有する乗車駅・降車駅・全徒歩は1回ずつしか測らない', () => {
    const shared = [stop(0), stop(1)];
    const plan = planAccessWalkMatrix(
      origin,
      goal,
      [
        { boardStops: shared, alightStops: shared },
        { boardStops: [...shared, stop(2)], alightStops: [stop(1), stop(3)] },
      ],
      nothingMeasured,
    );
    const keys = requestedKeys(plan.requests);
    expect(new Set(keys).size).toEqual(keys.length);
    expect(keys).toContain(walkCacheKey(origin, goal));
    expect(keys.filter((k) => k === walkCacheKey(origin, goal))).toHaveLength(1);
    // 乗車側 origin→{0,1,2,goal}・降車側 {0,1,3}→goal。
    expect(plan.uniqueLegs).toEqual(7);
    // 路線ごとに投げていたら測った本数（乗車＋goal＋降車）。
    expect(plan.requestedLegs).toEqual(2 + 1 + 2 + (3 + 1 + 2));
  });

  it('同じ駅でも乗車側（origin→駅）と降車側（駅→goal）は別のレッグとして測る', () => {
    const plan = planAccessWalkMatrix(
      origin,
      goal,
      [
        { boardStops: [stop(0)], alightStops: [] },
        { boardStops: [], alightStops: [stop(0)] },
      ],
      nothingMeasured,
    );
    const keys = requestedKeys(plan.requests);
    expect(keys).toContain(walkCacheKey(origin, stop(0)));
    expect(keys).toContain(walkCacheKey(stop(0), goal));
    expect(keys).not.toContain(walkCacheKey(stop(0), origin));
    expect(keys).not.toContain(walkCacheKey(goal, stop(0)));
  });

  it('既存のキー精度（小数5桁）で同一視し、5桁目が違えば別の駅として測る', () => {
    const a = new GeoPoint(35.012341, 139.012341);
    const sameAtFiveDigits = new GeoPoint(35.012344, 139.012344);
    const differentAtFifth = new GeoPoint(35.01235, 139.01235);
    const plan = planAccessWalkMatrix(
      origin,
      goal,
      [{ boardStops: [a, sameAtFiveDigits, differentAtFifth], alightStops: [] }],
      nothingMeasured,
    );
    // origin→a・origin→differentAtFifth・origin→goal。
    expect(plan.uniqueLegs).toEqual(3);
    expect(requestedKeys(plan.requests)).toHaveLength(3);
  });

  it('成功した実測が既にあるレッグは要求しない', () => {
    const measured = new Set([
      walkCacheKey(origin, goal),
      walkCacheKey(origin, stop(0)),
      walkCacheKey(stop(1), goal),
    ]);
    const plan = planAccessWalkMatrix(
      origin,
      goal,
      [{ boardStops: [stop(0), stop(2)], alightStops: [stop(1), stop(3)] }],
      (k) => measured.has(k),
    );
    expect(requestedKeys(plan.requests).sort()).toEqual(
      [walkCacheKey(origin, stop(2)), walkCacheKey(stop(3), goal)].sort(),
    );
  });

  it('測るものが無ければ要求を作らない', () => {
    const plan = planAccessWalkMatrix(
      origin,
      goal,
      [{ boardStops: [stop(0)], alightStops: [stop(1)] }],
      () => true,
    );
    expect(plan.requests).toEqual([]);
  });

  it('路線が無くても全徒歩（origin→goal）だけは測る', () => {
    const plan = planAccessWalkMatrix(origin, goal, [], nothingMeasured);
    expect(requestedKeys(plan.requests)).toEqual([walkCacheKey(origin, goal)]);
    expect(plan.requestedLegs).toEqual(1);
  });

  it.each([
    { boards: 24, calls: 1 },
    { boards: 25, calls: 2 },
    { boards: 30, calls: 2 },
    { boards: 50, calls: 3 },
  ])(
    '乗車側 $boards 駅＋goal は要素数上限25以下へ分割する（$calls 本）',
    ({ boards, calls }) => {
      const plan = planAccessWalkMatrix(
        origin,
        goal,
        [{ boardStops: stops(boards), alightStops: [] }],
        nothingMeasured,
      );
      expect(plan.requests).toHaveLength(calls);
      for (const r of plan.requests) {
        expect(elementsOf(r)).toBeLessThanOrEqual(25);
        expect(elementsOf(r)).toBeGreaterThan(0);
      }
      expect(new Set(requestedKeys(plan.requests)).size).toEqual(boards + 1);
    },
  );

  it.each([
    { alights: 25, calls: 1 },
    { alights: 26, calls: 2 },
  ])('降車側 $alights 駅は要素数上限25以下へ分割する（$calls 本）', ({ alights, calls }) => {
    const plan = planAccessWalkMatrix(
      origin,
      goal,
      [{ boardStops: [], alightStops: stops(alights) }],
      (k) => k === walkCacheKey(origin, goal),
    );
    expect(plan.requests).toHaveLength(calls);
    for (const r of plan.requests) {
      expect(r.dests).toEqual([goal]);
      expect(elementsOf(r)).toBeLessThanOrEqual(25);
    }
    expect(new Set(requestedKeys(plan.requests)).size).toEqual(alights);
  });

  it('3路線ぶん（片側10駅ずつ）を集約しても上限25を超える要求を作らない', () => {
    const plan = planAccessWalkMatrix(
      origin,
      goal,
      [0, 10, 20].map((from) => ({
        boardStops: stops(10, from),
        alightStops: stops(10, from + 100),
      })),
      nothingMeasured,
    );
    for (const r of plan.requests) {
      expect(elementsOf(r)).toBeLessThanOrEqual(25);
    }
    expect(plan.uniqueLegs).toEqual(30 + 1 + 30);
    expect(new Set(requestedKeys(plan.requests)).size).toEqual(61);
  });
});

describe('applyWalkMatrixRows: 応答から有向レッグを復元する (#485)', () => {
  const request: WalkMatrixRequest = {
    origins: [stop(0), stop(1)],
    dests: [goal],
  };

  it('応答の並び順に依らず originIndex/destinationIndex でレッグへ戻す', () => {
    const measured = new Map<string, number>();
    applyWalkMatrixRows(
      request,
      [
        { originIndex: 1, destinationIndex: 0, duration: '600s' },
        { originIndex: 0, destinationIndex: 0, duration: '120s' },
      ],
      measured,
    );
    expect(measured.get(walkCacheKey(stop(0), goal))).toEqual(2);
    expect(measured.get(walkCacheKey(stop(1), goal))).toEqual(10);
  });

  it('0 の添字が省かれた要素は 0 番として読む（proto3 JSON は既定値を出さない）', () => {
    const measured = new Map<string, number>();
    applyWalkMatrixRows(
      { origins: [origin], dests: [stop(0), goal] },
      [{ destinationIndex: 1, duration: '300s' }, { duration: '60s' }],
      measured,
    );
    expect(measured.get(walkCacheKey(origin, stop(0)))).toEqual(1);
    expect(measured.get(walkCacheKey(origin, goal))).toEqual(5);
  });

  it('失敗した要求（null）は何も書かず、範囲外・時間欠落の要素も捨てる', () => {
    const measured = new Map<string, number>();
    applyWalkMatrixRows(request, null, measured);
    expect(measured.size).toEqual(0);
    applyWalkMatrixRows(
      request,
      [
        { originIndex: 2, destinationIndex: 0, duration: '60s' },
        { originIndex: 0, destinationIndex: 1, duration: '60s' },
        { originIndex: -1, destinationIndex: 0, duration: '60s' },
        { originIndex: 1, destinationIndex: 0 },
        'garbage',
      ],
      measured,
    );
    expect(measured.size).toEqual(0);
  });
});
