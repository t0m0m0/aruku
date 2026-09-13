// 移植元: lib/core/state/app_state.dart の locationState / refreshLocation /
// departureLabelText。

import { describe, expect, it, vi } from 'vitest';

import { GeoPoint } from '@aruku/engine/models/geo-point';

import {
  locationAvailable,
  locationDenied,
  locationUnavailable,
  type LocationState,
} from '../../src/location/location-state';
import { departureLabelText } from '../../src/state/derived';
import { createAppStore } from '../../src/state/store';

function serviceReturning(...results: LocationState[]) {
  const request = vi.fn(() => Promise.resolve(results.shift() ?? locationDenied));
  return { service: { request }, request };
}

describe('現在地', () => {
  it('取得するまでは loading', () => {
    const store = createAppStore();

    expect(store.getState().locationState.kind).toBe('loading');
  });

  it('refreshLocation の結果が状態へ入る', async () => {
    const { service } = serviceReturning(locationAvailable(new GeoPoint(35.68, 139.76)));
    const store = createAppStore({}, undefined, service);

    await store.getState().refreshLocation();

    expect(store.getState().locationState.kind).toBe('available');
  });

  // StrictMode は effect を二度走らせる。素通しすると権限ダイアログが 2 回出る。
  it('取得中の再要求は同じ取得に相乗りする', async () => {
    const { service, request } = serviceReturning(locationDenied, locationUnavailable);
    const store = createAppStore({}, undefined, service);

    await Promise.all([
      store.getState().refreshLocation(),
      store.getState().refreshLocation(),
    ]);

    expect(request).toHaveBeenCalledOnce();
  });

  it('取得が終われば次の要求は新しく取りに行く', async () => {
    const { service, request } = serviceReturning(locationDenied, locationUnavailable);
    const store = createAppStore({}, undefined, service);

    await store.getState().refreshLocation();
    await store.getState().refreshLocation();

    expect(request).toHaveBeenCalledTimes(2);
    expect(store.getState().locationState.kind).toBe('unavailable');
  });

  // 失敗理由は LocationState として返す設計だが、想定外の例外は権限拒否と断定
  // できないため再試行可能な側へ寄せる（移植元の catch と同じ）。
  it('取得が例外で終わっても unavailable へ落ちる', async () => {
    const service = { request: () => Promise.reject(new Error('boom')) };
    const store = createAppStore({}, undefined, service);

    await store.getState().refreshLocation();

    expect(store.getState().locationState.kind).toBe('unavailable');
  });
});

describe('departureLabelText', () => {
  it('出発地が指定されていればそれを出す', () => {
    expect(departureLabelText('新宿駅', locationDenied)).toBe('新宿駅');
  });

  it.each([
    ['loading' as const, '現在地 · 取得中...'],
    ['available' as const, '現在地'],
    ['denied' as const, '位置情報なし'],
    ['unavailable' as const, '現在地 · 取得失敗'],
  ])('出発地が無いとき %s は「%s」と出る', (kind, expected) => {
    const state: LocationState =
      kind === 'available'
        ? locationAvailable(new GeoPoint(0, 0))
        : kind === 'denied'
          ? locationDenied
          : kind === 'unavailable'
            ? locationUnavailable
            : { kind: 'loading' };

    expect(departureLabelText(null, state)).toBe(expected);
  });
});
