// 移植元: test/core/services/route_plan_builder_test.dart

import { describe, expect, it } from 'vitest';

import { GeoPoint } from '../../src/models/geo-point';
import {
  RouteSegment,
  SegmentType,
  type RoutePlan,
} from '../../src/models/route-plan';
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
    // 9:00 出発 → 徒歩5分で駅着 9:05 → 電車は 9:12 発・9:30 着。
    // 乗車駅ノードは早着して待つぶんを含め「電車の発車時刻 9:12」を表示する（駅着 9:05
    // ではない）。到着は累積分(9:23)ではなく 9:30。
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

    expect(plan.timelineNodes.map((n) => n.time)).toEqual([
      '9:00',
      '9:12',
      '9:30',
    ]);
    // 乗車駅は発車時刻＋路線名（駅着 9:05 → 9:12 発。待ちは表示しない）。
    expect(plan.timelineNodes[1].sub).toEqual('○○線');
    expect(last(plan.timelineNodes).sub).toEqual('到着 · 制限内 ✓');
    expect(plan.totalMin).toEqual(30);
  });

  it('直結乗換は乗換駅を「着」「発」の2行に分ける', () => {
    // 徒歩5分(9:05着) → 電車1 9:10発/9:25着 → （間に徒歩なし）→ 電車2 9:40発/10:00着。
    // 乗換駅 S2 は電車1の到着 9:25（着・無表示・カード無し）と電車2の発車 9:40（発・
    // 15分待ち）の2行に分ける。
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
    // S1 乗車駅は電車1の発（9:05着→9:10発。待ちは表示しない）。
    expect(plan.timelineNodes[1].sub).toEqual('1号線');
    // 乗換駅 S2 の「着」行は無表示＆カードを挟まない。
    expect(plan.timelineNodes[2].place).toEqual('S2');
    expect(plan.timelineNodes[2].sub).toEqual('');
    expect(plan.timelineNodes[2].cardBelow).toBe(false);
    // 乗換駅 S2 の「発」行は電車2の発（9:25着→9:40発。待ちは表示しない）。
    expect(plan.timelineNodes[3].place).toEqual('S2');
    expect(plan.timelineNodes[3].sub).toEqual('2号線');
  });

  it('0km・0分の徒歩レッグは除外し直結乗換にする（#225 保険）', () => {
    // 同駅乗換で挿入され得る 0km・0分の徒歩レッグは segments から落とし、
    // timelineNodes と 1:1 対応を保ったまま直結乗換として描く。
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

    // 0値 walk は segments から除外され電車2本のみ。
    expect(plan.segments.map((s) => s.type)).toEqual([
      SegmentType.train,
      SegmentType.train,
    ]);
    // ノード列は [S1出発, S2着(カード無し), S2発, S3到着]。
    // S2 は「着（カード無し）」＋「発」の直結乗換2行になる。
    expect(plan.timelineNodes[1].place).toEqual('S2');
    expect(plan.timelineNodes[1].cardBelow).toBe(false);
    expect(plan.timelineNodes[2].place).toEqual('S2');
    expect(plan.timelineNodes[2].sub).toEqual('2号線');
  });

  it('全区間が0値徒歩の退化入力でも出発・到着ノードは残す（#225）', () => {
    // from≈to の 0km・0分ルート等。フィルタ後 segments が空でも到着ノードを欠落
    // させない。
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
        // 9:05 着・9:05 発で待ち 0。
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

    // 乗車駅（発）ノードは待ち 0 なので路線名のみ。
    expect(plan.timelineNodes[1].sub).toEqual('○○線');
    // 降車駅は到着時刻＋「徒歩へ」。
    expect(plan.timelineNodes[2].place).toEqual('B駅');
    expect(plan.timelineNodes[2].sub).toEqual('徒歩へ');
  });

  it('着時刻が欠落(arr=null)でも発車時刻で待ちを算出する', () => {
    // 9:00発・徒歩5分で 9:05 駅着 → 発車 9:12 まで7分待ち。着時刻が無くても発車時刻が
    // あれば「7分待ち」を実時刻で表示する（乗車時間は着時刻欠落のため距離概算18分）。
    // 電車の後に徒歩を置き電車ノードの sub を確認する。
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
        // arrTime は null。
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

    // 駅着 9:05 → 7分待ち → 9:12 発 → 乗車18分で 9:30 着 → 徒歩3分で 9:33 着。
    // 待ちを使わない旧挙動なら総 26 分(=5+18+3)。発車時刻採用で 33 分になる。
    // 乗車駅（発）は 9:12（待ち非表示）、降車駅（着）は arr 欠落のため累積 9:30。
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

    expect(plan.timelineNodes.map((n) => n.time)).toEqual([
      '9:00',
      '9:05',
      '9:23',
    ]);
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
    // 徒歩20分で駅着 9:20 だが、予定列車は 9:12 発・9:30 着（乗車18分）。
    // 次列車の時刻は持たないため、待ち無しで実到着 9:20 + 乗車18分 = 9:38。
    // 末尾に徒歩3分を足し、電車ノード（非最終）の sub を検証できるようにする。
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

    expect(plan.timelineNodes.map((n) => n.time)).toEqual([
      '9:00',
      '9:20',
      '9:38',
      '9:41',
    ]);
    expect(plan.totalMin).toEqual(41);
    // 乗り遅れは待ち無し扱いなので乗車駅（発）は「○分待ち」を前置きしない。
    expect(plan.timelineNodes[1].sub).toEqual('○○線');
  });

  it('時刻表区間が前段の概算（フォールバック）に続いても発車時刻で待ちを算出する', () => {
    // 1本目は発着時刻なし＝所要分で概算（9:00+20=9:20着）。2本目は時刻表
    // 9:35発・10:00着。直結乗換なので乗換駅 B は「着 9:20」「発 9:35（15分待ち）」の2行。
    // 末尾に徒歩2分を足し、2号線の発ノードの sub を検証できるようにする。
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
    // 乗換駅 B の「着」行(index1)は無表示、「発」行(index2)は概算到着 9:20 →
    // 発車 9:35（待ち非表示。先頭に徒歩が無いぶん test B より index が 1 つ前）。
    expect(plan.timelineNodes[1].sub).toEqual('');
    expect(plan.timelineNodes[1].cardBelow).toBe(false);
    expect(plan.timelineNodes[2].sub).toEqual('2号線');
  });
});

