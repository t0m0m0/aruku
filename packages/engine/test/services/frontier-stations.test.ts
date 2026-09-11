// 移植元: test/core/services/frontier_stations_test.dart
//
// #384 が移した6ファイルに frontierStations は含まれず、エンジン本体（#385）を
// 全て緑にしても一度も実行されない。移植したサービステストが呼ぶのは
// selectBestRoute 経由の経路だけで、この関数は transit_route_service からしか
// 呼ばれないうえ、そちらのテストは matrix 実測を fake で固定するため
// 間引きの結果（どの index を残すか）を観測しない。

import { describe, expect, it } from 'vitest';

import { GeoPoint } from '../../src/models/geo-point';
import { frontierStations } from '../../src/services/hybrid-route-selector';

describe('frontierStations', () => {
  // 経度線上に等間隔で並ぶ駅。origin は西端、goal は東端のさらに東。
  // → origin への距離は s0<s1<s2<s3（単調増加）、goal への距離は逆順（単調減少）。
  const origin = new GeoPoint(35.0, 139.0);
  const goal = new GeoPoint(35.0, 139.05);
  const monotonic = [
    new GeoPoint(35.0, 139.01), // s0: origin に最も近い / goal から最も遠い
    new GeoPoint(35.0, 139.02), // s1
    new GeoPoint(35.0, 139.03), // s2
    new GeoPoint(35.0, 139.04), // s3: origin から最も遠い / goal に最も近い
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
    // 徒歩分降順 top-K だと乗車側=[2,3]・降車側=[0,1] に割れて b<a ペアが作れない。
    // 均等間引きは両端を残す → 両側とも [0,3]（b=0<a=3 のペアが作れる）。
    expect(r.boarding).toEqual([0, 3]);
    expect(r.alighting).toEqual([0, 3]);
  });

  it('maxPerSide 超の長大路線でも中間駅を残し b<a の乗降ペアを保つ', () => {
    // origin 西・goal 東、12駅が等間隔。予算大で全12駅が両側 feasible。
    // 片側 top-K（徒歩降順）だと乗車側=東寄り・降車側=西寄りに割れて b<a が作れないが、
    // 均等間引きなら両端＋中間が残り b<a ペアが存在する。
    const stops = Array.from(
      { length: 12 },
      (_, i) => new GeoPoint(35.0, 139.0 + (i + 1) * 0.005),
    );
    const farOrigin = new GeoPoint(35.0, 139.0);
    const farGoal = new GeoPoint(35.0, 139.07);
    const r = frontierStations(stops, farOrigin, farGoal, 1000, {
      maxPerSide: 4,
    });
    expect(r.boarding).toHaveLength(4);
    expect(r.alighting).toHaveLength(4);
    // 両端（最遠アクセス・最遠エグレスの候補）を取りこぼさない。
    expect(r.boarding[0]).toBe(0);
    expect(r.boarding[r.boarding.length - 1]).toBe(11);
    // 中間駅が残るため b<a の乗降ペアが少なくとも1組存在する。
    const hasPair = r.boarding.some((b) => r.alighting.some((a) => b < a));
    expect(hasPair).toBe(true);
  });

  it('直線徒歩が予算を超える駅は feasible から外す（左右非対称）', () => {
    // s0 は origin の至近・goal の最遠、s2 は goal の至近・origin の最遠。
    const origin2 = new GeoPoint(35.0, 139.0);
    const goal2 = new GeoPoint(35.0, 139.3);
    const stops = [
      new GeoPoint(35.0, 139.002), // s0: origin 至近, goal 最遠
      new GeoPoint(35.0, 139.15), // s1: 両側とも遠い
      new GeoPoint(35.0, 139.298), // s2: origin 最遠, goal 至近
      new GeoPoint(35.1, 139.15), // s3: 両側とも遠い
    ];
    const r = frontierStations(stops, origin2, goal2, 30);
    // origin から徒歩予算内なのは s0 だけ、goal へ徒歩予算内なのは s2 だけ。
    expect(r.boarding).toEqual([0]);
    expect(r.alighting).toEqual([2]);
  });

  it('空の駅配列なら両側とも空', () => {
    const r = frontierStations([], origin, goal, 100);
    expect(r.boarding).toHaveLength(0);
    expect(r.alighting).toHaveLength(0);
  });
});
