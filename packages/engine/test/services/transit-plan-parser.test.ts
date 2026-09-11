// 移植元: test/core/services/transit_plan_parser_test.dart

import { describe, expect, it } from 'vitest';

import type { JsonMap } from '../../src/json';
import { SegmentType } from '../../src/models/route-plan';
import {
  parseGuidancePlan,
  stripStationRomaji,
  transitSecsToJst,
} from '../../src/services/transit-plan-parser';
import { dateTime } from '../../src/time';
import { single } from '../support/iterable';

// Transit API `/guidance/plan` レスポンス（実機構造に準拠）を組むヘルパ。
// - journey.legs: 時刻と路線（access/egress walk は含まず secs で持つ）。
// - map.segments: access/egress を含む全ジオメトリ。transit セグメントは
//   transit leg と同数・同順で fromPointId/toPointId が leg.from.id/to.id に一致する
//   （実機検証済み）。

const station = (id: string, name: string): JsonMap => ({ id, name });

interface LegArgs {
  route: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  dep: number;
  arr: number;
}

const railLeg = (a: LegArgs): JsonMap => ({
  kind: 'transit',
  mode: 'rail',
  routeName: a.route,
  from: station(a.fromId, a.fromName),
  to: station(a.toId, a.toName),
  departureSecs: a.dep,
  arrivalSecs: a.arr,
});

const busLeg = (a: LegArgs): JsonMap => ({
  kind: 'transit',
  mode: 'bus',
  routeName: a.route,
  from: station(a.fromId, a.fromName),
  to: station(a.toId, a.toName),
  departureSecs: a.dep,
  arrivalSecs: a.arr,
});

const walkLeg = (a: Omit<LegArgs, 'route'>): JsonMap => ({
  kind: 'walk',
  from: station(a.fromId, a.fromName),
  to: station(a.toId, a.toName),
  departureSecs: a.dep,
  arrivalSecs: a.arr,
});

const poly = (latLon: number[][]): JsonMap[] =>
  latLon.map((p) => ({ lat: p[0], lon: p[1] }));

interface MapSegArgs {
  fromId: string;
  toId: string;
  geom: string;
  coords: number[][];
}

const mapTransit = (a: MapSegArgs): JsonMap => ({
  kind: 'transit',
  geometrySource: a.geom,
  fromPointId: a.fromId,
  toPointId: a.toId,
  polyline: poly(a.coords),
});

const mapWalk = (a: MapSegArgs): JsonMap => ({
  kind: 'walk',
  geometrySource: a.geom,
  fromPointId: a.fromId,
  toPointId: a.toId,
  polyline: poly(a.coords),
});

const journey = (a: {
  dep: number;
  arr: number;
  dur: number;
  access?: number;
  egress?: number;
  legs: JsonMap[];
}): JsonMap => ({
  departureSecs: a.dep,
  arrivalSecs: a.arr,
  durationSecs: a.dur,
  accessWalkSecs: a.access ?? 0,
  egressWalkSecs: a.egress ?? 0,
  legs: a.legs,
});

const option = (a: { journey: JsonMap; segments: JsonMap[] }): JsonMap => ({
  journey: a.journey,
  map: { points: [], segments: a.segments },
});

const guidance = (a: { date?: string; options: JsonMap[] }): JsonMap => ({
  date: a.date ?? '20260627',
  timezone: 'Asia/Tokyo',
  from: station('origin', '地点(出発)'),
  to: station('destination', '地点(目的)'),
  options: a.options,
});

describe('stripStationRomaji', () => {
  it('日本語駅名に付くローマ字サフィックスを落とす', () => {
    expect(stripStationRomaji('下北沢 Shimo-kitazawa')).toEqual('下北沢');
    expect(stripStationRomaji('渋谷 Shibuya')).toEqual('渋谷');
    expect(stripStationRomaji('明大前 Meidaimae')).toEqual('明大前');
  });

  it('マクロン付きローマ字も落とす', () => {
    expect(stripStationRomaji('成城学園前 Seijōgakuen-mae')).toEqual('成城学園前');
  });

  it('ローマ字を含まない名前はそのまま', () => {
    expect(stripStationRomaji('新宿')).toEqual('新宿');
    expect(stripStationRomaji('地点(出発)')).toEqual('地点(出発)');
  });
});