describe('buildRoutePlan 連続徒歩の統合', () => {
  // #337 の実例（現在地 → 久が原）。乗車駅探索の継ぎ目で徒歩が 3 本並び、
  // うち 1 本は端点名が空。利用者から見れば「久が原まで 55 分歩く」だけの行程。
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
    // 出発 → 乗車駅（発車時刻）→ 到着 の 3 行だけ。徒歩が続いただけの行は出さない。
    expect(
      plan.timelineNodes.map((n) => `${n.time} ${n.place} ${n.sub}`),
    ).toEqual(['14:51 現在地 出発', '15:51 久が原 東急池上線', '16:01 池上 到着 · 制限内 ✓']);
  });

  it('統合しても所要・距離・kcal・到着時刻は子の合計と一致する', () => {
    const plan = planOf([...consecutiveWalks(), ikegamiLine()]);

    expect(first(plan.segments).minutes).toEqual(55);
    expect(Math.abs(first(plan.segments).km! - 3.9)).toBeLessThanOrEqual(1e-9);
    // kcal は距離から引き直さない（3.9km×57 = 222 に化けて合計が 1 ずれる）。
    expect(first(plan.segments).kcal).toEqual(223);
    expect(plan.kcal).toEqual(223);
    expect(Math.abs(plan.walkKm - 3.9)).toBeLessThanOrEqual(1e-9);
    expect(Math.abs(plan.totalKm - 5.9)).toBeLessThanOrEqual(1e-9);
    // 徒歩 55 分で 15:46 着 → 15:51 発 → 16:01 着。統合前と 1 分もずらさない。
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
    // 連結すると中間点 X で終わる polyline になり、legEndPoint が「歩き終える地点」
    // ではなく X を返す＝引き継ぎ先も到着自動判定も X に化ける。終点を偽るくらいなら
    // 座標不明（空）にして #323 のフォールバックへ委ねる。
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
    expect(plan.timelineNodes.map((n) => n.place)).toEqual([
      '現在地',
      '久が原',
      '池上',
      '目的地',
    ]);
  });

  it('端点名が空の徒歩を含んでも空欄のまま描かれるノードが残らない', () => {
    const plan = planOf([...consecutiveWalks(), ikegamiLine()]);

    expect(plan.timelineNodes.every((n) => n.place.length > 0)).toBe(true);
  });

  it('発着時刻を持つ徒歩は統合せず到着時刻を保つ', () => {
    // 統合すると所要の単純合計（10+10=20分）で 15:11 着に化ける。時刻を持つ区間は
    // advance が待ちを吸収するため、畳んだ瞬間に到着時刻がずれる。
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
    // 徒歩20分で駅着(累積20分)。予定列車は 9:12 発（発車相対12分）→ 20 > 12 で乗り遅れ。
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
    // 徒歩20分でバス停着(累積20分)。予定便は 9:12 発（発車相対12分）→ 20 > 12 で乗り遅れ。
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
    // 徒歩5分で駅着(累積5分) < 発車相対12分 → 間に合う。
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
    // 累積12分 == 発車相対12分 → ちょうど乗車（待ち0）。advance と同基準で乗り遅れ扱いしない。
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
    // 実データ再現: 自由が丘 発=04:30 はあるが 代官山 着=null。徒歩を延ばして駅着が
    // 発車後（4:31着）になれば、降車時刻が無くても発車時刻だけで乗り遅れと判定する。
    const segments = [
      new RouteSegment({
        type: SegmentType.walk,
        fromName: '出発地',
        toName: '自由が丘',
        minutes: 33, // 03:58発 → 04:31着（発車04:30の1分後）
      }),
      new RouteSegment({
        type: SegmentType.train,
        fromName: '自由が丘',
        toName: '代官山',
        minutes: 11,
        line: '東急東横線急行',
        depTime: dateTime(2026, 6, 15, 4, 30),
        // arrTime は欠落（null）。
      }),
    ];

    expect(firstMissedTransit(segments, dateTime(2026, 6, 15, 3, 58))).toEqual(1);
  });

  it('発車時刻があり着時刻が欠落でも発車前に駅着なら乗り遅れなし（null）', () => {
    // 03:58発・徒歩20分で 04:18 駅着 → 発車04:30 まで待てる（乗り遅れではない）。
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

    expect(
      firstMissedTransit(segments, dateTime(2026, 6, 15, 3, 58)),
    ).toBeNull();
  });

  it('departureAt 起点で先行区間の待ちを吸収した累積で判定する', () => {
    // 1本目: 9:00発の出発地から 9:10発・9:25着（乗車前待ち10分＋乗車15分）。2本目の
    // 発車時刻を動かして「S2 着＝累積25分」の境界そのものを固定する——乗車前待ちを
    // 取りこぼす実装（乗車分だけの累積15分）なら 9:20発でも「間に合う」と誤り、
    // 逆に待ちを二重計上する実装なら 9:25発ちょうどを乗り遅れにしてしまう。
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

    // 9:20発（発車相対20分）: 累積25分 > 20 で乗り遅れ。
    expect(
      firstMissedTransit(
        segmentsWithSecondDeparture(dateTime(2026, 5, 22, 9, 20)),
        departureAt,
      ),
    ).toEqual(1);
    // 9:24発（発車相対24分）: 累積25分 > 24 で、1分の差でも乗り遅れ側に落ちる。
    expect(
      firstMissedTransit(
        segmentsWithSecondDeparture(dateTime(2026, 5, 22, 9, 24)),
        departureAt,
      ),
    ).toEqual(1);
    // 9:25発（発車相対25分）: 累積25分ちょうど＝待ち0で乗車できる（境界は乗れる側）。
    expect(
      firstMissedTransit(
        segmentsWithSecondDeparture(dateTime(2026, 5, 22, 9, 25)),
        departureAt,
      ),
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
    // 23:30 出発、次のバスは翌朝 6:00 発＝待ち390分。train 限定のままだと 0 に
    // 見え、「今夜乗れる」と誤判定して全徒歩より優先されてしまう（#121 と同型）。
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
    expect(
      budgetMinutes(new TimeValue({ h: 9, m: 0 }), new TimeValue({ h: 10, m: 30 })),
    ).toEqual(90);
  });

  it('到着が翌日(dateOffset:1)なら日跨ぎ分を加算する', () => {
    // 23:55 出発 → 翌 0:55 着。dateOffset で +1440 され予算は 60 分。
    expect(
      budgetMinutes(
        new TimeValue({ h: 23, m: 55 }),
        new TimeValue({ h: 0, m: 55, dateOffset: 1 }),
      ),
    ).toEqual(60);
  });

  it('出発が isNow なら dateOffset を無視して当日扱いにする', () => {
    // 出発 isNow は当日固定（offset 無視）、到着 dateOffset:1 のみ繰り上がる。
    expect(
      budgetMinutes(
        new TimeValue({ h: 23, m: 55, isNow: true, dateOffset: 3 }),
        new TimeValue({ h: 0, m: 55, dateOffset: 1 }),
      ),
    ).toEqual(60);
  });
});
