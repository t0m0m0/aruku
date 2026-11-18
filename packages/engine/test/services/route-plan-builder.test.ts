import { describe, expect, it } from 'vitest';

import { GeoPoint } from '../../src/models/geo-point';
import { RouteSegment, SegmentType, type RoutePlan } from '../../src/models/route-plan';
import { TimeValue } from '../../src/models/time-value';
import {
  budgetMinutes,
  buildRoutePlan,
  firstMissedTransit,
  hasUnverifiedTransit,
  maxBoardingWait,
} from '../../src/services/route-plan-builder';
import { dateTime } from '../../src/time';
import { first, last, single } from '../support/iterable';

describe('buildRoutePlan timeline', () => {
  it('乗車駅ノードは徒歩到着ではなく電車の発車時刻を表示する', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '出発地',
        toName: 'A駅',
        minutes: 5,
        km: 0.4,
        kcal: 23,
      }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'A駅',
        toName: 'B駅',
        minutes: 18,
        km: 6,
        line: '○○線',
        depTime: dateTime(2026, 5, 22, 9, 12),
        arrTime: dateTime(2026, 5, 22, 9, 30),
      }),
    ];

    const plan = buildRoutePlan({
      from: '出発地',
      to: 'B駅',
      segments,
      departure: new TimeValue({ h: 9, m: 0 }),
      budgetMin: 60,
      departureAt: dateTime(2026, 5, 22, 9, 0),
    });

    expect(plan.timelineNodes.map((n) => n.time)).toEqual(['9:00', '9:12', '9:30']);
    expect(plan.timelineNodes[1].sub).toEqual('○○線');
    expect(last(plan.timelineNodes).sub).toEqual('到着 · 制限内 ✓');
    expect(plan.totalMin).toEqual(30);
  });

  it('直結乗換は乗換駅を「着」「発」の2行に分ける', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '出発地',
        toName: 'S1',
        minutes: 5,
      }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'S1',
        toName: 'S2',
        minutes: 15,
        line: '1号線',
        depTime: dateTime(2026, 5, 22, 9, 10),
        arrTime: dateTime(2026, 5, 22, 9, 25),
      }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'S2',
        toName: 'S3',
        minutes: 20,
        line: '2号線',
        depTime: dateTime(2026, 5, 22, 9, 40),
        arrTime: dateTime(2026, 5, 22, 10, 0),
      }),
    ];

    const plan = buildRoutePlan({
      from: '出発地',
      to: 'S3',
      segments,
      departure: new TimeValue({ h: 9, m: 0 }),
      budgetMin: 90,
      departureAt: dateTime(2026, 5, 22, 9, 0),
    });

    expect(plan.timelineNodes.map((n) => n.time)).toEqual([
      '9:00',
      '9:10',
      '9:25',
      '9:40',
      '10:00',
    ]);
    expect(plan.totalMin).toEqual(60);
    expect(plan.timelineNodes[1].sub).toEqual('1号線');
    expect(plan.timelineNodes[2].place).toEqual('S2');
    expect(plan.timelineNodes[2].sub).toEqual('');
    expect(plan.timelineNodes[2].cardBelow).toBe(false);
    expect(plan.timelineNodes[3].place).toEqual('S2');
    expect(plan.timelineNodes[3].sub).toEqual('2号線');
  });

  it('0km・0分の徒歩レッグは除外し直結乗換にする（#225 保険）', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'S1',
        toName: 'S2',
        minutes: 15,
        line: '1号線',
        depTime: dateTime(2026, 5, 22, 9, 10),
        arrTime: dateTime(2026, 5, 22, 9, 25),
      }),
      new RouteSegment({
        type: SegmentType.walk,
        fromName: 'S2',
        toName: 'S2',
        minutes: 0,
        km: 0,
        kcal: 0,
      }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'S2',
        toName: 'S3',
        minutes: 20,
        line: '2号線',
        depTime: dateTime(2026, 5, 22, 9, 40),
        arrTime: dateTime(2026, 5, 22, 10, 0),
      }),
    ];

    const plan = buildRoutePlan({
      from: 'S1',
      to: 'S3',
      segments,
      departure: new TimeValue({ h: 9, m: 10 }),
      budgetMin: 90,
      departureAt: dateTime(2026, 5, 22, 9, 10),
    });

    expect(plan.segments.map((s) => s.type)).toEqual([SegmentType.train, SegmentType.train]);
    expect(plan.timelineNodes[1].place).toEqual('S2');
    expect(plan.timelineNodes[1].cardBelow).toBe(false);
    expect(plan.timelineNodes[2].place).toEqual('S2');
    expect(plan.timelineNodes[2].sub).toEqual('2号線');
  });

  it('乗車駅ノードの駅名は手前の徒歩の到着名でなく電車の乗車駅名を出す', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '現在地',
        toName: '',
        minutes: 50,
        km: 3.6,
        kcal: 202,
      }),
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '',
        toName: '沼部',
        minutes: 0,
        km: 0,
        kcal: 0,
      }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: '沼部',
        toName: '多摩川',
        minutes: 3,
        line: '東急多摩川線',
      }),
    ];

    const plan = buildRoutePlan({
      from: '現在地',
      to: '多摩川',
      segments,
      departure: new TimeValue({ h: 11, m: 21 }),
      budgetMin: 90,
    });

    expect(plan.timelineNodes[1].place).toEqual('沼部');
    expect(plan.timelineNodes[1].sub).toEqual('東急多摩川線');
  });

  it('全区間が0値徒歩の退化入力でも出発・到着ノードは残す（#225）', () => {
    const plan = buildRoutePlan({
      from: 'A',
      to: 'A',
      segments: [
        new RouteSegment({
          type: SegmentType.walk,
          fromName: 'A',
          toName: 'A',
          minutes: 0,
          km: 0,
          kcal: 0,
        }),
      ],
      departure: new TimeValue({ h: 9, m: 0 }),
      budgetMin: 30,
    });

    expect(plan.segments).toHaveLength(0);
    expect(plan.timelineNodes.map((n) => n.place)).toEqual(['A', 'A']);
    expect(first(plan.timelineNodes).sub).toEqual('出発');
    expect(last(plan.timelineNodes).sub).toEqual('到着 · 制限内 ✓');
    expect(plan.totalMin).toEqual(0);
  });

  it('待ち時間が無い電車ノードは路線名のみ表示する', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '出発地',
        toName: 'A駅',
        minutes: 5,
      }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'A駅',
        toName: 'B駅',
        minutes: 15,
        line: '○○線',
        depTime: dateTime(2026, 5, 22, 9, 5),
        arrTime: dateTime(2026, 5, 22, 9, 20),
      }),
      new RouteSegment({
        type: SegmentType.walk,
        fromName: 'B駅',
        toName: '目的地',
        minutes: 3,
      }),
    ];

    const plan = buildRoutePlan({
      from: '出発地',
      to: '目的地',
      segments,
      departure: new TimeValue({ h: 9, m: 0 }),
      budgetMin: 60,
      departureAt: dateTime(2026, 5, 22, 9, 0),
    });

    expect(plan.timelineNodes[1].sub).toEqual('○○線');
    expect(plan.timelineNodes[2].place).toEqual('B駅');
    expect(plan.timelineNodes[2].sub).toEqual('徒歩へ');
  });

  it('着時刻が欠落(arr=null)でも発車時刻で待ちを算出する', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '出発地',
        toName: 'A駅',
        minutes: 5,
      }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'A駅',
        toName: 'B駅',
        minutes: 18,
        line: '○○線',
        depTime: dateTime(2026, 5, 22, 9, 12),
      }),
      new RouteSegment({
        type: SegmentType.walk,
        fromName: 'B駅',
        toName: '目的地',
        minutes: 3,
      }),
    ];

    const plan = buildRoutePlan({
      from: '出発地',
      to: '目的地',
      segments,
      departure: new TimeValue({ h: 9, m: 0 }),
      budgetMin: 60,
      departureAt: dateTime(2026, 5, 22, 9, 0),
    });

    expect(plan.timelineNodes[1].time).toEqual('9:12');
    expect(plan.timelineNodes[1].sub).toEqual('○○線');
    expect(plan.timelineNodes[2].time).toEqual('9:30');
    expect(plan.timelineNodes[2].sub).toEqual('徒歩へ');
    expect(plan.totalMin).toEqual(33);
  });

  it('発着時刻が無い電車区間は累積所要分にフォールバックする', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '出発地',
        toName: 'A駅',
        minutes: 5,
      }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'A駅',
        toName: 'B駅',
        minutes: 18,
        line: '○○線',
      }),
    ];

    const plan = buildRoutePlan({
      from: '出発地',
      to: 'B駅',
      segments,
      departure: new TimeValue({ h: 9, m: 0 }),
      budgetMin: 60,
      departureAt: dateTime(2026, 5, 22, 9, 0),
    });

    expect(plan.timelineNodes.map((n) => n.time)).toEqual(['9:00', '9:05', '9:23']);
    expect(plan.totalMin).toEqual(23);
  });

  it('departureAt が無ければ絶対時刻を無視して累積所要分で算出する', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'A駅',
        toName: 'B駅',
        minutes: 18,
        line: '○○線',
        depTime: dateTime(2026, 5, 22, 9, 12),
        arrTime: dateTime(2026, 5, 22, 9, 30),
      }),
    ];

    const plan = buildRoutePlan({
      from: 'A駅',
      to: 'B駅',
      segments,
      departure: new TimeValue({ h: 9, m: 0 }),
      budgetMin: 60,
    });

    expect(last(plan.timelineNodes).time).toEqual('9:18');
    expect(plan.totalMin).toEqual(18);
  });

  it('予定列車の発車後に駅着（乗り遅れ）なら待ち無しで乗車時間を足す', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '出発地',
        toName: 'A駅',
        minutes: 20,
      }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'A駅',
        toName: 'B駅',
        minutes: 18,
        line: '○○線',
        depTime: dateTime(2026, 5, 22, 9, 12),
        arrTime: dateTime(2026, 5, 22, 9, 30),
      }),
      new RouteSegment({
        type: SegmentType.walk,
        fromName: 'B駅',
        toName: '目的地',
        minutes: 3,
      }),
    ];

    const plan = buildRoutePlan({
      from: '出発地',
      to: '目的地',
      segments,
      departure: new TimeValue({ h: 9, m: 0 }),
      budgetMin: 60,
      departureAt: dateTime(2026, 5, 22, 9, 0),
    });

    expect(plan.timelineNodes.map((n) => n.time)).toEqual(['9:00', '9:20', '9:38', '9:41']);
    expect(plan.totalMin).toEqual(41);
    expect(plan.timelineNodes[1].sub).toEqual('○○線');
  });

  it('時刻表区間が前段の概算（フォールバック）に続いても発車時刻で待ちを算出する', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'A駅',
        toName: 'B駅',
        minutes: 20,
        line: '1号線',
      }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'B駅',
        toName: 'C駅',
        minutes: 25,
        line: '2号線',
        depTime: dateTime(2026, 5, 22, 9, 35),
        arrTime: dateTime(2026, 5, 22, 10, 0),
      }),
      new RouteSegment({
        type: SegmentType.walk,
        fromName: 'C駅',
        toName: '目的地',
        minutes: 2,
      }),
    ];

    const plan = buildRoutePlan({
      from: 'A駅',
      to: '目的地',
      segments,
      departure: new TimeValue({ h: 9, m: 0 }),
      budgetMin: 90,
      departureAt: dateTime(2026, 5, 22, 9, 0),
    });

    expect(plan.timelineNodes.map((n) => n.time)).toEqual([
      '9:00',
      '9:20',
      '9:35',
      '10:00',
      '10:02',
    ]);
    expect(plan.totalMin).toEqual(62);
    expect(plan.timelineNodes[1].sub).toEqual('');
    expect(plan.timelineNodes[1].cardBelow).toBe(false);
    expect(plan.timelineNodes[2].sub).toEqual('2号線');
  });
});

