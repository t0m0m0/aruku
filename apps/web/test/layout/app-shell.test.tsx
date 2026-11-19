import { render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';

import { RoutePhase } from '@aruku/engine/services/route-service';

import { AppShell } from '../../src/layout/app-shell';
import { stubViewport } from './viewport';
import { createNavigator } from '../../src/navigation/navigator';
import { Screen, screenPath } from '../../src/navigation/screens';
import { createAppStore, type AppStore } from '../../src/state/store';

function renderShell(entries: string[], store: StoreApi<AppStore> = createAppStore()) {
  const router = createMemoryRouter(
    [
      {
        Component: () => <AppShell store={store} />,
        children: [
          { path: screenPath[Screen.home], element: <p>ホーム本文</p> },
          { path: screenPath[Screen.search], element: <p>検索本文</p> },
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

describe('AppShell', () => {
  it.each([
    ['モバイル幅', false],
    ['デスクトップ幅', true],
  ])('%sでも上部バーを画面の上に出し、押せるのはロゴだけ', (_, isDesktop) => {
    stubViewport(isDesktop);

    renderShell([screenPath[Screen.home]]);

    const banner = screen.getByRole('banner');
    expect(
      within(banner)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['あるく ホームへ戻る']);
    expect(screen.getByText('ホーム本文')).toBeDefined();
  });

  it('子の画面でロゴを押すと home へ移る', async () => {
    stubViewport(true);
    const { router } = renderShell([screenPath[Screen.home], screenPath[Screen.search]]);

    screen.getByRole('button', { name: 'あるく ホームへ戻る' }).click();

    expect(await screen.findByText('ホーム本文')).toBeDefined();
    expect(router.state.location.pathname).toBe(screenPath[Screen.home]);
  });

  it('待ち画面からロゴを押すと、検索を打ち切って home へ降りる', async () => {
    stubViewport(true);
    const { store, router } = renderShell([screenPath[Screen.home], screenPath[Screen.loading]]);
    store.setState({ routePhase: RoutePhase.routing });

    screen.getByRole('button', { name: 'あるく ホームへ戻る' }).click();

    expect(await screen.findByText('ホーム本文')).toBeDefined();
    expect(router.state.location.pathname).toBe(screenPath[Screen.home]);
    expect(store.getState().routePhase).toBeNull();
  });

  it('画面が移ったら本文のスクロール位置を先頭へ戻す', async () => {
    stubViewport(true);
    const scrollTo = vi.spyOn(Element.prototype, 'scrollTo');
    const { store } = renderShell([screenPath[Screen.home], screenPath[Screen.search]]);
    scrollTo.mockClear();

    store.getState().go(Screen.home);

    expect(await screen.findByText('ホーム本文')).toBeDefined();
    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    });
    scrollTo.mockRestore();
  });
});
