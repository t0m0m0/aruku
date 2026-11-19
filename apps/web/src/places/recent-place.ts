import { isRecord } from '@aruku/engine/json';
import { GeoPoint } from '@aruku/engine/models/geo-point';

export interface RecentPlace {
  readonly name: string;
  readonly placeId: string | null;
  readonly latLng: GeoPoint | null;
  readonly address: string | null;

  readonly usedAt: Date | null;
}

export function dedupeKey(place: RecentPlace): string {
  const { placeId } = place;
  return placeId !== null && placeId !== '' ? `id:${placeId}` : `name:${place.name}`;
}

export function recentPlaceToJson(place: RecentPlace): Record<string, unknown> {
  return {
    name: place.name,
    ...(place.placeId !== null ? { placeId: place.placeId } : {}),
    ...(place.latLng !== null ? { lat: place.latLng.lat, lng: place.latLng.lng } : {}),
    ...(place.address !== null ? { address: place.address } : {}),
    ...(place.usedAt !== null ? { usedAt: place.usedAt.toISOString() } : {}),
  };
}

export function recentPlaceFromJson(json: unknown): RecentPlace | null {
  if (!isRecord(json)) return null;

  const name = json['name'];
  if (typeof name !== 'string') return null;

  const lat = json['lat'];
  const lng = json['lng'];
  const usedAt = json['usedAt'];
  const parsedUsedAt = typeof usedAt === 'string' ? new Date(usedAt) : null;

  return {
    name,
    placeId: typeof json['placeId'] === 'string' ? json['placeId'] : null,
    latLng: typeof lat === 'number' && typeof lng === 'number' ? new GeoPoint(lat, lng) : null,
    address: typeof json['address'] === 'string' ? json['address'] : null,
    usedAt: parsedUsedAt !== null && !Number.isNaN(parsedUsedAt.getTime()) ? parsedUsedAt : null,
  };
}
