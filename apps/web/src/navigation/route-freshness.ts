import type { StoreApi } from 'zustand/vanilla';

import { routeFreshness } from '../state/app-state';
import type { AppStore } from '../state/store';

export interface VisibilitySource {
  isVisible(): boolean;

  subscribe(listener: () => void): () => void;
}

export interface FreshnessTimers {
  setTimeout(handler: () => void, ms: number): number;
  clearTimeout(id: number): void;
  now(): Date;
}

const browserTimers: FreshnessTimers = {
  setTimeout: (handler, ms) => window.setTimeout(handler, ms),
  clearTimeout: (id) => {
    window.clearTimeout(id);
  },
  now: () => new Date(),
};

export function watchRouteFreshness(
  source: VisibilitySource,
  store: StoreApi<AppStore>,
  timers: FreshnessTimers = browserTimers,
): () => void {
  const stopVisibility = source.subscribe(() => {
    if (!source.isVisible()) return;
    store.getState().revalidateRoute();
  });

  let timer: number | null = null;

  function reschedule(): void {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
    const { route, routeAsOf } = store.getState();
    if (route === null || routeAsOf === null) return;

    const remaining = routeAsOf.getTime() + routeFreshness - timers.now().getTime();
    timer = timers.setTimeout(
      () => {
        timer = null;
        store.getState().revalidateRoute();
      },
      Math.max(remaining, 0),
    );
  }

  const stopStore = store.subscribe(reschedule);
  reschedule();

  return () => {
    stopVisibility();
    stopStore();
    if (timer !== null) timers.clearTimeout(timer);
  };
}

export function documentVisibility(): VisibilitySource {
  return {
    isVisible: () => document.visibilityState === 'visible',
    subscribe: (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => {
        document.removeEventListener('visibilitychange', listener);
      };
    },
  };
}