describe('transitSecsToJst', () => {
  it('サービス日0時 + 秒の naive JST を返す', () => {
    expect(transitSecsToJst('20260627', 360)).toEqual(dateTime(2026, 6, 27, 0, 6));
    expect(transitSecsToJst('20260627', 1260)).toEqual(dateTime(2026, 6, 27, 0, 21));
  });

  it('86400 超（0時跨ぎ便）は翌日へ繰り上がる', () => {
    // 90000s = 25:00 → 翌日 01:00。
    expect(transitSecsToJst('20260627', 90000)).toEqual(dateTime(2026, 6, 28, 1, 0));
  });

  it('返り値は naive（isUtc=false）', () => {
    // JS の `Date` に `isUtc` は無い。UTC 起点で組み立てていないことは、固定した
    // タイムゾーン（Asia/Tokyo・vitest.config.ts）でローカルの壁時計を読めば判る
    // ——UTC で作れば 09:06 になる。TZ を UTC で走らせるとこの反証が消える。
    const d = transitSecsToJst('20260627', 360)!;
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(6);
  });

  it('date/secs が不正・null なら null', () => {
    expect(transitSecsToJst(null, 360)).toBeNull();
    expect(transitSecsToJst('2026', 360)).toBeNull();
    expect(transitSecsToJst('20260627', null)).toBeNull();
  });
});

