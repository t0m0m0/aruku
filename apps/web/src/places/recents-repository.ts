import {
  dedupeKey,
  recentPlaceFromJson,
  recentPlaceToJson,
  type RecentPlace,
} from './recent-place';

export const destinationsKey = 'recents.destinations.v1';

export const originsKey = 'recents.origins.v1';

export const maxRecents = 10;

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RecentsRepository {
  load(): RecentPlace[];

  add(place: RecentPlace): void;

  clear(): void;
}

export type Now = () => Date;

export function browserStore(): KeyValueStore {
  try {
    return globalThis.localStorage;
  } catch {
    return nullStore();
  }
}

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

    return decoded.map(recentPlaceFromJson).filter((place): place is RecentPlace => place !== null);
  }

  function add(place: RecentPlace): void {
    const stamped: RecentPlace = place.usedAt === null ? { ...place, usedAt: now() } : place;

    const added = dedupeKey(stamped);
    const kept = load().filter((e) => dedupeKey(e) !== added);
    save(store, key, [stamped, ...kept].slice(0, maxRecents));
  }

  function clear(): void {
    try {
      store.removeItem(key);
    } catch {}
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
  } catch {}
}
