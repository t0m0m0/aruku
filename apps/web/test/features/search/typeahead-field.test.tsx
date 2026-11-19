import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { StoreApi } from 'zustand/vanilla';

import { GeoPoint } from '@aruku/engine/models/geo-point';

import { TypeaheadField } from '../../../src/features/search/typeahead-field';
import { searchDebounce } from '../../../src/features/search/search-state';
import { locationAvailable } from '../../../src/location/location-state';
import type { PlacePrediction } from '../../../src/places/place-prediction';
import type { RecentPlace } from '../../../src/places/recent-place';
import type { PlacesService } from '../../../src/places/places-service';
import {
  createRecentsRepository,
  destinationsKey,
  type KeyValueStore,
  type RecentsRepository,
} from '../../../src/places/recents-repository';
import { createAppStore, type AppStore } from '../../../src/state/store';

const here = new GeoPoint(35.681, 139.767);
const shibuya = new GeoPoint(35.658, 139.701);

function prediction(name: string): PlacePrediction {
  return {
    placeId: `id-${name}`,
    name,
    address: `${name}の住所`,
    distanceMeters: null,
  };
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
  autocomplete?: (query: string) => Promise<PlacePrediction[]>;
  fetchLatLng?: (placeId: string) => Promise<GeoPoint | null>;
  seed?: RecentPlace[];
}

let store: StoreApi<AppStore>;
let recents: RecentsRepository;

function setup(options: Options = {}) {
  const navigate = vi.fn();
  store = createAppStore({}, () => new Date(2026, 8, 13, 12, 0, 0));
  store.getState().attachNavigator(navigate);
  act(() => {
    store.setState({ locationState: locationAvailable(here) });
  });

  recents = createRecentsRepository(memoryStore(), destinationsKey);
  for (const place of options.seed ?? []) recents.add(place);

  const places: PlacesService = {
    autocomplete: options.autocomplete ?? (async () => []),
    fetchLatLng: options.fetchLatLng ?? (async () => shibuya),
    close() {},
  };

  render(<TypeaheadField store={store} mode="destination" places={places} recents={recents} />);
  return { navigate, store, recents };
}

function field() {
  return screen.getByRole('combobox');
}

async function type(text: string) {
  fireEvent.change(field(), { target: { value: text } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(searchDebounce);
  });
}

