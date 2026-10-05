// 移植元: flutter-final:lib/shared/widgets/desktop_shell.dart。
//
// 移植元はシェルを Navigator の**外**に置いた。go_router のネスト構造が戻り先
// （search/result/error→home）を表していて、ShellRoute で包むとその構造に
// 手を入れることになるからだった。React Router ではネストは `<Outlet>` の入れ子で
// あって履歴を積まない——戻り先を作っているのは navigator.ts の push/replace/pop の
// 使い分けなので、レイアウトルートで包んでも戻り挙動には触れない。

import { render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StoreApi } from 'zustand/vanilla';

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
        Component: DesktopShell,
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

describe('DesktopShell', () => {
  it('モバイル幅では上部バーを出さず、画面だけを出す', () => {
    stubViewport(false);

    renderShell([screenPath[Screen.home]]);

    expect(screen.queryByRole('banner')).toBeNull();
    expect(screen.getByText('ホーム本文')).toBeDefined();
  });

  // タブは #432 で撤去した。上部バーはロゴと名前だけで、押せるものを置かない。
  it('デスクトップ幅では上部バーを画面の上に出し、バーには押せるものを置かない', () => {
    stubViewport(true);

    renderShell([screenPath[Screen.home]]);

    const banner = screen.getByRole('banner');
    expect(within(banner).queryAllByRole('button')).toEqual([]);
    expect(within(banner).getByText('あるく')).toBeDefined();
    expect(screen.getByText('ホーム本文')).toBeDefined();
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
    const { store } = renderShell([screenPath[Screen.home], screenPath[Screen.search]]);
    scrollTo.mockClear();

    store.getState().go(Screen.home);

    expect(await screen.findByText('ホーム本文')).toBeDefined();
    // 描画の確定と useEffect の実行は別の tick。findByText が前者を捉えた時点では
    // まだ走っていないことがある（CI で再現）。
    await waitFor(() => {
      expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    });
    scrollTo.mockRestore();
  });
});
