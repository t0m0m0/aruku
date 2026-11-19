import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StoreApi } from 'zustand/vanilla';

import { GeoPoint } from '@aruku/engine/models/geo-point';
import { TimeValue } from '@aruku/engine/models/time-value';

import { HomeScreen } from '../../../src/features/home/home-screen';
import {
  locationAvailable,
  locationDenied,
  type LocationState,
} from '../../../src/location/location-state';
import { stubViewport } from '../../layout/viewport';
import { ja } from '../../../src/i18n/ja';
import type { ScreenDeps } from '../../../src/navigation/screen-deps';
import { Screen, screenPath } from '../../../src/navigation/screens';
import {
  createRecentsRepository,
  destinationsKey,
  originsKey,
  type KeyValueStore,
} from '../../../src/places/recents-repository';
import type { PlacePrediction } from '../../../src/places/place-prediction';
import type { RouteCore } from '../../../src/state/app-state';
import { createAppStore, type AppStore } from '../../../src/state/store';

const noon = new Date(2026, 8, 11, 12, 0, 0);
const somewhere = new GeoPoint(35.681, 139.767);

interface Options {
  now?: Date;
  onStartSearch?: (() => void) | null;
  locations?: LocationState[];
  deps?: ScreenDeps;
}

function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

function screenDeps(
  autocomplete: (query: string) => Promise<PlacePrediction[]> = async () => [],
): ScreenDeps {
  const kv = memoryStore();
  return {
    places: {
      autocomplete,
      fetchLatLng: async () => somewhere,
      close() {},
    },
    recents: {
      destination: createRecentsRepository(kv, destinationsKey),
      origin: createRecentsRepository(kv, originsKey),
    },
  };
}

let store: StoreApi<AppStore>;

function setup(initial: Partial<RouteCore> = {}, options: Options = {}) {
  const navigate = vi.fn();
  const at = options.now ?? noon;
  const results = [...(options.locations ?? [locationDenied])];
  const request = vi.fn(() => Promise.resolve(results.shift() ?? locationDenied));
  store = createAppStore(initial, () => at, { request });
  store.getState().attachNavigator(navigate);

  const deps = options.deps ?? screenDeps();
  render(
    <HomeScreen
      store={store}
      deps={deps}
      now={() => at}
      onStartSearch={options.onStartSearch === undefined ? () => {} : options.onStartSearch}
    />,
  );
  return { navigate, store, request, deps };
}