describe('buildRoutePlan 連続徒歩の統合', () => {
  const consecutiveWalks = (): RouteSegment[] => [
    new RouteSegment({
      type: SegmentType.walk,
      fromName: '現在地',
      toName: '',
      minutes: 40,
      km: 2.9,
      kcal: 163,
    }),
    new RouteSegment({
      type: SegmentType.walk,
      fromName: '',
      toName: '久が原',
      minutes: 12,
      km: 0.8,
      kcal: 46,
    }),
    new RouteSegment({
      type: SegmentType.walk,
      fromName: '久が原',
      toName: '久が原',
      minutes: 3,
      km: 0.2,
      kcal: 14,
    }),
  ];

  const ikegamiLine = (): RouteSegment =>
    new RouteSegment({
      type: SegmentType.train,
      fromName: '久が原',
      toName: '池上',
      minutes: 10,
      km: 2.0,
      line: '東急池上線',
      depTime: dateTime(2026, 7, 24, 15, 51),
      arrTime: dateTime(2026, 7, 24, 16, 1),
    });

  const planOf = (segments: RouteSegment[], to = '池上'): RoutePlan =>
    buildRoutePlan({
      from: '現在地',
      to,
      segments,
      departure: new TimeValue({ h: 14, m: 51 }),
      budgetMin: 90,
      departureAt: dateTime(2026, 7, 24, 14, 51),
    });

  it('連続する徒歩は1区間へ統合され中間の通過ノードが生成されない', () => {
    const plan = planOf([...consecutiveWalks(), ikegamiLine()]);

    expect(plan.segments).toHaveLength(2);
    expect(first(plan.segments).type).toEqual(SegmentType.walk);
    expect(first(plan.segments).fromName).toEqual('現在地');
    expect(first(plan.segments).toName).toEqual('久が原');
    expect(plan.timelineNodes.map((n) => `${n.time} ${n.place} ${n.sub}`)).toEqual([
      '14:51 現在地 出発',
      '15:51 久が原 東急池上線',
      '16:01 池上 到着 · 制限内 ✓',
    ]);
  });

  it('統合しても所要・距離・kcal・到着時刻は子の合計と一致する', () => {
    const plan = planOf([...consecutiveWalks(), ikegamiLine()]);

    expect(first(plan.segments).minutes).toEqual(55);
    expect(Math.abs(first(plan.segments).km! - 3.9)).toBeLessThanOrEqual(1e-9);
    expect(first(plan.segments).kcal).toEqual(223);
    expect(plan.kcal).toEqual(223);
    expect(Math.abs(plan.walkKm - 3.9)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(plan.totalKm - 5.9)).toBeLessThanOrEqual(1e-9);
    expect(plan.totalMin).toEqual(70);
    expect(last(plan.timelineNodes).time).toEqual('16:01');
  });

  it('統合後の polyline は子を順に連結し継ぎ目の重複点を持たない', () => {
    const a = new GeoPoint(35.5614, 139.7161);
    const b = new GeoPoint(35.568, 139.69);
    const c = new GeoPoint(35.575, 139.681);
    const plan = planOf(
      [
        new RouteSegment({
          type: SegmentType.walk,
          fromName: '現在地',
          toName: '',
          minutes: 20,
          km: 1.5,
          kcal: 86,
          polyline: [a, b],
        }),
        new RouteSegment({
          type: SegmentType.walk,
          fromName: '',
          toName: '久が原',
          minutes: 10,
          km: 0.7,
          kcal: 40,
          polyline: [b, c],
        }),
      ],
      '久が原',
    );

    expect(single(plan.segments).polyline).toEqual([a, b, c]);
  });

  it('末尾の徒歩が geometry を欠くなら統合後の polyline を空にする', () => {
    const a = new GeoPoint(35.5614, 139.7161);
    const x = new GeoPoint(35.568, 139.69);
    const plan = planOf(
      [
        new RouteSegment({
          type: SegmentType.walk,
          fromName: '現在地',
          toName: '',
          minutes: 40,
          km: 2.9,
          kcal: 163,
          polyline: [a, x],
        }),
        new RouteSegment({
          type: SegmentType.walk,
          fromName: '',
          toName: '久が原',
          minutes: 12,
          km: 0.8,
          kcal: 46,
        }),
      ],
      '久が原',
    );

    expect(single(plan.segments).polyline).toHaveLength(0);
  });

  it('先頭の徒歩が geometry を欠いても末尾の終点座標は保つ', () => {
    const y = new GeoPoint(35.568, 139.69);
    const z = new GeoPoint(35.575, 139.681);
    const plan = planOf(
      [
        new RouteSegment({
          type: SegmentType.walk,
          fromName: '現在地',
          toName: '',
          minutes: 40,
          km: 2.9,
          kcal: 163,
        }),
        new RouteSegment({
          type: SegmentType.walk,
          fromName: '',
          toName: '久が原',
          minutes: 12,
          km: 0.8,
          kcal: 46,
          polyline: [y, z],
        }),
      ],
      '久が原',
    );

    expect(single(plan.segments).polyline).toEqual([y, z]);
  });

  it('徒歩→電車→徒歩 のように連続していない徒歩は統合しない', () => {
    const plan = planOf(
      [
        new RouteSegment({
          type: SegmentType.walk,
          fromName: '現在地',
          toName: '久が原',
          minutes: 40,
          km: 2.9,
          kcal: 163,
        }),
        ikegamiLine(),
        new RouteSegment({
          type: SegmentType.walk,
          fromName: '池上',
          toName: '目的地',
          minutes: 5,
          km: 0.4,
          kcal: 23,
        }),
      ],
      '目的地',
    );

    expect(plan.segments).toHaveLength(3);
    expect(plan.timelineNodes.map((n) => n.place)).toEqual(['現在地', '久が原', '池上', '目的地']);
  });

  it('端点名が空の徒歩を含んでも空欄のまま描かれるノードが残らない', () => {
    const plan = planOf([...consecutiveWalks(), ikegamiLine()]);

    expect(plan.timelineNodes.every((n) => n.place.length > 0)).toBe(true);
  });

  it('発着時刻を持つ徒歩は統合せず到着時刻を保つ', () => {
    const plan = planOf(
      [
        new RouteSegment({
          type: SegmentType.walk,
          fromName: '現在地',
          toName: '中間点',
          minutes: 10,
          km: 0.7,
          kcal: 40,
        }),
        new RouteSegment({
          type: SegmentType.walk,
          fromName: '中間点',
          toName: '久が原',
          minutes: 10,
          km: 0.7,
          kcal: 40,
          depTime: dateTime(2026, 7, 24, 15, 11),
          arrTime: dateTime(2026, 7, 24, 15, 21),
        }),
      ],
      '久が原',
    );

    expect(plan.segments).toHaveLength(2);
    expect(plan.totalMin).toEqual(30);
    expect(last(plan.timelineNodes).time).toEqual('15:21');
  });
});

