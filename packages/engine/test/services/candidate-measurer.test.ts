import { describe, expect, it } from 'vitest';

import type { JsonMap } from '../../src/json';
import { GeoPoint } from '../../src/models/geo-point';
import { RouteSegment, SegmentType } from '../../src/models/route-plan';
import { CandidateMeasurer } from '../../src/services/candidate-measurer';
import { ClientException, type HttpResponse } from '../../src/services/http-client';
import { RouteCandidate } from '../../src/services/hybrid-route-selector';
import { RouteDiagnostics } from '../../src/services/route-diagnostics';
import { TransitApiClient } from '../../src/services/transit-api-client';
import { dateTime } from '../../src/time';
import { jsonResponse, mockClient } from '../support/mock-client';

const departureAt = dateTime(2026, 11, 26, 9, 0);
const A = new GeoPoint(35.0, 139.0);
const B = new GeoPoint(35.0, 139.05);
const B2 = new GeoPoint(35.0, 139.051);
const C = new GeoPoint(35.0, 139.1);

const walk = (minutes: number) =>
  new RouteSegment({ type: SegmentType.walk, fromName: '', toName: '', minutes });

const ride = (
  line: string,
  from: GeoPoint,
  to: GeoPoint,
  minutes: number,
  o: { type?: SegmentType; fromName?: string; toName?: string } = {},
) =>
  new RouteSegment({
    type: o.type ?? SegmentType.train,
    fromName: o.fromName ?? '',
    toName: o.toName ?? '',
    minutes,
    line,
    polyline: [from, to],
  });

const candidate = (segments: RouteSegment[]) =>
  new RouteCandidate({ from: '出発', to: '到着', segments });

const twoRides = () =>
  candidate([walk(5), ride('甲線', A, B, 20), walk(3), ride('乙線', B2, C, 8), walk(2)]);

const jst = (hh: number, mm: number) =>
  `2026-11-26T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+09:00`;

const FEEDS = [{ id: 'mini-tokyo-3d/Tokyu', fetchedAt: '2026-11-24T01:22:03.623Z' }];

const packRide = (route: string, board: [number, number], alight: [number, number]) => ({
  ride: {
    route,
    headsign: null,
    from: `${route}乗`,
    to: `${route}降`,
    boardAt: jst(...board),
    alightAt: jst(...alight),
  },
  feeds: FEEDS,
});

const guidanceDirect = (line: string, depSecs: number, arrSecs: number): JsonMap => ({
  date: '20261126',
  timezone: 'Asia/Tokyo',
  from: { id: 'origin', name: '地点(出発)' },
  to: { id: 'destination', name: '地点(目的)' },
  options: [
    {
      journey: {
        departureSecs: depSecs,
        arrivalSecs: arrSecs,
        durationSecs: arrSecs - depSecs,
        accessWalkSecs: 0,
        egressWalkSecs: 0,
        legs: [
          {
            kind: 'transit',
            mode: 'rail',
            routeName: line,
            from: { id: 'g0', name: 'G乗' },
            to: { id: 'g1', name: 'G降' },
            departureSecs: depSecs,
            arrivalSecs: arrSecs,
          },
        ],
      },
      map: {
        points: [],
        segments: [
          {
            kind: 'transit',
            geometrySource: 'stopOrder',
            fromPointId: 'g0',
            toPointId: 'g1',
            polyline: [
              { lat: 35, lon: 139 },
              { lat: 35, lon: 139.05 },
            ],
          },
        ],
      },
    },
  ],
});

interface Harness {
  measurer: CandidateMeasurer;
  api: TransitApiClient;
  rideUrls: URL[];
}

