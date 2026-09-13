// 移植元: lib/core/services/recents_repository.dart と
// test/core/services/recents_repository_test.dart
//
// 書き込みの直列化（_writeLock）は移植していない。localStorage が同期なので
// load→変更→save の間に別の操作が割り込む余地が無い。その反証が
// 「連続して add しても取りこぼさない」。

import { describe, expect, it, vi } from 'vitest';

import { GeoPoint } from '@aruku/engine/models/geo-point';

import {
  createRecentsRepository,
  destinationsKey,
  maxRecents,
  originsKey,
  type KeyValueStore,
} from '../../src/places/recents-repository';
import type { RecentPlace } from '../../src/places/recent-place';

function memoryStore(initial: Record<string, string> = {}): KeyValueStore {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

function place(name: string, overrides: Partial<RecentPlace> = {}): RecentPlace {
  return {
    name,
    placeId: null,
    latLng: new GeoPoint(35.6, 139.7),
    address: null,
    usedAt: null,
    ...overrides,
  };
}

describe('読み込み', () => {
  it('何も無ければ空', () => {
    expect(createRecentsRepository(memoryStore()).load()).toEqual([]);
  });

  it('空文字は空として読む', () => {
    const repo = createRecentsRepository(memoryStore({ [destinationsKey]: '' }));

    expect(repo.load()).toEqual([]);
  });

  it('壊れた JSON は空として読む', () => {
    const repo = createRecentsRepository(
      memoryStore({ [destinationsKey]: '{壊れている' }),
    );

    expect(repo.load()).toEqual([]);
  });

  it('配列でない JSON は空として読む', () => {
    const repo = createRecentsRepository(
      memoryStore({ [destinationsKey]: '{"name":"渋谷"}' }),
    );

    expect(repo.load()).toEqual([]);
  });

  // 1件の壊れで履歴を全部落とさない。読めたものは読む。
  it('地点として成立しない要素だけ読み飛ばす', () => {
    const repo = createRecentsRepository(
      memoryStore({
        [destinationsKey]: JSON.stringify([
          { name: '渋谷駅' },
          { placeId: 'p1' },
          'ごみ',
          { name: '新宿駅' },
        ]),
      }),
    );

    expect(repo.load().map((p) => p.name)).toEqual(['渋谷駅', '新宿駅']);
  });
});

describe('追加', () => {
  it('先頭へ積む', () => {
    const repo = createRecentsRepository(memoryStore());

    repo.add(place('渋谷駅'));
    repo.add(place('新宿駅'));

    expect(repo.load().map((p) => p.name)).toEqual(['新宿駅', '渋谷駅']);
  });

  it('同じ地点は重複させず先頭へ繰り上げる', () => {
    const repo = createRecentsRepository(memoryStore());

    repo.add(place('渋谷駅', { placeId: 'p1' }));
    repo.add(place('新宿駅', { placeId: 'p2' }));
    repo.add(place('渋谷駅', { placeId: 'p1' }));

    expect(repo.load().map((p) => p.name)).toEqual(['渋谷駅', '新宿駅']);
  });

  it('上限を超えたぶんは古い方から落とす', () => {
    const repo = createRecentsRepository(memoryStore());

    for (let i = 0; i < maxRecents + 3; i++) repo.add(place(`駅${i}`));

    const names = repo.load().map((p) => p.name);
    expect(names).toHaveLength(maxRecents);
    expect(names[0]).toBe(`駅${maxRecents + 2}`);
    expect(names).not.toContain('駅0');
  });

  it('使った時刻を打つ', () => {
    const now = new Date('2026-09-13T01:00:00.000Z');
    const repo = createRecentsRepository(memoryStore(), destinationsKey, () => now);

    repo.add(place('渋谷駅'));

    expect(repo.load()[0]!.usedAt).toEqual(now);
  });

  it('すでに時刻を持つ記録は打ち直さない', () => {
    const stamped = new Date('2026-01-01T00:00:00.000Z');
    const repo = createRecentsRepository(
      memoryStore(),
      destinationsKey,
      () => new Date('2026-09-13T01:00:00.000Z'),
    );

    repo.add(place('渋谷駅', { usedAt: stamped }));

    expect(repo.load()[0]!.usedAt).toEqual(stamped);
  });

  // localStorage は同期なので、Dart 版の _writeLock が防いでいた
  // 「load→save の間に別の add が割り込んで互いを上書きする」が起き得ない。
  it('連続して add しても取りこぼさない', () => {
    const repo = createRecentsRepository(memoryStore());

    repo.add(place('A'));
    repo.add(place('B'));
    repo.add(place('C'));

    expect(repo.load().map((p) => p.name)).toEqual(['C', 'B', 'A']);
  });

  it('座標と住所を保って往復する', () => {
    const repo = createRecentsRepository(memoryStore());

    repo.add(place('渋谷駅', { placeId: 'p1', address: '東京都渋谷区' }));

    const [restored] = repo.load();
    expect(restored!.latLng).toEqual(new GeoPoint(35.6, 139.7));
    expect(restored!.address).toBe('東京都渋谷区');
    expect(restored!.placeId).toBe('p1');
  });
});

describe('消去', () => {
  it('履歴を空にする', () => {
    const repo = createRecentsRepository(memoryStore());
    repo.add(place('渋谷駅'));

    repo.clear();

    expect(repo.load()).toEqual([]);
  });
});

describe('系統の独立', () => {
  it('目的地と出発地は互いに混ざらない', () => {
    const store = memoryStore();
    const destinations = createRecentsRepository(store, destinationsKey);
    const origins = createRecentsRepository(store, originsKey);

    destinations.add(place('渋谷駅'));
    origins.add(place('自宅'));

    expect(destinations.load().map((p) => p.name)).toEqual(['渋谷駅']);
    expect(origins.load().map((p) => p.name)).toEqual(['自宅']);
  });
});

// Safari のプライベートモード、サイトデータを止めた設定、容量超過。どれも
// localStorage のアクセス**自体**が投げる。履歴は利便のための機能なので、
// 読めない・書けないことで検索そのものを落としてはいけない。
describe('localStorage が使えない環境', () => {
  it('読めなければ空として扱う', () => {
    const repo = createRecentsRepository({
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
      removeItem: () => {},
    });

    expect(repo.load()).toEqual([]);
  });

  it('書けなくても落ちない', () => {
    const setItem = vi.fn(() => {
      throw new Error('QuotaExceededError');
    });
    const repo = createRecentsRepository({
      getItem: () => null,
      setItem,
      removeItem: () => {},
    });

    expect(() => repo.add(place('渋谷駅'))).not.toThrow();
    expect(setItem).toHaveBeenCalled();
  });

  it('消せなくても落ちない', () => {
    const repo = createRecentsRepository({
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {
        throw new Error('SecurityError');
      },
    });

    expect(() => repo.clear()).not.toThrow();
  });
});