describe('firstMissedTransit', () => {
  it('予定列車の発車後に駅着なら乗り遅れ区間を返す', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '出発地',
        toName: 'A駅',
        minutes: 20,
      }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'A駅',
        toName: 'B駅',
        minutes: 18,
        line: '○○線',
        depTime: dateTime(2026, 5, 22, 9, 12),
        arrTime: dateTime(2026, 5, 22, 9, 30),
      }),
    ];

    expect(firstMissedTransit(segments, dateTime(2026, 5, 22, 9, 0))).toEqual(1);
  });

  it('バス区間も発車後に停留所着なら乗り遅れ扱い (#250)', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '出発地',
        toName: 'A停留所',
        minutes: 20,
      }),
      new RouteSegment({
        type: SegmentType.bus,
        fromName: 'A停留所',
        toName: 'B停留所',
        minutes: 18,
        line: '渋谷01',
        depTime: dateTime(2026, 5, 22, 9, 12),
        arrTime: dateTime(2026, 5, 22, 9, 30),
      }),
    ];

    expect(firstMissedTransit(segments, dateTime(2026, 5, 22, 9, 0))).toEqual(1);
  });

  it('発車前に駅着なら乗り遅れなし（null）', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '出発地',
        toName: 'A駅',
        minutes: 5,
      }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'A駅',
        toName: 'B駅',
        minutes: 18,
        line: '○○線',
        depTime: dateTime(2026, 5, 22, 9, 12),
        arrTime: dateTime(2026, 5, 22, 9, 30),
      }),
    ];

    expect(firstMissedTransit(segments, dateTime(2026, 5, 22, 9, 0))).toBeNull();
  });

  it('駅着と発車が同時刻（累積==発車相対）は乗り遅れにしない', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '出発地',
        toName: 'A駅',
        minutes: 12,
      }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'A駅',
        toName: 'B駅',
        minutes: 18,
        line: '○○線',
        depTime: dateTime(2026, 5, 22, 9, 12),
        arrTime: dateTime(2026, 5, 22, 9, 30),
      }),
    ];

    expect(firstMissedTransit(segments, dateTime(2026, 5, 22, 9, 0))).toBeNull();
  });

  it('発着時刻が無い電車区間は乗り遅れ判定の対象外（null）', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '出発地',
        toName: 'A駅',
        minutes: 30,
      }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'A駅',
        toName: 'B駅',
        minutes: 18,
        line: '○○線',
      }),
    ];

    expect(firstMissedTransit(segments, dateTime(2026, 5, 22, 9, 0))).toBeNull();
  });

  it('降車駅の時刻が欠落(arr=null)でも発車時刻を過ぎて駅着なら乗り遅れ（実データ）', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '出発地',
        toName: '自由が丘',
        minutes: 33,
      }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: '自由が丘',
        toName: '代官山',
        minutes: 11,
        line: '東急東横線急行',
        depTime: dateTime(2026, 6, 15, 4, 30),
      }),
    ];

    expect(firstMissedTransit(segments, dateTime(2026, 6, 15, 3, 58))).toEqual(1);
  });

  it('発車時刻があり着時刻が欠落でも発車前に駅着なら乗り遅れなし（null）', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '出発地',
        toName: '自由が丘',
        minutes: 20,
      }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: '自由が丘',
        toName: '代官山',
        minutes: 11,
        line: '東急東横線急行',
        depTime: dateTime(2026, 6, 15, 4, 30),
      }),
    ];

    expect(firstMissedTransit(segments, dateTime(2026, 6, 15, 3, 58))).toBeNull();
  });

  it('departureAt 起点で先行区間の待ちを吸収した累積で判定する', () => {
    const segmentsWithSecondDeparture = (dep: Date): RouteSegment[] => [
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'S1',
        toName: 'S2',
        minutes: 15,
        line: '1号線',
        depTime: dateTime(2026, 5, 22, 9, 10),
        arrTime: dateTime(2026, 5, 22, 9, 25),
      }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'S2',
        toName: 'S3',
        minutes: 10,
        line: '2号線',
        depTime: dep,
        arrTime: dateTime(2026, 5, 22, 9, 40),
      }),
    ];
    const departureAt = dateTime(2026, 5, 22, 9, 0);

    expect(
      firstMissedTransit(segmentsWithSecondDeparture(dateTime(2026, 5, 22, 9, 20)), departureAt),
    ).toEqual(1);
    expect(
      firstMissedTransit(segmentsWithSecondDeparture(dateTime(2026, 5, 22, 9, 24)), departureAt),
    ).toEqual(1);
    expect(
      firstMissedTransit(segmentsWithSecondDeparture(dateTime(2026, 5, 22, 9, 25)), departureAt),
    ).toBeNull();
  });
});

