// 移植元の戻り挙動（settings/search/result/error→home）を React Router で再現する層。
//
// 移植元は go_router のネスト構造で Navigator の pop スタックを作っていた。React Router
// のネストは <Outlet> の入れ子であって履歴を積まないので、URL の前置きだけでは戻り先に
// ならない（PR #391 レビュー）。push / replace の使い分けで明示的に作る。

import { describe, expect, it } from 'vitest';

import {
  createNavigator,
  navigationIntent,
  seedInitialHistory,
  type HistoryLike,
  type RouterLike,
} from '../../src/navigation/navigator';
import { Screen, screenPath } from '../../src/navigation/screens';

function fakeRouter(startPath: string) {
  const calls: { path: string; replace: boolean }[] = [];
  let path = startPath;
  const router: RouterLike = {
    currentPath: () => path,
    navigate(next, options) {
      calls.push({ path: next, replace: options?.replace === true });
      // 実際のルーターの遷移は非同期で、決着するまで現在地は変わらない。
      setTimeout(() => {
        path = next;
      }, 0);
    },
  };
  return { router, calls };
}

function fakeHistory(startUrl: string, isRouterEntry = false) {
  const calls: { path: string; replace: boolean }[] = [];
  const url = new URL(startUrl, 'https://app.test');
  return {
    history: {
      currentPath: () => url.pathname,
      currentUrl: () => `${url.pathname}${url.search}${url.hash}`,
      isRouterEntry: () => isRouterEntry,
      replaceState: (path: string) => calls.push({ path, replace: true }),
      pushState: (path: string) => calls.push({ path, replace: false }),
    } satisfies HistoryLike,
    calls,
  };
}

const settled = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('navigationIntent', () => {
  it('home から子へは push する（戻ると home に戻る）', () => {
    expect(navigationIntent(Screen.home, Screen.settings)).toBe('push');
    expect(navigationIntent(Screen.home, Screen.search)).toBe('push');
  });

  it('子から子へは replace する（戻り先を home のままに保つ）', () => {
    // push すると [home, search, result] になり、戻ると閉じたはずの search が出る。
    expect(navigationIntent(Screen.search, Screen.result)).toBe('replace');
    expect(navigationIntent(Screen.loading, Screen.error)).toBe('replace');
  });

  it('子から home へは replace する', () => {
    // push すると [home, settings, home] になり、戻ると閉じた settings が出る。
    expect(navigationIntent(Screen.settings, Screen.home)).toBe('replace');
  });
});

describe('createNavigator', () => {
  it('現在地に応じて push / replace を選ぶ', async () => {
    const { router, calls } = fakeRouter(screenPath.home);
    const navigate = createNavigator(router);

    // 遷移の決着を挟むのは、実際の利用が「描画済みの画面を操作する」形だから。
    // 決着前に続けて呼ぶと現在地が古いまま読まれる（下のテスト）。
    navigate(screenPath.search);
    await settled();
    navigate(screenPath.result);
    await settled();
    navigate(screenPath.home);
    await settled();

    expect(calls).toEqual([
      { path: screenPath.search, replace: false },
      { path: screenPath.result, replace: true },
      { path: screenPath.home, replace: true },
    ]);
  });

  it('決着前に続けて遷移すると現在地を古いまま読む（既知の劣化）', async () => {
    // home → loading → error が一気に起きると、2本目は現在地を home と読んで
    // push してしまい、履歴が [home, loading, error] になる。
    // 戻ると loading だが routePhase は消えているのでガードが home へ寄せる。
    // 安全側に倒れるため、ここでは事実の記録に留める。
    const { router, calls } = fakeRouter(screenPath.home);
    const navigate = createNavigator(router);

    navigate(screenPath.loading);
    navigate(screenPath.error);
    await settled();

    expect(calls[1]).toEqual({ path: screenPath.error, replace: false });
  });
});

describe('seedInitialHistory', () => {
  it('子を直接開いたときは下に home を敷く', () => {
    // deep link では履歴にその1件しか無く、戻るとアプリの外へ出てしまう。
    const { history, calls } = fakeHistory(screenPath.settings);

    seedInitialHistory(history);

    expect(calls).toEqual([
      { path: screenPath.home, replace: true },
      { path: screenPath.settings, replace: false },
    ]);
  });

  it('home で開いたときは何もしない', () => {
    const { history, calls } = fakeHistory(screenPath.home);

    seedInitialHistory(history);

    expect(calls).toEqual([]);
  });

  it('未知のパスで開いたときは何もしない（ガードが home へ寄せる）', () => {
    const { history, calls } = fakeHistory('/home/nav');

    seedInitialHistory(history);

    expect(calls).toEqual([]);
  });

  it('ルーター由来のエントリでは敷き直さない', () => {
    // アプリ内で home→子と遷移した後にリロードすると、履歴は既に [home, 子]。
    // ここで敷き直すと [home, home, 子] になり、リロードのたびに home が増える。
    const { history, calls } = fakeHistory(screenPath.settings, true);

    seedInitialHistory(history);

    expect(calls).toEqual([]);
  });

  it('クエリとハッシュを保ったまま積み直す', () => {
    // 分類は pathname で行うが、積み直す URL は元のまま。落とすと deep link の
    // 状態が黙って消える（screenFromLocation はクエリ付きを明示的に扱う）。
    const { history, calls } = fakeHistory('/home/settings?tab=a#section');

    seedInitialHistory(history);

    expect(calls).toEqual([
      { path: screenPath.home, replace: true },
      { path: '/home/settings?tab=a#section', replace: false },
    ]);
  });
});
