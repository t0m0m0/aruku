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
      setTimeout(() => {
        path = next;
      }, 0);
    },
    back() {
      calls.push({ path: '(back)', replace: false });
    },
  };
  return { router, calls };
}

function fakeHistory(
  startUrl: string,
  options: { isRouterEntry?: boolean; hasParentEntry?: boolean } = {},
) {
  const calls: { path: string; replace: boolean; index?: number }[] = [];
  const url = new URL(startUrl, 'https://app.test');
  return {
    history: {
      currentPath: () => url.pathname,
      currentUrl: () => `${url.pathname}${url.search}${url.hash}`,
      isRouterEntry: () => options.isRouterEntry === true,
      hasParentEntry: () => options.hasParentEntry === true,
      replaceState: (path: string, index: number) => calls.push({ path, replace: true, index }),
      pushState: (path: string, index: number) => calls.push({ path, replace: false, index }),
      back: () => calls.push({ path: '(back)', replace: false }),
    } satisfies HistoryLike,
    calls,
  };
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('navigationIntent', () => {
  it('home から子へは push する（戻ると home に戻る）', () => {
    expect(navigationIntent(Screen.home, Screen.search)).toBe('push');
    expect(navigationIntent(Screen.home, Screen.searchOrigin)).toBe('push');
  });

  it('子から子へは replace する（戻り先を home のままに保つ）', () => {
    expect(navigationIntent(Screen.search, Screen.result)).toBe('replace');
    expect(navigationIntent(Screen.loading, Screen.error)).toBe('replace');
  });

  it('子から home へは pop する', () => {
    expect(navigationIntent(Screen.search, Screen.home)).toBe('pop');
  });

  it('home から home へは replace する（降ろす子が無い）', () => {
    expect(navigationIntent(Screen.home, Screen.home)).toBe('replace');
  });
});

describe('createNavigator', () => {
  it('現在地に応じて push / replace を選ぶ', async () => {
    const { router, calls } = fakeRouter(screenPath.home);
    const navigate = createNavigator(router);

    navigate(screenPath.search);
    await settled();
    navigate(screenPath.result);
    await settled();
    navigate(screenPath.home);
    await settled();

    expect(calls).toEqual([
      { path: screenPath.search, replace: false },
      { path: screenPath.result, replace: true },
      { path: '(back)', replace: false },
    ]);
  });

  it('決着前に続けて遷移すると現在地を古いまま読む（既知の劣化）', async () => {
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
    const { history, calls } = fakeHistory(screenPath.search);

    seedInitialHistory(history, () => true);

    expect(calls).toEqual([
      { path: screenPath.home, replace: true, index: 0 },
      { path: screenPath.search, replace: false, index: 1 },
    ]);
  });

  it('敷いた子には深さ1を書く（後のリロードで親を見つけられる）', () => {
    const { history, calls } = fakeHistory(screenPath.search);

    seedInitialHistory(history, () => true);

    expect(calls.map((c) => c.index)).toEqual([0, 1]);
  });

  it('home で開いたときは何もしない', () => {
    const { history, calls } = fakeHistory(screenPath.home);

    seedInitialHistory(history, () => true);

    expect(calls).toEqual([]);
  });

  it('未知のパスで開いたときは何もしない（ガードが home へ寄せる）', () => {
    const { history, calls } = fakeHistory('/home/nav');

    seedInitialHistory(history, () => true);

    expect(calls).toEqual([]);
  });

  it('ルーター由来のエントリでは敷き直さない', () => {
    const { history, calls } = fakeHistory(screenPath.search, {
      isRouterEntry: true,
    });

    seedInitialHistory(history, () => true);

    expect(calls).toEqual([]);
  });

  it('リロードで通らなくなった子からは真下の home へ降りる', () => {
    const { history, calls } = fakeHistory(screenPath.result, {
      isRouterEntry: true,
      hasParentEntry: true,
    });

    seedInitialHistory(history, () => false);

    expect(calls).toEqual([{ path: '(back)', replace: false }]);
  });

  it('手前が無いなら降りない（アプリの外へ出てしまう）', () => {
    const { history, calls } = fakeHistory(screenPath.result, {
      isRouterEntry: true,
      hasParentEntry: false,
    });

    seedInitialHistory(history, () => false);

    expect(calls).toEqual([]);
  });

  it('初回のガードを通れない画面には敷かない', () => {
    const { history, calls } = fakeHistory(screenPath.result);

    seedInitialHistory(history, () => false);

    expect(calls).toEqual([]);
  });

  it('クエリとハッシュを保ったまま積み直す', () => {
    const { history, calls } = fakeHistory('/home/search?tab=a#section');

    seedInitialHistory(history, () => true);

    expect(calls).toEqual([
      { path: screenPath.home, replace: true, index: 0 },
      { path: '/home/search?tab=a#section', replace: false, index: 1 },
    ]);
  });
});
