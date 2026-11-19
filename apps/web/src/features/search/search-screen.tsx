import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { GeoPoint } from '@aruku/engine/models/geo-point';

import { ja, searchErrorWithStatus } from '../../i18n/ja';
import { useInitialLocation } from '../../location/use-initial-location';
import { Screen } from '../../navigation/screens';
import type { PlacePrediction } from '../../places/place-prediction';
import type { PlacesService } from '../../places/places-service';
import type { RecentPlace } from '../../places/recent-place';
import type { RecentsRepository } from '../../places/recents-repository';
import { resolvePlacePrediction } from '../../places/resolve-prediction';
import { ChevronIcon, CloseIcon, CompassIcon, PinIcon, SearchIcon } from '../../shared/icons';
import type { AppStore } from '../../state/store';
import { createSearchState } from './search-state';

export type SearchMode = 'destination' | 'origin';

interface SearchScreenProps {
  store: StoreApi<AppStore>;
  mode: SearchMode;
  places: PlacesService;

  recents: Record<SearchMode, RecentsRepository>;
}

export function SearchScreen({ store, mode, places, recents }: SearchScreenProps) {
  const locationState = useStore(store, (s) => s.locationState);
  const go = useStore(store, (s) => s.go);
  const setDestination = useStore(store, (s) => s.setDestination);
  const setOrigin = useStore(store, (s) => s.setOrigin);

  const currentLocation: GeoPoint | null =
    locationState.kind === 'available' ? locationState.position : null;

  const located = currentLocation !== null;
  const locationRef = useRef(currentLocation);
  locationRef.current = currentLocation;

  const history = recents[mode];

  useInitialLocation(store);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const search = useMemo(
    () =>
      createSearchState({
        service: places,
        currentLocation: () => locationRef.current,
      }),
    [places],
  );
  useEffect(() => () => search.getState().dispose(), [search]);

  const status = useStore(search, (s) => s.status);
  const suggestions = useStore(search, (s) => s.suggestions);
  const errorStatus = useStore(search, (s) => s.errorStatus);
  const nearby = useStore(search, (s) => s.nearby);

  const [query, setQuery] = useState('');
  const [pickFailed, setPickFailed] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [saved, setSaved] = useState<RecentPlace[]>(() => history.load());

  function applySelection(name: string | null, latLng: GeoPoint | null) {
    if (mode === 'origin') setOrigin(name, latLng);
    else setDestination(name, latLng);
    go(Screen.home);
  }

  function remember(place: RecentPlace) {
    history.add(place);
    setSaved(history.load());
  }

  async function selectPrediction(prediction: PlacePrediction) {
    if (selecting) return;
    setSelecting(true);
    setPickFailed(false);

    const resolved = await resolvePlacePrediction(places, prediction);
    if (!alive.current) return;
    setSelecting(false);
    if (resolved === null) {
      setPickFailed(true);
      return;
    }
    remember(resolved);
    applySelection(resolved.name, resolved.latLng);
  }

  function selectRecent(place: RecentPlace) {
    remember(place);
    applySelection(place.name, place.latLng);
  }

  function useCurrentLocation() {
    if (mode === 'origin') {
      applySelection(null, null);
      return;
    }
    if (currentLocation === null) return;
    applySelection(ja.searchCurrentLocationName, currentLocation);
  }

  function onQueryChange(next: string) {
    setQuery(next);
    setPickFailed(false);
    search.getState().search(next);
  }

  function clearHistory() {
    history.clear();
    setSaved([]);
  }

  const showCurrentLocation = mode === 'origin' || located;

  return (
    <main className="flex min-h-(--screen-min-height) flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]">
      <header className="flex items-center gap-1.5 px-3.5 pt-1 pb-3.5">
        <button
          type="button"
          className="grid size-10 flex-none cursor-pointer place-items-center rounded-sm text-ink active:bg-sand"
          aria-label={ja.commonBack}
          onClick={() => {
            go(Screen.home);
          }}
        >
          <ChevronIcon size={20} dir="left" />
        </button>

        <div className="flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-[14px] border border-hairline bg-paper px-3.5 text-ink-3">
          <SearchIcon size={18} />
          <input
            type="search"
            className="min-w-0 flex-1 bg-transparent text-[16px] font-semibold text-ink caret-moss-500 placeholder:font-medium placeholder:text-ink-3 focus:outline-none [&::-webkit-search-cancel-button]:appearance-none"
            aria-label={mode === 'origin' ? ja.searchOriginHint : ja.searchDestinationHint}
            placeholder={mode === 'origin' ? ja.searchOriginHint : ja.searchDestinationHint}
            value={query}
            autoFocus
            onChange={(event) => {
              onQueryChange(event.target.value);
            }}
          />
          {query !== '' && (
            <button
              type="button"
              className="grid size-6 flex-none cursor-pointer place-items-center text-ink-3"
              aria-label={ja.searchClearInput}
              onClick={() => {
                onQueryChange('');
              }}
            >
              <CloseIcon size={18} />
            </button>
          )}
        </div>
      </header>

      {located && (
        <button
          type="button"
          role="switch"
          aria-checked={nearby}
          className="mx-5 mb-2.5 inline-flex cursor-pointer items-center gap-1.5 self-start rounded-full border border-hairline bg-paper px-3.5 py-2 text-[13px] font-bold text-ink-3 aria-checked:border-moss-500 aria-checked:bg-moss-500 aria-checked:text-paper"
          onClick={() => {
            search.getState().setNearby(!nearby);
          }}
        >
          <CompassIcon size={15} />
          <span>{ja.searchNearbyToggle}</span>
        </button>
      )}

      {query !== '' ? (
        <Results
          status={status}
          errorStatus={errorStatus}
          suggestions={suggestions}
          query={query}
          mode={mode}
          pickFailed={pickFailed}
          selecting={selecting}
          onSelect={(prediction) => void selectPrediction(prediction)}
        />
      ) : (
        <Recents
          mode={mode}
          places={saved}
          showCurrentLocation={showCurrentLocation}
          onUseCurrentLocation={useCurrentLocation}
          onSelect={selectRecent}
          onClear={clearHistory}
        />
      )}
    </main>
  );
}

