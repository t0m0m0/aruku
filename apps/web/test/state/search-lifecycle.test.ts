// 移植元: lib/core/state/app_state.dart の `startSearch` / `cancelSearch` /
// `_expireRoute` と、test/core/state/ の対応するテスト群。
//
// 守りたい不変条件は移植元と同じ——画面と表示前提データが揃っていること。ただし
// 権威が URL へ移ったので、`go()` が呼ばれた時点でストアが遷移先のガードを通ることで
// 反証する（store.test.ts と同じ流儀）。

import { describe, expect, it, vi } from 'vitest';

import { GeoPoint } from '@aruku/engine/models/geo-point';
import type { RoutePlan } from '@aruku/engine/models/route-plan';
import { TimeValue } from '@aruku/engine/models/time-value';
import { ClientException } from '@aruku/engine/services/http-client';
import {
  RouteException,
  RoutePhase,
  type PlanArgs,
  type RouteService,
} from '@aruku/engine/services/route-service';

import { resolveRedirect } from '../../src/navigation/guard';
import { Screen, screenPath } from '../../src/navigation/screens';
import { locationAvailable, locationDenied } from '../../src/location/location-state';
import { RouteErrorKind, routeFreshness } from '../../src/state/app-state';
import { createAppStore, type AppStore } from '../../src/state/store';
import type { StoreApi } from 'zustand/vanilla';

const noon = new Date(2026, 8, 13, 12, 0, 0);
const somewhere = new GeoPoint(35.681, 139.767);
const goal = new GeoPoint(35.658, 139.701);
const aRoute = { totalMinutes: 42 } as unknown as RoutePlan;

interface Harness {
  store: StoreApi<AppStore>;
  navigate: ReturnType<typeof vi.fn>;
  plan: ReturnType<typeof vi.fn>;
  seen: { path: string; redirectedTo: string | null }[];
  setNow: (at: Date) => void;
}

function harness(
  options: {
    respond?: (args: PlanArgs) => Promise<RoutePlan>;
    located?: boolean;
    initial?: Parameters<typeof createAppStore>[0];
  } = {},
): Harness {
  let current = noon;
  const now = () => current;
  const plan = vi.fn(async (args: PlanArgs) =>
    options.respond ? options.respond(args) : aRoute,
  );
  const routeService: RouteService = { plan: plan as RouteService['plan'] };

  const store = createAppStore(
    options.initial ?? {},
    now,
    { request: async () => locationDenied },
    routeService,
  );
  store.setState({
    locationState: options.located === false ? locationDenied : locationAvailable(somewhere),
  });

  const seen: { path: string; redirectedTo: string | null }[] = [];
  const navigate = vi.fn((path: string) => {
    seen.push({ path, redirectedTo: resolveRedirect(path, store.getState(), now()) });
  });
  store.getState().attachNavigator(navigate);

  return { store, navigate, plan, seen, setNow: (at) => (current = at) };
}

/// 目的地が決まった状態。検索の入口はここから。
const withDestination = { destination: '渋谷駅', destinationLatLng: goal };

describe('検索の開始', () => {
  it('まず待ち画面へ、経路の段階を持って移る', async () => {
    const { store, seen } = harness({ initial: withDestination });

    const done = store.getState().startSearch();
    expect(seen[0]?.path).toBe(screenPath[Screen.loading]);
    expect(store.getState().routePhase).toBe(RoutePhase.routing);
    await done;
  });

  it('遷移した時点でその画面の前提を満たしている', async () => {
    const { store, seen } = harness({ initial: withDestination });

    await store.getState().startSearch();

    expect(seen.map((s) => s.redirectedTo)).toEqual([null, null]);
  });

  it('前回の失敗を持ち越さない', async () => {
    const { store } = harness({
      initial: { ...withDestination, routeErrorKind: RouteErrorKind.network },
    });

    const done = store.getState().startSearch();
    expect(store.getState().routeErrorKind).toBeNull();
    await done;
  });

  it('進捗の通知が段階へ反映される', async () => {
    const phases: (string | null)[] = [];
    const { store } = harness({
      initial: withDestination,
      respond: async (args) => {
        args.onProgress?.(RoutePhase.walkability);
        phases.push(store.getState().routePhase);
        args.onProgress?.(RoutePhase.building);
        phases.push(store.getState().routePhase);
        return aRoute;
      },
    });

    await store.getState().startSearch();

    expect(phases).toEqual([RoutePhase.walkability, RoutePhase.building]);
  });
});

