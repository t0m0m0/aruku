// 移植元: lib/features/search/places_provider.dart と
// test/features/search/places_provider_test.dart

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GeoPoint } from '@aruku/engine/models/geo-point';

import type { PlacePrediction } from '../../../src/places/place-prediction';
import { PlacesException, type PlacesService } from '../../../src/places/places-service';
import {
  createSearchState,
  searchDebounce,
  type SearchState,
} from '../../../src/features/search/search-state';

function prediction(
  placeId: string,
  distanceMeters: number | null = null,
): PlacePrediction {
  return { placeId, name: placeId, address: `${placeId}の住所`, distanceMeters };
}

interface Harness {
  readonly state: SearchState;
  readonly autocomplete: ReturnType<typeof vi.fn>;
}

function harness(
  options: {
    respond?: (query: string, bias: GeoPoint | null) => Promise<PlacePrediction[]>;
    location?: GeoPoint | null;
  } = {},
): Harness {
  const respond = options.respond ?? (async () => []);
  const autocomplete = vi.fn(
    async (query: string, bias: GeoPoint | null = null) => respond(query, bias),
  );
  const service: PlacesService = {
    autocomplete,
    fetchLatLng: async () => null,
    close() {},
  };
  const state = createSearchState({
    service,
    currentLocation: () => options.location ?? null,
  });
  return { state, autocomplete };
}

/// debounce を跨いで、走り出した fetch の解決まで進める。
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(searchDebounce);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('入力の待ち合わせ', () => {
  it('打っている間は問い合わせない', async () => {
    const { state, autocomplete } = harness();

    state.getState().search('渋');
    await vi.advanceTimersByTimeAsync(searchDebounce - 1);

    expect(autocomplete).not.toHaveBeenCalled();
  });

  it('手が止まってから問い合わせる', async () => {
    const { state, autocomplete } = harness();

    state.getState().search('渋谷');
    await settle();

    expect(autocomplete).toHaveBeenCalledWith('渋谷', null);
  });

  // 1文字ごとに投げると課金リクエストが打鍵数だけ出る。
  it('連打しても最後の1回だけ問い合わせる', async () => {
    const { state, autocomplete } = harness();

    state.getState().search('渋');
    await vi.advanceTimersByTimeAsync(100);
    state.getState().search('渋谷');
    await vi.advanceTimersByTimeAsync(100);
    state.getState().search('渋谷駅');
    await settle();

    expect(autocomplete).toHaveBeenCalledOnce();
    expect(autocomplete).toHaveBeenCalledWith('渋谷駅', null);
  });

  it('問い合わせの前から待ち状態を出す', () => {
    const { state } = harness();

    state.getState().search('渋谷');

    expect(state.getState().status).toBe('loading');
  });

  it('空のクエリでは問い合わせず待ち状態にもしない', async () => {
    const { state, autocomplete } = harness();

    state.getState().search('');
    await settle();

    expect(autocomplete).not.toHaveBeenCalled();
    expect(state.getState().status).toBe('idle');
  });

  it('クエリを消しても近くの店モードは保つ', async () => {
    const { state } = harness({ location: new GeoPoint(35.6, 139.7) });

    state.getState().setNearby(true);
    state.getState().search('');

    expect(state.getState().nearby).toBe(true);
  });

  it('入力し直した時点で前の候補を消す', async () => {
    const { state } = harness({ respond: async () => [prediction('a')] });

    state.getState().search('渋谷');
    await settle();
    state.getState().search('新宿');

    expect(state.getState().suggestions).toEqual([]);
  });
});

describe('位置バイアス', () => {
  it('現在地が分かるときは渡す', async () => {
    const here = new GeoPoint(35.6, 139.7);
    const { state, autocomplete } = harness({ location: here });

    state.getState().search('コンビニ');
    await settle();

    expect(autocomplete).toHaveBeenCalledWith('コンビニ', here);
  });
});

