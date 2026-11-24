import { describe, expect, it } from 'vitest';

import type { JsonMap } from '../../src/json';
import { GeoPoint } from '../../src/models/geo-point';
import { RouteSegment, SegmentType } from '../../src/models/route-plan';
import { CandidateMeasurer } from '../../src/services/candidate-measurer';
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
  type: SegmentType = SegmentType.train,
) => new RouteSegment({ type, fromName: '', toName: '', minutes, line, polyline: [from, to] });

const candidate = (segments: RouteSegment[]) =>
  new RouteCandidate({ from: '出発', to: '到着', segments });

const twoRides = () =>
  candidate([walk(5), ride('甲線', A, B, 10), walk(3), ride('乙線', B2, C, 8), walk(2)]);

const jst = (hh: number, mm: number) =>
  `2026-11-26T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+09:00`;

const dep = (
  route: string,
  board: [number, number],
  alight: [number, number],
  from = 'X',
  to = 'Y',
) => ({
  route,
  headsign: null,
  from,
  to,
  boardAt: jst(...board),
  alightAt: jst(...alight),
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

const withinWindow = (url: URL, legs: unknown[]): unknown[] => {
  const departAt = new Date(url.searchParams.get('departAt') ?? '').getTime();
  const fromMins = (url.searchParams.get('legs') ?? '')
    .split(';')
    .map((l) => Number(l.split(',')[4]));
  return legs.map((leg, k) => {
    const { departures, truncated } = leg as {
      departures: { boardAt: string }[];
      truncated: boolean;
    };
    const from = departAt + fromMins[k] * 60000;
    return {
      departures: departures.filter((d) => new Date(d.boardAt).getTime() >= from),
      truncated,
    };
  });
};

interface Harness {
  measurer: CandidateMeasurer;
  api: TransitApiClient;
  urls: URL[];
}

function harness(o: {
  rideDepartures: boolean;
  packLegs?: unknown[] | null;
  guidance?: () => JsonMap;
}): Harness {
  const urls: URL[] = [];
  const client = mockClient((url) => {
    urls.push(url);
    if (url.pathname === '/rideDepartures') {
      return o.packLegs === null || o.packLegs === undefined
        ? jsonResponse({ error: 'not found' }, 404)
        : jsonResponse({ legs: withinWindow(url, o.packLegs), feeds: [] });
    }
    if (url.pathname.includes('guidance/plan')) {
      return jsonResponse(o.guidance?.() ?? { plans: [] });
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
  return { measurer, api, urls };
}

const rides = (c: RouteCandidate) => c.segments.filter((s) => s.type !== SegmentType.walk);
const hm = (d: Date | null) =>
  d === null ? null : `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

describe('resolveBoardingTimes: 時刻表パックで乗車時刻を確定する (#549)', () => {
  it('全区間をパックで確定できれば、1 回だけ問い合わせ、Transit は引かない', async () => {
    const h = harness({
      rideDepartures: true,
      packLegs: [
        {
          departures: [dep('甲線', [9, 8], [9, 18]), dep('甲線', [9, 12], [9, 20])],
          truncated: false,
        },
        {
          departures: [dep('乙線', [9, 20], [9, 28]), dep('乙線', [9, 25], [9, 33])],
          truncated: false,
        },
      ],
    });

    const out = await h.measurer.resolveBoardingTimes(twoRides(), departureAt);

    expect(rides(out).map((s) => [hm(s.depTime), hm(s.arrTime), s.minutes])).toEqual([
      ['9:08', '9:18', 10],
      ['9:25', '9:33', 8],
    ]);
    expect(h.api.rideDepartureCalls).toEqual(1);
    expect(h.api.guidanceCalls).toEqual(0);
  });

  it('区間ごとの最早の乗車までの分と、時間帯の長さを渡す', async () => {
    const h = harness({
      rideDepartures: true,
      packLegs: [
        { departures: [dep('甲線', [9, 8], [9, 18])], truncated: false },
        { departures: [dep('乙線', [9, 25], [9, 33])], truncated: false },
      ],
    });

    await h.measurer.resolveBoardingTimes(twoRides(), departureAt);

    const q = h.urls.find((u) => u.pathname === '/rideDepartures')!.searchParams;
    expect(q.get('departAt')).toEqual('2026-11-26T09:00:00+09:00');
    expect(q.get('legs')).toEqual('35.0,139.0,35.0,139.05,5;35.0,139.051,35.0,139.1,8');
    expect(Number(q.get('untilMin'))).toBeGreaterThanOrEqual(28);
  });

  it('前の区間が見込みより早く着いても、後ろの区間の乗れる列車を取りこぼさない', async () => {
    const h = harness({
      rideDepartures: true,
      packLegs: [
        { departures: [dep('甲線', [9, 6], [9, 9])], truncated: false },
        {
          departures: [dep('乙線', [9, 13], [9, 21]), dep('乙線', [9, 30], [9, 38])],
          truncated: false,
        },
      ],
    });

    const out = await h.measurer.resolveBoardingTimes(
      candidate([walk(5), ride('甲線', A, B, 20), walk(3), ride('乙線', B2, C, 8)]),
      departureAt,
    );

    expect(rides(out).map((s) => hm(s.depTime))).toEqual(['9:06', '9:13']);
  });

  it('乗れる列車のうち、着くのがいちばん早い列車を採る（後発の急行が先着するとき）', async () => {
    const h = harness({
      rideDepartures: true,
      packLegs: [
        {
          departures: [dep('甲線', [9, 6], [9, 20]), dep('甲線', [9, 8], [9, 16])],
          truncated: false,
        },
        { departures: [dep('乙線', [9, 25], [9, 33])], truncated: false },
      ],
    });

    const out = await h.measurer.resolveBoardingTimes(twoRides(), departureAt);

    expect(hm(rides(out)[0].depTime)).toEqual('9:08');
  });

  it('空の駅名はパックの駅名で埋め、名前のある駅は書き換えない', async () => {
    const h = harness({
      rideDepartures: true,
      packLegs: [{ departures: [dep('甲線', [9, 8], [9, 18], '甲駅', '乙駅')], truncated: false }],
    });
    const named = new RouteSegment({
      type: SegmentType.train,
      fromName: '元の乗車駅',
      toName: '',
      minutes: 10,
      line: '甲線',
      polyline: [A, B],
    });

    const out = await h.measurer.resolveBoardingTimes(candidate([walk(5), named]), departureAt);

    expect([rides(out)[0].fromName, rides(out)[0].toName]).toEqual(['元の乗車駅', '乙駅']);
  });

  it('路線名が事業者名つきで食い違っても、片方がもう片方を含めば同じ路線とみなす', async () => {
    const h = harness({
      rideDepartures: true,
      packLegs: [{ departures: [dep('東横線', [9, 8], [9, 18])], truncated: false }],
    });

    const out = await h.measurer.resolveBoardingTimes(
      candidate([walk(5), ride('東急東横線', A, B, 10)]),
      departureAt,
    );

    expect(hm(rides(out)[0].depTime)).toEqual('9:08');
    expect(h.api.guidanceCalls).toEqual(0);
  });

  it('同じ路線の列車が無い区間だけを Transit で確定し、後ろの区間はパックでつなぐ', async () => {
    const h = harness({
      rideDepartures: true,
      packLegs: [
        { departures: [dep('丙線', [9, 8], [9, 18])], truncated: false },
        { departures: [dep('乙線', [9, 25], [9, 33])], truncated: false },
      ],
      guidance: () => guidanceDirect('甲線', 9 * 3600 + 10 * 60, 9 * 3600 + 21 * 60),
    });

    const out = await h.measurer.resolveBoardingTimes(twoRides(), departureAt);

    expect(rides(out).map((s) => hm(s.depTime))).toEqual(['9:10', '9:25']);
    expect(h.api.guidanceCallsByPurpose.boarding).toEqual(1);
  });

  it('打ち切られた一覧の外で乗る区間は、Transit で確定する', async () => {
    const h = harness({
      rideDepartures: true,
      packLegs: [
        { departures: [dep('甲線', [9, 8], [9, 18])], truncated: false },
        { departures: [dep('乙線', [9, 19], [9, 27])], truncated: true },
      ],
    });

    await h.measurer.resolveBoardingTimes(twoRides(), departureAt);

    expect(h.api.guidanceCallsByPurpose.boarding).toEqual(1);
  });

  it('バスの区間はパックに聞かず、Transit で確定する', async () => {
    const h = harness({ rideDepartures: true, packLegs: [] });

    await h.measurer.resolveBoardingTimes(
      candidate([walk(5), ride('バス01', A, B, 10, SegmentType.bus)]),
      departureAt,
    );

    expect(h.api.rideDepartureCalls).toEqual(0);
    expect(h.api.guidanceCallsByPurpose.boarding).toEqual(1);
  });

  it('エンドポイントが失敗したら、全区間を Transit で確定する', async () => {
    const h = harness({ rideDepartures: true, packLegs: null });

    await h.measurer.resolveBoardingTimes(twoRides(), departureAt);

    expect(h.api.rideDepartureCalls).toEqual(1);
    expect(h.api.guidanceCallsByPurpose.boarding).toEqual(2);
  });

  it('無効のときはパックに聞かない', async () => {
    const h = harness({ rideDepartures: false, packLegs: [] });

    await h.measurer.resolveBoardingTimes(twoRides(), departureAt);

    expect(h.api.rideDepartureCalls).toEqual(0);
    expect(h.api.guidanceCallsByPurpose.boarding).toEqual(2);
  });
});