function press(key: string) {
  fireEvent.keyDown(field(), { key });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('インラインのタイプアヘッド', () => {
  it('未入力でフォーカスすると履歴が並ぶ', () => {
    setup({
      seed: [{ name: '公園', placeId: 'id-公園', latLng: shibuya, address: null, usedAt: null }],
    });

    fireEvent.focus(field());

    expect(screen.getByRole('option', { name: /公園/ })).toBeTruthy();
  });

  it('打つと候補が並ぶ', async () => {
    setup({ autocomplete: async () => [prediction('美術館')] });

    fireEvent.focus(field());
    await type('び');

    expect(screen.getByRole('option', { name: /美術館/ })).toBeTruthy();
  });

  it('↓ と Enter だけで目的地を確定できる', async () => {
    const { navigate } = setup({
      autocomplete: async () => [prediction('一番目'), prediction('二番目')],
    });

    fireEvent.focus(field());
    await type('て');
    press('ArrowDown');
    await act(async () => {
      press('Enter');
    });

    expect(store.getState().destination).toBe('二番目');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('確定した目的地が欄に残り、一覧は閉じる', async () => {
    setup({ autocomplete: async () => [prediction('美術館')] });

    fireEvent.focus(field());
    await type('び');
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /美術館/ }));
    });

    expect((field() as HTMLInputElement).value).toBe('美術館');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Escape で一覧を閉じる', async () => {
    setup({ autocomplete: async () => [prediction('美術館')] });

    fireEvent.focus(field());
    await type('び');
    expect(screen.getByRole('listbox')).toBeTruthy();

    press('Escape');

    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('IME の変換中は Enter で確定しない', async () => {
    setup({ autocomplete: async () => [prediction('美術館')] });

    fireEvent.focus(field());
    await type('び');
    await act(async () => {
      fireEvent.keyDown(field(), { key: 'Enter', isComposing: true });
    });

    expect(store.getState().destination).toBeNull();
  });

  it('IME の変換中は ↓ で選択位置を動かさない', () => {
    setup({
      seed: [
        { name: '公園', placeId: 'id-公園', latLng: shibuya, address: null, usedAt: null },
        { name: '会館', placeId: 'id-会館', latLng: shibuya, address: null, usedAt: null },
      ],
    });

    fireEvent.focus(field());
    const before = field().getAttribute('aria-activedescendant');
    fireEvent.keyDown(field(), { key: 'ArrowDown', isComposing: true });

    expect(field().getAttribute('aria-activedescendant')).toBe(before);
  });

  it('Escape で閉じたあとの Enter では確定しない', async () => {
    setup({ autocomplete: async () => [prediction('美術館')] });

    fireEvent.focus(field());
    await type('び');
    press('Escape');
    await act(async () => {
      press('Enter');
    });

    expect(store.getState().destination).toBeNull();
  });

  it('Escape で閉じたあとも ↓ で開き直せる', async () => {
    setup({ autocomplete: async () => [prediction('美術館')] });

    fireEvent.focus(field());
    await type('び');
    press('Escape');
    press('ArrowDown');

    expect(screen.getByRole('listbox')).toBeTruthy();
  });

  it('確定したあと、もう一度押すと履歴が開く', async () => {
    setup({ autocomplete: async () => [prediction('美術館')] });

    fireEvent.focus(field());
    await type('び');
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /美術館/ }));
    });
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.click(field());

    expect(screen.getByRole('option', { name: /美術館/ })).toBeTruthy();
  });

  it('打ち替えると確定済みの目的地が外れる', async () => {
    setup({ autocomplete: async () => [prediction('美術館')] });

    fireEvent.focus(field());
    await type('び');
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /美術館/ }));
    });
    expect(store.getState().destination).toBe('美術館');

    await type('べ');

    expect(store.getState().destination).toBeNull();
  });

  it('座標を引けない候補は確定させず、理由を出す', async () => {
    setup({
      autocomplete: async () => [prediction('美術館')],
      fetchLatLng: async () => null,
    });

    fireEvent.focus(field());
    await type('び');
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /美術館/ }));
    });

    expect(store.getState().destination).toBeNull();
    expect(
      screen.getByText('この目的地は位置情報を取得できませんでした。別の候補を選んでください'),
    ).toBeTruthy();
  });

  it('候補が出ているときに「見つかりませんでした」を出さない', async () => {
    setup({ autocomplete: async () => [prediction('美術館')] });

    fireEvent.focus(field());
    await type('び');

    expect(screen.getByRole('option', { name: /美術館/ })).toBeTruthy();
    expect(screen.queryByText('候補が見つかりませんでした')).toBeNull();
  });

  it('候補が1件も無ければ理由を出す', async () => {
    setup({ autocomplete: async () => [] });

    fireEvent.focus(field());
    await type('ぬ');

    expect(screen.getByText('候補が見つかりませんでした')).toBeTruthy();
  });

  it('確定を待っている間に打ち替えたら、新しい候補が確定できる', async () => {
    const pending = new Map<string, (value: GeoPoint | null) => void>();
    setup({
      autocomplete: async (query) => [prediction(query === 'ふ' ? '古い' : '新しい')],
      fetchLatLng: async (placeId) => new Promise((resolve) => pending.set(placeId, resolve)),
    });

    fireEvent.focus(field());
    await type('ふ');
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /古い/ }));
    });

    await type('あ');
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /新しい/ }));
    });
    await act(async () => {
      pending.get('id-新しい')?.(shibuya);
    });

    expect(store.getState().destination).toBe('新しい');
  });

  it('追い越された確定は、走っている確定の錠を解かない', async () => {
    const pending = new Map<string, (value: GeoPoint | null) => void>();
    const fetchLatLng = vi.fn(
      (placeId: string) => new Promise<GeoPoint | null>((resolve) => pending.set(placeId, resolve)),
    );
    setup({
      autocomplete: async (query) => [prediction(query === 'ふ' ? '古い' : '新しい')],
      fetchLatLng,
    });

    fireEvent.focus(field());
    await type('ふ');
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /古い/ }));
    });

    await type('あ');
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /新しい/ }));
    });
    await act(async () => {
      pending.get('id-古い')?.(shibuya);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /新しい/ }));
    });
    expect(fetchLatLng.mock.calls.filter(([id]) => id === 'id-新しい')).toHaveLength(1);

    await act(async () => {
      pending.get('id-新しい')?.(shibuya);
    });
    expect(store.getState().destination).toBe('新しい');
  });

  it('確定したあとの選択位置は先頭へ戻る', async () => {
    setup({ autocomplete: async () => [prediction('一番目'), prediction('二番目')] });

    fireEvent.focus(field());
    await type('て');
    press('ArrowDown');
    await act(async () => {
      press('Enter');
    });
    expect(store.getState().destination).toBe('二番目');

    fireEvent.click(field());
    const active = field().getAttribute('aria-activedescendant');

    expect(active).not.toBeNull();
    expect(document.getElementById(active ?? '')).not.toBeNull();
  });

  it('選択位置の行を見えるところへ送る', async () => {
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    setup({ autocomplete: async () => [prediction('一番目'), prediction('二番目')] });

    fireEvent.focus(field());
    await type('て');
    scroll.mockClear();
    press('ArrowDown');

    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    scroll.mockRestore();
  });

  it('確定した目的地は消去ボタンで外せる', async () => {
    setup({ autocomplete: async () => [prediction('美術館')] });

    fireEvent.focus(field());
    await type('び');
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /美術館/ }));
    });

    fireEvent.click(screen.getByRole('button', { name: '入力を消去' }));

    expect(store.getState().destination).toBeNull();
    expect((field() as HTMLInputElement).value).toBe('');
  });

  it('打ちかけの文字も消去ボタンで消せる', async () => {
    setup({ autocomplete: async () => [prediction('美術館')] });

    fireEvent.focus(field());
    await type('び');

    fireEvent.click(screen.getByRole('button', { name: '入力を消去' }));

    expect((field() as HTMLInputElement).value).toBe('');
  });

  it('消すものが無ければ消去ボタンを出さない', () => {
    setup();

    fireEvent.focus(field());

    expect(screen.queryByRole('button', { name: '入力を消去' })).toBeNull();
  });

  it('選んだ地点は履歴へ積む', async () => {
    setup({ autocomplete: async () => [prediction('美術館')] });

    fireEvent.focus(field());
    await type('び');
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: /美術館/ }));
    });

    expect(recents.load().map((r) => r.name)).toEqual(['美術館']);
  });
});
