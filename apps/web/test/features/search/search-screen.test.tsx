// 移植元: lib/features/search/search_screen.dart と search_widgets.dart。
//
// 移植元の widget test は運んでいない（#386 の方針）。ここで押さえるのは、画面が
// 状態から何を出し、操作が状態・履歴・遷移へどう届くか。
//
// 読み上げ名は aria-label で明示している。jsdom は CSS を読まないので中身から
// 名前を組ませると、横並びの語が空白なしで繋がって実ブラウザと食い違う。

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StoreApi } from 'zustand/vanilla';

import { GeoPoint } from '@aruku/engine/models/geo-point';

import { SearchScreen } from '../../../src/features/search/search-screen';
import { searchDebounce } from '../../../src/features/search/search-state';
import { locationAvailable, locationDenied } from '../../../src/location/location-state';
import type { PlacePrediction } from '../../../src/places/place-prediction';
import type { RecentPlace } from '../../../src/places/recent-place';
import { PlacesException, type PlacesService } from '../../../src/places/places-service';
import {
  createRecentsRepository,
  destinationsKey,
  originsKey,
  type KeyValueStore,
  type RecentsRepository,
} from '../../../src/places/recents-repository';
import { Screen, screenPath } from '../../../src/navigation/screens';
import { createAppStore, type AppStore } from '../../../src/state/store';

const here = new GeoPoint(35.681, 139.767);
const shibuya = new GeoPoint(35.658, 139.701);

function prediction(
  name: string,
  overrides: Partial<PlacePrediction> = {},
): PlacePrediction {
  return {
    placeId: `id-${name}`,
    name,
    address: `${name}の住所`,
    distanceMeters: null,
    ...overrides,
  };
}

function saved(name: string, address: string | null = null): RecentPlace {
  return { name, placeId: `id-${name}`, latLng: shibuya, address, usedAt: null };
}

function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

interface Options {
  mode?: 'destination' | 'origin';
  located?: boolean;
  autocomplete?: (query: string) => Promise<PlacePrediction[]>;
  fetchLatLng?: (placeId: string) => Promise<GeoPoint | null>;

  /// 描画前に積んでおく履歴。画面は読み込んだ時点の履歴を出すので、
  /// 描いた後に足しても出てこない。
  seed?: Partial<Record<'destination' | 'origin', RecentPlace[]>>;
}

let store: StoreApi<AppStore>;
let recents: Record<'destination' | 'origin', RecentsRepository>;

function setup(options: Options = {}) {
  const navigate = vi.fn();
  const located = options.located ?? false;
  store = createAppStore({}, () => new Date(2026, 8, 13, 12, 0, 0), {
    request: async () => (located ? locationAvailable(here) : locationDenied),
  });
  store.getState().attachNavigator(navigate);
  act(() => {
    store.setState({
      locationState: located ? locationAvailable(here) : locationDenied,
    });
  });

  const kv = memoryStore();
  recents = {
    destination: createRecentsRepository(kv, destinationsKey),
    origin: createRecentsRepository(kv, originsKey),
  };

  for (const mode of ['destination', 'origin'] as const) {
    for (const place of options.seed?.[mode] ?? []) recents[mode].add(place);
  }

  const places: PlacesService = {
    autocomplete: options.autocomplete ?? (async () => []),
    fetchLatLng: options.fetchLatLng ?? (async () => shibuya),
    close() {},
  };

  render(
    <SearchScreen
      store={store}
      mode={options.mode ?? 'destination'}
      places={places}
      recents={recents}
    />,
  );
  return { navigate, store, recents };
}

