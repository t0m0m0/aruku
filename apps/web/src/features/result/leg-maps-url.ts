import type { GeoPoint } from '@aruku/engine/models/geo-point';
import { SegmentType, type RoutePlan } from '@aruku/engine/models/route-plan';

import { ja } from '../../i18n/ja';

export function buildLegMapsUrl(route: RoutePlan, index: number): string | null {
  const leg = index < 0 ? undefined : route.segments.at(index);
  if (leg === undefined) return null;
  const destination = legDestination(route, index);
  if (destination === null) return null;
  const origin = legOrigin(route, index);

  const query = new URLSearchParams({ api: '1' });
  if (origin !== null) query.set('origin', origin);
  query.set('destination', destination);
  query.set('travelmode', leg.type === SegmentType.walk ? 'walking' : 'transit');
  return `https://www.google.com/maps/dir/?${query.toString()}`;
}

function legDestination(route: RoutePlan, index: number): string | null {
  const leg = route.segments[index];
  const next = route.segments.at(index + 1);
  return (
    coordinate(leg.polyline.at(-1)) ??
    firstNonEmpty(leg.toName, next !== undefined ? next.fromName : route.to)
  );
}

function legOrigin(route: RoutePlan, index: number): string | null {
  const leg = route.segments[index];
  if (index === 0) return departureOrigin(route.from);
  const prev = route.segments[index - 1];
  return coordinate(prev.polyline.at(-1)) ?? firstNonEmpty(leg.fromName, prev.toName);
}

function departureOrigin(from: string): string | null {
  if (from === ja.searchCurrentLocationName) return null;
  return firstNonEmpty(from);
}

function coordinate(point: GeoPoint | undefined): string | null {
  return point === undefined ? null : `${point.lat},${point.lng}`;
}

function firstNonEmpty(...names: string[]): string | null {
  return names.find((name) => name !== '') ?? null;
}
