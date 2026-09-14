// 開いたままの経路を復帰のたびに検算する購読（navigation/route-freshness.ts）。

import { describe, expect, it, vi } from 'vitest';

import { GeoPoint } from '@aruku/engine/models/geo-point';
import type { RoutePlan } from '@aruku/engine/models/route-plan';
import { TimeValue } from '@aruku/engine/models/time-value';
import type { RouteService } from '@aruku/engine/services/route-service';

import { locationDenied } from '../../src/location/location-state';
import { routeFreshness } from '../../src/state/app-state';
import { createAppStore } from '../../src/state/store';
import {
  watchRouteFreshness,
  type FreshnessTimers,
  type VisibilitySource,
} from '../../src/navigation/route-freshness';

function source(visible: boolean) {
  let isVisible = visible;
  const listeners: (() => void)[] = [];
  const api: VisibilitySource = {
    isVisible: () => isVisible,
    subscribe: (listener) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
  };
  return {
    api,
    listenerCount: () => listeners.length,
    set(next: boolean) {
      isVisible = next;
      for (const l of [...listeners]) l();
    },
  };
}

/// 経路を持たない最小のストア。締切のタイマーは張られない（route が null）ので、
/// 復帰の合図だけを見たいテストで使う。
function storeWith(revalidateRoute: () => void) {
  return {
    getState: () => ({ revalidateRoute, route: null, routeAsOf: null }),
    subscribe: () => () => {},
  } as never;
}

describe('復帰での検算', () => {
  it('見える状態へ戻ったら検算する', () => {
    const revalidateRoute = vi.fn();
    const s = source(false);
    watchRouteFreshness(s.api, storeWith(revalidateRoute));

    s.set(true);

    expect(revalidateRoute).toHaveBeenCalledOnce();
  });

  // 見えていない間に home へ戻しても誰も見ていない。戻ってきたときに判定するので
  // 取りこぼさない。
  it('隠れる側では検算しない', () => {
    const revalidateRoute = vi.fn();
    const s = source(true);
    watchRouteFreshness(s.api, storeWith(revalidateRoute));

    s.set(false);

    expect(revalidateRoute).not.toHaveBeenCalled();
  });

  it('解除すると購読が残らない', () => {
    const s = source(true);
    const stop = watchRouteFreshness(s.api, storeWith(() => {}));

    stop();

    expect(s.listenerCount()).toBe(0);
  });
});

// 前面に置いたまま見続けているときは可視性が変わらない。復帰の合図だけでは
// 一生検算されず、乗れない便の経路を見せ続ける（PR #398 の Codex レビュー）。
describe('締切のタイマー', () => {
  const noon = new Date(2026, 8, 13, 12, 0, 0);
  const goal = new GeoPoint(35.658, 139.701);
  const aRoute = {} as RoutePlan;

  function harness(at: Date = noon) {
    let current = at;
    const scheduled: { fn: () => void; ms: number }[] = [];
    const timers: FreshnessTimers = {
      setTimeout: (fn, ms) => scheduled.push({ fn, ms }) - 1,
      clearTimeout: (id) => {
        scheduled.splice(id, 1);
      },
      now: () => current,
    };
    const routeService: RouteService = {
      plan: (async () => aRoute) as RouteService['plan'],
    };
    const store = createAppStore(
      { destination: '渋谷駅', destinationLatLng: goal },
      () => current,
      { request: async () => locationDenied },
      routeService,
    );
    store.getState().attachNavigator(() => {});
    return {
      store,
      scheduled,
      setNow: (next: Date) => (current = next),
      timers,
    };
  }

  it('「今すぐ」経路を持つと猶予の残りで張る', async () => {
    const h = harness();
    const visibility = source(true);
    watchRouteFreshness(visibility.api, h.store, h.timers);

    h.store.setState({ departure: new TimeValue({ h: 12, m: 0, isNow: true }) });
    await h.store.getState().startSearch();

    expect(h.scheduled.at(-1)?.ms).toBe(routeFreshness);
  });

  it('締切が来たら検算する', async () => {
    const h = harness();
    watchRouteFreshness(source(true).api, h.store, h.timers);
    h.store.setState({ departure: new TimeValue({ h: 12, m: 0, isNow: true }) });
    await h.store.getState().startSearch();
    expect(h.store.getState().route).toBe(aRoute);

    h.setNow(new Date(noon.getTime() + routeFreshness));
    h.scheduled.at(-1)!.fn();

    expect(h.store.getState().route).toBeNull();
  });

  // 固定出発は時間経過で腐らない（routeAsOf を持たない）。
  it('固定出発の経路には張らない', async () => {
    const h = harness();
    watchRouteFreshness(source(true).api, h.store, h.timers);

    h.store.setState({ departure: new TimeValue({ h: 9, m: 0 }) });
    await h.store.getState().startSearch();

    expect(h.scheduled).toHaveLength(0);
  });

  it('解除するとタイマーも残らない', async () => {
    const h = harness();
    const stop = watchRouteFreshness(source(true).api, h.store, h.timers);
    h.store.setState({ departure: new TimeValue({ h: 12, m: 0, isNow: true }) });
    await h.store.getState().startSearch();

    stop();

    expect(h.scheduled).toHaveLength(0);
  });
});