/// 入力して、待ち合わせと問い合わせの解決まで進める。
async function type(text: string) {
  fireEvent.change(screen.getByRole('searchbox'), { target: { value: text } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(searchDebounce);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('入力欄', () => {
  it('目的地モードでは目的地を促す', () => {
    setup({ mode: 'destination' });

    expect(screen.getByRole('searchbox', { name: '目的地を検索' })).toBeTruthy();
  });

  it('出発地モードでは出発地を促す', () => {
    setup({ mode: 'origin' });

    expect(screen.getByRole('searchbox', { name: '出発地を検索' })).toBeTruthy();
  });

  it('開いた時点で入力を受けられる', () => {
    setup();

    expect(document.activeElement).toBe(screen.getByRole('searchbox'));
  });

  it('入力があるときだけ消去ボタンを出す', async () => {
    setup();

    expect(screen.queryByRole('button', { name: '入力を消去' })).toBeNull();

    await type('渋谷');

    expect(screen.getByRole('button', { name: '入力を消去' })).toBeTruthy();
  });

  it('消去すると入力も候補も消える', async () => {
    setup({ autocomplete: async () => [prediction('渋谷駅')] });
    await type('渋谷');
    expect(screen.getByRole('button', { name: '渋谷駅 渋谷駅の住所' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '入力を消去' }));

    expect(screen.getByRole<HTMLInputElement>('searchbox').value).toBe('');
    expect(screen.queryByText('渋谷駅の住所')).toBeNull();
  });

  it('戻るで home へ帰る', () => {
    const { navigate } = setup();

    fireEvent.click(screen.getByRole('button', { name: '戻る' }));

    expect(navigate).toHaveBeenCalledWith(screenPath[Screen.home]);
  });
});

describe('候補', () => {
  it('名称と住所を出す', async () => {
    setup({ autocomplete: async () => [prediction('渋谷駅')] });

    await type('渋谷');

    expect(
      screen.getByRole('button', { name: '渋谷駅 渋谷駅の住所' }),
    ).toBeTruthy();
    expect(screen.getByText('渋谷駅の住所')).toBeTruthy();
  });

  // 読み上げ名は「名称 住所」で組む。中身から組ませると jsdom が空白なしで繋ぐ。
  it('候補は名称と住所で読み上げられる', async () => {
    setup({ autocomplete: async () => [prediction('渋谷駅')] });

    await type('渋谷');

    expect(
      screen.getByRole('button', { name: '渋谷駅 渋谷駅の住所' }),
    ).toBeTruthy();
  });

  it('一致した部分を目立たせる', async () => {
    setup({ autocomplete: async () => [prediction('渋谷駅')] });

    await type('渋谷');

    expect(screen.getByText('渋谷', { selector: 'mark' })).toBeTruthy();
  });

  it('一致しない候補には印を付けない', async () => {
    setup({ autocomplete: async () => [prediction('ハチ公前')] });

    await type('渋谷');

    expect(screen.queryByText('渋谷', { selector: 'mark' })).toBeNull();
  });

  it('候補が無ければ別の語を促す', async () => {
    setup({ autocomplete: async () => [] });

    await type('xyzzy');

    expect(screen.getByText('候補が見つかりませんでした')).toBeTruthy();
  });

  it('失敗は生ステータスを添えて出す', async () => {
    setup({
      autocomplete: async () => {
        throw new PlacesException('REQUEST_DENIED');
      },
    });

    await type('渋谷');

    expect(screen.getByText('検索できませんでした (REQUEST_DENIED)')).toBeTruthy();
  });

  it('原因不明の失敗はステータスを付けずに出す', async () => {
    setup({
      autocomplete: async () => {
        throw new TypeError('Failed to fetch');
      },
    });

    await type('渋谷');

    expect(screen.getByText('検索できませんでした')).toBeTruthy();
  });
});

describe('候補の確定', () => {
  it('目的地モードは目的地を座標ごと設定して home へ帰る', async () => {
    const { navigate } = setup({
      mode: 'destination',
      autocomplete: async () => [prediction('渋谷駅')],
      fetchLatLng: async () => shibuya,
    });
    await type('渋谷');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '渋谷駅 渋谷駅の住所' }));
    });

    expect(store.getState().destination).toBe('渋谷駅');
    expect(store.getState().destinationLatLng).toEqual(shibuya);
    expect(navigate).toHaveBeenCalledWith(screenPath[Screen.home]);
  });

  it('出発地モードは出発地を設定する', async () => {
    setup({
      mode: 'origin',
      autocomplete: async () => [prediction('新宿駅')],
      fetchLatLng: async () => shibuya,
    });
    await type('新宿');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '新宿駅 新宿駅の住所' }));
    });

    expect(store.getState().origin).toBe('新宿駅');
    expect(store.getState().originLatLng).toEqual(shibuya);
    expect(store.getState().destination).toBeNull();
  });

  it('確定した地点をそのモードの履歴に残す', async () => {
    setup({
      mode: 'origin',
      autocomplete: async () => [prediction('新宿駅')],
    });
    await type('新宿');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '新宿駅 新宿駅の住所' }));
    });

    expect(recents.origin.load().map((p) => p.name)).toEqual(['新宿駅']);
    expect(recents.destination.load()).toEqual([]);
  });

  // 座標が取れない候補を通すと、経路照会まで行って初めて失敗する。
  it('座標を引けなければ確定させず別候補を促す', async () => {
    const { navigate } = setup({
      autocomplete: async () => [prediction('渋谷駅')],
      fetchLatLng: async () => null,
    });
    await type('渋谷');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '渋谷駅 渋谷駅の住所' }));
    });

    expect(
      screen.getByText(
        'この目的地は位置情報を取得できませんでした。別の候補を選んでください',
      ),
    ).toBeTruthy();
    expect(store.getState().destination).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('出発地モードの確定失敗は出発地として伝える', async () => {
    setup({
      mode: 'origin',
      autocomplete: async () => [prediction('新宿駅')],
      fetchLatLng: async () => null,
    });
    await type('新宿');

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '新宿駅 新宿駅の住所' }));
    });

    expect(
      screen.getByText(
        'この出発地は位置情報を取得できませんでした。別の候補を選んでください',
      ),
    ).toBeTruthy();
  });

  it('打ち直せば確定失敗の知らせは消える', async () => {
    setup({
      autocomplete: async () => [prediction('渋谷駅')],
      fetchLatLng: async () => null,
    });
    await type('渋谷');
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '渋谷駅 渋谷駅の住所' }));
    });

    await type('新宿');

    expect(
      screen.queryByText(
        'この目的地は位置情報を取得できませんでした。別の候補を選んでください',
      ),
    ).toBeNull();
  });

  // 座標解決の最中に別の候補を押せると、2件目の結果が1件目を上書きする。
  it('確定中は次の候補を受け付けない', async () => {
    let resolve!: (value: GeoPoint | null) => void;
    const fetchLatLng = vi.fn(
      () => new Promise<GeoPoint | null>((r) => (resolve = r)),
    );
    setup({
      autocomplete: async () => [prediction('渋谷駅'), prediction('新宿駅')],
      fetchLatLng,
    });
    await type('駅');

    fireEvent.click(screen.getByRole('button', { name: '渋谷駅 渋谷駅の住所' }));
    fireEvent.click(screen.getByRole('button', { name: '新宿駅 新宿駅の住所' }));

    expect(fetchLatLng).toHaveBeenCalledOnce();

    await act(async () => {
      resolve(shibuya);
    });
    expect(store.getState().destination).toBe('渋谷駅');
  });
});

