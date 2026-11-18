import { expect, it } from 'vitest';

import { GeoPoint } from '../../src/models/geo-point';
import { TimeValue } from '../../src/models/time-value';
import { CancellationToken, SearchCanceledException } from '../../src/services/cancellation';
import type { HttpClient, HttpResponse } from '../../src/services/http-client';
import { TransitRouteService } from '../../src/services/transit-route-service';
import { dateTime } from '../../src/time';

const guidance = {
  date: '20260627',
  from: { id: 'o', name: '出発' },
  to: { id: 'd', name: '目的' },
  options: [
    {
      journey: {
        departureSecs: 33000,
        arrivalSecs: 36600,
        durationSecs: 4200,
        accessWalkSecs: 400,
        egressWalkSecs: 500,
        legs: [
          {
            kind: 'transit',
            mode: 'rail',
            routeName: 'L',
            from: { id: 'a', name: 'A' },
            to: { id: 'b', name: 'B' },
            departureSecs: 33000,
            arrivalSecs: 36600,
          },
        ],
      },
      map: {
        segments: [
          {
            kind: 'walk',
            fromPointId: 'o',
            toPointId: 'a',
            geometrySource: 'osmWalk',
            polyline: [
              { lat: 35.0, lon: 139.0 },
              { lat: 35.002, lon: 139.002 },
            ],
          },
          {
            kind: 'transit',
            fromPointId: 'a',
            toPointId: 'b',
            geometrySource: 'stopOrder',
            polyline: [
              { lat: 35.002, lon: 139.002 },
              { lat: 35.004, lon: 139.01 },
              { lat: 35.006, lon: 139.02 },
            ],
          },
          {
            kind: 'walk',
            fromPointId: 'b',
            toPointId: 'd',
            geometrySource: 'osmWalk',
            polyline: [
              { lat: 35.006, lon: 139.02 },
              { lat: 35.008, lon: 139.022 },
            ],
          },
        ],
      },
    },
  ],
};

it('アクセス徒歩マトリクス2本の in-flight 中にキャンセルしても未処理の拒否を残さない', async () => {
  const cancellation = new CancellationToken();
  const client: HttpClient = {
    get: async (url: URL): Promise<HttpResponse> => {
      await Promise.resolve();
      if (url.pathname.includes('MatrixProxy')) {
        cancellation.cancel();
        throw new SearchCanceledException();
      }
      return {
        statusCode: 200,
        bodyBytes: new TextEncoder().encode(JSON.stringify(guidance)),
      };
    },
    close: () => {},
  };
  const service = new TransitRouteService({
    transitClient: client,
    proxyClient: client,
    transitBaseUrl: 'https://transit.example',
    proxyBaseUrl: 'https://proxy.example',
    clock: () => dateTime(2026, 6, 27, 9, 0),
    cancellation,
  });

  await expect(
    service.plan({
      destination: '目的',
      destinationLatLng: new GeoPoint(35.008, 139.022),
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 30 }),
      origin: new GeoPoint(35.0, 139.0),
      originName: '出発',
    }),
  ).rejects.toBeInstanceOf(SearchCanceledException);

  await new Promise((resolve) => setTimeout(resolve, 50));
});
