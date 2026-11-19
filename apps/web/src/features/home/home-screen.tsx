import { useRef } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { PickerMode, TimeValue } from '@aruku/engine/models/time-value';
import { budgetMinutes } from '@aruku/engine/services/route-plan-builder';

import { privacyPolicyUrl, termsOfServiceUrl } from '../../config';
import { useIsDesktop } from '../../layout/use-is-desktop';
import { useInitialLocation } from '../../location/use-initial-location';
import { ja } from '../../i18n/ja';
import type { ScreenDeps } from '../../navigation/screen-deps';
import { Screen } from '../../navigation/screens';
import { Button } from '../../shared/ui/button';
import { ClockIcon, PinIcon, RoutesIcon, SearchIcon } from '../../shared/icons';
import { TimeField } from '../picker/time-field';
import { PlaceFieldButton } from '../search/place-field-button';
import { TypeaheadField } from '../search/typeahead-field';
import { departureLabelText } from '../../state/derived';
import type { AppStore } from '../../state/store';

interface HomeScreenProps {
  store: StoreApi<AppStore>;

  deps: ScreenDeps;

  onStartSearch: (() => void) | null;

  now?: () => Date;
}

export function HomeScreen({
  store,
  deps,
  onStartSearch,
  now = () => new Date(),
}: HomeScreenProps) {
  const isDesktop = useIsDesktop();
  const origin = useStore(store, (s) => s.origin);
  const destination = useStore(store, (s) => s.destination);
  const departure = useStore(store, (s) => s.departure);
  const arrival = useStore(store, (s) => s.arrival);
  const locationState = useStore(store, (s) => s.locationState);
  const go = useStore(store, (s) => s.go);

  useInitialLocation(store);

  const destinationField = useRef<HTMLInputElement>(null);

  const goSearch = () => {
    if (isDesktop) {
      destinationField.current?.focus();
      return;
    }
    go(Screen.search);
  };

  const currentLocationText = departureLabelText(null, locationState);

  return (
    <main className="mx-auto flex min-h-(--screen-min-height) max-w-[620px] flex-col gap-3 px-5 pt-5 pb-9">
      <header className="px-1 pt-1 pb-2">
        <h1 className="text-[20px] leading-snug font-extrabold text-ink">{ja.homeTagline}</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{ja.homeTaglineDescription}</p>
      </header>

      <section className="relative rounded-[22px] border border-border bg-card px-3.5 py-1.5 shadow-card-subtle">
        <span
          className="pointer-events-none absolute top-[58px] bottom-[32px] left-4 flex flex-col items-center text-burnt"
          aria-hidden="true"
        >
          <span className="size-2.5 rounded-full border-3 border-moss-100 bg-moss-500" />
          <span className="my-1 w-0.5 flex-1 bg-moss-200" />
          <PinIcon size={16} filled />
        </span>

        <div className={placeRow}>
          <span className={placeLabel}>{ja.homeDepartureLabel}</span>
          {isDesktop ? (
            <TypeaheadField
              store={store}
              mode="origin"
              places={deps.places}
              recents={deps.recents.origin}
              emptyText={currentLocationText}
            />
          ) : (
            <PlaceFieldButton
              label={ja.homeDepartureLabel}
              value={origin}
              placeholder={currentLocationText}
              onClick={() => {
                go(Screen.searchOrigin);
              }}
            />
          )}
        </div>

        <div className={placeRow}>
          <span className={placeLabel}>{ja.homeDestinationLabel}</span>
          {isDesktop ? (
            <TypeaheadField
              store={store}
              mode="destination"
              places={deps.places}
              recents={deps.recents.destination}
              inputRef={destinationField}
            />
          ) : (
            <PlaceFieldButton
              label={ja.homeDestinationLabel}
              value={destination}
              placeholder={ja.homeDestinationPlaceholder}
              onClick={goSearch}
            />
          )}
        </div>
      </section>

      <section className="mt-6">
        <h2 className="my-[0.83em] flex items-center gap-[5px] px-1 pb-2 text-[13px] font-extrabold tracking-[0.08em] text-ink-2">
          <ClockIcon size={14} />
          <span className="min-w-0 flex-1">{ja.homeTimeSectionLabel}</span>
          <span className="text-end font-semibold tracking-normal">
            {ja.homeWalkablePrefix}
            <span className="font-extrabold text-moss-600">
              {TimeValue.formatBudget(budgetMinutes(departure, arrival))}
            </span>
            {ja.homeWalkableSuffix}
          </span>
        </h2>
        <div className="flex items-stretch gap-7 rounded-md border border-border bg-card p-1.5">
          <TimeField
            store={store}
            mode={PickerMode.depart}
            label={ja.homeDepartureLabel}
            now={now}
          />
          <TimeField
            store={store}
            mode={PickerMode.arrival}
            label={ja.homeArrivalLabel}
            now={now}
          />
        </div>
      </section>

      <div className="min-h-6 flex-1" />

      <Button
        className="min-h-15 rounded-[20px] text-[18px] tracking-[0.06em] shadow-cta-primary"
        disabled={destination !== null && onStartSearch === null}
        onClick={destination !== null ? (onStartSearch ?? noop) : goSearch}
      >
        {destination !== null ? <RoutesIcon size={20} /> : <SearchIcon size={19} />}
        {ctaLabel(destination, onStartSearch)}
      </Button>

      <nav className="flex justify-center gap-4" aria-label={ja.legalSection}>
        <LegalLink label={ja.legalTermsOfService} href={termsOfServiceUrl} />
        <LegalLink label={ja.legalPrivacyPolicy} href={privacyPolicyUrl} />
      </nav>
    </main>
  );
}

const placeRow = 'flex flex-col gap-1.5 py-2 pl-[38px]';
const placeLabel = 'block text-[12px] font-bold tracking-[0.06em] text-ink-2';

function ctaLabel(destination: string | null, onStartSearch: (() => void) | null): string {
  if (destination === null) return ja.homeChooseDestination;
  return onStartSearch === null ? ja.homeSearchRouteNotReady : ja.homeSearchRoute;
}

function noop(): void {}

function LegalLink({ label, href }: { label: string; href: string }) {
  return (
    <a
      className="inline-flex min-h-tap-min items-center px-1 text-[12px] font-semibold text-ink-3 underline-offset-2 hover:underline"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      {label}
    </a>
  );
}