describe('近くの店モード', () => {
  it('現在地が分かるときだけ出す', () => {
    setup({ located: true });

    expect(screen.getByRole('switch', { name: '近くの店' })).toBeTruthy();
  });

  it('現在地が無ければ出さない', () => {
    setup({ located: false });

    expect(screen.queryByRole('switch', { name: '近くの店' })).toBeNull();
  });

  it('入りきりを読み上げに乗せる', async () => {
    setup({ located: true });
    const toggle = screen.getByRole('switch', { name: '近くの店' });

    expect(toggle.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(toggle);

    expect(
      screen.getByRole('switch', { name: '近くの店' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('入れると距離の近い順に並べ替える', async () => {
    setup({
      located: true,
      autocomplete: async () => [
        prediction('遠い店', { distanceMeters: 900 }),
        prediction('近い店', { distanceMeters: 100 }),
      ],
    });
    fireEvent.click(screen.getByRole('switch', { name: '近くの店' }));

    await type('コンビニ');

    const names = screen
      .getAllByRole('button')
      .map((b) => b.getAttribute('aria-label'))
      .filter((name): name is string => name !== null && name.includes('の住所'));
    expect(names[0]).toContain('近い店');
  });
});

describe('履歴', () => {
  it('入力が空のときに出す', () => {
    setup({ seed: { destination: [saved('渋谷駅')] } });

    expect(
      screen.getByRole('heading', { name: '最近の目的地' }),
    ).toBeTruthy();
  });

  it('モードごとに別の系統を出す', () => {
    setup({
      mode: 'origin',
      seed: { destination: [saved('渋谷駅')], origin: [saved('自宅')] },
    });

    expect(screen.getByRole('heading', { name: '最近の出発地' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /渋谷駅/ })).toBeNull();
  });

  it('履歴から選ぶと確定して home へ帰る', () => {
    const { navigate } = setup({
      seed: { destination: [saved('渋谷駅', '東京都渋谷区')] },
    });

    fireEvent.click(screen.getByRole('button', { name: '渋谷駅 東京都渋谷区' }));

    expect(store.getState().destination).toBe('渋谷駅');
    expect(store.getState().destinationLatLng).toEqual(shibuya);
    expect(navigate).toHaveBeenCalledWith(screenPath[Screen.home]);
  });

  it('消去すると履歴が空になる', () => {
    setup({ seed: { destination: [saved('渋谷駅')] } });

    fireEvent.click(screen.getByRole('button', { name: '履歴を消去' }));

    expect(screen.queryByRole('heading', { name: '最近の目的地' })).toBeNull();
    expect(recents.destination.load()).toEqual([]);
  });

  it('履歴が無ければ見出しも出さない', () => {
    setup();

    expect(screen.queryByRole('heading', { name: '最近の目的地' })).toBeNull();
    expect(screen.queryByRole('button', { name: '履歴を消去' })).toBeNull();
  });
});

describe('現在地を使う', () => {
  it('出発地モードでは測位できていなくても出す', () => {
    setup({ mode: 'origin', located: false });

    expect(screen.getByRole('button', { name: '現在地を使う' })).toBeTruthy();
  });

  // 目的地に「現在地」を入れるには座標が要る。取れていないうちは出せない。
  it('目的地モードでは測位できているときだけ出す', () => {
    setup({ mode: 'destination', located: false });

    expect(screen.queryByRole('button', { name: '現在地を使う' })).toBeNull();
  });

  // 出発地の null は「未設定」ではなく「現在地を使う」。
  it('出発地モードは出発地を現在地へ戻す', () => {
    const { navigate } = setup({ mode: 'origin', located: false });
    act(() => {
      store.getState().setOrigin('自宅', shibuya);
    });

    fireEvent.click(screen.getByRole('button', { name: '現在地を使う' }));

    expect(store.getState().origin).toBeNull();
    expect(store.getState().originLatLng).toBeNull();
    expect(navigate).toHaveBeenCalledWith(screenPath[Screen.home]);
  });

  it('目的地モードは測位した座標を目的地にする', () => {
    const { navigate } = setup({ mode: 'destination', located: true });

    fireEvent.click(screen.getByRole('button', { name: '現在地を使う' }));

    expect(store.getState().destination).toBe('現在地');
    expect(store.getState().destinationLatLng).toEqual(here);
    expect(navigate).toHaveBeenCalledWith(screenPath[Screen.home]);
  });
});
