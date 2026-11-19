import { createStore, type StoreApi } from 'zustand/vanilla';

import type { GeoPoint } from '@aruku/engine/models/geo-point';
import { PickerMode, TimeValue, calendarDaysBetween } from '@aruku/engine/models/time-value';
import { CancellationToken } from '@aruku/engine/services/cancellation';
import { RoutePhase, type RouteService } from '@aruku/engine/services/route-service';
import { absoluteMinutes, budgetMinutes } from '@aruku/engine/services/route-plan-builder';

import { ja } from '../i18n/ja';
import {
  isNowRouteExpired,
  kInitialBudgetMinutes,
  kMinBudgetMinutes,
  routeFreshness,
} from './app-state';
import { classifyRouteError } from './route-error';
import { Screen, screenPath } from '../navigation/screens';
import { browserLocationService, type LocationService } from '../location/geolocation';
import {
  locationLoading,
  locationUnavailable,
  type LocationState,
} from '../location/location-state';
import type { RouteCore } from './app-state';

export type Navigate = (path: string) => void;

export interface AppActions {
  refreshLocation: () => Promise<void>;

  setDestination: (name: string | null, latLng?: GeoPoint | null) => void;

  setOrigin: (name: string | null, latLng?: GeoPoint | null) => void;

  go: (screen: Screen, update?: Partial<RouteCore>) => void;

  applyPickedTime: (picked: { mode: PickerMode; h: number; m: number; dateOffset: number }) => void;

  rebaseDates: (days: number, now: Date) => void;

  rebaseToToday: (at: Date) => void;

  startSearch: () => Promise<void>;

  revalidateRoute: () => void;

  cancelSearch: () => void;

  abandonSearch: () => void;

  attachNavigator: (navigate: Navigate) => void;
}

export interface AppAmbient {
  locationState: LocationState;
}

export type AppStore = RouteCore & AppAmbient & AppActions;

export type Now = () => Date;

function initialCore(now: Now): RouteCore {
  const at = now();
  const arrivalTotal = at.getHours() * 60 + at.getMinutes() + kInitialBudgetMinutes;
  return {
    dateBasis: at,
    destination: null,
    destinationLatLng: null,
    origin: null,
    originLatLng: null,
    departure: new TimeValue({
      h: at.getHours(),
      m: at.getMinutes(),
      isNow: true,
    }),
    arrival: new TimeValue({
      h: Math.floor(arrivalTotal / 60) % 24,
      m: arrivalTotal % 60,
      dateOffset: Math.floor(arrivalTotal / (24 * 60)),
    }),
    route: null,
    routeAsOf: null,
    routeErrorKind: null,
    routePhase: null,
  };
}

const routeServiceNotWired: RouteService = {
  plan: () => {
    throw new Error('RouteService が未配線（createAppStore の第4引数）');
  },
};