describe('maxBoardingWait', () => {
  it('電車の乗車待ちを返す', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'A駅',
        toName: 'B駅',
        minutes: 10,
        depTime: dateTime(2026, 5, 22, 9, 30),
        arrTime: dateTime(2026, 5, 22, 9, 40),
      }),
    ];
    expect(maxBoardingWait(segments, dateTime(2026, 5, 22, 9, 0))).toEqual(30);
  });

  it('バスの乗車待ちも数える（深夜の翌朝始発バス対策・#250）', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.bus,
        fromName: 'A停留所',
        toName: 'B停留所',
        minutes: 20,
        line: '渋谷01',
        depTime: dateTime(2026, 5, 23, 6, 0),
        arrTime: dateTime(2026, 5, 23, 6, 20),
      }),
    ];
    expect(maxBoardingWait(segments, dateTime(2026, 5, 22, 23, 30))).toEqual(390);
  });

  it('時刻を持たない区間・全徒歩は 0', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '出発地',
        toName: '目的地',
        minutes: 40,
      }),
      new RouteSegment({
        type: SegmentType.bus,
        fromName: 'A停留所',
        toName: 'B停留所',
        minutes: 20,
      }),
    ];
    expect(maxBoardingWait(segments, dateTime(2026, 5, 22, 9, 0))).toEqual(0);
  });
});

