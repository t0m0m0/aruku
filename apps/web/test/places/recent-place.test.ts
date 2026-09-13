// 移植元: lib/core/models/recent_place.dart と test/core/models/recent_place_test.dart

import { describe, expect, it } from 'vitest';

import { GeoPoint } from '@aruku/engine/models/geo-point';

import {
  dedupeKey,
  recentPlaceFromJson,
  recentPlaceToJson,
  type RecentPlace,
} from '../../src/places/recent-place';

function place(overrides: Partial<RecentPlace> = {}): RecentPlace {
  return {
    name: '渋谷駅',
    placeId: 'p1',
    latLng: new GeoPoint(35.6, 139.7),
    address: '東京都渋谷区',
    usedAt: new Date('2026-09-13T01:00:00.000Z'),
    ...overrides,
  };
}

describe('dedupeKey', () => {
  it('placeId があればそれで寄せる', () => {
    expect(dedupeKey(place({ placeId: 'p1', name: 'A' }))).toBe('id:p1');
  });

  it('placeId が無ければ名前で寄せる', () => {
    expect(dedupeKey(place({ placeId: null, name: '自宅' }))).toBe('name:自宅');
  });

  // 空文字を id 扱いすると 'id:' という1つのキーに畳まれ、placeId を持たない
  // 別々の地点が互いを追い出す。
  it('空文字の placeId は名前へ落とす', () => {
    expect(dedupeKey(place({ placeId: '', name: '自宅' }))).toBe('name:自宅');
  });
});

describe('JSON の往復', () => {
  it('全項目そろった記録を往復できる', () => {
    const original = place();

    expect(recentPlaceFromJson(recentPlaceToJson(original))).toEqual(original);
  });

  it('省略できる項目が無い記録も往復できる', () => {
    const original = place({
      placeId: null,
      latLng: null,
      address: null,
      usedAt: null,
    });

    expect(recentPlaceFromJson(recentPlaceToJson(original))).toEqual(original);
  });

  it('null の項目はキーごと落とす（移植元と同じ形）', () => {
    const json = recentPlaceToJson(
      place({ placeId: null, latLng: null, address: null, usedAt: null }),
    );

    expect(Object.keys(json)).toEqual(['name']);
  });

  it('座標は lat / lng の2キーへ開く', () => {
    const json = recentPlaceToJson(place());

    expect(json['lat']).toBe(35.6);
    expect(json['lng']).toBe(139.7);
  });
});

describe('壊れた JSON の読み', () => {
  it('名前を欠く記録は地点として成立しない', () => {
    expect(recentPlaceFromJson({ placeId: 'p1' })).toBeNull();
  });

  it('オブジェクトでない値は読まない', () => {
    expect(recentPlaceFromJson('渋谷駅')).toBeNull();
    expect(recentPlaceFromJson(null)).toBeNull();
    expect(recentPlaceFromJson(42)).toBeNull();
  });

  // 片方だけの座標から GeoPoint を作ると、NaN を抱えた点が「座標あり」の顔で
  // 経路照会まで届く。
  it('片方だけの座標は座標なしにする', () => {
    expect(recentPlaceFromJson({ name: 'A', lat: 35.6 })?.latLng).toBeNull();
    expect(recentPlaceFromJson({ name: 'A', lng: 139.7 })?.latLng).toBeNull();
  });

  it('数値でない座標は座標なしにする', () => {
    expect(
      recentPlaceFromJson({ name: 'A', lat: '35.6', lng: '139.7' })?.latLng,
    ).toBeNull();
  });

  // Dart の DateTime.parse は投げるので上位の捕捉に入るが、new Date は静かに
  // Invalid Date を返し、書き戻す toISOString() が後から RangeError になる。
  it('パースできない日付は持たない', () => {
    const restored = recentPlaceFromJson({ name: 'A', usedAt: 'ぐちゃぐちゃ' });

    expect(restored?.usedAt).toBeNull();
    expect(() => recentPlaceToJson(restored!)).not.toThrow();
  });

  it('文字列でない名前は読まない', () => {
    expect(recentPlaceFromJson({ name: 42 })).toBeNull();
  });
});
