// 移植元: flutter-final:lib/core/navigation/leg_handoff.dart（buildLegHandoffUri）。
//
// 移植元は「いま案内中の区間」だけを開くので origin を省き、Google マップに端末の現在地を
// 使わせていた。Web は行程を追跡せず、どの区間のリンクも同時に並ぶ——先の区間を家から
// 開いても、その区間の始点から引かれていなければならない。

import { describe, expect, it } from 'vitest';

import { GeoPoint } from '@aruku/engine/models/geo-point';
import { RoutePlan, RouteSegment, SegmentType } from '@aruku/engine/models/route-plan';

import { buildLegMapsUrl } from '../../../src/features/result/leg-maps-url';
import { ja } from '../../../src/i18n/ja';

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

function plan(segments: RouteSegment[], from: string = ja.searchCurrentLocationName): RoutePlan {
  return new RoutePlan({
    from,
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

describe('出発地', () => {
  it('2つ目以降の区間は前の区間の終点の座標から引く', () => {
    expect(params(buildLegMapsUrl(plan([walk(), ride()]), 1)).get('origin')).toBe(
      '35.683,139.702',
    );
  });

  it('区間自身の polyline の先頭は使わない——畳まれた徒歩では途中の地点を指し得る', () => {
    const merged = walk({
      fromName: '渋谷駅',
      toName: '渋谷ヒカリエ',
      polyline: [new GeoPoint(35.6585, 139.702), new GeoPoint(35.659, 139.703)],
    });
    const query = params(buildLegMapsUrl(plan([walk(), ride({ polyline: [] }), merged]), 2));
    expect(query.get('origin')).toBe('渋谷駅');
  });

  it('前の区間に座標が無ければ区間の出発名、それも空なら前の区間の行き先名', () => {
    const route = plan([walk({ polyline: [] }), ride({ polyline: [] })]);
    expect(params(buildLegMapsUrl(route, 1)).get('origin')).toBe('代々木駅');
    const noFromName = plan([walk({ polyline: [] }), ride({ polyline: [], fromName: '' })]);
    expect(params(buildLegMapsUrl(noFromName, 1)).get('origin')).toBe('代々木駅');
  });

  it('現在地から出る最初の区間は出発地を付けず、端末の現在地に任せる', () => {
    expect(params(buildLegMapsUrl(plan([walk()]), 0)).has('origin')).toBe(false);
  });

  it('選んだ地点から出る最初の区間は、座標が無くてもその地点名から引く', () => {
    const route = plan([walk({ polyline: [], fromName: '新宿御苑' })], '新宿御苑');
    expect(params(buildLegMapsUrl(route, 0)).get('origin')).toBe('新宿御苑');
  });

  it('選んだ地点から出る最初の区間は、polyline の先頭ではなく地点名を使う', () => {
    expect(params(buildLegMapsUrl(plan([walk()], '新宿御苑'), 0)).get('origin')).toBe('新宿御苑');
  });
});

describe('目的地', () => {
  it('区間の polyline の末尾の座標', () => {
    expect(params(buildLegMapsUrl(plan([walk(), ride()]), 1)).get('destination')).toBe(
      '35.658,139.701',
    );
  });

  it('自区間に座標が無ければ、次の区間の polyline の先頭ではなく区間の行き先名', () => {
    const query = params(buildLegMapsUrl(plan([walk(), ride({ polyline: [] }), walk({
      fromName: '渋谷駅',
      toName: '渋谷ヒカリエ',
      polyline: [new GeoPoint(35.6585, 139.702), new GeoPoint(35.659, 139.703)],
    })]), 1));
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
