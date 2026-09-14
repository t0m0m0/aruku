// 移植元: lib/features/loading/loading_screen.dart
//
// 地図を敷いた背景（ArukuMap + 放射グラデーションのベール、約 40 行）は運んでいない。
// 地図そのものが未移植で、装飾なので対になる相手が来てから運ぶ。

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

function setup(
  initial: Partial<RouteCore> = {},
  options: { plan?: RouteService['plan'] } = {},
) {
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

    // 予算の書式はエンジンが持つ（「1時間 30分」）。ここで組み直さない。
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
  // 段階ごとに下限を持たせ、到達が見た目に必ず出るようにする。時間ランプだけだと
  // 段階が進んでも何も変わらない。
  it('段階が進むほど下限が上がる', () => {
    expect(progressFloor(RoutePhase.routing)).toBe(0);
    expect(progressFloor(RoutePhase.walkability)).toBeGreaterThan(
      progressFloor(RoutePhase.routing),
    );
    expect(progressFloor(RoutePhase.building)).toBeGreaterThan(
      progressFloor(RoutePhase.walkability),
    );
  });

  // 満タンは「完了」を意味してしまう。完了で起きるのは画面遷移であって塗り切りではない。
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

  // 離脱での中断はこの画面が持たない（navigation/search-abandon.test.ts）。
  // アンマウントを合図にすると StrictMode の二重マウントで本物の検索を殺すため。
  // 合図をアンマウントへ戻すと、ここが赤くなる。
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

  // 成功で result へ移るときも loading はアンマウントされる。そこで止めにいくと、
  // 次の検索まで巻き添えにしかねない。
  it('結果が出て離れるときは止めない', async () => {
    const { view } = setup();

    await act(async () => {
      await store.getState().startSearch();
    });
    view.unmount();

    expect(store.getState().route).toBe(aRoute);
  });
});
