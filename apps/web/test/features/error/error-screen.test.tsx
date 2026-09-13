// 移植元: lib/features/error/error_screen.dart
//
// DesktopContent（デスクトップ幅の中央寄せ）は運んでいない。#372 の作り分けと対で、
// 検索スライスで見送ったのと同じ理由（PORTING.md）。

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { RoutePlan } from '@aruku/engine/models/route-plan';
import type { RouteService } from '@aruku/engine/services/route-service';

import { ErrorScreen } from '../../../src/features/error/error-screen';
import { locationDenied } from '../../../src/location/location-state';
import { Screen, screenPath } from '../../../src/navigation/screens';
import { RouteErrorKind } from '../../../src/state/app-state';
import { createAppStore, type AppStore } from '../../../src/state/store';
import type { StoreApi } from 'zustand/vanilla';

let store: StoreApi<AppStore>;

function setup(kind: RouteErrorKind | null) {
  const navigate = vi.fn();
  const plan = vi.fn(async () => ({}) as RoutePlan);
  const routeService: RouteService = { plan: plan as RouteService['plan'] };
  store = createAppStore(
    { routeErrorKind: kind, destination: '渋谷駅' },
    () => new Date(2026, 8, 13, 12, 0, 0),
    { request: async () => locationDenied },
    routeService,
  );
  store.getState().attachNavigator(navigate);
  render(<ErrorScreen store={store} />);
  return { navigate, plan };
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
