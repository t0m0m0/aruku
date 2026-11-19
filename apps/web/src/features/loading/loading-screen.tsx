import { useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { TimeValue } from '@aruku/engine/models/time-value';
import { budgetMinutes } from '@aruku/engine/services/route-plan-builder';
import { RoutePhase } from '@aruku/engine/services/route-service';

import { ja } from '../../i18n/ja';
import { ArukuMap } from '../../map/aruku-map';
import { Button } from '../../shared/ui/button';
import type { AppStore } from '../../state/store';

const floors: Readonly<Record<RoutePhase, number>> = {
  [RoutePhase.routing]: 0,
  [RoutePhase.walkability]: 0.55,
  [RoutePhase.building]: 0.95,
};

export function progressFloor(phase: RoutePhase | null): number {
  return phase === null ? floors[RoutePhase.routing] : floors[phase];
}

const asymptote = 0.9;

const rampTau = 6;

const chaseTau = 250;

interface LoadingScreenProps {
  store: StoreApi<AppStore>;
}

export function LoadingScreen({ store }: LoadingScreenProps) {
  const destination = useStore(store, (s) => s.destination);
  const departure = useStore(store, (s) => s.departure);
  const arrival = useStore(store, (s) => s.arrival);
  const routePhase = useStore(store, (s) => s.routePhase);
  const cancelSearch = useStore(store, (s) => s.cancelSearch);

  const progress = useRampedProgress(progressFloor(routePhase));

  const budget = TimeValue.formatBudgetJp(budgetMinutes(departure, arrival));
  const subtitle =
    destination !== null && destination !== ''
      ? `${destination} まで · 制限 ${budget}`
      : `制限 ${budget}`;
  const percent = Math.round(progress * 100);

  return (
    <main className="relative flex min-h-(--screen-min-height) flex-col items-center justify-center gap-7 overflow-hidden p-6">
      <div
        className="pointer-events-none absolute inset-0 opacity-35 saturate-70"
        data-testid="loading-map"
        aria-hidden="true"
        inert
      >
        <ArukuMap showRoute={false} />
      </div>
      <div
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_center,rgb(251_252_236/0)_0%,var(--color-ivory)_70%)]"
        aria-hidden="true"
      />

      <div className="relative flex w-full max-w-80 flex-col items-center gap-2.5 text-center">
        <span
          className="mb-[18px] size-30 animate-pulse-ring rounded-full bg-moss-100 motion-reduce:animate-none"
          aria-hidden="true"
        />
        <p className="text-[13px] font-semibold text-ink-3">{subtitle}</p>
        <p className="text-[18px] font-bold text-ink">{ja.loadingSearchingMessage}</p>

        <div
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-sand"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={ja.loadingSearchingMessage}
        >
          <span
            className="block h-full rounded-full bg-moss-500"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      <Button className="relative max-w-80" variant="outline" onClick={cancelSearch}>
        {ja.loadingCancelButton}
      </Button>
    </main>
  );
}

function useRampedProgress(floor: number): number {
  const [value, setValue] = useState(0);
  const floorRef = useRef(floor);
  floorRef.current = floor;

  useEffect(() => {
    if (typeof requestAnimationFrame !== 'function') return;

    let frame = 0;
    let startedAt: number | null = null;
    let last: number | null = null;
    let current = 0;

    const tick = (at: number) => {
      startedAt ??= at;
      const dtMs = last === null ? 0 : at - last;
      last = at;

      const seconds = (at - startedAt) / 1000;
      const ramp = asymptote * (1 - Math.exp(-seconds / rampTau));
      const target = Math.max(ramp, floorRef.current);
      const k = 1 - Math.exp(-dtMs / chaseTau);
      current += (target - current) * k;
      setValue(current);

      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return Math.max(value, floor);
}
