import { ja } from '../i18n/ja';
import type { LocationState } from '../location/location-state';

export function departureLabelText(origin: string | null, location: LocationState): string {
  if (origin !== null) return origin;
  switch (location.kind) {
    case 'loading':
      return ja.departureCurrentLocationLoading;
    case 'available':
      return ja.departureCurrentLocation;
    case 'denied':
      return ja.departureNoLocation;
    case 'unavailable':
      return ja.departureCurrentLocationFailed;
  }
}
