import { replace, type RouteObject } from 'react-router';
import type { StoreApi } from 'zustand/vanilla';

import { ErrorScreen } from '../features/error/error-screen';
import { HomeScreen } from '../features/home/home-screen';
import { LoadingScreen } from '../features/loading/loading-screen';
import { ResultScreen } from '../features/result/result-screen';
import { SearchScreen } from '../features/search/search-screen';
import { AppShell } from '../layout/app-shell';
import type { RecentsRepository } from '../places/recents-repository';
import type { ScreenDeps } from './screen-deps';
import type { AppStore } from '../state/store';
import { resolveRedirect } from './guard';
import { Screen, screenPath } from './screens';

export type Now = () => Date;

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
  return { load: failNotWired, add: failNotWired, clear: failNotWired };
}

function failNotWired(): never {
  throw new Error('RecentsRepository が未配線（appRoutes の deps）');
}

export function appRoutes(
  store: StoreApi<AppStore>,
  now: Now = () => new Date(),
  deps: ScreenDeps = depsNotWired,
): RouteObject[] {
  const guard = ({ request }: { request: Request }): null => {
    const to = resolveRedirect(request.url, store.getState(), now());
    // oxlint-disable-next-line typescript/only-throw-error
    if (to !== null) throw replace(to);
    return null;
  };

  const screens: RouteObject[] = Object.values(Screen).map((screen) => ({
    path: screenPath[screen],
    loader: guard,
    Component: componentFor(screen, store, now, deps),
  }));

  return [
    {
      Component: () => <AppShell store={store} />,
      children: [{ path: '/', loader: guard }, ...screens, { path: '*', loader: guard }],
    },
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
          deps={deps}
          now={now}
          onStartSearch={() => {
            void store.getState().startSearch();
          }}
        />
      );
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
  }
}