describe('検索へ渡すもの', () => {
  it('出発地が未設定なら現在地の座標を使う', async () => {
    const { store, plan } = harness({ initial: withDestination });

    await store.getState().startSearch();

    expect(plan.mock.calls[0]![0].origin).toEqual(somewhere);
  });

  it('出発地が設定されていればその座標を優先する', async () => {
    const home = new GeoPoint(35.7, 139.6);
    const { store, plan } = harness({
      initial: { ...withDestination, origin: '自宅', originLatLng: home },
    });

    await store.getState().startSearch();

    expect(plan.mock.calls[0]![0].origin).toEqual(home);
    expect(plan.mock.calls[0]![0].originName).toBe('自宅');
  });

  it('現在地しか無いときの名前は「現在地」', async () => {
    const { store, plan } = harness({ initial: withDestination });

    await store.getState().startSearch();

    expect(plan.mock.calls[0]![0].originName).toBe('現在地');
  });

  it('現在地も出発地も無ければ名前を持たせない', async () => {
    const { store, plan } = harness({ initial: withDestination, located: false });

    await store.getState().startSearch();

    expect(plan.mock.calls[0]![0].originName).toBeNull();
  });

  // isNow の出発は起動時刻のまま腐る。照会の直前に現在時刻へ更新する（#264）。
  it('「今すぐ」出発は照会直前の現在時刻へ更新する', async () => {
    const { store, plan, setNow } = harness({
      initial: {
        ...withDestination,
        departure: new TimeValue({ h: 9, m: 0, isNow: true }),
        arrival: new TimeValue({ h: 10, m: 30 }),
      },
    });
    setNow(new Date(2026, 8, 13, 9, 45, 0));

    await store.getState().startSearch();

    const args = plan.mock.calls[0]![0];
    expect(args.departure.h).toBe(9);
    expect(args.departure.m).toBe(45);
    // 予算90分を保って到着も追従する。
    expect(args.arrival.h).toBe(11);
    expect(args.arrival.m).toBe(15);
  });

  it('固定出発は動かさない', async () => {
    const { store, plan, setNow } = harness({
      initial: {
        ...withDestination,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 30 }),
      },
    });
    setNow(new Date(2026, 8, 13, 9, 45, 0));

    await store.getState().startSearch();

    expect(plan.mock.calls[0]![0].departure.m).toBe(0);
  });
});

describe('成功', () => {
  it('結果画面へ経路を持って移る', async () => {
    const { store, seen } = harness({ initial: withDestination });

    await store.getState().startSearch();

    expect(seen.at(-1)?.path).toBe(screenPath[Screen.result]);
    expect(store.getState().route).toBe(aRoute);
    expect(store.getState().routePhase).toBeNull();
    expect(store.getState().routeErrorKind).toBeNull();
  });

  // routeAsOf は「now 基準で確定した経路」にだけ付く。固定出発は時間で腐らない。
  it('「今すぐ」経路だけ失効の基準時刻を持つ', async () => {
    const nowStore = harness({
      initial: {
        ...withDestination,
        departure: new TimeValue({ h: 12, m: 0, isNow: true }),
      },
    });
    await nowStore.store.getState().startSearch();
    expect(nowStore.store.getState().routeAsOf).toEqual(noon);

    const fixed = harness({
      initial: { ...withDestination, departure: new TimeValue({ h: 9, m: 0 }) },
    });
    await fixed.store.getState().startSearch();
    expect(fixed.store.getState().routeAsOf).toBeNull();
  });

  it('更新した出発・到着を成功時に確定する', async () => {
    const { store, setNow } = harness({
      initial: {
        ...withDestination,
        departure: new TimeValue({ h: 9, m: 0, isNow: true }),
        arrival: new TimeValue({ h: 10, m: 30 }),
      },
    });
    setNow(new Date(2026, 8, 13, 9, 45, 0));

    await store.getState().startSearch();

    expect(store.getState().departure.m).toBe(45);
    expect(store.getState().arrival.h).toBe(11);
  });
});

describe('失敗', () => {
  it('種別を持ってエラー画面へ移る', async () => {
    const { store, seen } = harness({
      initial: withDestination,
      respond: async () => {
        throw new RouteException('ZERO_RESULTS');
      },
    });

    await store.getState().startSearch();

    expect(seen.at(-1)?.path).toBe(screenPath[Screen.error]);
    expect(store.getState().routeErrorKind).toBe(RouteErrorKind.noResults);
    expect(store.getState().routePhase).toBeNull();
  });

  it('通信の失敗も種別へ落とす', async () => {
    const { store } = harness({
      initial: withDestination,
      respond: async () => {
        throw new ClientException('Failed to fetch');
      },
    });

    await store.getState().startSearch();

    expect(store.getState().routeErrorKind).toBe(RouteErrorKind.network);
  });

  // 失敗時に出発を確定すると、旧経路を残したままヘッダー（出発）だけ新時刻へ動き、
  // 旧経路のタイムラインと前提時刻がズレる。
  it('出発・到着も旧経路も触らない', async () => {
    const { store, setNow } = harness({
      initial: {
        ...withDestination,
        departure: new TimeValue({ h: 9, m: 0, isNow: true }),
        arrival: new TimeValue({ h: 10, m: 30 }),
        route: aRoute,
        routeAsOf: noon,
      },
      respond: async () => {
        throw new RouteException('TIMEOUT');
      },
    });
    setNow(new Date(2026, 8, 13, 9, 45, 0));

    await store.getState().startSearch();

    expect(store.getState().departure.m).toBe(0);
    expect(store.getState().arrival.h).toBe(10);
    expect(store.getState().route).toBe(aRoute);
    expect(store.getState().routeAsOf).toEqual(noon);
  });
});

