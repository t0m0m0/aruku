// 移植元: lib/core/state/app_state.dart の `AppNotifier`（経路検索の中核だけ）。
//
// 守りたい不変条件は移植元と同じ——「画面と、その表示前提データを同一の更新で
// 書き換える」。移植元は copyWith 1回でそれを表現していたが、権威が URL へ移った
// ので、ここでは **navigate が呼ばれる時点でストアが遷移先の前提を満たしていること**
// として反証する。

import { describe, expect, it } from 'vitest';

import { RoutePhase } from '@aruku/engine/services/route-service';
import { budgetMinutes } from '@aruku/engine/services/route-plan-builder';
import type { RoutePlan } from '@aruku/engine/models/route-plan';

import { resolveRedirect } from '../../src/navigation/guard';
import { Screen, screenPath } from '../../src/navigation/screens';
import { RouteErrorKind } from '../../src/state/app-state';
import { createAppStore } from '../../src/state/store';

const someRoute = {} as RoutePlan;

/// go のたびに「その瞬間のストアがガードを通るか」を記録するナビゲータ。
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
    // 先に navigate してから状態を書くと、ガードが home へ跳ね返す。
    const store = createAppStore();
    const seen = guardRecorder(store);

    store.getState().go(Screen.result, {
      route: someRoute,
      routeAsOf: null,
      routePhase: null,
    });
    store
      .getState()
      .go(Screen.error, { routeErrorKind: RouteErrorKind.timeout });

    expect(seen.map((s) => s.redirectedTo)).toEqual([null, null]);
  });

  it('渡していないフィールドは保つ', () => {
    const store = createAppStore();
    guardRecorder(store);
    const before = store.getState().departure;

    store.getState().go(Screen.settings);

    expect(store.getState().departure).toBe(before);
  });

  it('ナビゲータ未接続の go は失敗する', () => {
    // 静かに状態だけ進むと、画面と前提データが乖離したまま次の遷移を迎える。
    const store = createAppStore();

    expect(() => store.getState().go(Screen.settings)).toThrow();
  });
});

describe('初期状態', () => {
  // 移植元は AppState.initial の 00:00 リテラルを AppNotifier.build() が現在時刻と
  // 「+ kInitialBudgetMinutes」で上書きする。リテラルだけ運ぶと予算 0 分の検索に
  // なり、isNow の出発も深夜 0 時に固定される。
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
    for (const path of [
      screenPath.result,
      screenPath.loading,
      screenPath.error,
    ]) {
      expect(resolveRedirect(path, store.getState(), new Date())).toBe('/home');
    }
  });
});
