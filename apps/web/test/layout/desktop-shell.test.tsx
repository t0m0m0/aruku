// 移植元: lib/shared/widgets/desktop_shell.dart。
//
// 移植元はシェルを Navigator の**外**に置いた。go_router のネスト構造が戻り先
// （settings/search/result/error→home）を表していて、ShellRoute で包むとその構造に
// 手を入れることになるからだった。React Router ではネストは `<Outlet>` の入れ子で
// あって履歴を積まない——戻り先を作っているのは navigator.ts の push/replace/pop の
// 使い分けなので、レイアウトルートで包んでも戻り挙動には触れない。

import { render, screen } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';

import { RoutePhase } from '@aruku/engine/services/route-service';

import { DesktopShell } from '../../src/layout/desktop-shell';
import { stubViewport } from './viewport';
import { createNavigator } from '../../src/navigation/navigator';
import { Screen, screenPath } from '../../src/navigation/screens';
import { createAppStore, type AppStore } from '../../src/state/store';


/// シェルをレイアウトルートに置いた最小のルート表で描く。画面の中身は
/// 差し替えている——ここで見るのはシェルと、シェルが起こす遷移だけ。
function renderShell(entries: string[], store: StoreApi<AppStore> = createAppStore()) {
  const router = createMemoryRouter(
    [
      {
        Component: () => <DesktopShell store={store} />,
        children: [
          { path: screenPath[Screen.home], element: <p>ホーム本文</p> },
          { path: screenPath[Screen.settings], element: <p>設定本文</p> },
          { path: screenPath[Screen.loading], element: <p>待ち本文</p> },
        ],
      },
    ],
    { initialEntries: entries, initialIndex: entries.length - 1 },
  );
  store.getState().attachNavigator(
    createNavigator({
      currentPath: () => router.state.location.pathname,
      navigate: (path, options) => {
        void router.navigate(path, options);
      },
      back: () => {
        void router.navigate(-1);
      },
    }),
  );
  render(<RouterProvider router={router} />);
  return { router, store };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DesktopShell', () => {
  it('モバイル幅では上部バーを出さず、画面だけを出す', () => {
    stubViewport(false);

    renderShell([screenPath[Screen.home]]);

    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.getByText('ホーム本文')).toBeDefined();
  });

  it('デスクトップ幅では上部バーと2つのタブを画面の上に出す', () => {
    stubViewport(true);

    renderShell([screenPath[Screen.home]]);

    expect(screen.getByRole('banner')).toBeDefined();
    expect(screen.getByRole('button', { name: 'ルートを計画' })).toBeDefined();
    expect(screen.getByRole('button', { name: '設定' })).toBeDefined();
    expect(screen.getByText('ホーム本文')).toBeDefined();
  });

  it('設定以外の画面では「ルートを計画」を現在地として示す', () => {
    stubViewport(true);

    renderShell([screenPath[Screen.home]]);

    expect(
      screen.getByRole('button', { name: 'ルートを計画' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(
      screen.getByRole('button', { name: '設定' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('設定画面では「設定」を現在地として示す', () => {
    stubViewport(true);

    renderShell([screenPath[Screen.home], screenPath[Screen.settings]]);

    expect(
      screen.getByRole('button', { name: '設定' }).getAttribute('aria-current'),
    ).toBe('page');
  });

  it('タブを押すと画面が移る', async () => {
    stubViewport(true);
    const { router } = renderShell([screenPath[Screen.home]]);

    screen.getByRole('button', { name: '設定' }).click();

    expect(await screen.findByText('設定本文')).toBeDefined();
    expect(router.state.location.pathname).toBe(screenPath[Screen.settings]);
  });

  it('画面が移ったら本文のスクロール位置を先頭へ戻す', async () => {
    // 本文の器は遷移で作り直されない（替わるのは <Outlet> の中身だけ）。この器が
    // スクローラなので、前の画面の scrollTop を次の画面が引き継ぐ。ブラウザの
    // 復元は document のスクロールしか見ない（PR #407 の Codex レビュー）。
    //
    // 今は本文の器でスクロールする画面が home しか無く、短い画面へ移ると
    // scrollTop は自然に 0 へ丸まる——実ブラウザでは再現できないので、ここでは
    // 機構そのものを見る。
    stubViewport(true);
    const scrollTo = vi.spyOn(Element.prototype, 'scrollTo');
    renderShell([screenPath[Screen.home]]);
    scrollTo.mockClear();

    screen.getByRole('button', { name: '設定' }).click();

    expect(await screen.findByText('設定本文')).toBeDefined();
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    scrollTo.mockRestore();
  });

  it('待ち画面からタブで離れると進行中の検索を打ち切る', async () => {
    // 上部バーは移植元の PopScope も watchSearchAbandon も塞げない出口。前者は
    // モバイルの戻る操作、後者は POP だけを見るのに対し、タブは push で出ていく。
    stubViewport(true);
    const { store, router } = renderShell([
      screenPath[Screen.home],
      screenPath[Screen.loading],
    ]);
    store.setState({ routePhase: RoutePhase.routing });

    screen.getByRole('button', { name: '設定' }).click();

    expect(await screen.findByText('設定本文')).toBeDefined();
    expect(router.state.location.pathname).toBe(screenPath[Screen.settings]);
    expect(store.getState().routePhase).toBeNull();
  });

  it('待ち画面から「ルートを計画」を押すと、検索を打ち切って home へ降りる', async () => {
    stubViewport(true);
    const { store, router } = renderShell([
      screenPath[Screen.home],
      screenPath[Screen.loading],
    ]);
    store.setState({ routePhase: RoutePhase.routing });

    screen.getByRole('button', { name: 'ルートを計画' }).click();

    expect(await screen.findByText('ホーム本文')).toBeDefined();
    expect(router.state.location.pathname).toBe(screenPath[Screen.home]);
    expect(store.getState().routePhase).toBeNull();
  });
});