describe('中断', () => {
  it('待ち画面から home へ戻し、段階を捨てる', () => {
    const { store, seen } = harness({ initial: withDestination });
    void store.getState().startSearch();

    store.getState().cancelSearch();

    expect(seen.at(-1)?.path).toBe(screenPath[Screen.home]);
    expect(store.getState().routePhase).toBeNull();
  });

  // 中断後に古い応答が届いて home から result へ引き戻すのを防ぐ（#221）。
  it('中断後に届いた結果を反映しない', async () => {
    let resolve!: (plan: RoutePlan) => void;
    const { store, seen } = harness({
      initial: withDestination,
      respond: () => new Promise<RoutePlan>((r) => (resolve = r)),
    });
    const done = store.getState().startSearch();

    store.getState().cancelSearch();
    resolve(aRoute);
    await done;

    expect(store.getState().route).toBeNull();
    expect(seen.at(-1)?.path).toBe(screenPath[Screen.home]);
  });

  it('中断後に届いた失敗も反映しない', async () => {
    let reject!: (reason: unknown) => void;
    const { store } = harness({
      initial: withDestination,
      respond: () => new Promise<RoutePlan>((_r, rj) => (reject = rj)),
    });
    const done = store.getState().startSearch();

    store.getState().cancelSearch();
    reject(new RouteException('TIMEOUT'));
    await done;

    expect(store.getState().routeErrorKind).toBeNull();
  });

  // 世代だけでは進行中の HTTP が完了まで走り切る。通信そのものを切る（#259）。
  it('進行中の通信を切る', () => {
    const { store, plan } = harness({ initial: withDestination });
    void store.getState().startSearch();

    store.getState().cancelSearch();

    expect(plan.mock.calls[0]![0].cancellation?.isCanceled).toBe(true);
  });

  it('再検索の連打でも古い通信を切る', async () => {
    const { store, plan } = harness({ initial: withDestination });
    void store.getState().startSearch();

    await store.getState().startSearch();

    expect(plan.mock.calls[0]![0].cancellation?.isCanceled).toBe(true);
    expect(plan.mock.calls[1]![0].cancellation?.isCanceled).toBe(false);
  });

  it('後から始めた検索の結果だけが残る', async () => {
    const plans: ((plan: RoutePlan) => void)[] = [];
    const second = { totalMinutes: 7 } as unknown as RoutePlan;
    const { store } = harness({
      initial: withDestination,
      respond: () => new Promise<RoutePlan>((r) => plans.push(r)),
    });
    const first = store.getState().startSearch();
    const latest = store.getState().startSearch();

    plans[1]!(second);
    plans[0]!(aRoute);
    await Promise.all([first, latest]);

    expect(store.getState().route).toBe(second);
  });
});

// 照会中にバックグラウンド滞在などで猶予を超えると、古い前提の結果になる（#264）。
// 完了時のここが最後の砦——ローディング中は画面遷移で無効化できない。
describe('照会中の失効', () => {
  it('「今すぐ」経路が猶予を超えたら結果を捨てて home へ戻す', async () => {
    const { store, seen, setNow } = harness({
      initial: {
        ...withDestination,
        departure: new TimeValue({ h: 12, m: 0, isNow: true }),
      },
      respond: async () => {
        setNow(new Date(noon.getTime() + routeFreshness));
        return aRoute;
      },
    });

    await store.getState().startSearch();

    expect(store.getState().route).toBeNull();
    expect(seen.at(-1)?.path).toBe(screenPath[Screen.home]);
  });

  it('猶予内なら結果を出す', async () => {
    const { store, seen, setNow } = harness({
      initial: {
        ...withDestination,
        departure: new TimeValue({ h: 12, m: 0, isNow: true }),
      },
      respond: async () => {
        setNow(new Date(noon.getTime() + routeFreshness - 1));
        return aRoute;
      },
    });

    await store.getState().startSearch();

    expect(store.getState().route).toBe(aRoute);
    expect(seen.at(-1)?.path).toBe(screenPath[Screen.result]);
  });

  it('固定出発は時間が経っても失効しない', async () => {
    const { store, setNow } = harness({
      initial: { ...withDestination, departure: new TimeValue({ h: 9, m: 0 }) },
      respond: async () => {
        setNow(new Date(noon.getTime() + routeFreshness * 10));
        return aRoute;
      },
    });

    await store.getState().startSearch();

    expect(store.getState().route).toBe(aRoute);
  });
});
