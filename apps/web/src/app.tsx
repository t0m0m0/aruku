import { createBrowserRouter, RouterProvider } from 'react-router';

import {
  browserHistory,
  createNavigator,
  seedInitialHistory,
  type RouterLike,
} from './navigation/navigator';
import { appRoutes } from './navigation/router';
import { createAppStore } from './state/store';

export const appStore = createAppStore();

// ルーターを作る前に敷く。ルーターは RouterProvider がマウントするまで履歴に
// 繋がらないので、作った後では履歴に現れない（navigator.ts 参照）。
seedInitialHistory(browserHistory());

const router = createBrowserRouter(appRoutes(appStore));

const routerLike: RouterLike = {
  currentPath: () => router.state.location.pathname,
  navigate: (path, options) => {
    void router.navigate(path, options);
  },
};

// ストアとルーターは互いを要る（ガードはストアを読み、遷移はルーターを呼ぶ）。
// 片方を後から差してほどく。
appStore.getState().attachNavigator(createNavigator(routerLike));

export function App() {
  return <RouterProvider router={router} />;
}