describe('世代のガード', () => {
  // 遅れて返った古い検索の結果で、新しい検索の表示を上書きしてはいけない。
  it('追い越された結果は反映しない', async () => {
    const pending = new Map<string, (value: PlacePrediction[]) => void>();
    const { state } = harness({
      respond: (query) =>
        new Promise<PlacePrediction[]>((resolve) => pending.set(query, resolve)),
    });

    state.getState().search('古い');
    await settle();
    state.getState().search('新しい');
    await settle();

    pending.get('新しい')!([prediction('new')]);
    await vi.advanceTimersByTimeAsync(0);
    pending.get('古い')!([prediction('old')]);
    await vi.advanceTimersByTimeAsync(0);

    expect(state.getState().suggestions.map((p) => p.placeId)).toEqual(['new']);
  });

  it('追い越された失敗もエラーにしない', async () => {
    const pending = new Map<string, (reason: unknown) => void>();
    const { state } = harness({
      respond: (query) =>
        new Promise<PlacePrediction[]>((_resolve, reject) =>
          pending.set(query, reject),
        ),
    });

    state.getState().search('古い');
    await settle();
    state.getState().search('新しい');
    await settle();

    pending.get('古い')!(new PlacesException('REQUEST_DENIED'));
    await vi.advanceTimersByTimeAsync(0);

    expect(state.getState().status).toBe('loading');
  });

  // 空のクエリも世代を進める。進めないと、走っている fetch が後から
  // 「候補あり」を書き戻して、消したはずの入力に候補が残る。
  it('入力を消した後に届いた結果も反映しない', async () => {
    let resolve!: (value: PlacePrediction[]) => void;
    const { state } = harness({
      respond: () => new Promise<PlacePrediction[]>((r) => (resolve = r)),
    });

    state.getState().search('渋谷');
    await settle();
    state.getState().search('');

    resolve([prediction('a')]);
    await vi.advanceTimersByTimeAsync(0);

    expect(state.getState().status).toBe('idle');
    expect(state.getState().suggestions).toEqual([]);
  });
});

describe('近くの店モード', () => {
  const here = new GeoPoint(35.6, 139.7);

  it('距離の昇順へ並べ替える', async () => {
    const { state } = harness({
      location: here,
      respond: async () => [prediction('far', 900), prediction('near', 100)],
    });

    state.getState().setNearby(true);
    state.getState().search('コンビニ');
    await settle();

    expect(state.getState().suggestions.map((p) => p.placeId)).toEqual([
      'near',
      'far',
    ]);
  });

  // 距離が取れない候補を 0 扱いにすると、無関係な候補が先頭へ来る。
  it('距離の取れない候補は関連度順のまま末尾へ回す', async () => {
    const { state } = harness({
      location: here,
      respond: async () => [
        prediction('unknown1'),
        prediction('far', 900),
        prediction('unknown2'),
        prediction('near', 100),
      ],
    });

    state.getState().setNearby(true);
    state.getState().search('コンビニ');
    await settle();

    expect(state.getState().suggestions.map((p) => p.placeId)).toEqual([
      'near',
      'far',
      'unknown1',
      'unknown2',
    ]);
  });

  it('モードが切れていれば関連度順のまま', async () => {
    const { state } = harness({
      location: here,
      respond: async () => [prediction('far', 900), prediction('near', 100)],
    });

    state.getState().search('コンビニ');
    await settle();

    expect(state.getState().suggestions.map((p) => p.placeId)).toEqual([
      'far',
      'near',
    ]);
  });

  it('現在地が無ければ並べ替えない', async () => {
    const { state } = harness({
      location: null,
      respond: async () => [prediction('far', 900), prediction('near', 100)],
    });

    state.getState().setNearby(true);
    state.getState().search('コンビニ');
    await settle();

    expect(state.getState().suggestions.map((p) => p.placeId)).toEqual([
      'far',
      'near',
    ]);
  });

  // 切替のたびに問い合わせると、課金リクエストと 400ms 待ちが積み上がる。
  it('切替では問い合わせ直さず、取得済みを並べ替える', async () => {
    const { state, autocomplete } = harness({
      location: here,
      respond: async () => [prediction('far', 900), prediction('near', 100)],
    });

    state.getState().search('コンビニ');
    await settle();
    state.getState().setNearby(true);

    expect(autocomplete).toHaveBeenCalledOnce();
    expect(state.getState().suggestions.map((p) => p.placeId)).toEqual([
      'near',
      'far',
    ]);
  });

  it('切り戻すと関連度順へ戻る', async () => {
    const { state } = harness({
      location: here,
      respond: async () => [prediction('far', 900), prediction('near', 100)],
    });

    state.getState().search('コンビニ');
    await settle();
    state.getState().setNearby(true);
    state.getState().setNearby(false);

    expect(state.getState().suggestions.map((p) => p.placeId)).toEqual([
      'far',
      'near',
    ]);
  });

  it('取得中はフラグだけ更新する', async () => {
    const { state } = harness({
      location: here,
      respond: async () => [prediction('far', 900), prediction('near', 100)],
    });

    state.getState().search('コンビニ');
    state.getState().setNearby(true);

    expect(state.getState().status).toBe('loading');

    await settle();

    // 走っていた取得が、切り替わった後のモードで反映される。
    expect(state.getState().suggestions.map((p) => p.placeId)).toEqual([
      'near',
      'far',
    ]);
  });

  it('同じ値での切替は何もしない', async () => {
    const { state } = harness({ location: here });

    state.getState().setNearby(false);

    expect(state.getState().nearby).toBe(false);
  });
});

