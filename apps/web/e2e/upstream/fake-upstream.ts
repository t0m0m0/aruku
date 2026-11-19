import type { Page, Request } from '@playwright/test';

import { GeoPoint } from '@aruku/engine/models/geo-point';
import { haversineKm } from '@aruku/engine/services/hybrid-route-selector';
import {
  trainMetersPerMinute,
  walkMetersPerMinute,
} from '@aruku/engine/services/route-plan-builder';

import { proxyBaseUrl, transitBaseUrl, upstreamPrefix } from './endpoints';

export const fakeRailLine = 'テスト線';

const stationNames = ['桜川', '青葉台', '緑が丘', '柊町', '楓橋', '椿平', '欅坂', '楠本'];

const boardingWaitSecs = 240;

export interface FakePlace {
  readonly placeId: string;
  readonly name: string;

  readonly description: string;
  readonly lat: number;
  readonly lng: number;
}

export interface UpstreamLog {
  readonly places: URL[];
  readonly guidance: URL[];
  readonly walk: URL[];
  readonly matrix: URL[];

  readonly unmatched: URL[];
}

export interface FakeUpstreamOptions {
  readonly places: readonly FakePlace[];
}

export async function installFakeUpstream(
  page: Page,
  options: FakeUpstreamOptions,
): Promise<UpstreamLog> {
  const log: UpstreamLog = {
    places: [],
    guidance: [],
    walk: [],
    matrix: [],
    unmatched: [],
  };

  await page.route(
    (url) => url.pathname.startsWith(upstreamPrefix),
    async (route, request) => {
      log.unmatched.push(new URL(request.url()));
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: `偽の上流に該当なし: ${request.url()}` }),
      });
    },
  );

  await route(page, `${proxyBaseUrl}/placesProxy`, (url) => {
    log.places.push(url);
    return placesResponse(url, options.places);
  });

  await route(page, `${transitBaseUrl}/api/v1/guidance/plan`, (url) => {
    log.guidance.push(url);
    return guidanceResponse(url);
  });

  await route(page, `${proxyBaseUrl}/googleWalkProxy`, (url) => {
    log.walk.push(url);
    return walkResponse(url);
  });

  await route(page, `${proxyBaseUrl}/googleWalkMatrixProxy`, (url) => {
    log.matrix.push(url);
    return matrixResponse(url);
  });

  return log;
}

async function route(page: Page, endpoint: string, respond: (url: URL) => unknown): Promise<void> {
  const path = new URL(endpoint).pathname;
  await page.route(
    (url) => url.pathname === path,
    async (handler, request: Request) => {
      await handler.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(respond(new URL(request.url()))),
      });
    },
  );
}

function placesResponse(url: URL, places: readonly FakePlace[]): unknown {
  const action = url.searchParams.get('action');

  if (action === 'details') {
    const id = url.searchParams.get('place_id');
    const place = places.find((p) => p.placeId === id);
    if (place === undefined) return { status: 'NOT_FOUND' };
    return {
      status: 'OK',
      result: { geometry: { location: { lat: place.lat, lng: place.lng } } },
    };
  }

  const input = url.searchParams.get('input') ?? '';
  const hits = places.filter((p) => p.name.includes(input) || p.description.includes(input));
  if (hits.length === 0) return { status: 'ZERO_RESULTS', predictions: [] };
  return {
    status: 'OK',
    predictions: hits.map((p) => ({
      place_id: p.placeId,
      description: p.description,
      terms: [{ value: p.name }],
    })),
  };
}