interface ResultsProps {
  status: 'idle' | 'loading' | 'success' | 'error';
  errorStatus: string | null;
  suggestions: PlacePrediction[];
  query: string;
  mode: SearchMode;
  pickFailed: boolean;
  selecting: boolean;
  onSelect: (prediction: PlacePrediction) => void;
}

function Results({
  status,
  errorStatus,
  suggestions,
  query,
  mode,
  pickFailed,
  selecting,
  onSelect,
}: ResultsProps) {
  if (status === 'idle') return null;

  if (status === 'loading') {
    return (
      <div className={list} aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex items-center gap-3.5 px-[22px] py-2.5" aria-hidden="true">
            <span className="size-[38px] flex-none rounded-sm bg-hairline" />
            <span className="flex flex-1 flex-col gap-1.5">
              <span className="h-3.5 rounded-[4px] bg-hairline" />
              <span className="h-2.5 w-40 rounded-[4px] bg-hairline" />
            </span>
          </div>
        ))}
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className={notice}>
        <SearchIcon size={32} />
        <p className={noticeTitle}>
          {errorStatus !== null ? searchErrorWithStatus(errorStatus) : ja.searchErrorGeneric}
        </p>
        <p className={noticeHint}>{ja.searchNetworkHint}</p>
      </div>
    );
  }

  if (suggestions.length === 0) {
    return (
      <div className={notice}>
        <PinIcon size={32} />
        <p className={noticeTitle}>{ja.searchEmptyTitle}</p>
        <p className={noticeHint}>{ja.searchEmptyHint}</p>
      </div>
    );
  }

  return (
    <>
      <span className="sr-only" role="status">
        {selecting ? ja.searchResolvingPlace : ''}
      </span>
      {pickFailed && (
        <p
          className="mx-[22px] mt-2 mb-1 rounded-sm bg-burnt-soft px-3.5 py-3 text-[13px] font-semibold text-burnt"
          role="alert"
        >
          {mode === 'origin' ? ja.searchPickFailedOrigin : ja.searchPickFailedDestination}
        </p>
      )}
      <div className={list}>
        {suggestions.map((s) => (
          <PlaceRow
            key={s.placeId}
            name={s.name}
            address={s.address}
            query={query}
            disabled={selecting}
            onSelect={() => {
              onSelect(s);
            }}
          />
        ))}
      </div>
    </>
  );
}