describe('ホームの見出し', () => {
  it.each([
    new Date(2026, 8, 11, 6, 0, 0),
    new Date(2026, 8, 11, 12, 0, 0),
    new Date(2026, 8, 11, 18, 0, 0),
  ])('%s でも日付と挨拶の小見出しを出さない', (at) => {
    setup({}, { now: at });

    expect(screen.queryByText(/おはようございます|こんにちは|こんばんは/)).toBeNull();
    expect(screen.queryByText(/9月11日 \(金\) · /)).toBeNull();
  });

  it('主見出しは見出しレベル1で、最短ではなく歩くルートを出すアプリだと見せる', () => {
    setup();

    const heading = screen.getByRole('heading', { level: 1 });

    expect(heading.textContent).toBe('間に合う範囲でいちばん歩くルート');
    expect(heading.className).not.toContain('sr-only');
    expect(
      screen.getByText('最短ルートではなく、時間いっぱい歩けるようなルートを提示します'),
    ).toBeDefined();
  });

  it('挨拶は出さない', () => {
    setup();

    expect(screen.queryByText(/歩こう/)).toBeNull();
  });

  it.each([
    ['利用規約', '/terms'],
    ['プライバシーポリシー', '/privacy'],
  ])('法的情報の%sは自サイトのページを新しいタブで開く', (name, url) => {
    setup();

    const legal = screen.getByRole('navigation', { name: '法的情報' });
    const link = within(legal).getByRole('link', { name });

    expect(link.getAttribute('href')).toBe(url);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('ホームの出発地', () => {
  it('出発地が指定されていればそれを読み上げる', () => {
    setup({ origin: '新宿駅' });

    expect(screen.getByRole('button', { name: '出発 新宿駅' })).toBeDefined();
  });

  it('指定が無ければ開いた時点で現在地を取りに行き、結果を出す', async () => {
    const { request } = setup();

    expect(screen.getByText('現在地 · 取得中...')).toBeDefined();
    expect(await screen.findByText('位置情報なし')).toBeDefined();
    expect(request).toHaveBeenCalledOnce();
  });

  it('戻ってきても取り直さない', async () => {
    const { request } = setup();
    await screen.findByText('位置情報なし');

    cleanup();
    render(
      <HomeScreen store={store} deps={screenDeps()} now={() => noon} onStartSearch={() => {}} />,
    );

    expect(await screen.findByText('位置情報なし')).toBeDefined();
    expect(request).toHaveBeenCalledOnce();
  });

  it('出発地欄に現在地の再取得ボタンを置かない', async () => {
    setup();
    await screen.findByText('位置情報なし');

    expect(screen.queryByRole('button', { name: '現在地を再取得' })).toBeNull();
  });

  it('押すと出発地の検索へ行く', () => {
    const { navigate } = setup({ origin: '新宿駅' });

    fireEvent.click(screen.getByRole('button', { name: '出発 新宿駅' }));

    expect(navigate).toHaveBeenCalledWith('/home/search-origin');
  });
});

describe('ホームの目的地', () => {
  it('未指定なら入力を促す', () => {
    setup();
    expect(screen.getByRole('button', { name: '目的地 どこへ歩く?' })).toBeDefined();
  });

  it('指定済みならその名前を読み上げる', () => {
    setup({ destination: '高尾山口駅', destinationLatLng: somewhere });

    expect(screen.getByRole('button', { name: '目的地 高尾山口駅' })).toBeDefined();
  });

  it('押すと目的地の検索へ行く', () => {
    const { navigate } = setup();

    fireEvent.click(screen.getByRole('button', { name: '目的地 どこへ歩く?' }));

    expect(navigate).toHaveBeenCalledWith('/home/search');
  });

  it('検索の入口は行そのものだけで、別のボタンを並べない', () => {
    setup();

    expect(screen.queryByRole('button', { name: '目的地を検索' })).toBeNull();
  });
});

describe('ホームの時刻', () => {
  it('出発と到着を出す', () => {
    setup({
      departure: new TimeValue({ h: 9, m: 5 }),
      arrival: new TimeValue({ h: 10, m: 30 }),
    });

    expect(screen.getByLabelText<HTMLInputElement>('出発の時刻').value).toBe('09:05');
    expect(screen.getByLabelText<HTMLInputElement>('到着の時刻').value).toBe('10:30');
  });

  it('矢印はステッパーのボタンにだけ出て、出発と到着の間に区切りの矢印を置かない', () => {
    for (const desktop of [false, true]) {
      stubViewport(desktop);
      setup({});
      const section = screen.getByLabelText('出発の時刻').closest('section')!;
      const chevrons = section.querySelectorAll('path[d="M9 6l6 6-6 6"]');
      for (const chevron of chevrons) expect(chevron.closest('button')).not.toBeNull();
      cleanup();
    }
    vi.unstubAllGlobals();
  });

  it('予算は出発と到着の差から出す', () => {
    setup({
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 30 }),
    });

    expect(screen.getByText('1時間 30分')).toBeDefined();
  });

  it('予算は歩ける上限として読ませる', () => {
    setup({
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 30 }),
    });

    expect(screen.getByText('1時間 30分').parentElement?.textContent).toBe(
      '最大 1時間 30分 歩ける',
    );
  });

  it('日を跨ぐ到着でも予算が出て、日付が添う', () => {
    setup({
      departure: new TimeValue({ h: 23, m: 0 }),
      arrival: new TimeValue({ h: 0, m: 30, dateOffset: 1 }),
    });

    expect(screen.getByText('1時間 30分')).toBeDefined();
    const arrivalDate = screen.getByLabelText<HTMLInputElement>(
      ja.timeFieldDate(ja.homeArrivalLabel),
    );
    expect(arrivalDate.value).toBe('2026-09-12');
  });
});

