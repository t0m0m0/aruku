import { isNowRouteExpired, type RouteCore } from '../state/app-state';
import { fallbackScreen, Screen, screenFromLocation, screenPath } from './screens';

export function resolveRedirect(location: string, state: RouteCore, now: Date): string | null {
  const requestedPath = new URL(location, 'https://placeholder.invalid').pathname;
  const target = screenFromLocation(requestedPath);

  if (screenPath[target] !== requestedPath) return screenPath[target];

  const expired = isNowRouteExpired(state, now);
  const missingPrerequisite =
    (target === Screen.result && (state.route == null || expired)) ||
    (target === Screen.loading && state.routePhase == null) ||
    (target === Screen.error && state.routeErrorKind == null);

  return missingPrerequisite ? screenPath[fallbackScreen] : null;
}
