// 移植元: flutter-final:lib/core/navigation/leg_handoff.dart（buildLegHandoffUri）。
//
// 移植元は「いま案内中の区間」だけを開くので origin を省き、Google マップに端末の現在地を
// 使わせていた。Web は行程を追跡せず、どの区間のリンクも同時に並ぶ——先の区間を家から
// 開いても、その区間の始点から引かれていなければならない。

import { describe, expect, it } from 'vitest';

import { GeoPoint } from '@aruku/engine/models/geo-point';
import { RoutePlan, RouteSegment, SegmentType } from '@aruku/engine/models/route-plan';

import { buildLegMapsUrl } from '../../../src/features/result/leg-maps-url';

type SegmentInit = ConstructorParameters<typeof RouteSegment>[0];

function walk(overrides: Partial<SegmentInit> = {}) {
  return new RouteSegment({
    type: SegmentType.walk,
    fromName: '新宿駅',
    toName: '代々木駅',
    minutes: 12,
    polyline: [new GeoPoint(35.69, 139.7), new GeoPoint(35.683, 139.702)],
    ...overrides,
  });
}

function ride(overrides: Partial<SegmentInit> = {}) {
  return new RouteSegment({
    type: SegmentType.train,
    fromName: '代々木駅',
    toName: '渋谷駅',
    minutes: 8,
    line: '山手線',
    polyline: [new GeoPoint(35.683, 139.702), new GeoPoint(35.658, 139.701)],
    ...overrides,
  });
}

function plan(segments: RouteSegment[]): RoutePlan {
  return new RoutePlan({
    from: '現在地',
    to: '渋谷ヒカリエ',
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

function params(url: string | null): URLSearchParams {
  expect(url).not.toBeNull();
  const parsed = new URL(url!);
  expect(`${parsed.origin}${parsed.pathname}`).toBe('https://www.google.com/maps/dir/');
  return parsed.searchParams;
}

describe('移動手段', () => {
  it('徒歩区間は徒歩ルートで開く', () => {
    expect(params(buildLegMapsUrl(plan([walk(), ride()]), 0)).get('travelmode')).toBe('walking');
  });

  it('電車区間は乗換案内で開く', () => {
    expect(params(buildLegMapsUrl(plan([walk(), ride()]), 1)).get('travelmode')).toBe('transit');
  });

  it('バス区間も乗換案内で開く', () => {
    const bus = ride({ type: SegmentType.bus, line: '都営バス' });
    expect(params(buildLegMapsUrl(plan([walk(), bus]), 1)).get('travelmode')).toBe('transit');
  });

  it('Maps URLs の api=1 を付ける', () => {
    expect(params(buildLegMapsUrl(plan([walk()]), 0)).get('api')).toBe('1');
  });
});

describe('出発地と目的地は区間の両端の座標', () => {
  it('区間の polyline の先頭と末尾を渡す', () => {
    const query = params(buildLegMapsUrl(plan([walk(), ride()]), 1));
    expect(query.get('origin')).toBe('35.683,139.702');
    expect(query.get('destination')).toBe('35.658,139.701');
  });

  it('先の区間でも端末の現在地ではなくその区間の始点から引く', () => {
    expect(params(buildLegMapsUrl(plan([walk(), ride(), walk()]), 2)).get('origin')).not.toBeNull();
  });

  it('自区間に座標が無ければ隣の区間の継ぎ目の座標を使う', () => {
    const query = params(buildLegMapsUrl(plan([walk(), ride({ polyline: [] }), walk({
      fromName: '渋谷駅',
      toName: '渋谷ヒカリエ',
      polyline: [new GeoPoint(35.658, 139.701), new GeoPoint(35.659, 139.703)],
    })]), 1));
    expect(query.get('origin')).toBe('35.683,139.702');
    expect(query.get('destination')).toBe('35.658,139.701');
  });
});

describe('座標が取れない区間は名前で引き継ぐ', () => {
  it('両隣にも座標が無ければ区間の駅名を使う', () => {
    const query = params(
      buildLegMapsUrl(plan([walk({ polyline: [] }), ride({ polyline: [] })]), 1),
    );
    expect(query.get('origin')).toBe('代々木駅');
    expect(query.get('destination')).toBe('渋谷駅');
  });

  it('行き先名が空の最終区間は経路の目的地名を使う', () => {
    const query = params(buildLegMapsUrl(plan([walk({ polyline: [], toName: '' })]), 0));
    expect(query.get('destination')).toBe('渋谷ヒカリエ');
  });

  it('行き先名が空の途中区間は次の区間の出発名を使う', () => {
    const query = params(
      buildLegMapsUrl(plan([walk({ polyline: [], toName: '' }), ride({ polyline: [] })]), 0),
    );
    expect(query.get('destination')).toBe('代々木駅');
  });

  it('出発名が空の途中区間は前の区間の行き先名を使う', () => {
    const query = params(
      buildLegMapsUrl(plan([walk({ polyline: [] }), ride({ polyline: [], fromName: '' })]), 1),
    );
    expect(query.get('origin')).toBe('代々木駅');
  });

  it('最初の区間は座標が無ければ出発地を付けず、端末の現在地に任せる', () => {
    const query = params(buildLegMapsUrl(plan([walk({ polyline: [], fromName: '現在地' })]), 0));
    expect(query.has('origin')).toBe(false);
  });
});

describe('引き継げない区間', () => {
  it('行き先がどこからも決まらなければ null', () => {
    const route = plan([walk({ polyline: [], toName: '' })]);
    const noDestination = new RoutePlan({ ...route, to: '' });
    expect(buildLegMapsUrl(noDestination, 0)).toBeNull();
  });

  it('範囲外の区間は null', () => {
    expect(buildLegMapsUrl(plan([walk()]), 1)).toBeNull();
  });
});
