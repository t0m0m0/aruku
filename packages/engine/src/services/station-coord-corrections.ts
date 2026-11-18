import { GeoPoint } from '../models/geo-point';
import { stationCoordTable } from './station-coord-table';

const coordKey = (lat: number, lng: number): string => `${lat.toFixed(5)},${lng.toFixed(5)}`;

const correctedByRawCoord = new Map<string, GeoPoint>(
  stationCoordTable.map((r) => [coordKey(r.from[0], r.from[1]), new GeoPoint(r.to[0], r.to[1])]),
);

export function correctStationCoord(p: GeoPoint): GeoPoint | null {
  return correctedByRawCoord.get(coordKey(p.lat, p.lng)) ?? null;
}
