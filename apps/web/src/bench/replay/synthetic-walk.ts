import { GeoPoint } from '@aruku/engine/models/geo-point';
import { haversineKm } from '@aruku/engine/services/hybrid-route-selector';

export const syntheticDetourRatio = 1.25;
export const syntheticWalkMetersPerMinute = 80;
export const syntheticRouteDelayMs = 600;
export const syntheticMatrixDelayMs = 900;

export const syntheticWalkMeters = (a: GeoPoint, b: GeoPoint): number =>
  haversineKm(a, b) * 1000 * syntheticDetourRatio;

export function syntheticWalkSeconds(a: GeoPoint, b: GeoPoint): number {
  return Math.round((syntheticWalkMeters(a, b) / syntheticWalkMetersPerMinute) * 60);
}

export function syntheticWalkResponse(url: URL): { body: string; delayMs: number } | null {
  if (url.pathname.endsWith('/googleWalkMatrixProxy')) {
    const origins = points(url.searchParams.get('origins'));
    const dests = points(url.searchParams.get('destinations'));
    const rows = origins.flatMap((o, originIndex) =>
      dests.map((d, destinationIndex) => ({
        originIndex,
        destinationIndex,
        duration: `${syntheticWalkSeconds(o, d)}s`,
      })),
    );
    return { body: JSON.stringify(rows), delayMs: syntheticMatrixDelayMs };
  }
  if (url.pathname.endsWith('/googleWalkProxy')) {
    const start = points(url.searchParams.get('start')).at(0);
    const goal = points(url.searchParams.get('goal')).at(0);
    if (start === undefined || goal === undefined) return null;
    const body = {
      routes: [
        {
          duration: `${syntheticWalkSeconds(start, goal)}s`,
          distanceMeters: Math.round(syntheticWalkMeters(start, goal)),
        },
      ],
    };
    return { body: JSON.stringify(body), delayMs: syntheticRouteDelayMs };
  }
  return null;
}

function points(param: string | null): GeoPoint[] {
  if (param === null || param === '') return [];
  return param.split(';').map((s) => {
    const [lat, lng] = s.split(',').map(Number);
    return new GeoPoint(lat, lng);
  });
}
