import { createBrowserRouter, RouterProvider } from 'react-router';

import { resolveRedirect } from './navigation/guard';
import {
  browserHistory,
  createNavigator,
  seedInitialHistory,
  type RouterLike,
} from './navigation/navigator';
import { appRoutes, type ScreenDeps } from './navigation/router';
import {
  documentVisibility,
  watchRouteFreshness,
} from './navigation/route-freshness';
import { watchSearchAbandon } from './navigation/search-abandon';
import { initializeFirebaseAppCheck } from './firebase/app-check';
import {
  createRecentsRepository,
  destinationsKey,
  originsKey,
} from './places/recents-repository';
import { appConfig } from './config';
import { createPlacesService } from './search/places';
import { createRouteService } from './search/route-service';
import { browserLocationService } from './location/geolocation';
import { createAppStore } from './state/store';

// App Check は Firebase の初期化と対。有効化できない設定（本番でサイトキーが空）では
// トークンの取れないプロバイダが返り、プロキシは 401 を返す——課金 API が素通しで
// 開くよりは検索が失敗するほうがよい（src/firebase/app-check.ts）。
const appCheck = initializeFirebaseAppCheck();

export const appStore = createAppStore(
  {},
  () => new Date(),
  browserLocationService(),
  createRouteService({
    transitBaseUrl: appConfig.transitApiBaseUrl,
    proxyBaseUrl: appConfig.proxyBaseUrl,
    appCheck,
  }),
);

const deps: ScreenDeps = {
  places: createPlacesService({ appCheck }),
  recents: {
    destination: createRecentsRepository(undefined, destinationsKey),
    origin: createRecentsRepository(undefined, originsKey),
  },
};

// ルーターを作る前に敷く。ルーターは RouterProvider がマウントするまで履歴に
// 繋がらないので、作った後では履歴に現れない（navigator.ts 参照）。
// ルーター由来のエントリ（＝リロード）と、起動直後のガードを通れない画面は除く。
seedInitialHistory(browserHistory(), (url) =>
  resolveRedirect(url, appStore.getState(), new Date()) === null,
);

const router = createBrowserRouter(appRoutes(appStore, undefined, deps));

const routerLike: RouterLike = {
  currentPath: () => router.state.location.pathname,
  navigate: (path, options) => {
    void router.navigate(path, options);
  },
  back: () => {
    void router.navigate(-1);
  },
};

// ストアとルーターは互いを要る（ガードはストアを読み、遷移はルーターを呼ぶ）。
// 片方を後から差してほどく。
appStore.getState().attachNavigator(createNavigator(routerLike));

// 待ち画面を離れたら進行中の検索を止める。購読をルーターに張るのは、コンポーネントの
// アンマウントを合図にすると StrictMode の二重マウントで本物の検索を殺すため
// （navigation/search-abandon.ts）。
// 開いたままの「今すぐ」経路は、ガードにも検索完了時の砦にも掛からない（どちらも
// 画面を跨ぐときにしか走らない）。復帰のたびに検算する（移植元 onAppResumed）。
watchRouteFreshness(documentVisibility(), appStore);

watchSearchAbandon(
  {
    snapshot: () => ({
      path: router.state.location.pathname,
      action: router.state.historyAction,
      // 遷移の途中で読むと location がまだ遷移前で、`go(loading)` の最中に
      // 「loading から離れた」と誤読する（search-abandon.ts の注記）。
      settled: router.state.navigation.state === 'idle',
    }),
    subscribe: (listener) => router.subscribe(listener),
  },
  appStore,
);

export function App() {
  return <RouterProvider router={router} />;
}
