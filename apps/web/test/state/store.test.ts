import { describe, expect, it } from 'vitest';

import { RoutePhase } from '@aruku/engine/services/route-service';
import { budgetMinutes } from '@aruku/engine/services/route-plan-builder';
import type { RoutePlan } from '@aruku/engine/models/route-plan';
import { GeoPoint } from '@aruku/engine/models/geo-point';

import { resolveRedirect } from '../../src/navigation/guard';
import { Screen, screenPath } from '../../src/navigation/screens';
import { RouteErrorKind } from '../../src/state/app-state';
import { createAppStore } from '../../src/state/store';

const someRoute = {} as RoutePlan;

function guardRecorder(store: ReturnType<typeof createAppStore>) {
  const seen: { path: string; redirectedTo: string | null }[] = [];
  store.getState().attachNavigator((path) => {
    seen.push({
      path,
      redirectedTo: resolveRedirect(path, store.getState(), new Date()),
    });
  });
  return seen;
}

describe('go', () => {
  it('画面と表示前提データを同一の更新で書き換える', () => {
    const store = createAppStore();
    const seen = guardRecorder(store);

    store.getState().go(Screen.loading, { routePhase: RoutePhase.routing });

    expect(store.getState().routePhase).toBe(RoutePhase.routing);
    expect(seen).toEqual([{ path: screenPath.loading, redirectedTo: null }]);
  });

  it('ナビゲータが呼ばれた時点で遷移先の前提が満たされている', () => {
    const store = createAppStore();
    const seen = guardRecorder(store);

    store.getState().go(Screen.result, {
      route: someRoute,
      routeAsOf: null,
      routePhase: null,
    });
    store.getState().go(Screen.error, { routeErrorKind: RouteErrorKind.timeout });

    expect(seen.map((s) => s.redirectedTo)).toEqual([null, null]);
  });

  it('渡していないフィールドは保つ', () => {
    const store = createAppStore();
    guardRecorder(store);
    const before = store.getState().departure;

    store.getState().go(Screen.search);

    expect(store.getState().departure).toBe(before);
  });

  it('ナビゲータ未接続の go は失敗する', () => {
    const store = createAppStore();

    expect(() => store.getState().go(Screen.search)).toThrow('go() before attachNavigator()');
  });
});

describe('初期状態', () => {
  it('出発は現在時刻の「今すぐ」になる', () => {
    const now = new Date(2026, 8, 11, 14, 23);
    const store = createAppStore({}, () => now);

    expect(store.getState().departure).toMatchObject({
      h: 14,
      m: 23,
      isNow: true,
      dateOffset: 0,
    });
  });

  it('到着は出発の60分後になる', () => {
    const store = createAppStore({}, () => new Date(2026, 8, 11, 14, 23));

    expect(store.getState().arrival).toMatchObject({
      h: 15,
      m: 23,
      dateOffset: 0,
    });
  });

  it('日跨ぎは到着の dateOffset へ繰り上げる', () => {
    const store = createAppStore({}, () => new Date(2026, 8, 11, 23, 30));

    expect(store.getState().arrival).toMatchObject({
      h: 0,
      m: 30,
      dateOffset: 1,
    });
  });

  it('初期の予算は60分', () => {
    const store = createAppStore({}, () => new Date(2026, 8, 11, 23, 30));
    const { departure, arrival } = store.getState();

    expect(budgetMinutes(departure, arrival)).toBe(60);
  });

  it('経路も失敗も持たない', () => {
    const store = createAppStore();
    const state = store.getState();

    expect(state.departure.isNow).toBe(true);
    expect(state.route).toBeNull();
    expect(state.routeAsOf).toBeNull();
    expect(state.routePhase).toBeNull();
    expect(state.routeErrorKind).toBeNull();
  });

  it('初期状態では home だけが表示できる', () => {
    const store = createAppStore();

    expect(resolveRedirect('/home', store.getState(), new Date())).toBeNull();
    for (const path of [screenPath.result, screenPath.loading, screenPath.error]) {
      expect(resolveRedirect(path, store.getState(), new Date())).toBe('/home');
    }
  });
});

describe('地点の設定', () => {
  it('目的地を名前と座標で設定する', () => {
    const store = createAppStore();

    store.getState().setDestination('渋谷駅', new GeoPoint(35.6, 139.7));

    expect(store.getState().destination).toBe('渋谷駅');
    expect(store.getState().destinationLatLng).toEqual(new GeoPoint(35.6, 139.7));
  });

  it('座標を渡さない設定は前の座標を消す', () => {
    const store = createAppStore();
    store.getState().setDestination('渋谷駅', new GeoPoint(35.6, 139.7));

    store.getState().setDestination('新宿駅');

    expect(store.getState().destinationLatLng).toBeNull();
  });

  it('出発地を名前と座標で設定する', () => {
    const store = createAppStore();

    store.getState().setOrigin('自宅', new GeoPoint(35.7, 139.6));

    expect(store.getState().origin).toBe('自宅');
    expect(store.getState().originLatLng).toEqual(new GeoPoint(35.7, 139.6));
  });

  it('出発地を null にすると現在地へ戻る', () => {
    const store = createAppStore();
    store.getState().setOrigin('自宅', new GeoPoint(35.7, 139.6));

    store.getState().setOrigin(null);

    expect(store.getState().origin).toBeNull();
    expect(store.getState().originLatLng).toBeNull();
  });

  it('目的地と出発地は互いを書き換えない', () => {
    const store = createAppStore();

    store.getState().setOrigin('自宅', new GeoPoint(35.7, 139.6));
    store.getState().setDestination('渋谷駅', new GeoPoint(35.6, 139.7));

    expect(store.getState().origin).toBe('自宅');
    expect(store.getState().originLatLng).toEqual(new GeoPoint(35.7, 139.6));
  });
});
