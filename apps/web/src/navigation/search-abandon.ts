import type { StoreApi } from 'zustand/vanilla';

import type { AppStore } from '../state/store';
import { Screen, screenPath } from './screens';

export interface NavigationSnapshot {
  readonly path: string;

  readonly action: 'POP' | 'PUSH' | 'REPLACE';

  readonly settled: boolean;
}

export interface NavigationSource {
  snapshot(): NavigationSnapshot;

  subscribe(listener: () => void): () => void;
}

export function watchSearchAbandon(
  source: NavigationSource,
  store: StoreApi<AppStore>,
): () => void {
  return source.subscribe(() => {
    const { path, action, settled } = source.snapshot();
    if (!settled) return;
    if (action !== 'POP') return;
    if (path === screenPath[Screen.loading]) return;
    store.getState().abandonSearch();
  });
}