describe('parseGuidancePlan', () => {
  it('単一電車（access/egress 徒歩あり）を区間へ変換する', () => {
    const body = guidance({
      options: [
        option({
          journey: journey({
            dep: 360,
            arr: 1260,
            dur: 1100,
            access: 120,
            egress: 60,
            legs: [
              railLeg({
                route: '中央線快速',
                fromId: 'jr:Tokyo',
                fromName: '東京',
                toId: 'jr:Shinjuku',
                toName: '新宿',
                dep: 360,
                arr: 1260,
              }),
            ],
          }),
          segments: [
            mapWalk({
              fromId: 'origin',
              toId: 'jr:Tokyo',
              geom: 'osmWalk',
              coords: [
                [35.6812, 139.7671],
                [35.6813, 139.7672],
              ],
            }),
            mapTransit({
              fromId: 'jr:Tokyo',
              toId: 'jr:Shinjuku',
              geom: 'stopOrder',
              coords: [
                [35.6812, 139.7671],
                [35.6916, 139.7706],
                [35.6909, 139.7003],
              ],
            }),
            mapWalk({
              fromId: 'jr:Shinjuku',
              toId: 'destination',
              geom: 'estimatedWalk',
              coords: [
                [35.6909, 139.7003],
                [35.691, 139.7004],
              ],
            }),
          ],
        }),
      ],
    });

    const options = parseGuidancePlan(body);
    expect(options).toHaveLength(1);
    const o = single(options);

    // access walk → train → egress walk の順。
    expect(o.segments.map((s) => s.type)).toEqual([
      SegmentType.walk,
      SegmentType.train,
      SegmentType.walk,
    ]);

    const train = o.segments[1];
    expect(train.line).toEqual('中央線快速');
    expect(train.fromName).toEqual('東京');
    expect(train.toName).toEqual('新宿');
    expect(train.minutes).toEqual(15); // (1260-360)/60
    expect(train.depTime).toEqual(dateTime(2026, 6, 27, 0, 6));
    expect(train.arrTime).toEqual(dateTime(2026, 6, 27, 0, 21));
    expect(train.polyline).toHaveLength(3);

    // access/egress の所要は journey の secs を分へ。
    expect(o.segments[0].minutes).toEqual(2); // 120s
    expect(o.segments[o.segments.length - 1].minutes).toEqual(1); // 60s

    // コリドーは transit leg ぶん。stopOrder の座標がそのまま。
    expect(o.corridors).toHaveLength(1);
    expect(single(o.corridors).geometrySource).toEqual('stopOrder');
    expect(single(o.corridors).coords).toHaveLength(3);
    expect(single(o.corridors).legIndex).toEqual(0);
  });

  it('私鉄の路線記号コード（routeName=OH）を和名へ写す', () => {
    const body = guidance({
      options: [
        option({
          journey: journey({
            dep: 360,
            arr: 1260,
            dur: 900,
            legs: [
              railLeg({
                route: 'OH',
                fromId: 'odakyu:Setagaya-Daita',
                fromName: '世田谷代田 Setagaya-Daita',
                toId: 'odakyu:Shimo-Kitazawa',
                toName: '下北沢 Shimo-kitazawa',
                dep: 360,
                arr: 1260,
              }),
            ],
          }),
          segments: [
            mapTransit({
              fromId: 'odakyu:Setagaya-Daita',
              toId: 'odakyu:Shimo-Kitazawa',
              geom: 'gtfsShape',
              coords: [
                [35.658, 139.661],
                [35.661, 139.668],
              ],
            }),
          ],
        }),
      ],
    });

    const train = single(single(parseGuidancePlan(body)).segments);
    expect(train.type).toEqual(SegmentType.train);
    expect(train.line).toEqual('小田急小田原線');
    // 駅名はローマ字サフィックスを除いて持つ。
    expect(train.fromName).toEqual('世田谷代田');
    expect(train.toName).toEqual('下北沢');
  });

  it('乗換（電車+乗換徒歩+電車）を順序通りに変換しコリドー2本', () => {
    const body = guidance({
      options: [
        option({
          journey: journey({
            dep: 1260,
            arr: 3357,
            dur: 2097,
            access: 113,
            egress: 57,
            legs: [
              railLeg({
                route: '山手線',
                fromId: 'ya:Shibuya',
                fromName: '渋谷',
                toId: 'ya:Yoyogi',
                toName: '代々木',
                dep: 1260,
                arr: 1560,
              }),
              walkLeg({
                fromId: 'ya:Yoyogi',
                fromName: '代々木',
                toId: 'so:Yoyogi',
                toName: '代々木',
                dep: 1560,
                arr: 1680,
              }),
              railLeg({
                route: '中央・総武線',
                fromId: 'so:Yoyogi',
                fromName: '代々木',
                toId: 'so:Kichijoji',
                toName: '吉祥寺',
                dep: 1980,
                arr: 3300,
              }),
            ],
          }),
          segments: [
            mapWalk({
              fromId: 'origin',
              toId: 'ya:Shibuya',
              geom: 'osmWalk',
              coords: [
                [35.658, 139.7016],
                [35.6585, 139.7017],
              ],
            }),
            mapTransit({
              fromId: 'ya:Shibuya',
              toId: 'ya:Yoyogi',
              geom: 'stopOrder',
              coords: [
                [35.658, 139.7016],
                [35.6645, 139.702],
                [35.683, 139.702],
              ],
            }),
            mapWalk({
              fromId: 'ya:Yoyogi',
              toId: 'so:Yoyogi',
              geom: 'osmWalk',
              coords: [
                [35.683, 139.702],
                [35.6831, 139.7019],
              ],
            }),
            mapTransit({
              fromId: 'so:Yoyogi',
              toId: 'so:Kichijoji',
              geom: 'stopOrder',
              coords: [
                [35.683, 139.702],
                [35.696, 139.626],
                [35.703, 139.5797],
              ],
            }),
            mapWalk({
              fromId: 'so:Kichijoji',
              toId: 'destination',
              geom: 'estimatedWalk',
              coords: [
                [35.703, 139.5797],
                [35.7031, 139.5798],
              ],
            }),
          ],
        }),
      ],
    });

    const o = single(parseGuidancePlan(body));
    expect(o.segments.map((s) => s.type)).toEqual([
      SegmentType.walk, // access
      SegmentType.train, // 山手線
      SegmentType.walk, // 乗換
      SegmentType.train, // 中央総武
      SegmentType.walk, // egress
    ]);
    // 乗換徒歩の所要は leg の arr-dep（待ちは含めない）。
    expect(o.segments[2].minutes).toEqual(2); // (1680-1560)/60
    // 2 本目の電車の発車時刻は待ち後の 1980s。
    expect(o.segments[3].depTime).toEqual(dateTime(2026, 6, 27, 0, 33));
    expect(o.corridors).toHaveLength(2);
    expect(o.corridors[0].legIndex).toEqual(0);
    expect(o.corridors[1].legIndex).toEqual(1);
  });

  it('gtfsShape はコリドー座標と geometrySource を保持する', () => {
    const body = guidance({
      options: [
        option({
          journey: journey({
            dep: 800,
            arr: 4000,
            dur: 3200,
            access: 30,
            egress: 30,
            legs: [
              railLeg({
                route: 'KO',
                fromId: 'keio:Shinjuku',
                fromName: '新宿',
                toId: 'keio:Hachioji',
                toName: '京王八王子',
                dep: 800,
                arr: 4000,
              }),
            ],
          }),
          segments: [
            mapWalk({
              fromId: 'origin',
              toId: 'keio:Shinjuku',
              geom: 'osmWalk',
              coords: [
                [35.69, 139.7],
                [35.69, 139.699],
              ],
            }),
            mapTransit({
              fromId: 'keio:Shinjuku',
              toId: 'keio:Hachioji',
              geom: 'gtfsShape',
              // 線路追従の密な頂点（停車駅とは無関係）。
              coords: [
                [35.69, 139.699],
                [35.685, 139.66],
                [35.67, 139.52],
                [35.66, 139.4],
                [35.658, 139.343],
              ],
            }),
            mapWalk({
              fromId: 'keio:Hachioji',
              toId: 'destination',
              geom: 'estimatedWalk',
              coords: [
                [35.658, 139.343],
                [35.6558, 139.3389],
              ],
            }),
          ],
        }),
      ],
    });

    const o = single(parseGuidancePlan(body));
    expect(single(o.corridors).geometrySource).toEqual('gtfsShape');
    expect(single(o.corridors).coords).toHaveLength(5);
  });

  it('全徒歩 option は単一の徒歩区間へ畳む', () => {
    const body = guidance({
      options: [
        option({
          journey: journey({ dep: 0, arr: 3600, dur: 3600, legs: [] }),
          segments: [
            mapWalk({
              fromId: 'origin',
              toId: 'destination',
              geom: 'osmWalk',
              coords: [
                [35.1, 139.1],
                [35.2, 139.2],
              ],
            }),
          ],
        }),
      ],
    });

    const o = single(parseGuidancePlan(body));
    expect(o.segments).toHaveLength(1);
    expect(single(o.segments).type).toEqual(SegmentType.walk);
    expect(single(o.segments).minutes).toEqual(60); // 3600s
    expect(o.corridors).toHaveLength(0);
  });

  it('同駅乗換の0km・0分の徒歩レッグは生成しない（#225）', () => {
    // 多摩川→多摩川の乗換：所要0秒・polyline は同一点で距離0。ノイズなので落とす。
    const body = guidance({
      options: [
        option({
          journey: journey({
            dep: 600,
            arr: 2400,
            dur: 1800,
            legs: [
              railLeg({
                route: '東急東横線',
                fromId: 'ty:Shibuya',
                fromName: '渋谷',
                toId: 'ty:Tamagawa',
                toName: '多摩川',
                dep: 600,
                arr: 1200,
              }),
              walkLeg({
                fromId: 'ty:Tamagawa',
                fromName: '多摩川',
                toId: 'tm:Tamagawa',
                toName: '多摩川',
                dep: 1200,
                arr: 1200,
              }),
              railLeg({
                route: '東急多摩川線',
                fromId: 'tm:Tamagawa',
                fromName: '多摩川',
                toId: 'tm:Kamata',
                toName: '蒲田',
                dep: 1200,
                arr: 2400,
              }),
            ],
          }),
          segments: [
            mapTransit({
              fromId: 'ty:Shibuya',
              toId: 'ty:Tamagawa',
              geom: 'stopOrder',
              coords: [
                [35.658, 139.7016],
                [35.5895, 139.668],
              ],
            }),
            mapWalk({
              fromId: 'ty:Tamagawa',
              toId: 'tm:Tamagawa',
              geom: 'osmWalk',
              coords: [[35.5895, 139.668]],
            }),
            mapTransit({
              fromId: 'tm:Tamagawa',
              toId: 'tm:Kamata',
              geom: 'stopOrder',
              coords: [
                [35.5895, 139.668],
                [35.5626, 139.716],
              ],
            }),
          ],
        }),
      ],
    });

    const o = single(parseGuidancePlan(body));
    // 0km・0分の乗換徒歩は挟まず、電車2本のみ（直結乗換）。
    expect(o.segments.map((s) => s.type)).toEqual([
      SegmentType.train,
      SegmentType.train,
    ]);
    // コリドーは電車区間ぶん維持される。
    expect(o.corridors).toHaveLength(2);
  });

  it('options が無い・不正なら空リスト', () => {
    expect(parseGuidancePlan({})).toHaveLength(0);
    expect(parseGuidancePlan({ options: 'nope' })).toHaveLength(0);
  });

  it('バス（mode=bus）区間は SegmentType.bus として扱い、電車の乗車駅名と混同しない（#245/#249）', () => {
    // 実データの再現: 森０２ バスで山王三丁目(バス停)→大森駅(バス停)、徒歩で大森へ、
    // そこから京浜東北線。以前はバス区間まで電車扱いし、乗車駅名がバス停
    // 「山王三丁目」に化けていた（#245）。#249 でバスは SegmentType.bus という
    // 別型になったため、option は除外されず、バス区間・電車区間それぞれ正しい
    // 駅名で残ることを検証する。
    const busViaRail = option({
      journey: journey({
        dep: 360,
        arr: 1326,
        dur: 966,
        egress: 66,
        legs: [
          busLeg({
            route: '森０２',
            fromId: 'bus:Sannousanchoume',
            fromName: '山王三丁目',
            toId: 'bus:Oomorieki',
            toName: '大森駅',
            dep: 360,
            arr: 700,
          }),
          walkLeg({
            fromId: 'bus:Oomorieki',
            fromName: '大森駅',
            toId: 'jr:Omori',
            toName: '大森',
            dep: 700,
            arr: 760,
          }),
          railLeg({
            route: '京浜東北線（北行（大宮方面））',
            fromId: 'jr:Omori',
            fromName: '大森',
            toId: 'jr:Shimbashi',
            toName: '新橋',
            dep: 760,
            arr: 1326,
          }),
        ],
      }),
      segments: [
        mapTransit({
          fromId: 'bus:Sannousanchoume',
          toId: 'bus:Oomorieki',
          geom: 'stopOrder',
          coords: [
            [35.5822, 139.7231],
            [35.5855, 139.7254],
          ],
        }),
        mapWalk({
          fromId: 'bus:Oomorieki',
          toId: 'jr:Omori',
          geom: 'osmWalk',
          coords: [
            [35.5855, 139.7254],
            [35.5885, 139.7279],
          ],
        }),
        mapTransit({
          fromId: 'jr:Omori',
          toId: 'jr:Shimbashi',
          geom: 'stopOrder',
          coords: [
            [35.5885, 139.7279],
            [35.6665, 139.7583],
          ],
        }),
        mapWalk({
          fromId: 'jr:Shimbashi',
          toId: 'destination',
          geom: 'estimatedWalk',
          coords: [
            [35.6665, 139.7583],
            [35.6666, 139.7584],
          ],
        }),
      ],
    });

    const options = parseGuidancePlan(guidance({ options: [busViaRail] }));

    expect(options).toHaveLength(1);
    const segs = single(options).segments;
    expect(segs.map((s) => s.type)).toEqual([
      SegmentType.bus,
      SegmentType.walk,
      SegmentType.train,
      SegmentType.walk,
    ]);

    // バス区間の乗車停留所名はバス停のまま。
    const bus = segs[0];
    expect(bus.fromName).toEqual('山王三丁目');
    expect(bus.toName).toEqual('大森駅');
    // バス系統名は railLineLabel（電車の路線名整形）を経由せずそのまま出す。
    expect(bus.line).toEqual('森０２');

    // 電車区間の乗車駅名はバス停「山王三丁目」ではなく鉄道駅「大森」。
    const train = segs[2];
    expect(train.fromName).toEqual('大森');
    expect(train.toName).toEqual('新橋');
  });

  it('バスのみの option は SegmentType.bus の単一区間になる（#249）', () => {
    const busOnly = option({
      journey: journey({
        dep: 360,
        arr: 700,
        dur: 340,
        legs: [
          busLeg({
            route: '森０２',
            fromId: 'bus:Sannousanchoume',
            fromName: '山王三丁目',
            toId: 'bus:Oomorieki',
            toName: '大森駅',
            dep: 360,
            arr: 700,
          }),
        ],
      }),
      segments: [
        mapTransit({
          fromId: 'bus:Sannousanchoume',
          toId: 'bus:Oomorieki',
          geom: 'stopOrder',
          coords: [
            [35.5822, 139.7231],
            [35.5855, 139.7254],
          ],
        }),
      ],
    });

    const options = parseGuidancePlan(guidance({ options: [busOnly] }));
    expect(options).toHaveLength(1);
    const segs = single(options).segments;
    expect(segs).toHaveLength(1);
    expect(single(segs).type).toEqual(SegmentType.bus);
    expect(single(segs).fromName).toEqual('山王三丁目');
    expect(single(segs).toName).toEqual('大森駅');
  });

  it('地下鉄（mode=subway）を含む option は電車として維持する（#245）', () => {
    // 地下鉄・私鉄・モノレール等は mode が rail/subway 等で返る。バスと違い
    // 電車として扱い、区間・駅名解決に残す。segmentTypeForMode の写像を
    // 崩すリファクタから守る回帰ガード。
    const subwayLeg: JsonMap = {
      kind: 'transit',
      mode: 'subway',
      routeName: '都営浅草線',
      from: station('toei:Nihombashi', '日本橋'),
      to: station('toei:Shimbashi', '新橋'),
      departureSecs: 480,
      arrivalSecs: 900,
    };
    const options = parseGuidancePlan(
      guidance({
        options: [
          option({
            journey: journey({
              dep: 360,
              arr: 960,
              dur: 600,
              access: 120,
              egress: 60,
              legs: [subwayLeg],
            }),
            segments: [
              mapWalk({
                fromId: 'origin',
                toId: 'toei:Nihombashi',
                geom: 'osmWalk',
                coords: [
                  [35.6817, 139.7745],
                  [35.682, 139.7748],
                ],
              }),
              mapTransit({
                fromId: 'toei:Nihombashi',
                toId: 'toei:Shimbashi',
                geom: 'stopOrder',
                coords: [
                  [35.682, 139.7748],
                  [35.6665, 139.7583],
                ],
              }),
              mapWalk({
                fromId: 'toei:Shimbashi',
                toId: 'destination',
                geom: 'estimatedWalk',
                coords: [
                  [35.6665, 139.7583],
                  [35.6666, 139.7584],
                ],
              }),
            ],
          }),
        ],
      }),
    );

    expect(options).toHaveLength(1);
    const trains = single(options).segments.filter(
      (s) => s.type === SegmentType.train,
    );
    expect(trains).toHaveLength(1);
    expect(single(trains).fromName).toEqual('日本橋');
    expect(single(trains).toName).toEqual('新橋');
  });

  it('mode 欠落の transit leg は電車として維持する（後方互換）', () => {
    // 実 API・既存フィクスチャで mode を欠く transit leg があり得る。パーサは mode 欠落を
    // 電車扱いとするため、除外されず区間へ残ることを検証する。
    const noModeLeg: JsonMap = {
      kind: 'transit',
      routeName: '京浜東北線（北行（大宮方面））',
      from: station('jr:Omori', '大森'),
      to: station('jr:Shimbashi', '新橋'),
      departureSecs: 480,
      arrivalSecs: 1200,
    };
    const options = parseGuidancePlan(
      guidance({
        options: [
          option({
            journey: journey({
              dep: 360,
              arr: 1260,
              dur: 900,
              access: 120,
              egress: 60,
              legs: [noModeLeg],
            }),
            segments: [
              mapWalk({
                fromId: 'origin',
                toId: 'jr:Omori',
                geom: 'osmWalk',
                coords: [
                  [35.5855, 139.7254],
                  [35.5885, 139.7279],
                ],
              }),
              mapTransit({
                fromId: 'jr:Omori',
                toId: 'jr:Shimbashi',
                geom: 'stopOrder',
                coords: [
                  [35.5885, 139.7279],
                  [35.6665, 139.7583],
                ],
              }),
              mapWalk({
                fromId: 'jr:Shimbashi',
                toId: 'destination',
                geom: 'estimatedWalk',
                coords: [
                  [35.6665, 139.7583],
                  [35.6666, 139.7584],
                ],
              }),
            ],
          }),
        ],
      }),
    );

    expect(options).toHaveLength(1);
    const trains = single(options).segments.filter(
      (s) => s.type === SegmentType.train,
    );
    expect(trains).toHaveLength(1);
    expect(single(trains).fromName).toEqual('大森');
    expect(single(trains).toName).toEqual('新橋');
  });
});