interface RecentsProps {
  mode: SearchMode;
  places: RecentPlace[];
  showCurrentLocation: boolean;
  onUseCurrentLocation: () => void;
  onSelect: (place: RecentPlace) => void;
  onClear: () => void;
}

function Recents({
  mode,
  places,
  showCurrentLocation,
  onUseCurrentLocation,
  onSelect,
  onClear,
}: RecentsProps) {
  if (!showCurrentLocation && places.length === 0) return null;

  return (
    <div className={list}>
      {showCurrentLocation && (
        <button
          type="button"
          className={row}
          aria-label={ja.searchUseCurrentLocation}
          onClick={onUseCurrentLocation}
        >
          <span className={rowIcon}>
            <CompassIcon size={18} />
          </span>
          <span className={rowName}>{ja.searchUseCurrentLocation}</span>
        </button>
      )}

      {places.length > 0 && (
        <>
          <div className="flex items-center justify-between px-[22px] pt-4 pb-1.5">
            <h2 className="text-[12px] font-bold text-ink-3">
              {mode === 'origin' ? ja.searchRecentOrigins : ja.searchRecentDestinations}
            </h2>
            <button
              type="button"
              className="cursor-pointer text-[12px] font-semibold text-ink-3"
              onClick={onClear}
            >
              {ja.searchClearHistory}
            </button>
          </div>
          {places.map((place) => (
            <PlaceRow
              key={`${place.placeId ?? ''}:${place.name}`}
              name={place.name}
              address={place.address ?? ''}
              onSelect={() => {
                onSelect(place);
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}

const list = 'flex-1 overflow-y-auto py-2';
const notice =
  'flex flex-1 flex-col items-center justify-center gap-1.5 px-[22px] text-center text-ink-3';
const noticeTitle = 'mt-1.5 text-[14px] font-semibold';
const noticeHint = 'text-[12px] font-medium';
const row =
  'flex w-full cursor-pointer items-center gap-3.5 px-[22px] py-3 text-start text-ink active:bg-sand disabled:cursor-default disabled:opacity-50';
const rowIcon = 'grid size-[38px] flex-none place-items-center rounded-sm bg-moss-50 text-moss-600';
const rowName = 'truncate text-[16px] font-bold text-ink';

interface PlaceRowProps {
  name: string;
  address: string;
  query?: string;
  disabled?: boolean;
  onSelect: () => void;
}

function PlaceRow({ name, address, query, disabled, onSelect }: PlaceRowProps) {
  return (
    <button
      type="button"
      className={row}
      aria-label={address !== '' ? `${name} ${address}` : name}
      disabled={disabled ?? false}
      onClick={onSelect}
    >
      <span className={rowIcon}>
        <PinIcon size={18} />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className={rowName}>
          <Highlighted text={name} query={query ?? ''} />
        </span>
        {address !== '' && (
          <span className="truncate text-[12px] font-medium text-ink-3">{address}</span>
        )}
      </span>
    </button>
  );
}

function Highlighted({ text, query }: { text: string; query: string }) {
  if (query === '') return <>{text}</>;
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="bg-moss-100 text-moss-700">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}
