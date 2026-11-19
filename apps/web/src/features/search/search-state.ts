import { createStore, type StoreApi } from 'zustand/vanilla';

import type { GeoPoint } from '@aruku/engine/models/geo-point';

import type { PlacePrediction } from '../../places/place-prediction';
import { PlacesException, type PlacesService } from '../../places/places-service';

export const searchDebounce = 400;

export type SearchStatus = 'idle' | 'loading' | 'success' | 'error';

export interface SearchStateValue {
  readonly status: SearchStatus;
  readonly suggestions: PlacePrediction[];

  readonly errorStatus: string | null;

  readonly nearby: boolean;
}

export interface SearchActions {
  search(query: string): void;
  setNearby(value: boolean): void;

  dispose(): void;
}

export type SearchState = StoreApi<SearchStateValue & SearchActions>;

export interface SearchStateOptions {
  readonly service: PlacesService;

  readonly currentLocation: () => GeoPoint | null;
}

export function createSearchState(options: SearchStateOptions): SearchState {
  let debounce: ReturnType<typeof setTimeout> | null = null;

  let generation = 0;

  let inflight: AbortController | null = null;

  function abortInflight(): void {
    inflight?.abort();
    inflight = null;
  }

  let raw: PlacePrediction[] = [];

  return createStore<SearchStateValue & SearchActions>()((set, get) => {
    async function fetch(query: string, gen: number): Promise<void> {
      const location = options.currentLocation();
      const aborter = new AbortController();
      inflight = aborter;
      try {
        const fetched = await options.service.autocomplete(query, location, aborter.signal);
        if (gen !== generation) return;
        raw = fetched;
        set({
          status: 'success',
          suggestions: arrange(get().nearby, location, fetched),
          errorStatus: null,
        });
      } catch (error) {
        if (gen !== generation) return;
        set({
          status: 'error',
          suggestions: [],
          errorStatus: error instanceof PlacesException ? error.status : null,
        });
      } finally {
        if (inflight === aborter) inflight = null;
      }
    }

    return {
      status: 'idle',
      suggestions: [],
      errorStatus: null,
      nearby: false,

      search(query: string) {
        if (debounce !== null) clearTimeout(debounce);
        generation++;
        abortInflight();

        if (query === '') {
          raw = [];
          set({ status: 'idle', suggestions: [], errorStatus: null });
          return;
        }

        set({ status: 'loading', suggestions: [], errorStatus: null });
        const gen = generation;
        debounce = setTimeout(() => {
          void fetch(query, gen);
        }, searchDebounce);
      },

      setNearby(value: boolean) {
        if (get().nearby === value) return;
        if (get().status !== 'success') {
          set({ nearby: value });
          return;
        }
        set({
          nearby: value,
          suggestions: arrange(value, options.currentLocation(), raw),
        });
      },

      dispose() {
        if (debounce !== null) clearTimeout(debounce);
        debounce = null;
        generation++;
        abortInflight();
      },
    };
  });
}

function arrange(
  nearby: boolean,
  location: GeoPoint | null,
  items: PlacePrediction[],
): PlacePrediction[] {
  return nearby && location !== null ? sortByDistance(items) : items;
}

function sortByDistance(items: PlacePrediction[]): PlacePrediction[] {
  const withDistance: { item: PlacePrediction; distanceMeters: number }[] = [];
  const without: PlacePrediction[] = [];
  for (const item of items) {
    const { distanceMeters } = item;
    if (distanceMeters === null) without.push(item);
    else withDistance.push({ item, distanceMeters });
  }
  withDistance.sort((a, b) => a.distanceMeters - b.distanceMeters);
  return [...withDistance.map((d) => d.item), ...without];
}
