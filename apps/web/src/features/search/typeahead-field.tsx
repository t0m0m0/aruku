import { useEffect, useId, useMemo, useRef, useState, type RefObject } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { GeoPoint } from '@aruku/engine/models/geo-point';

import { ja, searchErrorWithStatus } from '../../i18n/ja';
import type { PlacePrediction } from '../../places/place-prediction';
import type { PlacesService } from '../../places/places-service';
import type { RecentPlace } from '../../places/recent-place';
import type { RecentsRepository } from '../../places/recents-repository';
import { resolvePlacePrediction } from '../../places/resolve-prediction';
import { CloseIcon, SearchIcon } from '../../shared/icons';
import type { AppStore } from '../../state/store';
import { cn } from '../../shared/utils';
import { placeFieldBox } from './place-field-button';
import { createSearchState } from './search-state';
import type { SearchMode } from './search-screen';

interface TypeaheadFieldProps {
  store: StoreApi<AppStore>;
  mode: SearchMode;
  places: PlacesService;
  recents: RecentsRepository;

  inputRef?: RefObject<HTMLInputElement | null>;

  emptyText?: string;
}

interface Entry {
  readonly key: string;
  readonly name: string;
  readonly detail: string;
  select: () => void;
}

export function TypeaheadField({
  store,
  mode,
  places,
  recents,
  inputRef,
  emptyText,
}: TypeaheadFieldProps) {
  const locationState = useStore(store, (s) => s.locationState);
  const selected = useStore(store, (s) => (mode === 'origin' ? s.origin : s.destination));
  const setDestination = useStore(store, (s) => s.setDestination);
  const setOrigin = useStore(store, (s) => s.setOrigin);

  const locationRef = useRef<GeoPoint | null>(null);
  locationRef.current = locationState.kind === 'available' ? locationState.position : null;

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

  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const [pickFailed, setPickFailed] = useState(false);
  const [saved, setSaved] = useState<RecentPlace[]>(() => recents.load());

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const generation = useRef(0);
  const selecting = useRef(false);

  const typed = query ?? '';
  const listId = useId();

  const activeOption = useRef<HTMLLIElement>(null);

  function apply(place: RecentPlace) {
    recents.add(place);
    setSaved(recents.load());
    if (mode === 'origin') setOrigin(place.name, place.latLng);
    else setDestination(place.name, place.latLng);
    setQuery(null);
    setPickFailed(false);
    setOpen(false);
    setHighlighted(0);
    search.getState().search('');
  }

  async function selectPrediction(prediction: PlacePrediction) {
    if (selecting.current) return;
    const gen = ++generation.current;
    selecting.current = true;

    const resolved = await resolvePlacePrediction(places, prediction);
    if (!alive.current) return;
    if (gen !== generation.current) return;
    selecting.current = false;

    if (resolved === null) {
      setPickFailed(true);
      return;
    }
    apply(resolved);
  }

  const entries: Entry[] =
    typed === ''
      ? saved.map((place) => ({
          key: place.placeId ?? place.name,
          name: place.name,
          detail: place.address ?? '',
          select: () => {
            apply(place);
          },
        }))
      : suggestions.map((prediction) => ({
          key: prediction.placeId,
          name: prediction.name,
          detail: prediction.address,
          select: () => {
            void selectPrediction(prediction);
          },
        }));

  function clear() {
    if (selected !== null) {
      if (mode === 'origin') setOrigin(null, null);
      else setDestination(null, null);
    }
    generation.current++;
    selecting.current = false;
    setQuery('');
    setHighlighted(0);
    setPickFailed(false);
    setOpen(true);
    search.getState().search('');
    inputRef?.current?.focus();
  }

  function onChange(next: string) {
    if (selected !== null) {
      if (mode === 'origin') setOrigin(null, null);
      else setDestination(null, null);
    }
    generation.current++;
    selecting.current = false;
    setQuery(next);
    setHighlighted(0);
    setPickFailed(false);
    setOpen(true);
    search.getState().search(next);
  }

  function move(delta: number) {
    if (entries.length === 0) return;
    setHighlighted((current) => Math.min(Math.max(current + delta, 0), entries.length - 1));
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;

    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        if (!open) {
          setOpen(true);
          return;
        }
        move(event.key === 'ArrowDown' ? 1 : -1);
        return;
      case 'Escape':
        setOpen(false);
        return;
      case 'Enter':
        event.preventDefault();
        if (!open) return;
        entries[activeIndex]?.select();
        return;
      default:
        return;
    }
  }

  const activeIndex = Math.min(highlighted, Math.max(entries.length - 1, 0));
  const shown = query ?? selected ?? '';
  const showList = open && entries.length > 0;
  useEffect(() => {
    if (!showList) return;
    activeOption.current?.scrollIntoView({ block: 'nearest' });
  }, [showList, activeIndex, entries.length]);

  const message = messageFor({
    open,
    typed,
    status,
    errorStatus,
    pickFailed,
    mode,
    hasEntries: entries.length > 0,
  });

  return (
    <div className="relative">
      <div className={cn(placeFieldBox, open && 'border-moss-400')}>
        <SearchIcon size={17} />
        <input
          type="text"
          role="combobox"
          className="min-w-0 flex-1 bg-transparent text-[15.5px] font-bold text-ink outline-none placeholder:font-semibold placeholder:text-ink-3"
          aria-label={mode === 'origin' ? ja.searchOriginHint : ja.searchDestinationHint}
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList ? `${listId}-${activeIndex}` : undefined}
          placeholder={
            emptyText ?? (mode === 'origin' ? ja.homeDepartureLabel : ja.homeDestinationPlaceholder)
          }
          value={shown}
          ref={inputRef}
          onFocus={() => {
            setOpen(true);
          }}
          onClick={() => {
            setOpen(true);
          }}
          onBlur={() => {
            setOpen(false);
          }}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        {shown !== '' && (
          <button
            type="button"
            className="grid size-6 flex-none cursor-pointer place-items-center text-ink-3"
            aria-label={ja.searchClearInput}
            onMouseDown={(event) => {
              event.preventDefault();
            }}
            onClick={clear}
          >
            <CloseIcon size={18} />
          </button>
        )}
      </div>

      {showList && (
        <ul
          className="absolute top-[calc(100%+6px)] right-0 left-0 z-2 max-h-80 overflow-y-auto rounded-[14px] border border-hairline bg-popover p-1.5 shadow-[0_18px_40px_rgb(20_30_14/0.12)]"
          id={listId}
          role="listbox"
        >
          {entries.map((entry, index) => (
            <li
              key={entry.key}
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              className="flex cursor-pointer flex-col gap-0.5 rounded-[10px] px-3 py-2.5 aria-selected:bg-accent"
              ref={index === activeIndex ? activeOption : null}
              onMouseDown={(event) => {
                event.preventDefault();
              }}
              onClick={entry.select}
            >
              <span className="text-[14.5px] font-bold text-ink">{entry.name}</span>
              {entry.detail !== '' && (
                <span className="text-[12px] font-medium text-ink-3">{entry.detail}</span>
              )}
            </li>
          ))}
        </ul>
      )}

      {message !== null && (
        <p className="mx-0.5 mt-2 text-[12px] font-semibold text-ink-3" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

interface MessageInput {
  open: boolean;
  typed: string;
  status: 'idle' | 'loading' | 'success' | 'error';
  errorStatus: string | null;
  pickFailed: boolean;
  mode: SearchMode;
  hasEntries: boolean;
}

function messageFor({
  open,
  typed,
  status,
  errorStatus,
  pickFailed,
  mode,
  hasEntries,
}: MessageInput): string | null {
  if (pickFailed) {
    return mode === 'origin' ? ja.searchPickFailedOrigin : ja.searchPickFailedDestination;
  }
  if (!open || typed === '' || hasEntries) return null;
  if (status === 'error') {
    return errorStatus === null ? ja.searchErrorGeneric : searchErrorWithStatus(errorStatus);
  }
  if (status === 'success') return ja.searchEmptyTitle;
  return null;
}
