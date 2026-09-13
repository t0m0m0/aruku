// 移植元: lib/core/services/recents_repository.dart
//
// 書き込みの直列化（_writeLock）は運んでいない。SharedPreferences が非同期だった
// ために load→変更→save の間へ別の操作が割り込めたが、localStorage は同期なので
// 割り込む余地そのものが無い。
//
// replaceAll（クラウド同期の適用）も運んでいない。同期の相手——認証と Firestore——が
// まだ無く、運んでも呼ぶ側が存在しない。認証のスライスで対にして入れる。

import {
  dedupeKey,
  recentPlaceFromJson,
  recentPlaceToJson,
  type RecentPlace,
} from './recent-place';

/// 目的地履歴の保存キー。移植元の SharedPreferences キーをそのまま使う。
export const destinationsKey = 'recents.destinations.v1';

/// 出発地履歴の保存キー。目的地とは別系統で独立に管理する。
export const originsKey = 'recents.origins.v1';

/// 履歴として残す上限。超えたぶんは古い方から落とす。
export const maxRecents = 10;

/// localStorage のうち、このリポジトリが使う面だけ。
///
/// `Storage` をそのまま要求しないのは、テストが length / key / clear まで
/// 埋める必要が出るため。
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RecentsRepository {
  load(): RecentPlace[];

  /// 使った地点を先頭へ積む。同じ地点（[dedupeKey]）は重複させず繰り上げる。
  add(place: RecentPlace): void;

  clear(): void;
}

/// 現在時刻の供給元。テストで打刻を固定できるよう注入可能にする。
export type Now = () => Date;

/// ブラウザの localStorage。非セキュアコンテキストやサイトデータを止めた設定では
/// プロパティの**参照自体**が投げるので、掴むところから包む。
export function browserStore(): KeyValueStore {
  try {
    return globalThis.localStorage;
  } catch {
    return nullStore();
  }
}

/// 何も覚えない保存先。localStorage が掴めない環境での成り行き。
function nullStore(): KeyValueStore {
  return {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  };
}

export function createRecentsRepository(
  store: KeyValueStore = browserStore(),
  key: string = destinationsKey,
  now: Now = () => new Date(),
): RecentsRepository {
  function load(): RecentPlace[] {
    const raw = readRaw(store, key);
    if (raw === null || raw === '') return [];

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      return [];
    }
    if (!Array.isArray(decoded)) return [];

    // 1件の壊れで履歴を全部落とさない。地点として成立しないものだけ読み飛ばして、
    // 読めたものは読む。
    return decoded
      .map(recentPlaceFromJson)
      .filter((place): place is RecentPlace => place !== null);
  }

  function add(place: RecentPlace): void {
    // 打刻は入れる側の仕事。resolvePlacePrediction は「確定した地点」を返すだけで、
    // それが履歴に入る時刻を知らない。
    const stamped: RecentPlace =
      place.usedAt === null ? { ...place, usedAt: now() } : place;

    const added = dedupeKey(stamped);
    const kept = load().filter((e) => dedupeKey(e) !== added);
    save(store, key, [stamped, ...kept].slice(0, maxRecents));
  }

  function clear(): void {
    try {
      store.removeItem(key);
    } catch {
      // 消せないのは書けないのと同じ扱い。履歴は利便のための機能で、
      // これで検索そのものを止めてはいけない。
    }
  }

  return { load, add, clear };
}

function readRaw(store: KeyValueStore, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

function save(store: KeyValueStore, key: string, items: RecentPlace[]): void {
  try {
    store.setItem(key, JSON.stringify(items.map(recentPlaceToJson)));
  } catch {
    // 容量超過・プライベートモード。残らないだけで、この回の選択は成立している。
  }
}
