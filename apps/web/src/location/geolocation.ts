import { GeoPoint } from '@aruku/engine/models/geo-point';

import {
  locationAvailable,
  locationDenied,
  locationUnavailable,
  type LocationState,
} from './location-state';

export interface LocationService {
  request(): Promise<LocationState>;
}

export const locationRequestTimeoutMs = 10_000;

const permissionDenied = 1;

function ambientGeolocation(
  navigator: { readonly geolocation?: Geolocation } | undefined,
): Geolocation | undefined {
  return navigator?.geolocation;
}

export function browserLocationService(
  geolocation: Geolocation | undefined = ambientGeolocation(globalThis.navigator),
  timeoutMs: number = locationRequestTimeoutMs,
): LocationService {
  return {
    request() {
      if (geolocation === undefined) return Promise.resolve(locationDenied);

      return new Promise<LocationState>((resolve) => {
        try {
          geolocation.getCurrentPosition(
            (position) =>
              resolve(
                locationAvailable(
                  new GeoPoint(position.coords.latitude, position.coords.longitude),
                ),
              ),
            (error) =>
              resolve(error.code === permissionDenied ? locationDenied : locationUnavailable),
            { timeout: timeoutMs, enableHighAccuracy: true },
          );
        } catch {
          resolve(locationUnavailable);
        }
      });
    },
  };
}