function guidanceResponse(url: URL): unknown {
  const from = geoParam(url, 'from');
  const to = geoParam(url, 'to');
  const date = url.searchParams.get('date') ?? '';
  const empty = { date, timezone: 'Asia/Tokyo', options: [] };

  if (from === null || to === null) return empty;
  if (url.searchParams.get('type') === 'arrival') return empty;

  const at = serviceSecs(url.searchParams.get('time'));
  if (at === null) return empty;

  const board = between(from, to, 0.25);
  const alight = between(from, to, 0.75);
  const stops = [board, between(from, to, 0.4), between(from, to, 0.55), alight];

  const accessSecs = walkSecs(from, board);
  const egressSecs = walkSecs(alight, to);
  const depSecs = at + accessSecs + boardingWaitSecs;
  const arrSecs = depSecs + railSecs(board, alight);

  return {
    date,
    timezone: 'Asia/Tokyo',
    from: point('origin', '出発地'),
    to: point('destination', '目的地'),
    options: [
      {
        journey: {
          departureSecs: at,
          arrivalSecs: arrSecs + egressSecs,
          durationSecs: arrSecs + egressSecs - at,
          accessWalkSecs: accessSecs,
          egressWalkSecs: egressSecs,
          legs: [
            {
              kind: 'transit',
              mode: 'rail',
              routeName: fakeRailLine,
              from: station(board),
              to: station(alight),
              departureSecs: depSecs,
              arrivalSecs: arrSecs,
            },
          ],
        },
        map: {
          points: [],
          segments: [
            mapSegment('walk', 'origin', stationId(board), 'osmWalk', [from, board]),
            mapSegment('transit', stationId(board), stationId(alight), 'stopOrder', stops),
            mapSegment('walk', stationId(alight), 'destination', 'estimatedWalk', [alight, to]),
          ],
        },
      },
    ],
  };
}

function walkResponse(url: URL): unknown {
  const start = geoParam(url, 'start');
  const goal = geoParam(url, 'goal');
  if (start === null || goal === null) return { routes: [] };

  const km = haversineKm(start, goal);
  return {
    routes: [
      {
        duration: `${walkSecs(start, goal)}s`,
        distanceMeters: Math.round(km * 1000),
      },
    ],
  };
}

function matrixResponse(url: URL): unknown {
  const origins = geoList(url, 'origins');
  const dests = geoList(url, 'destinations');

  return origins.flatMap((o, originIndex) =>
    dests.map((d, destinationIndex) => ({
      originIndex,
      destinationIndex,
      duration: `${walkSecs(o, d)}s`,
      distanceMeters: Math.round(haversineKm(o, d) * 1000),
    })),
  );
}

function geoParam(url: URL, name: string): GeoPoint | null {
  return parsePoint(url.searchParams.get(name));
}

function geoList(url: URL, name: string): GeoPoint[] {
  return (url.searchParams.get(name) ?? '')
    .split(';')
    .map(parsePoint)
    .filter((p): p is GeoPoint => p !== null);
}

function parsePoint(raw: string | null): GeoPoint | null {
  if (raw === null) return null;
  const [lat, lng] = raw.replace(/^geo:/, '').split(',').map(Number.parseFloat);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return new GeoPoint(lat, lng);
}

function serviceSecs(time: string | null): number | null {
  if (time === null) return null;
  const [h, m] = time.split(':').map((v) => Number.parseInt(v, 10));
  if (!Number.isInteger(h) || !Number.isInteger(m)) return null;
  return h * 3600 + m * 60;
}

function between(from: GeoPoint, to: GeoPoint, ratio: number): GeoPoint {
  return new GeoPoint(
    from.lat + (to.lat - from.lat) * ratio,
    from.lng + (to.lng - from.lng) * ratio,
  );
}

function walkSecs(from: GeoPoint, to: GeoPoint): number {
  return Math.round(((haversineKm(from, to) * 1000) / walkMetersPerMinute) * 60);
}

function railSecs(from: GeoPoint, to: GeoPoint): number {
  return Math.round(((haversineKm(from, to) * 1000) / trainMetersPerMinute) * 60);
}

function stationId(p: GeoPoint): string {
  return `stop:${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
}

function stationName(p: GeoPoint): string {
  const seed = Math.round((Math.abs(p.lat) + Math.abs(p.lng)) * 1e5);
  return `${stationNames[seed % stationNames.length]}駅`;
}

function station(p: GeoPoint): unknown {
  return point(stationId(p), stationName(p));
}

function point(id: string, name: string): unknown {
  return { id, name };
}

function mapSegment(
  kind: string,
  fromPointId: string,
  toPointId: string,
  geometrySource: string,
  polyline: GeoPoint[],
): unknown {
  return {
    kind,
    geometrySource,
    fromPointId,
    toPointId,
    polyline: polyline.map((p) => ({ lat: p.lat, lon: p.lng })),
  };
}
