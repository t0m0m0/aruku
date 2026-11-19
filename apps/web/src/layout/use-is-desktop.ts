import { useCallback, useMemo, useSyncExternalStore } from 'react';

import { desktopMediaQuery } from './breakpoints';

export function useIsDesktop(): boolean {
  const media = useMemo(() => window.matchMedia(desktopMediaQuery), []);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      media.addEventListener('change', onStoreChange);
      return () => media.removeEventListener('change', onStoreChange);
    },
    [media],
  );

  return useSyncExternalStore(subscribe, () => media.matches);
}
