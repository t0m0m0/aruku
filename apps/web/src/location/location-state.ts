import type { GeoPoint } from '@aruku/engine/models/geo-point';

export type LocationState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'available'; readonly position: GeoPoint }
  | { readonly kind: 'denied' }
  | { readonly kind: 'unavailable' };

export const locationLoading: LocationState = { kind: 'loading' };
export const locationDenied: LocationState = { kind: 'denied' };
export const locationUnavailable: LocationState = { kind: 'unavailable' };

export function locationAvailable(position: GeoPoint): LocationState {
  return { kind: 'available', position };
}
