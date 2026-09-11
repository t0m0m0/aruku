import { createBrowserRouter, RouterProvider } from 'react-router';

import { appRoutes } from './navigation/router';
import { createAppStore } from './state/store';

export const appStore = createAppStore();

const router = createBrowserRouter(appRoutes(appStore));

// ストアとルーターは互いを要る（ガードはストアを読み、遷移はルーターを呼ぶ）。
// 片方を後から差してほどく。
appStore.getState().attachNavigator((path) => {
  void router.navigate(path);
});

export function App() {
  return <RouterProvider router={router} />;
}
