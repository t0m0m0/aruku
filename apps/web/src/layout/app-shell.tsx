import type { StoreApi } from 'zustand/vanilla';
import { useEffect, useRef } from 'react';
import { Outlet, useLocation } from 'react-router';

import { ja } from '../i18n/ja';
import { Screen, screenFromLocation } from '../navigation/screens';
import { ArukuLogo } from '../shared/logo';
import type { AppStore } from '../state/store';

interface AppShellProps {
  store: StoreApi<AppStore>;
}

export function AppShell({ store }: AppShellProps) {
  const pathname = useLocation().pathname;

  const body = useRef<HTMLDivElement>(null);
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [pathname]);

  const goHome = () => {
    const state = store.getState();
    if (screenFromLocation(pathname) === Screen.loading) state.abandonSearch();
    state.go(Screen.home);
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-ivory">
      <header className="h-16 flex-none border-b border-hairline bg-paper">
        <div className="flex h-full items-center gap-5 px-5 desktop:px-6">
          <button
            type="button"
            className="flex cursor-pointer items-center gap-2.5 rounded-[4px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-moss-700"
            aria-label={ja.shellHome}
            onClick={goHome}
          >
            <ArukuLogo size={34} />
            <span className="text-[19px] font-black tracking-[0.04em] text-ink">{ja.appTitle}</span>
          </button>
        </div>
      </header>
      <div
        className="min-h-0 flex-1 overflow-y-auto [--screen-min-height:100%]"
        ref={body}
        data-testid="shell-body"
      >
        <Outlet />
      </div>
    </div>
  );
}