function harness(o: {
  rideDepartures: boolean;
  pack?: (url: URL) => HttpResponse | Promise<HttpResponse>;
  guidance?: () => JsonMap;
}): Harness {
  const rideUrls: URL[] = [];
  const client = mockClient((url) => {
    if (url.pathname === '/rideDepartures') {
      rideUrls.push(url);
      return o.pack?.(url) ?? jsonResponse({ error: 'not found' }, 404);
    }
    if (url.pathname.includes('guidance/plan')) {
      return jsonResponse(o.guidance?.() ?? { options: [] });
    }
    return jsonResponse({}, 404);
  });
  const api = new TransitApiClient({
    transitClient: client,
    proxyClient: client,
    transitBaseUrl: 'https://transit.example',
    proxyBaseUrl: 'https://proxy.example',
  });
  const measurer = new CandidateMeasurer(api, new RouteDiagnostics({ verbose: false }), {
    rideDepartures: o.rideDepartures,
  });
  return { measurer, api, rideUrls };
}

const byLine =
  (answers: Record<string, unknown>) =>
  (url: URL): HttpResponse =>
    jsonResponse(answers[url.searchParams.get('line') ?? ''] ?? { ride: null, feeds: FEEDS });

const rides = (c: RouteCandidate) => c.segments.filter((s) => s.type !== SegmentType.walk);
const hm = (d: Date | null) =>
  d === null ? null : `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

describe('resolveBoardingTimes: 時刻表パックで乗車時刻を確定する (#549)', () => {
  it('区間ごとに、前の区間の実際の到着からつないだ時刻でパックに聞き、Transit は引かない', async () => {
    const h = harness({
      rideDepartures: true,
      pack: byLine({
        甲線: packRide('甲線', [9, 6], [9, 12]),
        乙線: packRide('乙線', [9, 16], [9, 24]),
      }),
    });

    const out = await h.measurer.resolveBoardingTimes(twoRides(), departureAt);

    expect(rides(out).map((s) => [hm(s.depTime), hm(s.arrTime), s.minutes])).toEqual([
      ['9:06', '9:12', 6],
      ['9:16', '9:24', 8],
    ]);
    expect(h.rideUrls.map((u) => u.searchParams.get('at'))).toEqual([
      '2026-11-26T09:05:00+09:00',
      '2026-11-26T09:15:00+09:00',
    ]);
    expect(h.api.rideDepartureCalls).toEqual(2);
    expect(h.api.guidanceCalls).toEqual(0);
    expect(h.measurer.packBoardingLegs).toEqual(2);
  });

  it('乗降駅の座標と名前・路線名を渡す', async () => {
    const h = harness({ rideDepartures: true, pack: byLine({}) });

    await h.measurer.resolveBoardingTimes(
      candidate([walk(5), ride('甲線', A, B, 10, { fromName: '一の駅', toName: '二の駅' })]),
      departureAt,
    );

    const q = h.rideUrls[0].searchParams;
    expect([q.get('board'), q.get('alight'), q.get('boardName'), q.get('alightName')]).toEqual([
      '35.0,139.0',
      '35.0,139.05',
      '一の駅',
      '二の駅',
    ]);
    expect(q.get('line')).toEqual('甲線');
  });

  it('空の駅名はパックの駅名で埋め、名前のある駅は書き換えない', async () => {
    const h = harness({
      rideDepartures: true,
      pack: byLine({ 甲線: packRide('甲線', [9, 8], [9, 18]) }),
    });

    const out = await h.measurer.resolveBoardingTimes(
      candidate([walk(5), ride('甲線', A, B, 10, { fromName: '元の乗車駅' })]),
      departureAt,
    );

    expect([rides(out)[0].fromName, rides(out)[0].toName]).toEqual(['元の乗車駅', '甲線降']);
  });

  it('パックに列車が無い区間だけを Transit で確定し、後ろの区間はパックでつなぐ', async () => {
    const h = harness({
      rideDepartures: true,
      pack: byLine({ 乙線: packRide('乙線', [9, 25], [9, 33]) }),
      guidance: () => guidanceDirect('甲線', 9 * 3600 + 10 * 60, 9 * 3600 + 21 * 60),
    });

    const out = await h.measurer.resolveBoardingTimes(twoRides(), departureAt);

    expect(rides(out).map((s) => hm(s.depTime))).toEqual(['9:10', '9:25']);
    expect(h.api.guidanceCallsByPurpose.boarding).toEqual(1);
    expect(h.rideUrls[1].searchParams.get('at')).toEqual('2026-11-26T09:24:00+09:00');
  });

  it('つないだ時刻より前に出る列車が返っても採らず、Transit で確定する', async () => {
    const h = harness({
      rideDepartures: true,
      pack: byLine({ 甲線: packRide('甲線', [9, 3], [9, 13]) }),
    });

    await h.measurer.resolveBoardingTimes(
      candidate([walk(5), ride('甲線', A, B, 10)]),
      departureAt,
    );

    expect(h.measurer.packBoardingLegs).toEqual(0);
    expect(h.api.guidanceCallsByPurpose.boarding).toEqual(1);
  });

  it('路線名の無い区間とバスの区間はパックに聞かず、Transit で確定する', async () => {
    const h = harness({ rideDepartures: true, pack: byLine({}) });

    await h.measurer.resolveBoardingTimes(
      candidate([
        walk(5),
        ride('', A, B, 10),
        walk(1),
        ride('バス01', B2, C, 10, { type: SegmentType.bus }),
      ]),
      departureAt,
    );

    expect(h.api.rideDepartureCalls).toEqual(0);
    expect(h.api.guidanceCallsByPurpose.boarding).toEqual(2);
  });

  it.each([
    ['404', () => jsonResponse({ error: 'not found' }, 404)],
    ['503', () => jsonResponse({ error: 'timetable unavailable' }, 503)],
    [
      'JSON でない本文',
      (): HttpResponse => ({ statusCode: 200, bodyBytes: new TextEncoder().encode('<html>') }),
    ],
    ['形の崩れた本文', () => jsonResponse({ ride: { route: 1 } })],
    [
      '通信の失敗',
      (): Promise<HttpResponse> => Promise.reject(new ClientException('network down')),
    ],
  ])(
    'エンドポイントの失敗（%s）は、その検索の残りをすべて Transit で確定する',
    async (_name, pack) => {
      const h = harness({ rideDepartures: true, pack });

      await h.measurer.resolveBoardingTimes(twoRides(), departureAt);
      await h.measurer.resolveBoardingTimes(twoRides(), departureAt);

      expect(h.api.rideDepartureCalls).toEqual(1);
      expect(h.api.guidanceCallsByPurpose.boarding).toBeGreaterThanOrEqual(2);
    },
  );

  it('パックで確定したら、そのフィードの取得日時を出典として持つ', async () => {
    const h = harness({
      rideDepartures: true,
      pack: byLine({ 甲線: packRide('甲線', [9, 8], [9, 18]) }),
    });

    await h.measurer.resolveBoardingTimes(
      candidate([walk(5), ride('甲線', A, B, 10)]),
      departureAt,
    );

    expect(h.measurer.packTimetableSources).toEqual([
      { feedId: 'mini-tokyo-3d/Tokyu', fetchedAt: new Date('2026-11-24T01:22:03.623Z') },
    ]);
  });

  it('パックで確定しなかったら、出典を持たない', async () => {
    const h = harness({ rideDepartures: true, pack: byLine({}) });

    await h.measurer.resolveBoardingTimes(
      candidate([walk(5), ride('甲線', A, B, 10)]),
      departureAt,
    );

    expect(h.measurer.packTimetableSources).toEqual([]);
  });

  it('無効のときはパックに聞かない', async () => {
    const h = harness({ rideDepartures: false, pack: byLine({}) });

    await h.measurer.resolveBoardingTimes(twoRides(), departureAt);

    expect(h.api.rideDepartureCalls).toEqual(0);
    expect(h.api.guidanceCallsByPurpose.boarding).toEqual(2);
  });
});
