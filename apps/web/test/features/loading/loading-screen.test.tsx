import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GeoPoint } from '@aruku/engine/models/geo-point';
import type { RoutePlan } from '@aruku/engine/models/route-plan';
import { TimeValue } from '@aruku/engine/models/time-value';
import { RoutePhase, type RouteService } from '@aruku/engine/services/route-service';

import { LoadingScreen, progressFloor } from '../../../src/features/loading/loading-screen';
import { Screen, screenPath } from '../../../src/navigation/screens';
import type { RouteCore } from '../../../src/state/app-state';
import { createAppStore, type AppStore } from '../../../src/state/store';
import { locationDenied } from '../../../src/location/location-state';
import type { StoreApi } from 'zustand/vanilla';

const noon = new Date(2026, 8, 13, 12, 0, 0);
const goal = new GeoPoint(35.658, 139.701);
const aRoute = {} as RoutePlan;

let store: StoreApi<AppStore>;

function setup(initial: Partial<RouteCore> = {}, options: { plan?: RouteService['plan'] } = {}) {
  const navigate = vi.fn();
  const routeService: RouteService = {
    plan: options.plan ?? (async () => aRoute),
  };
  store = createAppStore(
    {
      destination: '渋谷駅',
      destinationLatLng: goal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 30 }),
      routePhase: RoutePhase.routing,
      ...initial,
    },
    () => noon,
    { request: async () => locationDenied },
    routeService,
  );
  store.getState().attachNavigator(navigate);
  const view = render(<LoadingScreen store={store} />);
  return { navigate, view };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('見出し', () => {
  it('目的地と予算を出す', () => {
    setup();

    expect(screen.getByText('渋谷駅 まで · 制限 1時間 30分')).toBeTruthy();
  });

  it('目的地が無ければ予算だけ出す', () => {
    setup({ destination: null });

    expect(screen.getByText('制限 1時間 30分')).toBeTruthy();
  });

  it('探している最中であることを伝える', () => {
    setup();

    expect(screen.getByText('歩ける道を、探しています')).toBeTruthy();
  });
});

describe('進捗', () => {
  it('段階が進むほど下限が上がる', () => {
    expect(progressFloor(RoutePhase.routing)).toBe(0);
    expect(progressFloor(RoutePhase.walkability)).toBeGreaterThan(
      progressFloor(RoutePhase.routing),
    );
    expect(progressFloor(RoutePhase.building)).toBeGreaterThan(
      progressFloor(RoutePhase.walkability),
    );
  });

  it('どの段階でも満タンにはしない', () => {
    for (const phase of Object.values(RoutePhase)) {
      expect(progressFloor(phase)).toBeLessThan(1);
    }
  });

  it('段階が無ければ最初の段階として扱う', () => {
    expect(progressFloor(null)).toBe(progressFloor(RoutePhase.routing));
  });

  it('読み上げにも進捗として出す', () => {
    setup();

    const bar = screen.getByRole('progressbar');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });
});

describe('中断', () => {
  it('キャンセルで home へ戻る', () => {
    const { navigate } = setup();

    fireEvent.click(screen.getByRole('button', { name: 'キャンセル' }));

    expect(navigate).toHaveBeenCalledWith(screenPath[Screen.home]);
    expect(store.getState().routePhase).toBeNull();
  });

  it('StrictMode の二重マウントでは止めない', async () => {
    let resolve!: (plan: RoutePlan) => void;
    const navigate = vi.fn();
    const routeService: RouteService = {
      plan: () => new Promise<RoutePlan>((r) => (resolve = r)),
    };
    store = createAppStore(
      {
        destination: '渋谷駅',
        destinationLatLng: goal,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 30 }),
        routePhase: RoutePhase.routing,
      },
      () => noon,
      { request: async () => locationDenied },
      routeService,
    );
    store.getState().attachNavigator(navigate);
    const done = store.getState().startSearch();

    render(
      <StrictMode>
        <LoadingScreen store={store} />
      </StrictMode>,
    );

    resolve(aRoute);
    await act(async () => {
      await done;
    });

    expect(store.getState().route).toBe(aRoute);
  });

  it('結果が出て離れるときは止めない', async () => {
    const { view } = setup();

    await act(async () => {
      await store.getState().startSearch();
    });
    view.unmount();

    expect(store.getState().route).toBe(aRoute);
  });
});

describe('地図の背景', () => {
  it('地図を敷く', () => {
    setup();

    expect(screen.getByTestId('loading-map')).toBeDefined();
  });

  it('まだ出ていない経路を背景に描かない', () => {
    setup();

    expect(screen.getByTestId('loading-map').querySelector('[data-part="route"]')).toBeNull();
  });

  it('装飾なので読み上げへ出さない', () => {
    setup();

    expect(screen.getByTestId('loading-map').getAttribute('aria-hidden')).toBe('true');
  });

  it('装飾なので操作もできない', () => {
    setup();

    expect(screen.getByTestId('loading-map').hasAttribute('inert')).toBe(true);
  });
});
