import { replace, type RouteObject } from 'react-router';
import type { StoreApi } from 'zustand/vanilla';

import { ErrorScreen } from '../features/error/error-screen';
import { HomeScreen } from '../features/home/home-screen';
import { LoadingScreen } from '../features/loading/loading-screen';
import { ResultScreen } from '../features/result/result-screen';
import { SearchScreen, type SearchMode } from '../features/search/search-screen';
import type { PlacesService } from '../places/places-service';
import type { RecentsRepository } from '../places/recents-repository';
import type { AppStore } from '../state/store';
import { resolveRedirect } from './guard';
import { Screen, screenPath } from './screens';

/// 画面が要る外部依存。合成のルート（app.tsx）が組み立てて渡す。
export interface ScreenDeps {
  readonly places: PlacesService;
  readonly recents: Record<SearchMode, RecentsRepository>;
}

/// 現在時刻の供給元。テストで失効（#264）を制御できるよう注入可能にする。
export type Now = () => Date;

/// 実体がまだ無い画面。どの画面に着いたかだけを出す（#386 の後続スライスで
/// 差し替わる）。残るは settings のみ。
function ScreenPlaceholder({ screen }: { screen: Screen }) {
  return <div data-screen={screen} />;
}

/// 依存を渡さずに組んだルート表の既定。描画した時点で落ちる。
///
/// 黙って動く既定（何も返さない PlacesService 等）を置くと、配線漏れが
/// 「候補が出ない検索画面」として残る——上流の不調と区別がつかない。
const depsNotWired: ScreenDeps = {
  places: {
    autocomplete: () => {
      throw new Error('PlacesService が未配線（appRoutes の deps）');
    },
    fetchLatLng: () => {
      throw new Error('PlacesService が未配線（appRoutes の deps）');
    },
    close() {},
  },
  recents: {
    destination: notWiredRecents(),
    origin: notWiredRecents(),
  },
};

function notWiredRecents(): RecentsRepository {
  const fail = (): never => {
    throw new Error('RecentsRepository が未配線（appRoutes の deps）');
  };
  return { load: fail, add: fail, clear: fail };
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
  deps: ScreenDeps = depsNotWired,
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
      Component: componentFor(screen as Screen, store, now, deps),
    }),
  );

  return [
    { path: '/', loader: guard },
    ...screens,
    { path: '*', loader: guard },
  ];
}

function componentFor(
  screen: Screen,
  store: StoreApi<AppStore>,
  now: Now,
  deps: ScreenDeps,
): () => React.JSX.Element {
  switch (screen) {
    case Screen.home:
      return () => (
        <HomeScreen
          store={store}
          now={now}
          onStartSearch={() => {
            void store.getState().startSearch();
          }}
        />
      );
    // 検索は目的地／出発地で同じ画面。違うのはモードと、書き込む先・履歴の系統だけ。
    case Screen.search:
    case Screen.searchOrigin:
      return () => (
        <SearchScreen
          store={store}
          mode={screen === Screen.searchOrigin ? 'origin' : 'destination'}
          places={deps.places}
          recents={deps.recents}
        />
      );
    case Screen.loading:
      return () => <LoadingScreen store={store} />;
    case Screen.result:
      return () => <ResultScreen store={store} />;
    case Screen.error:
      return () => <ErrorScreen store={store} />;
    default:
      return () => <ScreenPlaceholder screen={screen} />;
  }
}
