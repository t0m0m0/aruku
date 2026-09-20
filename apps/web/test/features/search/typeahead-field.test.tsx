// 移植元: lib/features/search/desktop_typeahead_field.dart（#372）。
//
// 全画面の検索へ飛ばさず、条件カードの中で目的地を決めきる欄。押さえるのは
// 「遷移しないこと」と、キーボードだけで確定できること——移植元が InkWell を避けて
// Shortcuts/Actions を積んだのと同じ要請が web にもある。

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

  render(
    <TypeaheadField store={store} mode="destination" places={places} recents={recents} />,
  );
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
      seed: [
        { name: '公園', placeId: 'id-公園', latLng: shibuya, address: null, usedAt: null },
      ],
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
    // インライン化の眼目。確定しても画面は動かない。
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

  it('打ち替えると確定済みの目的地が外れる', async () => {
    // 表示は新しいクエリ・状態は古い座標、というズレを作らせない。残すと検索の
    // CTA が有効なまま前の目的地へ経路を引く（移植元 _clearSelection）。
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
      screen.getByText(
        'この目的地は位置情報を取得できませんでした。別の候補を選んでください',
      ),
    ).toBeTruthy();
  });

  it('候補が出ているときに「見つかりませんでした」を出さない', async () => {
    // 一覧とメッセージは排他。同時に出ると、候補が並んでいるのに「無い」と
    // 書かれた画面になる（実ブラウザで発覚）。
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
