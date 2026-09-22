// 移植元: lib/features/error/error_screen.dart
//
// デスクトップ幅の中央寄せは CSS のメディアクエリなので、ここ（jsdom）からは
// 見えない。寸法は e2e/desktop-layout.spec.ts が実測する。

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { RoutePlan } from '@aruku/engine/models/route-plan';
import type { PlanArgs, RouteService } from '@aruku/engine/services/route-service';

import { ErrorScreen } from '../../../src/features/error/error-screen';
import { GeoPoint } from '@aruku/engine/models/geo-point';

import {
  locationAvailable,
  locationDenied,
} from '../../../src/location/location-state';
import { Screen, screenPath } from '../../../src/navigation/screens';
import { RouteErrorKind } from '../../../src/state/app-state';
import { createAppStore, type AppStore } from '../../../src/state/store';
import type { StoreApi } from 'zustand/vanilla';

const here = new GeoPoint(35.681, 139.767);

let store: StoreApi<AppStore>;

function setup(kind: RouteErrorKind | null, located = false) {
  const navigate = vi.fn();
  const plan = vi.fn(async (_args: PlanArgs) => ({}) as RoutePlan);
  const routeService: RouteService = { plan: plan as RouteService['plan'] };
  const request = vi.fn(async () =>
    located ? locationAvailable(here) : locationDenied,
  );
  store = createAppStore(
    { routeErrorKind: kind, destination: '渋谷駅' },
    () => new Date(2026, 8, 13, 12, 0, 0),
    { request },
    routeService,
  );
  // 初回取得は済んでいる（拒否されて denied で止まっている）状態から始める。
  store.setState({ locationState: locationDenied });
  store.getState().attachNavigator(navigate);
  const view = render(<ErrorScreen store={store} />);
  return { navigate, plan, request, view };
}

describe('失敗の説明', () => {
  it.each([
    [RouteErrorKind.network, '通信に失敗しました'],
    [RouteErrorKind.timeout, '経路サービスの応答が遅れています'],
    [RouteErrorKind.noResults, 'ルートが見つかりませんでした'],
    [RouteErrorKind.noLocation, '現在地を取得できませんでした'],
    [RouteErrorKind.noDestination, '目的地が選ばれていません'],
    [RouteErrorKind.unknown, 'ルートを取得できませんでした'],
  ])('%s は「%s」', (kind, title) => {
    setup(kind);

    expect(screen.getByRole('heading', { name: title })).toBeTruthy();
  });

  it('種別ごとの補足も出す', () => {
    setup(RouteErrorKind.network);

    expect(screen.getByText('通信状況を確認してもう一度お試しください')).toBeTruthy();
  });

  // ガードが通す以上ここへは種別付きでしか来ないが、来てしまったときに空の画面を
  // 見せない。
  it('種別が無くても原因不明として成立する', () => {
    setup(null);

    expect(
      screen.getByRole('heading', { name: 'ルートを取得できませんでした' }),
    ).toBeTruthy();
  });
});

describe('復帰導線', () => {
  // 再試行で直る種別は、再試行を主導線に置く。
  it('通信の失敗は再試行が主導線', () => {
    const { plan } = setup(RouteErrorKind.network);

    fireEvent.click(screen.getByRole('button', { name: '再試行' }));

    expect(plan).toHaveBeenCalledOnce();
  });

  // 同じ条件で引き直しても同じ結果になる種別には、条件変更を先に出す。
  it('候補なしは条件変更が主導線', () => {
    const { navigate, plan } = setup(RouteErrorKind.noResults);

    fireEvent.click(screen.getByRole('button', { name: '条件を変更' }));

    expect(navigate).toHaveBeenCalledWith(screenPath[Screen.home]);
    expect(plan).not.toHaveBeenCalled();
  });

  it('目的地が無いときも条件変更が主導線', () => {
    setup(RouteErrorKind.noDestination);

    expect(screen.getByRole('button', { name: '条件を変更' })).toBeTruthy();
  });

  it('再試行が主導線のときは検索へ戻る導線も出す', () => {
    const { navigate } = setup(RouteErrorKind.timeout);

    fireEvent.click(screen.getByRole('button', { name: '検索に戻る' }));

    expect(navigate).toHaveBeenCalledWith(screenPath[Screen.search]);
  });

  it('条件変更が主導線のときは再試行も出す', () => {
    const { plan } = setup(RouteErrorKind.noResults);

    fireEvent.click(screen.getByRole('button', { name: '再試行' }));

    expect(plan).toHaveBeenCalledOnce();
  });
});

// 現在地が取れずに失敗したときの再試行は、取り直してから引き直す。
//
// 取り直さないと、権限を許可し直しても・一時的な測位失敗が解消しても、同じ null の
// 出発地を送り続けて同じ画面に戻る——主導線が永久に無意味になる。初回取得は
// useInitialLocation が locationState === 'loading' のときしか走らないので、
// denied / unavailable で止まった状態は誰も動かさない（PR #398 の Codex レビュー）。
describe('現在地が取れなかったときの再試行', () => {
  it('取り直してから引き直す', async () => {
    const { request, plan } = setup(RouteErrorKind.noLocation, true);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    });

    expect(request).toHaveBeenCalledOnce();
    expect(plan).toHaveBeenCalledOnce();
    // 取り直した座標が出発地として届く。
    expect(plan.mock.calls[0]![0].origin).toEqual(here);
  });

  it('取り直しても取れなければそのまま引き直す', async () => {
    const { request, plan } = setup(RouteErrorKind.noLocation, false);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    });

    expect(request).toHaveBeenCalledOnce();
    expect(plan).toHaveBeenCalledOnce();
  });

  // 現在地と無関係な失敗で測位し直す理由は無い。権限ダイアログを無駄に出さない。
  it('現在地と無関係な失敗では取り直さない', async () => {
    const { request, plan } = setup(RouteErrorKind.timeout);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    });

    expect(request).not.toHaveBeenCalled();
    expect(plan).toHaveBeenCalledOnce();
  });
});

// 測位の待ちを跨いで離脱したときの続きを止める。移植元の `if (!mounted) return;`
// に相当し、検索画面で同じ穴を塞いだのと同じ型（PR #395 レビュー）。
describe('画面を離れた後の再試行', () => {
  it('検索を始めない', async () => {
    let resolve!: (state: ReturnType<typeof locationDenied2>) => void;
    const navigate = vi.fn();
    const plan = vi.fn(async (_args: PlanArgs) => ({}) as RoutePlan);
    store = createAppStore(
      { routeErrorKind: RouteErrorKind.noLocation, destination: '渋谷駅' },
      () => new Date(2026, 8, 13, 12, 0, 0),
      { request: () => new Promise((r) => (resolve = r)) },
      { plan: plan as RouteService['plan'] },
    );
    store.setState({ locationState: locationDenied });
    store.getState().attachNavigator(navigate);
    const view = render(<ErrorScreen store={store} />);

    fireEvent.click(screen.getByRole('button', { name: '再試行' }));
    view.unmount();
    await act(async () => {
      resolve(locationAvailable(here));
    });

    expect(plan).not.toHaveBeenCalled();
  });
});

/// 型合わせのためのヘルパ（LocationState を返す）。
function locationDenied2() {
  return locationDenied;
}
