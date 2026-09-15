// 移植元: lib/shared/extensions/route_map_overlays.dart。
//
// 地図そのものは jsdom で描けないが、経路から何を描くかを決めるのはここの純関数で、
// 描画側は受け取った値を Google Maps へ渡すだけ。取り違えが起きるのはこの層なので、
// 検証もここへ寄せている。

import { describe, expect, it } from 'vitest';

import { GeoPoint } from '@aruku/engine/models/geo-point';
import {
  RoutePlan,
  RouteSegment,
  SegmentType,
} from '@aruku/engine/models/route-plan';

import {
  boundsEqual,
  toBounds,
  toEndpoints,
  toOverlayPaths,
} from '../../src/map/route-overlays';

function seg(
  type: SegmentType,
  polyline: GeoPoint[],
  overrides: Partial<ConstructorParameters<typeof RouteSegment>[0]> = {},
) {
  return new RouteSegment({
    type,
    fromName: '新宿駅',
    toName: '代々木駅',
    minutes: 10,
    polyline,
    ...overrides,
  });
}

function plan(segments: RouteSegment[]) {
  return new RoutePlan({
    from: '新宿駅',
    to: '渋谷駅',
    totalKm: 5.2,
    totalMin: 60,
    budgetMin: 90,
    kcal: 210,
    walkKm: 4.1,
    walkRatio: 0.79,
    segments,
    timelineNodes: [],
  });
}

const p = (lat: number, lng: number) => new GeoPoint(lat, lng);

describe('toOverlayPaths', () => {
  it('区間ごとに1本のパスを出す', () => {
    const route = plan([
      seg(SegmentType.walk, [p(35.6, 139.7), p(35.61, 139.71)]),
      seg(SegmentType.train, [p(35.61, 139.71), p(35.65, 139.75)]),
    ]);

    expect(toOverlayPaths(route)).toHaveLength(2);
  });

  it('polyline が空の区間は描かない', () => {
    const route = plan([
      seg(SegmentType.walk, []),
      seg(SegmentType.train, [p(35.61, 139.71), p(35.65, 139.75)]),
    ]);

    expect(toOverlayPaths(route)).toHaveLength(1);
  });

  it('空の区間を飛ばしても id は区間の位置を指し続ける', () => {
    const route = plan([
      seg(SegmentType.walk, []),
      seg(SegmentType.train, [p(35.61, 139.71), p(35.65, 139.75)]),
    ]);

    expect(toOverlayPaths(route)[0]!.id).toBe('seg-1');
  });

  it('徒歩は moss500 の破線で描く', () => {
    const route = plan([seg(SegmentType.walk, [p(35.6, 139.7), p(35.61, 139.71)])]);

    expect(toOverlayPaths(route)[0]).toMatchObject({
      strokeColor: '#4F9527',
      strokeWeight: 5,
      dash: { length: 20, gap: 12 },
    });
  });

  it('電車は train の実線で描く', () => {
    const route = plan([seg(SegmentType.train, [p(35.6, 139.7), p(35.61, 139.71)])]);

    expect(toOverlayPaths(route)[0]).toMatchObject({
      strokeColor: '#3E6792',
      strokeWeight: 6,
      dash: null,
    });
  });

  // 移植元は `seg.type == SegmentType.walk` の二分岐で、bus は else 側＝電車の見た目へ倒れる。
  it('バスは電車と同じ見た目へ倒す', () => {
    const route = plan([seg(SegmentType.bus, [p(35.6, 139.7), p(35.61, 139.71)])]);

    expect(toOverlayPaths(route)[0]!.strokeColor).toBe('#3E6792');
  });

  it('点を緯度経度のまま渡す', () => {
    const route = plan([seg(SegmentType.walk, [p(35.6, 139.7), p(35.61, 139.71)])]);

    expect(toOverlayPaths(route)[0]!.points).toEqual([
      { lat: 35.6, lng: 139.7 },
      { lat: 35.61, lng: 139.71 },
    ]);
  });
});

describe('toEndpoints', () => {
  it('全区間を通した最初と最後の点を返す', () => {
    const route = plan([
      seg(SegmentType.walk, [p(35.6, 139.7), p(35.61, 139.71)]),
      seg(SegmentType.train, [p(35.61, 139.71), p(35.65, 139.75)]),
    ]);

    expect(toEndpoints(route)).toEqual({
      start: { lat: 35.6, lng: 139.7 },
      end: { lat: 35.65, lng: 139.75 },
    });
  });

  it('先頭区間の polyline が空でも次の区間の点を始点にする', () => {
    const route = plan([
      seg(SegmentType.walk, []),
      seg(SegmentType.train, [p(35.61, 139.71), p(35.65, 139.75)]),
    ]);

    expect(toEndpoints(route)?.start).toEqual({ lat: 35.61, lng: 139.71 });
  });

  it('点が1つも無ければ null', () => {
    expect(toEndpoints(plan([seg(SegmentType.walk, [])]))).toBeNull();
  });
});

describe('toBounds', () => {
  it('全点を含む最小の矩形を返す', () => {
    const route = plan([
      seg(SegmentType.walk, [p(35.65, 139.7), p(35.6, 139.75)]),
      seg(SegmentType.train, [p(35.62, 139.68), p(35.7, 139.72)]),
    ]);

    expect(toBounds(route)).toEqual({
      south: 35.6,
      west: 139.68,
      north: 35.7,
      east: 139.75,
    });
  });

  it('点が1つでも矩形を返す', () => {
    const route = plan([seg(SegmentType.walk, [p(35.6, 139.7)])]);

    expect(toBounds(route)).toEqual({
      south: 35.6,
      west: 139.7,
      north: 35.6,
      east: 139.7,
    });
  });

  it('点が1つも無ければ null', () => {
    expect(toBounds(plan([seg(SegmentType.walk, [])]))).toBeNull();
  });
});

// 移植元の shouldAutoFitBounds は variant と bounds の2引数だが、variant は full しか
// 使われていない（nav/thumb は移植していない）ので、残るのは矩形の同値判定だけ。
describe('boundsEqual', () => {
  const bounds = { south: 35.6, west: 139.68, north: 35.7, east: 139.75 };

  it('同じ値なら等しい', () => {
    expect(boundsEqual(bounds, { ...bounds })).toBe(true);
  });

  it('1辺でも違えば等しくない', () => {
    expect(boundsEqual(bounds, { ...bounds, north: 35.71 })).toBe(false);
  });

  it('どちらも null なら等しい', () => {
    expect(boundsEqual(null, null)).toBe(true);
  });

  it('片方だけ null なら等しくない', () => {
    expect(boundsEqual(bounds, null)).toBe(false);
  });
});
