// 移植元: lib/features/home/home_screen.dart と home_widgets.dart。
//
// 移植元の widget test は運んでいない（#386 の方針）。ここで押さえるのは、画面が
// 状態から何を出し、操作が状態と遷移へどう届くか。
//
// ボタンは読み上げ名で引く。名前はラベルと現在値から組み上がるので、期待値が
// そのまま「スクリーンリーダーがどう読むか」の仕様になる。

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { StoreApi } from 'zustand/vanilla';

import { GeoPoint } from '@aruku/engine/models/geo-point';
import { TimeValue } from '@aruku/engine/models/time-value';

import { HomeScreen } from '../../../src/features/home/home-screen';
import {
  locationAvailable,
  locationDenied,
  type LocationState,
} from '../../../src/location/location-state';
import type { RouteCore } from '../../../src/state/app-state';
import { createAppStore, type AppStore } from '../../../src/state/store';

const noon = new Date(2026, 8, 11, 12, 0, 0);
const somewhere = new GeoPoint(35.681, 139.767);

interface Options {
  now?: Date;
  onStartSearch?: () => void;
  locations?: LocationState[];
}

/// 再マウントの検証で同じストアへ描き直せるよう、直近の setup のストアを保つ。
let store: StoreApi<AppStore>;

function setup(initial: Partial<RouteCore> = {}, options: Options = {}) {
  const navigate = vi.fn();
  const at = options.now ?? noon;
  const results = [...(options.locations ?? [locationDenied])];
  const request = vi.fn(() => Promise.resolve(results.shift() ?? locationDenied));
  store = createAppStore(initial, () => at, { request });
  store.getState().attachNavigator(navigate);

  render(
    <HomeScreen
      store={store}
      now={() => at}
      onStartSearch={options.onStartSearch ?? (() => {})}
    />,
  );
  return { navigate, store, request };
}

describe('ホームの見出し', () => {
  it.each([
    [new Date(2026, 8, 11, 6, 0, 0), 'おはようございます'],
    [new Date(2026, 8, 11, 12, 0, 0), 'こんにちは'],
    [new Date(2026, 8, 11, 18, 0, 0), 'こんばんは'],
  ])('%s には「%s」と挨拶する', (at, greeting) => {
    setup({}, { now: at });

    expect(screen.getByText(`9月11日 (金) · ${greeting}`)).toBeDefined();
  });

  it('設定へ行ける', () => {
    const { navigate } = setup();

    fireEvent.click(screen.getByRole('button', { name: '設定を開く' }));

    expect(navigate).toHaveBeenCalledWith('/home/settings');
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
    // StrictMode の二重実行を素通しすると、ここが 2 回になり権限ダイアログも 2 回出る。
    expect(request).toHaveBeenCalledOnce();
  });

  // 子画面へ行って戻ると HomeScreen は再マウントされる。効果を素通しすると、
  // 戻るたびに測位が走り、一度きりの許可を使うブラウザでは毎回ダイアログが出る。
  // 取り直しはコンパスという明示の導線がある。
  it('戻ってきても取り直さない', async () => {
    const { request } = setup();
    await screen.findByText('位置情報なし');

    cleanup();
    render(<HomeScreen store={store} now={() => noon} onStartSearch={() => {}} />);

    expect(await screen.findByText('位置情報なし')).toBeDefined();
    expect(request).toHaveBeenCalledOnce();
  });

  it('コンパスで取り直せる', async () => {
    setup({}, { locations: [locationDenied, locationAvailable(somewhere)] });
    await screen.findByText('位置情報なし');

    fireEvent.click(screen.getByRole('button', { name: '現在地を再取得' }));

    expect(await screen.findByText('現在地')).toBeDefined();
  });

  it('押すと出発地の検索へ行く', () => {
    const { navigate } = setup({ origin: '新宿駅' });

    fireEvent.click(screen.getByRole('button', { name: '出発 新宿駅' }));

    expect(navigate).toHaveBeenCalledWith('/home/search-origin');
  });
});

describe('ホームの目的地', () => {
  it('未指定なら入力を促す', () => {
    expect(setup() && screen.getByRole('button', { name: '目的地 どこへ歩く?' })).toBeDefined();
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

  it('検索チップからも目的地の検索へ行く', () => {
    const { navigate } = setup();

    fireEvent.click(screen.getByRole('button', { name: '目的地を検索' }));

    expect(navigate).toHaveBeenCalledWith('/home/search');
  });
});

describe('ホームの時刻', () => {
  it('出発と到着を出す', () => {
    setup({
      departure: new TimeValue({ h: 9, m: 5 }),
      arrival: new TimeValue({ h: 10, m: 30 }),
    });

    expect(screen.getByText('09:05')).toBeDefined();
    expect(screen.getByText('10:30')).toBeDefined();
  });

  it('予算は出発と到着の差から出す', () => {
    setup({
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 30 }),
    });

    expect(screen.getByText('1時間 30分')).toBeDefined();
  });

  // 日跨ぎ。dateOffset を無視すると予算が負になり「— 」に化ける。
  it('日を跨ぐ到着でも予算が出て、日付が添う', () => {
    setup({
      departure: new TimeValue({ h: 23, m: 0 }),
      arrival: new TimeValue({ h: 0, m: 30, dateOffset: 1 }),
    });

    expect(screen.getByText('1時間 30分')).toBeDefined();
    expect(screen.getByText('明日')).toBeDefined();
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

    fireEvent.click(screen.getByRole('button', { name: 'ルートを検索' }));

    expect(onStartSearch).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });
});
