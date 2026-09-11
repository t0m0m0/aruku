import { redirect, type RouteObject } from 'react-router';
import type { StoreApi } from 'zustand/vanilla';

import type { AppStore } from '../state/store';
import { resolveRedirect } from './guard';
import { screenPath, type Screen } from './screens';

/// 現在時刻の供給元。テストで失効（#264）を制御できるよう注入可能にする。
export type Now = () => Date;

/// 画面はまだ無い。ルーティングが先に入るスライスなので、どの画面に着いたかだけを
/// 出す（#386 の後続スライスで実体に差し替わる）。
function ScreenPlaceholder({ screen }: { screen: Screen }) {
  return <div data-screen={screen} />;
}

/// アプリ全体のルート表。
///
/// 移植元（lib/core/navigation/app_router.dart）と違い、現在地の権威は URL だけが
/// 持つ。state → router / router → state の双方向同期とエコー遮断は要らなくなった。
/// 残す不変条件は「画面と表示前提データが揃っていること」で、それは各ルートの
/// loader が [resolveRedirect] で見る。
///
/// '/' と '*' も同じ loader を通す。[resolveRedirect] が未知 location を home へ
/// 解決するので、跳ね返し先の分岐を2箇所に分けない。
export function appRoutes(
  store: StoreApi<AppStore>,
  now: Now = () => new Date(),
): RouteObject[] {
  const guard = ({ request }: { request: Request }): null => {
    const to = resolveRedirect(request.url, store.getState(), now());
    if (to !== null) throw redirect(to);
    return null;
  };

  const screens: RouteObject[] = Object.entries(screenPath).map(
    ([screen, path]) => ({
      path,
      loader: guard,
      Component: () => <ScreenPlaceholder screen={screen as Screen} />,
    }),
  );

  return [
    { path: '/', loader: guard },
    ...screens,
    { path: '*', loader: guard },
  ];
}
