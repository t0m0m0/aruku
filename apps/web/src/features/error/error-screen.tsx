import { useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { ja } from '../../i18n/ja';
import { Screen } from '../../navigation/screens';
import { Button } from '../../shared/ui/button';
import { RoutesIcon } from '../../shared/icons';
import { RouteErrorKind } from '../../state/app-state';
import { RouteRecovery, routeErrorView } from '../../state/route-error';
import type { AppStore } from '../../state/store';

interface ErrorScreenProps {
  store: StoreApi<AppStore>;
}

export function ErrorScreen({ store }: ErrorScreenProps) {
  const kind = useStore(store, (s) => s.routeErrorKind) ?? RouteErrorKind.unknown;
  const go = useStore(store, (s) => s.go);
  const startSearch = useStore(store, (s) => s.startSearch);
  const refreshLocation = useStore(store, (s) => s.refreshLocation);

  const view = routeErrorView(kind);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const retry = {
    label: ja.errorRetry,
    onPress: () => {
      void retrySearch();
    },
  };

  async function retrySearch(): Promise<void> {
    if (kind === RouteErrorKind.noLocation) await refreshLocation();
    if (!alive.current) return;
    await startSearch();
  }
  const changeConditions = {
    label: ja.resultChangeConditions,
    onPress: () => {
      go(Screen.home);
    },
  };
  const backToSearch = {
    label: ja.resultBackToSearch,
    onPress: () => {
      go(Screen.search);
    },
  };

  const [primary, secondary] =
    view.primaryRecovery === RouteRecovery.changeConditions
      ? [changeConditions, retry]
      : [retry, backToSearch];

  return (
    <main className="flex min-h-(--screen-min-height) flex-col items-center justify-center gap-2.5 px-8 py-6 text-center desktop:mx-auto desktop:max-w-[520px]">
      <span
        className="mb-3.5 grid size-[84px] place-items-center rounded-full border border-hairline bg-paper text-ink-3"
        aria-hidden="true"
      >
        <RoutesIcon size={32} />
      </span>
      <h1 className="text-[20px] font-bold text-ink">{view.title}</h1>
      <p className="text-[14px] font-medium text-ink-3">{view.description}</p>

      <div className="mt-[22px] flex w-full max-w-80 flex-col gap-2.5">
        <Button onClick={primary.onPress}>{primary.label}</Button>
        <Button variant="outline" onClick={secondary.onPress}>
          {secondary.label}
        </Button>
      </div>
    </main>
  );
}
