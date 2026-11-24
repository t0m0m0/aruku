import { createBrowserRouter, RouterProvider } from 'react-router';

import { resolveRedirect } from './navigation/guard';
import {
  browserHistory,
  createNavigator,
  seedInitialHistory,
  type RouterLike,
} from './navigation/navigator';
import { appRoutes } from './navigation/router';
import type { ScreenDeps } from './navigation/screen-deps';
import { documentVisibility, watchRouteFreshness } from './navigation/route-freshness';
import { watchSearchAbandon } from './navigation/search-abandon';
import { initializeFirebaseAppCheck } from './firebase/app-check';
import { createRecentsRepository, destinationsKey, originsKey } from './places/recents-repository';
import { appConfig } from './config';
import { createPlacesService } from './search/places';
import { createRouteService } from './search/route-service';
import { browserLocationService } from './location/geolocation';
import { createAppStore } from './state/store';

const appCheck = initializeFirebaseAppCheck();

export const appStore = createAppStore(
  {},
  () => new Date(),
  browserLocationService(),
  createRouteService({
    transitBaseUrl: appConfig.transitApiBaseUrl,
    proxyBaseUrl: appConfig.proxyBaseUrl,
    appCheck,
    exactWalkMax: appConfig.exactWalkMax,
    rideDepartures: appConfig.rideDepartures,
  }),
);

const deps: ScreenDeps = {
  places: createPlacesService({ appCheck }),
  recents: {
    destination: createRecentsRepository(undefined, destinationsKey),
    origin: createRecentsRepository(undefined, originsKey),
  },
};

seedInitialHistory(
  browserHistory(),
  (url) => resolveRedirect(url, appStore.getState(), new Date()) === null,
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

appStore.getState().attachNavigator(createNavigator(routerLike));

watchRouteFreshness(documentVisibility(), appStore);

watchSearchAbandon(
  {
    snapshot: () => ({
      path: router.state.location.pathname,
      action: router.state.historyAction,
      settled: router.state.navigation.state === 'idle',
    }),
    subscribe: (listener) => router.subscribe(listener),
  },
  appStore,
);

export function App() {
  return <RouterProvider router={router} />;
}
