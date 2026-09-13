import { replace, type RouteObject } from 'react-router';
import type { StoreApi } from 'zustand/vanilla';

import { HomeScreen } from '../features/home/home-screen';
import type { AppStore } from '../state/store';
import { resolveRedirect } from './guard';
import { Screen, screenPath } from './screens';

/// 現在時刻の供給元。テストで失効（#264）を制御できるよう注入可能にする。
export type Now = () => Date;

/// 実体がまだ無い画面。どの画面に着いたかだけを出す（#386 の後続スライスで
/// 差し替わる）。home は差し替え済み。
function ScreenPlaceholder({ screen }: { screen: Screen }) {
  return <div data-screen={screen} />;
}

/// 経路検索の開始（移植元の `AppNotifier.startSearch`）はまだ運んでいない。検索の
/// ライフサイクル（loading / result / error）と対で入るため、それらの画面を作る
/// スライスで繋ぐ。
///
/// 現時点では到達しない——CTA がここへ来るのは目的地が決まっているときだけで、
/// 目的地を設定できる検索画面がまだ無い。到達し得なくなった時点で黙って何もしない
/// 実装を置くと、繋ぎ忘れが「押しても反応しないボタン」として残る。
function startSearchNotPorted(): never {
  throw new Error('経路検索の開始は未移植（#386 の後続スライス）');
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
  // `redirect` ではなく `replace` を投げる。`redirect` は跳ね返し先を**積む**ので、
  // 弾かれた URL が履歴に残り、home へ着いた後の最初の「戻る」が home を再表示する
  // だけになる（実ブラウザで確認。PR #391 レビュー）。ガードが拒んだ location は
  // 履歴に残してはいけない。
  const guard = ({ request }: { request: Request }): null => {
    const to = resolveRedirect(request.url, store.getState(), now());
    if (to !== null) throw replace(to);
    return null;
  };

  const screens: RouteObject[] = Object.entries(screenPath).map(
    ([screen, path]) => ({
      path,
      loader: guard,
      Component:
        screen === Screen.home
          ? () => (
              <HomeScreen
                store={store}
                now={now}
                onStartSearch={startSearchNotPorted}
              />
            )
          : () => <ScreenPlaceholder screen={screen as Screen} />,
    }),
  );

  return [
    { path: '/', loader: guard },
    ...screens,
    { path: '*', loader: guard },
  ];
}
