import type { GeoPoint } from '@aruku/engine/models/geo-point';
import type { RoutePlan } from '@aruku/engine/models/route-plan';
import type { TimeValue } from '@aruku/engine/models/time-value';
import type { RoutePhase } from '@aruku/engine/services/route-service';
import { minutes, type Duration } from '@aruku/engine/time';

export const RouteErrorKind = {
  network: 'network',
  timeout: 'timeout',
  noResults: 'noResults',
  noLocation: 'noLocation',
  noDestination: 'noDestination',
  unknown: 'unknown',
} as const;
export type RouteErrorKind = (typeof RouteErrorKind)[keyof typeof RouteErrorKind];

export const routeFreshness: Duration = minutes(5);

export const kInitialBudgetMinutes = 60;

export const kMinBudgetMinutes = 1;

export interface RouteCore {
  destination: string | null;
  destinationLatLng: GeoPoint | null;
  origin: string | null;
  originLatLng: GeoPoint | null;
  departure: TimeValue;
  arrival: TimeValue;

  dateBasis: Date;
  route: RoutePlan | null;

  routeAsOf: Date | null;

  routeErrorKind: RouteErrorKind | null;
  routePhase: RoutePhase | null;
}

export function isNowRouteExpired(state: RouteCore, now: Date): boolean {
  return (
    state.route != null &&
    state.routeAsOf != null &&
    now.getTime() - state.routeAsOf.getTime() >= routeFreshness
  );
}
