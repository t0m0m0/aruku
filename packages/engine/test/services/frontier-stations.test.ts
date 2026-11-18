import { describe, expect, it } from 'vitest';

import { GeoPoint } from '../../src/models/geo-point';
import { frontierStations } from '../../src/services/hybrid-route-selector';

describe('frontierStations', () => {
  const origin = new GeoPoint(35.0, 139.0);
  const goal = new GeoPoint(35.0, 139.05);
  const monotonic = [
    new GeoPoint(35.0, 139.01),
    new GeoPoint(35.0, 139.02),
    new GeoPoint(35.0, 139.03),
    new GeoPoint(35.0, 139.04),
  ];

  it('予算が十分大きければ全駅を両側の候補にする', () => {
    const r = frontierStations(monotonic, origin, goal, 1000);
    expect(r.boarding).toEqual([0, 1, 2, 3]);
    expect(r.alighting).toEqual([0, 1, 2, 3]);
  });

  it('maxPerSide 超は均等間引きで両端を残す', () => {
    const r = frontierStations(monotonic, origin, goal, 1000, {
      maxPerSide: 2,
    });
    expect(r.boarding).toEqual([0, 3]);
    expect(r.alighting).toEqual([0, 3]);
  });

  it('maxPerSide 超の長大路線でも中間駅を残し b<a の乗降ペアを保つ', () => {
    const stops = Array.from({ length: 12 }, (_, i) => new GeoPoint(35.0, 139.0 + (i + 1) * 0.005));
    const farOrigin = new GeoPoint(35.0, 139.0);
    const farGoal = new GeoPoint(35.0, 139.07);
    const r = frontierStations(stops, farOrigin, farGoal, 1000, {
      maxPerSide: 4,
    });
    expect(r.boarding).toHaveLength(4);
    expect(r.alighting).toHaveLength(4);
    expect(r.boarding[0]).toBe(0);
    expect(r.boarding[r.boarding.length - 1]).toBe(11);
    const hasPair = r.boarding.some((b) => r.alighting.some((a) => b < a));
    expect(hasPair).toBe(true);
  });

  it('直線徒歩が予算を超える駅は feasible から外す（左右非対称）', () => {
    const origin2 = new GeoPoint(35.0, 139.0);
    const goal2 = new GeoPoint(35.0, 139.3);
    const stops = [
      new GeoPoint(35.0, 139.002),
      new GeoPoint(35.0, 139.15),
      new GeoPoint(35.0, 139.298),
      new GeoPoint(35.1, 139.15),
    ];
    const r = frontierStations(stops, origin2, goal2, 30);
    expect(r.boarding).toEqual([0]);
    expect(r.alighting).toEqual([2]);
  });

  it('空の駅配列なら両側とも空', () => {
    const r = frontierStations([], origin, goal, 100);
    expect(r.boarding).toHaveLength(0);
    expect(r.alighting).toHaveLength(0);
  });
});
