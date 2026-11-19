import { useEffect } from 'react';
import type { StoreApi } from 'zustand/vanilla';

import type { AppStore } from '../state/store';

export function useInitialLocation(store: StoreApi<AppStore>): void {
  useEffect(() => {
    const { locationState, refreshLocation } = store.getState();
    if (locationState.kind !== 'loading') return;
    void refreshLocation();
  }, [store]);
}