describe('失敗', () => {
  it('生ステータスを持って失敗にする', async () => {
    const { state } = harness({
      respond: async () => {
        throw new PlacesException('REQUEST_DENIED');
      },
    });

    state.getState().search('渋谷');
    await settle();

    expect(state.getState().status).toBe('error');
    expect(state.getState().errorStatus).toBe('REQUEST_DENIED');
  });

  it('PlacesException 以外は原因不明の失敗にする', async () => {
    const { state } = harness({
      respond: async () => {
        throw new TypeError('Failed to fetch');
      },
    });

    state.getState().search('渋谷');
    await settle();

    expect(state.getState().status).toBe('error');
    expect(state.getState().errorStatus).toBeNull();
  });

  it('打ち直せば前の失敗を持ち越さない', async () => {
    let fail = true;
    const { state } = harness({
      respond: async () => {
        if (fail) throw new PlacesException('REQUEST_DENIED');
        return [prediction('a')];
      },
    });

    state.getState().search('渋谷');
    await settle();
    fail = false;
    state.getState().search('新宿');

    expect(state.getState().errorStatus).toBeNull();

    await settle();
    expect(state.getState().status).toBe('success');
  });
});

describe('後片付け', () => {
  it('待っている問い合わせを捨てる', async () => {
    const { state, autocomplete } = harness();

    state.getState().search('渋谷');
    state.getState().dispose();
    await settle();

    expect(autocomplete).not.toHaveBeenCalled();
  });

  // debounce を過ぎて走り出した後の dispose。タイマーを落とすだけでは間に合わず、
  // 解決した結果が閉じた画面の状態へ書き戻る（React の「アンマウント後の更新」）。
  it('すでに走っている問い合わせの結果も反映しない', async () => {
    let resolve!: (value: PlacePrediction[]) => void;
    const { state } = harness({
      respond: () => new Promise<PlacePrediction[]>((r) => (resolve = r)),
    });

    state.getState().search('渋谷');
    await settle();
    state.getState().dispose();

    resolve([prediction('a')]);
    await vi.advanceTimersByTimeAsync(0);

    expect(state.getState().suggestions).toEqual([]);
    expect(state.getState().status).toBe('loading');
  });
});
