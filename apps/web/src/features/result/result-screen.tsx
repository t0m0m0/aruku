import { useId } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { SegmentType, type RoutePlan } from '@aruku/engine/models/route-plan';
import { TimeValue } from '@aruku/engine/models/time-value';
import { formatClock } from '@aruku/engine/services/route-plan-builder';

import {
  ja,
  resultCalories,
  resultDepartureLabel,
  resultExtraWalk,
  resultOverBudgetTitle,
  resultSlack,
  resultStandardDetail,
} from '../../i18n/ja';
import { useIsDesktop } from '../../layout/use-is-desktop';
import { ArukuMap } from '../../map/aruku-map';
import { Screen } from '../../navigation/screens';
import { Button } from '../../shared/ui/button';
import { ChevronIcon, RoutesIcon } from '../../shared/icons';
import type { AppStore } from '../../state/store';
import { ResultTimeline } from './result-timeline';
import { TimetableAttribution } from './timetable-attribution';

interface ResultScreenProps {
  store: StoreApi<AppStore>;
}

export function ResultScreen({ store }: ResultScreenProps) {
  const route = useStore(store, (s) => s.route);
  const departure = useStore(store, (s) => s.departure);
  const dateBasis = useStore(store, (s) => s.dateBasis);
  const go = useStore(store, (s) => s.go);
  const isDesktop = useIsDesktop();

  if (route === null) {
    return (
      <main className="flex min-h-(--screen-min-height) flex-col items-center justify-center gap-4 bg-surface p-6 text-on-surface-variant">
        <RoutesIcon size={32} />
        <p className="text-title-medium">{ja.resultNoRouteMessage}</p>
        <Button
          onClick={() => {
            go(Screen.search);
          }}
        >
          {ja.resultBackToSearch}
        </Button>
      </main>
    );
  }

  const overBudget = route.totalMin > route.budgetMin;

  const map = (
    <div
      className="h-[180px] flex-none overflow-hidden rounded-medium desktop:[grid-area:1/2/3/3] desktop:h-auto desktop:rounded-none"
      data-testid="result-map"
    >
      <ArukuMap route={route} />
    </div>
  );

  return (
    <main className="flex min-h-(--screen-min-height) flex-col gap-4 bg-surface px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-on-surface desktop:grid desktop:h-(--screen-min-height) desktop:min-h-0 desktop:grid-cols-[380px_1fr] desktop:grid-rows-[auto_1fr] desktop:gap-0 desktop:p-0">
      <header className="-ml-3 flex min-h-16 items-center gap-1 desktop:[grid-area:1/1] desktop:ml-0 desktop:border-r desktop:border-b desktop:border-outline-variant desktop:px-1">
        <button
          type="button"
          className="grid size-12 flex-none cursor-pointer place-items-center rounded-full text-on-surface hover:bg-on-surface/8"
          aria-label={ja.commonBack}
          onClick={() => {
            go(Screen.home);
          }}
        >
          <ChevronIcon size={20} dir="left" />
        </button>
        <p className="text-title-medium">
          {resultDepartureLabel(departure.fullDateLabel(dateBasis), departure.format())}
        </p>
      </header>

      {isDesktop && map}

      <div
        className="flex min-h-0 flex-1 flex-col gap-4 desktop:[grid-area:2/1] desktop:overflow-y-auto desktop:border-r desktop:border-outline-variant desktop:p-4"
        data-testid="result-panel"
      >
        {overBudget && (
          <section
            className="rounded-medium bg-error-container p-4 text-on-error-container"
            role="status"
          >
            <p className="text-title-medium">
              {resultOverBudgetTitle(route.totalMin - route.budgetMin)}
            </p>
            <p className="mt-1 text-body-medium">{ja.resultOverBudgetHint}</p>
            <Button
              className="mt-3"
              variant="outline"
              onClick={() => {
                go(Screen.home);
              }}
            >
              {ja.resultChangeConditions}
            </Button>
          </section>
        )}

        <section>
          <h2 className="mb-2 text-title-small text-on-surface-variant">
            {ja.resultSegmentsHeading}
          </h2>
          <ResultTimeline route={route} />
        </section>

        {!isDesktop && map}

        <RouteAuxiliary route={route} departure={departure} overBudget={overBudget} />

        <TimetableAttribution sources={route.timetableSources} />
      </div>
    </main>
  );
}

function RouteAuxiliary({
  route,
  departure,
  overBudget,
}: {
  route: RoutePlan;
  departure: TimeValue;
  overBudget: boolean;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="border-t border-outline-variant pt-4">
      <h2 id={headingId} className="pb-1 text-title-small text-on-surface-variant">
        {ja.resultAuxiliaryHeading}
      </h2>
      <ul>
        {!overBudget && <ExtraWalkSummary route={route} departure={departure} />}
        {!overBudget && (
          <AuxiliaryItem>
            {resultSlack(
              formatClock(departure, route.budgetMin),
              TimeValue.formatBudget(route.budgetMin - route.totalMin),
            )}
          </AuxiliaryItem>
        )}
        <AuxiliaryItem>{resultCalories(route.kcal)}</AuxiliaryItem>
      </ul>
    </section>
  );
}

function AuxiliaryItem({ children }: { children: React.ReactNode }) {
  return <li className="flex min-h-14 flex-col justify-center py-2 text-body-large">{children}</li>;
}

const minExtraWalkToShow = 5;

function ExtraWalkSummary({ route, departure }: { route: RoutePlan; departure: TimeValue }) {
  const standard = route.standardTransit;
  if (standard === null) return null;
  const walkMinutes = route.segments
    .filter((s) => s.type === SegmentType.walk)
    .reduce((a, s) => a + s.minutes, 0);
  const extra = walkMinutes - standard.walkMinutes;
  if (extra < minExtraWalkToShow) return null;

  return (
    <AuxiliaryItem>
      <p className="text-label-medium text-on-surface-variant">{ja.resultStandardLead}</p>
      <p className="tabular">{resultExtraWalk(TimeValue.formatBudget(extra))}</p>
      <p className="text-body-medium text-on-surface-variant">
        {resultStandardDetail(formatClock(departure, standard.totalMin), standard.walkMinutes)}
      </p>
    </AuxiliaryItem>
  );
}