describe('hasUnverifiedTransit', () => {
  it('depTime を欠く transit 区間（電車・バス）を検出する', () => {
    const untimedTrain = [
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'A駅',
        toName: 'B駅',
        minutes: 10,
      }),
    ];
    const untimedBus = [
      new RouteSegment({
        type: SegmentType.bus,
        fromName: 'A停留所',
        toName: 'B停留所',
        minutes: 20,
      }),
    ];
    expect(hasUnverifiedTransit(untimedTrain)).toBe(true);
    expect(hasUnverifiedTransit(untimedBus)).toBe(true);
  });

  it('全 transit 区間に depTime が揃えば false（徒歩は時刻不要）', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '出発地',
        toName: 'A駅',
        minutes: 5,
      }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: 'A駅',
        toName: 'B駅',
        minutes: 10,
        depTime: dateTime(2026, 5, 22, 9, 10),
        arrTime: dateTime(2026, 5, 22, 9, 20),
      }),
    ];
    expect(hasUnverifiedTransit(segments)).toBe(false);
  });

  it('全徒歩は false', () => {
    const segments = [
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '出発地',
        toName: '目的地',
        minutes: 40,
      }),
    ];
    expect(hasUnverifiedTransit(segments)).toBe(false);
  });
});

describe('budgetMinutes', () => {
  it('同日内は到着−出発の差をそのまま返す', () => {
    expect(budgetMinutes(new TimeValue({ h: 9, m: 0 }), new TimeValue({ h: 10, m: 30 }))).toEqual(
      90,
    );
  });

  it('到着が翌日(dateOffset:1)なら日跨ぎ分を加算する', () => {
    expect(
      budgetMinutes(new TimeValue({ h: 23, m: 55 }), new TimeValue({ h: 0, m: 55, dateOffset: 1 })),
    ).toEqual(60);
  });

  it('出発が isNow なら dateOffset を無視して当日扱いにする', () => {
    expect(
      budgetMinutes(
        new TimeValue({ h: 23, m: 55, isNow: true, dateOffset: 3 }),
        new TimeValue({ h: 0, m: 55, dateOffset: 1 }),
      ),
    ).toEqual(60);
  });
});
