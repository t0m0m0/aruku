// 移植元: flutter-final:lib/features/home/home_screen.dart と home_widgets.dart。
//
// 移植元の widget test は運んでいない（#386 の方針）。ここで押さえるのは、画面が
// 状態から何を出し、操作が状態と遷移へどう届くか。
//
// ボタンは読み上げ名で引く。名前はラベルと現在値から組み上がるので、期待値が
// そのまま「スクリーンリーダーがどう読むか」の仕様になる。

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

/// home が要る外部依存。デスクトップ幅のインライン検索欄だけが使う。
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

/// 再マウントの検証で同じストアへ描き直せるよう、直近の setup のストアを保つ。
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
      onStartSearch={
        options.onStartSearch === undefined ? () => {} : options.onStartSearch
      }
    />,
  );
  return { navigate, store, request, deps };
}

describe('ホームの見出し', () => {
  // 日付と挨拶の小見出しは #432 で撤去した。日付は時刻欄が出すので、ここでは
  // 挨拶の文言と、小見出しの「日付 · 挨拶」の形が無いことを見る。
  it.each([
    new Date(2026, 8, 11, 6, 0, 0),
    new Date(2026, 8, 11, 12, 0, 0),
    new Date(2026, 8, 11, 18, 0, 0),
  ])('%s でも日付と挨拶の小見出しを出さない', (at) => {
    setup({}, { now: at });

    expect(screen.queryByText(/おはようございます|こんにちは|こんばんは/)).toBeNull();
    expect(screen.queryByText(/9月11日 \(金\) · /)).toBeNull();
  });

  // 入力欄の形は普通の乗換案内と同じなので、何も書かないと最短経路を探す
  // アプリだと読まれ、遠回りの結果が不具合に見える（#445）。
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

  // 期待値を config の定数から取らない。取ると、定数がプレースホルダ
  // （example.com）のままでも緑になる——#281 で実際にそうだった。
  it.each([
    ['利用規約', '/terms'],
    ['プライバシーポリシー', '/privacy'],
  ])('法的情報の%sは自サイトのページを新しいタブで開く', (name, url) => {
    setup();

    const legal = screen.getByRole('navigation', { name: '法的情報' });
    const link = within(legal).getByRole('link', { name });

    expect(link.getAttribute('href')).toBe(url);
    expect(link.getAttribute('target')).toBe('_blank');
    // target=_blank の暗黙の noopener に頼らない。rel を明示しない <a> は、
    // 古い実装では開いた先から window.opener 経由でこちらを操作できる。
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
    // StrictMode の二重実行を素通しすると、ここが 2 回になり権限ダイアログも 2 回出る。
    expect(request).toHaveBeenCalledOnce();
  });

  // 子画面へ行って戻ると HomeScreen は再マウントされる。効果を素通しすると、
  // 戻るたびに測位が走り、一度きりの許可を使うブラウザでは毎回ダイアログが出る。
  // 取り直しはエラー画面の再試行が受け持つ。
  it('戻ってきても取り直さない', async () => {
    const { request } = setup();
    await screen.findByText('位置情報なし');

    cleanup();
    render(
      <HomeScreen
        store={store}
        deps={screenDeps()}
        now={() => noon}
        onStartSearch={() => {}}
      />,
    );

    expect(await screen.findByText('位置情報なし')).toBeDefined();
    expect(request).toHaveBeenCalledOnce();
  });

  // 押しても何が起きたか見えず、出発地を指定済みなら何もしなかった（#441）。
  // 測位の失敗はエラー画面の再試行で取り直せる。
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

  // 行そのものを入力欄の形にした（#430）。横に検索ボタンを並べると、同じ遷移の
  // 入口が2つ読み上げられる。
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

    // 値は入力欄が持つ（#386 スライス5 で表示だけの欄を置き換えた）。
    expect((screen.getByLabelText('出発の時刻') as HTMLInputElement).value).toBe('09:05');
    expect((screen.getByLabelText('到着の時刻') as HTMLInputElement).value).toBe('10:30');
  });

  // 押せない › が ◀▶ のステッパーと並ぶと、押せる矢印と見分けがつかない。
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

  // 予算はちょうど使い切る量ではなく、歩ける上限。
  it('予算は歩ける上限として読ませる', () => {
    setup({
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 30 }),
    });

    expect(screen.getByText('1時間 30分').parentElement?.textContent).toBe(
      '最大 1時間 30分 歩ける',
    );
  });

  // 日跨ぎ。dateOffset を無視すると予算が負になり「— 」に化ける。
  it('日を跨ぐ到着でも予算が出て、日付が添う', () => {
    setup({
      departure: new TimeValue({ h: 23, m: 0 }),
      arrival: new TimeValue({ h: 0, m: 30, dateOffset: 1 }),
    });

    expect(screen.getByText('1時間 30分')).toBeDefined();
    const arrivalDate = screen.getByLabelText(
      ja.timeFieldDate(ja.homeArrivalLabel),
    ) as HTMLInputElement;
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

// 経路検索が配線されるまでの過渡的な形（PR #395 の Codex レビュー P1）。#386 スライス4 で
// ルート表は実物を渡すようになったが、「未配線なら押せない」という契約自体は残す——
// 落ちるより押せないほうがよい、という判断は配線の有無に依らない。
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

// 時刻フィールドは #386 スライス2 から表示だけで、押しても何も起きなかった。
// ここで押さえるのは、欄が状態へ届くことと、その結果が予算の表示へ反映されること。
describe('時刻フィールド', () => {
  it('入れた時刻が状態と予算の表示へ届く', () => {
    setup({
      departure: new TimeValue({ h: 13, m: 0 }),
      arrival: new TimeValue({ h: 14, m: 0 }),
    });

    // 確定は欄を離れたとき（打ちかけを確定しない・time-field.test.tsx 参照）。
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
      within(screen.getByRole('navigation', { name: '法的情報' })).getAllByRole('link').map((a) => a.textContent),
    ).toEqual(['利用規約', 'プライバシーポリシー']);
  });

  it('全画面の検索へ飛ばさず、その場で打てる欄を出す', () => {
    stubViewport(true);

    setup();

    expect(screen.getByRole('combobox', { name: '目的地を検索' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^目的地 / })).toBeNull();
  });

  it('目的地が未選択のとき、CTA はその場の欄へ焦点を移す', () => {
    // 全画面の検索へ飛ばすと、この幅で作ったインラインの導線を自分で迂回する
    // （PR #407 の Codex レビュー）。
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

  // 未指定は空欄ではなく「現在地を使う」。欄の既定値として見せる。
  it('未指定なら現在地の状態を欄の既定として出す', async () => {
    stubViewport(true);

    setup({}, { locations: [locationAvailable(somewhere)] });

    const field = screen.getByRole('combobox', { name: '出発地を検索' }) as HTMLInputElement;
    expect(field.value).toBe('');
    await vi.waitFor(() => {
      expect(field.placeholder).toBe('現在地');
    });
  });

  it('現在地が使えなければ、そう欄に出す', async () => {
    stubViewport(true);

    setup({}, { locations: [locationDenied] });

    const field = screen.getByRole('combobox', { name: '出発地を検索' }) as HTMLInputElement;
    await vi.waitFor(() => {
      expect(field.placeholder).toBe('位置情報なし');
    });
  });

  it('指定済みの出発地を欄に映す', () => {
    stubViewport(true);

    setup({ origin: '新宿駅', originLatLng: somewhere });

    expect(
      (screen.getByRole('combobox', { name: '出発地を検索' }) as HTMLInputElement).value,
    ).toBe('新宿駅');
  });

  it('候補を選ぶと出発地になる', async () => {
    stubViewport(true);
    const { store } = setup({}, {
      deps: screenDeps(async () => [
        { placeId: 'id-新宿駅', name: '新宿駅', address: '東京都新宿区', distanceMeters: null },
      ]),
    });

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