export function createAppStore(
  initial: Partial<RouteCore> = {},
  now: Now = () => new Date(),
  location: LocationService = browserLocationService(),
  routeService: RouteService = routeServiceNotWired,
): StoreApi<AppStore> {
  let navigate: Navigate | null = null;

  let searchGeneration = 0;

  let activeCancellation: CancellationToken | null = null;

  function discardSearch(): void {
    searchGeneration++;
    activeCancellation?.cancel();
    activeCancellation = null;
  }

  let inFlight: Promise<void> | null = null;

  return createStore<AppStore>()((set, get) => ({
    ...initialCore(now),
    locationState: locationLoading,
    ...initial,

    refreshLocation() {
      if (inFlight !== null) return inFlight;

      inFlight = location
        .request()
        .catch(() => locationUnavailable)
        .then((result) => {
          set({ locationState: result });
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },

    setDestination(name: string | null, latLng: GeoPoint | null = null) {
      set({ destination: name, destinationLatLng: latLng });
    },

    setOrigin(name: string | null, latLng: GeoPoint | null = null) {
      set({ origin: name, originLatLng: latLng });
    },

    applyPickedTime({ mode, h, m, dateOffset }) {
      const picked = new TimeValue({ h, m, dateOffset });
      const state = get();
      set(
        mode === PickerMode.depart
          ? {
              ...discardedRoute,
              departure: picked,
              arrival: arrivalAfterDeparture(picked, state.departure, state.arrival),
            }
          : {
              ...discardedRoute,
              arrival: clampArrivalAfterDeparture(state.departure, picked),
            },
      );
    },

    rebaseDates(days: number, at: Date) {
      const state = get();
      const budget = budgetMinutes(state.departure, state.arrival);
      const departure = rebasedTime(state.departure, days, at);
      set({
        ...discardedRoute,
        departure,
        arrival: timeValueFromAbs(absoluteMinutes(departure) + budget),
        dateBasis: at,
      });
    },

    rebaseToToday(at: Date) {
      const drift = calendarDaysBetween({ from: get().dateBasis, to: at });
      if (drift !== 0) get().rebaseDates(drift, at);
    },

    async startSearch() {
      if (routeService === routeServiceNotWired) {
        throw new Error('RouteService が未配線（createAppStore の第4引数）');
      }

      const generation = ++searchGeneration;
      activeCancellation?.cancel();
      const cancellation = (activeCancellation = new CancellationToken());

      const at = now();
      get().rebaseToToday(at);
      const refreshed = refreshedNowTimes(get(), at);

      get().go(Screen.loading, {
        routeErrorKind: null,
        routePhase: RoutePhase.routing,
      });

      const state = get();
      const origin =
        state.originLatLng ??
        (state.locationState.kind === 'available' ? state.locationState.position : null);

      try {
        const plan = await routeService.plan({
          destination: state.destination,
          destinationLatLng: state.destinationLatLng,
          departure: refreshed.departure,
          arrival: refreshed.arrival,
          origin,
          originName: departureNameForRoute(state),
          cancellation,
          onProgress: (phase) => {
            if (generation !== searchGeneration) return;
            set({ routePhase: phase });
          },
        });
        if (generation !== searchGeneration) return;

        if (refreshed.departure.isNow && now().getTime() - at.getTime() >= routeFreshness) {
          const closed = now();
          get().rebaseToToday(closed);
          expireRoute(get(), closed);
          return;
        }

        get().go(Screen.result, {
          route: plan,
          routeAsOf: refreshed.departure.isNow ? at : null,
          departure: refreshed.departure,
          arrival: refreshed.arrival,
          dateBasis: at,
          routeErrorKind: null,
          routePhase: null,
        });
      } catch (error) {
        if (generation !== searchGeneration) return;
        get().go(Screen.error, {
          routeErrorKind: classifyRouteError(error),
          routePhase: null,
        });
      }
    },

    revalidateRoute() {
      const state = get();
      const at = now();
      if (!isNowRouteExpired(state, at)) return;
      get().rebaseToToday(at);
      expireRoute(get(), at);
    },

    cancelSearch() {
      discardSearch();
      get().go(Screen.home, { routePhase: null, routeErrorKind: null });
    },

    abandonSearch() {
      discardSearch();
      set({ routePhase: null });
    },

    attachNavigator(next: Navigate) {
      navigate = next;
    },

    go(screen: Screen, update: Partial<RouteCore> = {}) {
      if (navigate === null) {
        throw new Error('go() before attachNavigator()');
      }
      set(update);
      navigate(screenPath[screen]);
    },
  }));
}

function expireRoute(state: AppStore, at: Date): void {
  const refreshed = refreshedNowTimes(state, at);
  state.go(Screen.home, {
    route: null,
    routeAsOf: null,
    routePhase: null,
    routeErrorKind: null,
    departure: refreshed.departure,
    arrival: refreshed.arrival,
    dateBasis: at,
  });
}

function refreshedNowTimes(
  state: RouteCore,
  at: Date,
): { departure: TimeValue; arrival: TimeValue } {
  const { departure, arrival } = state;
  if (!departure.isNow) return { departure, arrival };

  const budget = budgetMinutes(departure, arrival);
  const next = new TimeValue({ h: at.getHours(), m: at.getMinutes(), isNow: true });
  return { departure: next, arrival: timeValueFromAbs(absoluteMinutes(next) + budget) };
}

function timeValueFromAbs(abs: number): TimeValue {
  return new TimeValue({
    h: Math.floor(abs / 60) % 24,
    m: abs % 60,
    dateOffset: Math.floor(abs / (24 * 60)),
  });
}

const discardedRoute = { route: null, routeAsOf: null } as const;

function arrivalAfterDeparture(
  newDeparture: TimeValue,
  oldDeparture: TimeValue,
  arrival: TimeValue,
): TimeValue {
  const newDepAbs = absoluteMinutes(newDeparture);
  if (absoluteMinutes(arrival) - newDepAbs >= kMinBudgetMinutes) return arrival;

  const oldBudget = absoluteMinutes(arrival) - absoluteMinutes(oldDeparture);
  const keep = oldBudget >= kMinBudgetMinutes ? oldBudget : kMinBudgetMinutes;
  return timeValueFromAbs(newDepAbs + keep);
}

function clampArrivalAfterDeparture(departure: TimeValue, arrival: TimeValue): TimeValue {
  const minAbs = absoluteMinutes(departure) + kMinBudgetMinutes;
  return absoluteMinutes(arrival) >= minAbs ? arrival : timeValueFromAbs(minAbs);
}

function rebasedTime(t: TimeValue, days: number, now: Date): TimeValue {
  if (t.isNow) return t.copyWith({ h: now.getHours(), m: now.getMinutes() });

  const atNow = () => new TimeValue({ h: now.getHours(), m: now.getMinutes() });
  if (t.dateOffset < days) return atNow();

  const shifted = t.dateOffset - days;
  if (shifted === 0 && t.totalMinutes < now.getHours() * 60 + now.getMinutes()) {
    return atNow();
  }
  return t.copyWith({ dateOffset: shifted });
}

function departureNameForRoute(state: AppStore): string | null {
  if (state.origin !== null) return state.origin;
  return state.locationState.kind === 'available' ? ja.searchCurrentLocationName : null;
}