describe('ホームの CTA', () => {
  it('目的地が無いときは選ばせ、検索画面へ送る', () => {
    const onStartSearch = vi.fn();
    const { navigate } = setup({}, { onStartSearch });

    fireEvent.click(screen.getByRole('button', { name: '目的地を選ぶ' }));

    expect(navigate).toHaveBeenCalledWith('/home/search');
    expect(onStartSearch).not.toHaveBeenCalled();
  });

  it('目的地があるときは検索を始める', () => {
    const onStartSearch = vi.fn();
    const { navigate } = setup(
      { destination: '高尾山口駅', destinationLatLng: somewhere },
      { onStartSearch },
    );

    fireEvent.click(screen.getByRole('button', { name: '歩けるルートを探す' }));

    expect(onStartSearch).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('経路検索が未配線のときの CTA', () => {
  it('目的地があっても押せない', () => {
    setup({ destination: '渋谷駅' }, { onStartSearch: null });

    const cta = screen.getByRole('button', { name: '経路検索は準備中' });
    expect((cta as HTMLButtonElement).disabled).toBe(true);
  });

  it('目的地が無ければ今までどおり目的地を選びに行く', () => {
    const { navigate } = setup({}, { onStartSearch: null });

    fireEvent.click(screen.getByRole('button', { name: '目的地を選ぶ' }));

    expect(navigate).toHaveBeenCalledWith(screenPath[Screen.search]);
  });

  it('配線されていれば押せる', () => {
    const onStartSearch = vi.fn();
    setup({ destination: '渋谷駅' }, { onStartSearch });

    fireEvent.click(screen.getByRole('button', { name: '歩けるルートを探す' }));

    expect(onStartSearch).toHaveBeenCalledOnce();
  });
});

describe('時刻フィールド', () => {
  it('入れた時刻が状態と予算の表示へ届く', () => {
    setup({
      departure: new TimeValue({ h: 13, m: 0 }),
      arrival: new TimeValue({ h: 14, m: 0 }),
    });

    const time = screen.getByLabelText('出発の時刻');
    fireEvent.change(time, { target: { value: '13:30' } });
    fireEvent.blur(time);

    expect(store.getState().departure.format()).toBe('13:30');
    expect(screen.getByText('30分')).toBeTruthy();
  });

  it('到着の日付も選べる', () => {
    setup({
      departure: new TimeValue({ h: 13, m: 0 }),
      arrival: new TimeValue({ h: 14, m: 0 }),
    });

    const date = screen.getByLabelText('到着の日付');
    fireEvent.change(date, { target: { value: '2026-09-12' } });
    fireEvent.blur(date);

    expect(store.getState().arrival.dateOffset).toBe(1);
  });
});

describe('デスクトップ幅の目的地', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('法的情報のリンクはこの幅でも出る', () => {
    stubViewport(true);
    setup();

    expect(
      within(screen.getByRole('navigation', { name: '法的情報' }))
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['利用規約', 'プライバシーポリシー']);
  });

  it('全画面の検索へ飛ばさず、その場で打てる欄を出す', () => {
    stubViewport(true);

    setup();

    expect(screen.getByRole('combobox', { name: '目的地を検索' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^目的地 / })).toBeNull();
  });

  it('目的地が未選択のとき、CTA はその場の欄へ焦点を移す', () => {
    stubViewport(true);
    const { navigate } = setup();

    fireEvent.click(screen.getByRole('button', { name: '目的地を選ぶ' }));

    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: '目的地を検索' }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('モバイル幅では今までどおり検索画面へ渡す', () => {
    stubViewport(false);
    const { navigate } = setup();

    fireEvent.click(screen.getByRole('button', { name: '目的地 どこへ歩く?' }));

    expect(screen.queryByRole('combobox')).toBeNull();
    expect(navigate).toHaveBeenCalledWith(screenPath[Screen.search]);
  });
});

describe('デスクトップ幅の出発地', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('全画面の検索へ飛ばさず、その場で打てる欄を出す', () => {
    stubViewport(true);

    setup();

    expect(screen.getByRole('combobox', { name: '出発地を検索' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^出発 / })).toBeNull();
  });

  it('未指定なら現在地の状態を欄の既定として出す', async () => {
    stubViewport(true);

    setup({}, { locations: [locationAvailable(somewhere)] });

    const field = screen.getByRole<HTMLInputElement>('combobox', { name: '出発地を検索' });
    expect(field.value).toBe('');
    await vi.waitFor(() => {
      expect(field.placeholder).toBe('現在地');
    });
  });

  it('現在地が使えなければ、そう欄に出す', async () => {
    stubViewport(true);

    setup({}, { locations: [locationDenied] });

    const field = screen.getByRole<HTMLInputElement>('combobox', { name: '出発地を検索' });
    await vi.waitFor(() => {
      expect(field.placeholder).toBe('位置情報なし');
    });
  });

  it('指定済みの出発地を欄に映す', () => {
    stubViewport(true);

    setup({ origin: '新宿駅', originLatLng: somewhere });

    expect(screen.getByRole<HTMLInputElement>('combobox', { name: '出発地を検索' }).value).toBe(
      '新宿駅',
    );
  });

  it('候補を選ぶと出発地になる', async () => {
    stubViewport(true);
    const { store } = setup(
      {},
      {
        deps: screenDeps(async () => [
          { placeId: 'id-新宿駅', name: '新宿駅', address: '東京都新宿区', distanceMeters: null },
        ]),
      },
    );

    const field = screen.getByRole('combobox', { name: '出発地を検索' });
    fireEvent.focus(field);
    fireEvent.change(field, { target: { value: '新宿' } });
    fireEvent.click(await screen.findByRole('option', { name: /新宿駅/ }));

    await vi.waitFor(() => {
      expect(store.getState().origin).toBe('新宿駅');
    });
    expect(store.getState().originLatLng).toEqual(somewhere);
  });

  it('消すと現在地へ戻る', async () => {
    stubViewport(true);
    const { store } = setup({ origin: '新宿駅', originLatLng: somewhere });

    fireEvent.click(screen.getByRole('button', { name: ja.searchClearInput }));

    expect(store.getState().origin).toBeNull();
    expect(store.getState().originLatLng).toBeNull();
  });
});
