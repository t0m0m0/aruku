import { describe, expect, it, vi } from 'vitest';

import type { JsonMap } from '../../src/json';
import { GeoPoint } from '../../src/models/geo-point';
import { RouteSegment, SegmentType, type RoutePlan } from '../../src/models/route-plan';
import { TimeValue } from '../../src/models/time-value';
import { SearchCanceledException } from '../../src/services/cancellation';
import { haversineKm, RouteCandidate } from '../../src/services/hybrid-route-selector';
import {
  TimeoutException,
  type HttpClient,
  type HttpResponse,
} from '../../src/services/http-client';
import { ArrivalWaveOutcome, RouteSearchMetrics } from '../../src/services/route-diagnostics';
import {
  firstMissedTransit,
  trainMetersPerMinute,
  walkMetersPerMinute,
} from '../../src/services/route-plan-builder';
import { RouteException } from '../../src/services/route-service';
import { SearchDeadline } from '../../src/services/search-deadline';
import { TransitCorridor, TransitOption } from '../../src/services/transit-plan-parser';
import { TransitRouteService } from '../../src/services/transit-route-service';
import { dateTime, seconds } from '../../src/time';
import { dartDouble } from '../support/dart-number';
import { deferred } from '../support/deferred';
import { delay } from '../support/delay';
import { expectThrowsA } from '../support/expect';
import { first, firstWhere, last, singleWhere } from '../support/iterable';
import { jsonResponse, mockClient } from '../support/mock-client';
import { withTimeout } from '../support/timeout';

const transitBase = 'https://transit.example.com';
const proxyBase = 'https://proxy.example.com';

const json = (body: unknown, status = 200): HttpResponse => jsonResponse(body, status);

const pt = (s: string): GeoPoint => {
  const p = s.split(',');
  return new GeoPoint(Number.parseFloat(p[0]), Number.parseFloat(p[1]));
};

const walkMin = (a: GeoPoint, b: GeoPoint): number =>
  Math.round((haversineKm(a, b) * 1000) / walkMetersPerMinute);

const station = (id: string, name: string): JsonMap => ({ id, name });

const railLeg = (a: {
  route: string;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  dep: number;
  arr: number;
}): JsonMap => ({
  kind: 'transit',
  mode: 'rail',
  routeName: a.route,
  from: station(a.fromId, a.fromName),
  to: station(a.toId, a.toName),
  departureSecs: a.dep,
  arrivalSecs: a.arr,
});

const poly = (latLon: number[][]): JsonMap[] => latLon.map((p) => ({ lat: p[0], lon: p[1] }));

const mapSeg = (
  kind: string,
  fromId: string,
  toId: string,
  geom: string,
  coords: number[][],
): JsonMap => ({
  kind,
  geometrySource: geom,
  fromPointId: fromId,
  toPointId: toId,
  polyline: poly(coords),
});

const singleTrainOption = (
  o: { dep?: number; arr?: number; access?: number; egress?: number } = {},
): JsonMap => {
  const dep = o.dep ?? 32760;
  const arr = o.arr ?? 34560;
  const access = o.access ?? 300;
  const egress = o.egress ?? 300;
  const stops = [
    [35.6812, 139.7671],
    [35.6916, 139.7706],
    [35.6909, 139.7003],
  ];
  return {
    journey: {
      departureSecs: dep,
      arrivalSecs: arr,
      durationSecs: arr - dep + access + egress,
      accessWalkSecs: access,
      egressWalkSecs: egress,
      legs: [
        railLeg({
          route: '中央線快速',
          fromId: 'jr:Tokyo',
          fromName: '東京',
          toId: 'jr:Shinjuku',
          toName: '新宿',
          dep,
          arr,
        }),
      ],
    },
    map: {
      points: [],
      segments: [
        mapSeg('walk', 'origin', 'jr:Tokyo', 'osmWalk', [[35.68, 139.76], stops[0]]),
        mapSeg('transit', 'jr:Tokyo', 'jr:Shinjuku', 'stopOrder', stops),
        mapSeg('walk', 'jr:Shinjuku', 'destination', 'estimatedWalk', [
          stops[stops.length - 1],
          [35.69, 139.7],
        ]),
      ],
    },
  };
};

const guidance = (options: JsonMap[]): JsonMap => ({
  date: '20260627',
  timezone: 'Asia/Tokyo',
  from: station('origin', '地点(出発)'),
  to: station('destination', '地点(目的)'),
  options,
});

const matrixFor = (url: URL): HttpResponse => {
  const parse = (raw: string | null): GeoPoint[] =>
    (raw ?? '')
      .split(';')
      .filter((s) => s.length > 0)
      .map(pt);
  const os = parse(url.searchParams.get('origins'));
  const ds = parse(url.searchParams.get('destinations'));
  const rows: JsonMap[] = [];
  for (let i = 0; i < os.length; i++) {
    for (let j = 0; j < ds.length; j++) {
      const km = haversineKm(os[i], ds[j]);
      rows.push({
        originIndex: i,
        destinationIndex: j,
        duration: `${walkMin(os[i], ds[j]) * 60}s`,
        distanceMeters: Math.round(km * 1000),
      });
    }
  }
  return json(rows);
};

const walkFor = (url: URL, o: { factor?: number } = {}): HttpResponse => {
  const factor = o.factor ?? 1.0;
  const s = pt(url.searchParams.get('start') ?? '0,0');
  const g = pt(url.searchParams.get('goal') ?? '0,0');
  const km = haversineKm(s, g);
  return json({
    routes: [
      {
        distanceMeters: Math.round(km * 1000 * factor),
        duration: `${Math.round(walkMin(s, g) * factor) * 60}s`,
      },
    ],
  });
};

const mock = (a: { transit: JsonMap; log?: URL[]; walkFactor?: number }): HttpClient =>
  mockClient((url) => {
    a.log?.push(url);
    const path = url.pathname;
    if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
    if (path.includes('googleWalkProxy')) {
      return walkFor(url, { factor: a.walkFactor ?? 1.0 });
    }
    if (path.includes('guidance/plan')) return json(a.transit);
    return json({}, 404);
  });

const waveMock = (a: {
  departure: JsonMap;
  arrival?: JsonMap;
  onArrival?: () => Promise<HttpResponse>;
  log?: URL[];
}): HttpClient =>
  mockClient((url) => {
    a.log?.push(url);
    const path = url.pathname;
    if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
    if (path.includes('googleWalkProxy')) return walkFor(url);
    if (path.includes('guidance/plan')) {
      if (url.searchParams.get('type') === 'arrival') {
        if (a.onArrival) return a.onArrival();
        return json(a.arrival ?? guidance([]));
      }
      return json(a.departure);
    }
    return json({}, 404);
  });

const collapseGuidance = (): JsonMap => {
  const stops = [
    [35.0, 139.003],
    [35.0, 139.25],
    [35.0, 139.49],
  ];
  return guidance([
    {
      journey: {
        departureSecs: 33000,
        arrivalSecs: 33900,
        durationSecs: 1500,
        accessWalkSecs: 300,
        egressWalkSecs: 300,
        legs: [
          railLeg({
            route: '快速',
            fromId: 'jr:board',
            fromName: '乗車駅',
            toId: 'jr:alight',
            toName: '降車駅',
            dep: 33000,
            arr: 33900,
          }),
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('walk', 'origin', 'jr:board', 'osmWalk', [
            [35.0, 139.0],
            [35.0, 139.003],
          ]),
          mapSeg('transit', 'jr:board', 'jr:alight', 'stopOrder', stops),
          mapSeg('walk', 'jr:alight', 'destination', 'estimatedWalk', [
            [35.0, 139.49],
            [35.0, 139.5],
          ]),
        ],
      },
    },
  ]);
};

const familyOrigin = new GeoPoint(35.0, 139.0);
const familyGoal = new GeoPoint(35.0, 139.1);

const familyA = (): JsonMap => ({
  journey: {
    departureSecs: 32580,
    arrivalSecs: 32880,
    durationSecs: 32880 - 32580 + 240,
    accessWalkSecs: 120,
    egressWalkSecs: 120,
    legs: [
      railLeg({
        route: '特急線',
        fromId: 'a:board',
        fromName: 'A乗車',
        toId: 'a:alight',
        toName: 'A降車',
        dep: 32580,
        arr: 32880,
      }),
    ],
  },
  map: {
    points: [],
    segments: [
      mapSeg('walk', 'origin', 'a:board', 'osmWalk', [
        [35.0, 139.0],
        [35.0, 139.002],
      ]),
      mapSeg('transit', 'a:board', 'a:alight', 'stopOrder', [
        [35.0, 139.002],
        [35.0, 139.098],
      ]),
      mapSeg('walk', 'a:alight', 'destination', 'estimatedWalk', [
        [35.0, 139.098],
        [35.0, 139.1],
      ]),
    ],
  },
});

const familyB = (): JsonMap => ({
  journey: {
    departureSecs: 32580,
    arrivalSecs: 33480,
    durationSecs: 33480 - 32580 + 240,
    accessWalkSecs: 120,
    egressWalkSecs: 120,
    legs: [
      railLeg({
        route: '各停線',
        fromId: 'b:board',
        fromName: 'B乗車',
        toId: 'b:alight',
        toName: 'B降車',
        dep: 32580,
        arr: 33480,
      }),
    ],
  },
  map: {
    points: [],
    segments: [
      mapSeg('walk', 'origin', 'b:board', 'osmWalk', [
        [35.0, 139.0],
        [35.0, 139.002],
      ]),
      mapSeg('transit', 'b:board', 'b:alight', 'stopOrder', [
        [35.0, 139.002],
        [35.0, 139.03],
        [35.0, 139.098],
      ]),
      mapSeg('walk', 'b:alight', 'destination', 'estimatedWalk', [
        [35.0, 139.098],
        [35.0, 139.1],
      ]),
    ],
  },
});

const service = (
  client: HttpClient,
  o: {
    onMetrics?: (metrics: RouteSearchMetrics) => void;
    arrivalWaveGrace?: number | null;
    clock?: () => Date;
    exactWalkMax?: boolean;
    exactWalkMaxGrace?: number | null;
    exactWalkMaxAb?: boolean;
  } = {},
): TransitRouteService =>
  new TransitRouteService({
    transitClient: client,
    proxyClient: client,
    transitBaseUrl: transitBase,
    proxyBaseUrl: proxyBase,
    clock: o.clock ?? (() => dateTime(2026, 6, 27, 9, 0)),
    onMetrics: o.onMetrics,
    arrivalWaveGrace: o.arrivalWaveGrace,
    exactWalkMax: o.exactWalkMax,
    exactWalkMaxGrace: o.exactWalkMaxGrace,
    exactWalkMaxAb: o.exactWalkMaxAb,
  });

const origin = new GeoPoint(35.68, 139.76);
const goal = new GeoPoint(35.69, 139.7);

const recording = (client: HttpClient, log: URL[]): HttpClient => ({
  get: (url) => {
    log.push(url);
    return client.get(url);
  },
  close: () => client.close(),
});

const requestKey = (url: URL): string => {
  const params = [...url.searchParams.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  return `${url.origin}${url.pathname}?${params}`;
};

const isoOrNull = (d: Date | null): string | null => (d === null ? null : d.toISOString());

const fingerprint = (
  plan: RoutePlan,
  log: URL[],
  metrics: RouteSearchMetrics | null,
  o: { timingDependent?: string[] } = {},
): unknown => {
  const skip = new Set(o.timingDependent ?? []);
  return {
    plan: {
      from: plan.from,
      to: plan.to,
      totalKm: plan.totalKm,
      totalMin: plan.totalMin,
      budgetMin: plan.budgetMin,
      kcal: plan.kcal,
      walkKm: plan.walkKm,
      standardTransit: plan.standardTransit,
      timetableSources: plan.timetableSources,
      segments: plan.segments.map((s) => ({
        type: s.type,
        fromName: s.fromName,
        toName: s.toName,
        line: s.line,
        minutes: s.minutes,
        km: s.km,
        stops: s.stops,
        depTime: isoOrNull(s.depTime),
        arrTime: isoOrNull(s.arrTime),
        polyline: s.polyline.map((p) => `${p.lat},${p.lng}`).join(' '),
      })),
    },
    requests: skip.has('requests') ? null : log.map(requestKey).sort(),
    metrics:
      metrics === null
        ? null
        : Object.fromEntries(
            Object.entries(metrics)
              .filter(([k]) => !k.endsWith('Ms') && !skip.has(k))
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          ),
  };
};

const characterize = async (
  client: HttpClient,
  run: (client: HttpClient, onMetrics: (m: RouteSearchMetrics) => void) => Promise<RoutePlan>,
  o: { timingDependent?: string[] } = {},
): Promise<unknown> => {
  const log: URL[] = [];
  let captured: RouteSearchMetrics | null = null;
  const plan = await run(recording(client, log), (m) => (captured = m));
  return fingerprint(plan, log, captured, o);
};

describe('plan: 入力ガード', () => {
  it('origin が無ければ NO_ORIGIN', async () => {
    const svc = service(mock({ transit: guidance([singleTrainOption()]) }));
    const e = await expectThrowsA(
      () =>
        svc.plan({
          destination: '新宿',
          destinationLatLng: goal,
          departure: new TimeValue({ h: 9, m: 0 }),
          arrival: new TimeValue({ h: 12, m: 0 }),
        }),
      RouteException,
    );
    expect(e.status).toEqual('NO_ORIGIN');
  });

  it('目的地座標が無ければ NO_DESTINATION', async () => {
    const svc = service(mock({ transit: guidance([singleTrainOption()]) }));
    const e = await expectThrowsA(
      () =>
        svc.plan({
          destination: '新宿',
          destinationLatLng: null,
          departure: new TimeValue({ h: 9, m: 0 }),
          arrival: new TimeValue({ h: 12, m: 0 }),
          origin,
        }),
      RouteException,
    );
    expect(e.status).toEqual('NO_DESTINATION');
  });

  it('options が空なら ZERO_RESULTS', async () => {
    const svc = service(mock({ transit: guidance([]) }));
    const e = await expectThrowsA(
      () =>
        svc.plan({
          destination: '新宿',
          destinationLatLng: goal,
          departure: new TimeValue({ h: 9, m: 0 }),
          arrival: new TimeValue({ h: 12, m: 0 }),
          origin,
        }),
      RouteException,
    );
    expect(e.status).toEqual('ZERO_RESULTS');
  });
});

describe('plan: タイムアウト (#156)', () => {
  it('本命 guidance 取得がタイムアウトすると RouteException(TIMEOUT) へ変換', async () => {
    const client = mockClient(() => {
      throw new TimeoutException('no response');
    });
    const svc = service(client);
    const e = await expectThrowsA(
      () =>
        svc.plan({
          destination: '新宿',
          destinationLatLng: goal,
          departure: new TimeValue({ h: 9, m: 0 }),
          arrival: new TimeValue({ h: 12, m: 0 }),
          origin,
        }),
      RouteException,
    );
    expect(e.status).toEqual('TIMEOUT');
  });
});

describe('plan: 標準乗換', () => {
  it('予算が小さいと電車を含む経路を返し、表示名はアプリ指定で上書き', async () => {
    const svc = service(
      mock({
        transit: guidance([singleTrainOption({ dep: 33300, arr: 35100 })]),
      }),
    );
    const plan = await svc.plan({
      destination: '新宿駅',
      destinationLatLng: goal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 9, m: 50 }),
      origin,
      originName: '東京駅',
    });
    expect(plan.from).toEqual('東京駅');
    expect(plan.to).toEqual('新宿駅');
    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);
    expect(train.line).toEqual('中央線快速');
    expect(train.fare).toBeNull();
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });

  it('固定応答で確定経路・上流への要求・計測が変わらない: 電車を含む通常の成功（#486）', async () => {
    expect(
      await characterize(
        mock({ transit: guidance([singleTrainOption({ dep: 33300, arr: 35100 })]) }),
        (client, onMetrics) =>
          service(client, { onMetrics }).plan({
            destination: '新宿駅',
            destinationLatLng: goal,
            departure: new TimeValue({ h: 9, m: 0 }),
            arrival: new TimeValue({ h: 9, m: 50 }),
            origin,
            originName: '東京駅',
          }),
      ),
    ).toMatchSnapshot();
  });

  it('固定応答で確定経路・上流への要求・計測が変わらない: 予算が十分なら全徒歩（#486）', async () => {
    expect(
      await characterize(
        mock({ transit: guidance([singleTrainOption({ dep: 33300, arr: 35100 })]) }),
        (client, onMetrics) =>
          service(client, { onMetrics }).plan({
            destination: '新宿駅',
            destinationLatLng: goal,
            departure: new TimeValue({ h: 9, m: 0 }),
            arrival: new TimeValue({ h: 11, m: 0 }),
            origin,
            originName: '東京駅',
          }),
      ),
    ).toMatchSnapshot();
  });

  it('guidance/plan に geo from/to・date/time・type=departure を送る', async () => {
    const log: URL[] = [];
    const svc = service(mock({ transit: guidance([singleTrainOption()]), log }));
    await svc.plan({
      destination: '新宿',
      destinationLatLng: goal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 12, m: 0 }),
      origin,
    });
    const g = firstWhere(
      log,
      (u) => u.pathname.includes('guidance/plan') && u.searchParams.get('type') === 'departure',
    );
    expect(g.searchParams.get('from')).toEqual('geo:35.68,139.76');
    expect(g.searchParams.get('to')).toEqual('geo:35.69,139.7');
    expect(g.searchParams.get('date')).toEqual('20260627');
    expect(g.searchParams.get('time')).toEqual('09:00');
    expect(g.searchParams.get('type')).toEqual('departure');
  });

  it('崩壊しない検索は collapse=0・board-search 不起動を記録する (#309)', async () => {
    let captured: RouteSearchMetrics | null = null;
    const svc = service(
      mock({
        transit: guidance([singleTrainOption({ dep: 33300, arr: 35100 })]),
      }),
      { onMetrics: (m) => (captured = m) },
    );
    await svc.plan({
      destination: '新宿駅',
      destinationLatLng: goal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 9, m: 50 }),
      origin,
      originName: '東京駅',
    });
    const m = captured!;
    expect(m.collapseFired).toBe(false);
    expect(m.boardSearchActivated).toBe(false);
    expect(m.boardSearchMs).toEqual(0);
    expect(m.guidanceCalls).toBeGreaterThanOrEqual(1);
    expect(m.httpRoundTrips).toBeGreaterThanOrEqual(1);
  });

  it('guidance の本数を用途別に記録し、合計は guidanceCalls と一致する (#546)', async () => {
    let captured: RouteSearchMetrics | null = null;
    const svc = service(
      mock({
        transit: guidance([singleTrainOption({ dep: 33300, arr: 35100 })]),
      }),
      { onMetrics: (m) => (captured = m) },
    );
    await svc.plan({
      destination: '新宿駅',
      destinationLatLng: goal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 9, m: 50 }),
      origin,
      originName: '東京駅',
    });
    const m = captured!;
    expect(m.guidanceInitial).toEqual(1);
    expect(m.guidanceArrival).toEqual(1);
    expect(m.guidanceBoardSearch).toEqual(0);
    expect(m.guidanceBus).toEqual(0);
    expect(
      m.guidanceInitial +
        m.guidanceArrival +
        m.guidanceBoarding +
        m.guidanceNames +
        m.guidanceBoardSearch +
        m.guidanceBus,
    ).toEqual(m.guidanceCalls);
  });
});

describe('plan: ふつうの乗換ルート (#445)', () => {
  const plan = (svc: TransitRouteService) =>
    svc.plan({
      destination: '新宿',
      destinationLatLng: goal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 13, m: 0 }),
      origin,
    });

  it('出発時刻で引いた経路のうち、到着が最も早い1本の徒歩と所要を持つ', async () => {
    const later = singleTrainOption({ dep: 34200, arr: 36000, access: 600, egress: 600 });
    const earliest = singleTrainOption({ dep: 32760, arr: 34560 });
    const svc = service(mock({ transit: guidance([later, earliest]) }));

    const result = await plan(svc);

    expect(result.standardTransit).toEqual({ walkMinutes: 10, totalMin: 41 });
  });

  it('到着アンカー波の便は比べない——締切から逆算した便は「ふつう」ではない', async () => {
    const departureWave = singleTrainOption({ dep: 32760, arr: 34560 });
    const arrivalWave = singleTrainOption({ dep: 32700, arr: 33600, access: 120 });
    const svc = service(
      waveMock({
        departure: guidance([departureWave]),
        arrival: guidance([arrivalWave]),
      }),
    );

    const result = await plan(svc);

    expect(result.standardTransit).toEqual({ walkMinutes: 10, totalMin: 41 });
  });

  it('出発時刻で乗れる便が無ければ持たない', async () => {
    const missed = singleTrainOption({ dep: 31800, arr: 33600 });
    const svc = service(mock({ transit: guidance([missed]) }));

    const result = await plan(svc);

    expect(result.standardTransit).toBeNull();
  });
});

describe('plan: 徒歩最大化', () => {
  it('予算が大きいと標準乗換（access+egress のみ）より歩く候補を選ぶ', async () => {
    const svc = service(mock({ transit: guidance([singleTrainOption()]) }));
    const plan = await svc.plan({
      destination: '新宿',
      destinationLatLng: goal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 13, m: 0 }),
      origin,
      originName: '出発',
    });
    const walkMinutes = plan.segments
      .filter((s) => s.type === SegmentType.walk)
      .reduce((a, s) => a + s.minutes, 0);
    expect(walkMinutes).toBeGreaterThan(10);
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });
});

describe('plan: 複数ファミリ base のハイブリッド生成 (#292)', () => {
  const o = familyOrigin;
  const g = familyGoal;

  it('別路線ファミリのコリドー由来の徒歩多め候補が選ばれる', async () => {
    const svc = service(mock({ transit: guidance([familyA(), familyB()]) }));
    const plan = await svc.plan({
      destination: '目的地',
      destinationLatLng: g,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 40 }),
      origin: o,
      originName: '出発',
    });
    const walkMinutes = plan.segments
      .filter((s) => s.type === SegmentType.walk)
      .reduce((a, s) => a + s.minutes, 0);
    expect(walkMinutes).toBeGreaterThan(40);
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
    expect(plan.segments.some((s) => s.type === SegmentType.train && s.line === '各停線')).toBe(
      true,
    );
  });

  it('複数 base に広げても guidance/plan 照会は増えない（増分APIコストゼロ）', async () => {
    const log: URL[] = [];
    const svc = service(mock({ transit: guidance([familyA(), familyB()]), log }));
    await svc.plan({
      destination: '目的地',
      destinationLatLng: g,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 40 }),
      origin: o,
      originName: '出発',
    });
    const mainCalls = log.filter(
      (u) =>
        u.pathname.includes('guidance/plan') && u.searchParams.get('from') === 'geo:35.0,139.0',
    ).length;
    expect(mainCalls).toEqual(2);
    const guidanceCalls = log.filter((u) => u.pathname.includes('guidance/plan')).length;
    expect(guidanceCalls).toBeLessThanOrEqual(6);
  });

  it('路線名を欠く別コリドーも別ファミリとして徒歩多め候補を生む', async () => {
    const unnamed = (stops: number[][], arr: number): JsonMap => ({
      journey: {
        departureSecs: 32580,
        arrivalSecs: arr,
        durationSecs: arr - 32580 + 240,
        accessWalkSecs: 120,
        egressWalkSecs: 120,
        legs: [
          {
            kind: 'transit',
            mode: 'rail',
            from: station('u:board', '乗車'),
            to: station('u:alight', '降車'),
            departureSecs: 32580,
            arrivalSecs: arr,
          },
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('walk', 'origin', 'u:board', 'osmWalk', [[35.0, 139.0], stops[0]]),
          mapSeg('transit', 'u:board', 'u:alight', 'stopOrder', stops),
          mapSeg('walk', 'u:alight', 'destination', 'estimatedWalk', [
            stops[stops.length - 1],
            [35.0, 139.1],
          ]),
        ],
      },
    });
    const svc = service(
      mock({
        transit: guidance([
          unnamed(
            [
              [35.0, 139.002],
              [35.0, 139.098],
            ],
            32880,
          ),
          unnamed(
            [
              [35.0, 139.002],
              [35.0, 139.03],
              [35.0, 139.098],
            ],
            33480,
          ),
        ]),
      }),
    );
    const plan = await svc.plan({
      destination: '目的地',
      destinationLatLng: g,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 40 }),
      origin: o,
      originName: '出発',
    });
    const walkMinutes = plan.segments
      .filter((s) => s.type === SegmentType.walk)
      .reduce((a, s) => a + s.minutes, 0);
    expect(walkMinutes).toBeGreaterThan(40);
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });
});

describe('plan: 路線ごとのアクセス徒歩実測を検索単位で集約する (#485)', () => {
  const o = familyOrigin;
  const g = familyGoal;
  const familyPlan = (client: HttpClient, onMetrics?: (m: RouteSearchMetrics) => void) =>
    service(client, { onMetrics }).plan({
      destination: '目的地',
      destinationLatLng: g,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 40 }),
      origin: o,
      originName: '出発',
    });

  it('固定応答で確定経路・上流への要求・計測が変わらない: 複数ファミリのハイブリッド（#486）', async () => {
    expect(
      await characterize(mock({ transit: guidance([familyA(), familyB()]) }), familyPlan),
    ).toMatchSnapshot();
  });

  const matrixLegs = (log: URL[]): string[] =>
    log
      .filter((u) => u.pathname.includes('googleWalkMatrixProxy'))
      .flatMap((u) => {
        const split = (k: string): string[] =>
          (u.searchParams.get(k) ?? '').split(';').filter((s) => s.length > 0);
        return split('origins').flatMap((a) => split('destinations').map((b) => `${a}|${b}`));
      });

  it('複数 base が共有するレッグを重複して実測しない', async () => {
    const log: URL[] = [];
    let captured: RouteSearchMetrics | null = null;
    await familyPlan(
      mock({ transit: guidance([familyA(), familyB()]), log }),
      (m) => (captured = m),
    );
    const legs = matrixLegs(log);
    expect(legs.length).toBeGreaterThan(0);
    expect(legs.length, `重複: ${legs.join(' ')}`).toEqual(new Set(legs).size);
    const m = captured!;
    expect(m.matrixElements).toEqual(legs.length);
    expect(m.accessMatrixUniqueLegs).toBeLessThan(m.accessMatrixRequestedLegs);
  });

  it('マトリクス応答の並び順が変わっても勝者は同じ', async () => {
    const reversed = mockClient((url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) {
        const rows = JSON.parse(new TextDecoder().decode(matrixFor(url).bodyBytes)) as unknown[];
        return json(rows.reverse());
      }
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (path.includes('guidance/plan')) {
        return json(guidance([familyA(), familyB()]));
      }
      return json({}, 404);
    });
    const normal = await familyPlan(mock({ transit: guidance([familyA(), familyB()]) }));
    const flipped = await familyPlan(reversed);
    expect(flipped.segments).toEqual(normal.segments);
  });

  it('マトリクスが全滅しても直線推定で候補を作り、全徒歩を候補に残す', async () => {
    const failing = mockClient((url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return json({}, 500);
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (path.includes('guidance/plan')) {
        return json(guidance([familyA(), familyB()]));
      }
      return json({}, 404);
    });
    const plan = await familyPlan(failing);
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
    expect(plan.segments.some((s) => s.type === SegmentType.train && s.line === '各停線')).toBe(
      true,
    );
  });

  it('マトリクス実測中のキャンセルを握り潰さず plan ごと落とす', async () => {
    const canceling = mockClient((url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) {
        throw new SearchCanceledException();
      }
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (path.includes('guidance/plan')) {
        return json(guidance([familyA(), familyB()]));
      }
      return json({}, 404);
    });
    await expectThrowsA(() => familyPlan(canceling), SearchCanceledException);
  });
});

describe('basesForHybrid: 路線ファミリ別 base 選定 (#292)', () => {
  const opt = (line: string, minutes: number): TransitOption => {
    const coords = [new GeoPoint(35.0, 139.0), new GeoPoint(35.0, 139.01)];
    return new TransitOption({
      from: '出発',
      to: '目的',
      segments: [
        new RouteSegment({
          type: SegmentType.train,
          fromName: '',
          toName: '',
          minutes,
          line,
          polyline: coords,
        }),
      ],
      corridors: [
        new TransitCorridor({
          legIndex: 0,
          geometrySource: 'stopOrder',
          coords,
        }),
      ],
    });
  };

  const lines = (os: TransitOption[]): (string | null)[] => os.map((o) => first(o.segments).line);

  it('同所要のタイブレークは代表(最短)option の出現順に従う', () => {
    const svc = service(mock({ transit: guidance([]) }));
    const bases = svc.basesForHybrid([opt('A', 20), opt('B', 10), opt('A', 10)]);
    expect(lines(bases)).toEqual(['B', 'A']);
    expect(first(bases[1].segments).minutes).toEqual(10);
  });

  it('先頭は総所要最小のファミリ（単一ファミリ時は1本）', () => {
    const svc = service(mock({ transit: guidance([]) }));
    expect(lines(svc.basesForHybrid([opt('A', 30), opt('B', 12)]))).toEqual(['B', 'A']);
    expect(lines(svc.basesForHybrid([opt('A', 30), opt('A', 12)]))).toEqual(['A']);
  });

  it('ファミリ数が上限を超えたら総所要の小さい代表から選ぶ', () => {
    const svc = service(mock({ transit: guidance([]) }));
    const bases = svc.basesForHybrid([opt('A', 40), opt('B', 10), opt('C', 20), opt('D', 30)]);
    expect(lines(bases)).toEqual(['B', 'C', 'D']);
  });

  const optAt = (line: string | null, minutes: number, coords: GeoPoint[]): TransitOption =>
    new TransitOption({
      from: '出発',
      to: '目的',
      segments: [
        new RouteSegment({
          type: SegmentType.train,
          fromName: '',
          toName: '',
          minutes,
          line,
          polyline: coords,
        }),
      ],
      corridors: [
        new TransitCorridor({
          legIndex: 0,
          geometrySource: 'stopOrder',
          coords,
        }),
      ],
    });

  it('空文字/欠落の routeName もコリドー形状で別ファミリに分ける', () => {
    const svc = service(mock({ transit: guidance([]) }));
    const corridorA = [new GeoPoint(35.0, 139.0), new GeoPoint(35.0, 139.02)];
    const corridorB = [
      new GeoPoint(35.0, 139.0),
      new GeoPoint(35.0, 139.01),
      new GeoPoint(35.0, 139.02),
    ];
    expect(svc.basesForHybrid([optAt('', 10, corridorA), optAt('', 20, corridorB)])).toHaveLength(
      2,
    );
    expect(
      svc.basesForHybrid([optAt(null, 10, corridorA), optAt(null, 20, corridorB)]),
    ).toHaveLength(2);
  });
});

describe('mergeHybrids: 予算内優先の上限マージ (#292)', () => {
  const cand = (walkMinutes: number, tag: number): RouteCandidate =>
    new RouteCandidate({
      from: '出発',
      to: '目的',
      segments: [
        new RouteSegment({
          type: SegmentType.walk,
          fromName: '',
          toName: '',
          minutes: walkMinutes,
          polyline: [new GeoPoint(35.0, tag), new GeoPoint(35.0, tag + 0.001)],
        }),
      ],
    });

  it('予算外の徒歩多め候補は予算内候補を締め出さない（予算内が先）', () => {
    const svc = service(mock({ transit: guidance([]) }));
    const over = cand(80, 139.1);
    const within1 = cand(50, 139.2);
    const within2 = cand(40, 139.3);
    const merged = svc.mergeHybrids([[over, within1], [within2]], (h) => h !== over);
    expect(merged).toHaveLength(3);
    expect(merged.indexOf(over)).toBeGreaterThan(merged.indexOf(within1));
    expect(merged.indexOf(over)).toBeGreaterThan(merged.indexOf(within2));
  });
});

describe('plan: 崩壊判定の測定基準（#137 指摘2）', () => {
  const origin2 = new GeoPoint(35.0, 139.0);
  const goal2 = new GeoPoint(35.0, 139.5);

  const inflatedMock = (guidanceCalls: URL[], o: { delay?: number } = {}): HttpClient => {
    const parse = (raw: string | null): GeoPoint[] =>
      (raw ?? '')
        .split(';')
        .filter((s) => s.length > 0)
        .map(pt);
    const matrix = (url: URL): HttpResponse => {
      const os = parse(url.searchParams.get('origins'));
      const ds = parse(url.searchParams.get('destinations'));
      const rows: JsonMap[] = [];
      for (let i = 0; i < os.length; i++) {
        for (let j = 0; j < ds.length; j++) {
          rows.push({
            originIndex: i,
            destinationIndex: j,
            duration: `${walkMin(os[i], ds[j]) * 3 * 60}s`,
            distanceMeters: Math.round(haversineKm(os[i], ds[j]) * 1000),
          });
        }
      }
      return json(rows);
    };

    const walk = (url: URL): HttpResponse => {
      const s = pt(url.searchParams.get('start') ?? '0,0');
      const g = pt(url.searchParams.get('goal') ?? '0,0');
      return json({
        routes: [
          {
            distanceMeters: Math.round(haversineKm(s, g) * 1000),
            duration: `${walkMin(s, g) * 3 * 60}s`,
          },
        ],
      });
    };

    const transit = collapseGuidance();
    return mockClient(async (url) => {
      if (o.delay !== undefined) await delay(o.delay);
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrix(url);
      if (path.includes('googleWalkProxy')) return walk(url);
      if (path.includes('guidance/plan')) {
        guidanceCalls.push(url);
        return json(transit);
      }
      return json({}, 404);
    });
  };

  it('実街路で膨らんだ徒歩で崩壊判定を潰さず乗車駅探索を起動する', async () => {
    const guidanceCalls: URL[] = [];
    const svc = service(inflatedMock(guidanceCalls));
    await svc.plan({
      destination: '降車駅',
      destinationLatLng: goal2,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 0 }),
      origin: origin2,
      originName: '出発',
    });
    expect(guidanceCalls.length).toBeGreaterThan(1);
  });

  it('崩壊・board-search 起動・上流本数を定量指標として記録する (#309)', async () => {
    let captured: RouteSearchMetrics | null = null;
    const svc = service(inflatedMock([]), { onMetrics: (m) => (captured = m) });
    await svc.plan({
      destination: '降車駅',
      destinationLatLng: goal2,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 0 }),
      origin: origin2,
      originName: '出発',
    });
    const m = captured!;
    expect(m.collapseFired).toBe(true);
    expect(m.boardSearchActivated).toBe(true);
    expect(m.matrixCalls).toBeGreaterThan(0);
    expect(m.guidanceCalls).toBeGreaterThan(1);
    expect(m.httpRoundTrips).toEqual(m.guidanceCalls + m.walkCalls + m.matrixCalls);
    expect(m.guidanceBoardSearch, 'board-search の照会を用途別に数える (#546)').toBeGreaterThan(0);
    expect(
      m.guidanceInitial +
        m.guidanceArrival +
        m.guidanceBoarding +
        m.guidanceNames +
        m.guidanceBoardSearch +
        m.guidanceBus,
    ).toEqual(m.guidanceCalls);
  });

  it('崩壊後の再選定で払った enrich も enrichMs が覆う (#309)', async () => {
    let captured: RouteSearchMetrics | null = null;
    await service(inflatedMock([], { delay: 2 }), {
      onMetrics: (m) => (captured = m),
    }).plan({
      destination: '降車駅',
      destinationLatLng: goal2,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 0 }),
      origin: origin2,
      originName: '出発',
    });
    const m = captured!;
    expect(m.collapseFired, '前提: 崩壊して再選定へ入る').toBe(true);
    expect(m.enrichCriticalMs, '前提: 実測を払っている').toBeGreaterThan(0);
    expect(m.enrichCriticalMs, '臨界パスは enrichMs が覆う区間の部分集合').toBeLessThanOrEqual(
      m.enrichMs,
    );
  });

  it('コリドー由来の確定経路でも乗降駅名を復元しタイムラインに出す', async () => {
    const svc = service(inflatedMock([]));
    const plan = await svc.plan({
      destination: '降車駅',
      destinationLatLng: goal2,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 0 }),
      origin: origin2,
      originName: '出発',
    });

    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);
    expect(train.fromName).toEqual('乗車駅');
    expect(train.toName).toEqual('降車駅');

    const places = plan.timelineNodes.map((n) => n.place);
    expect(places).toContain('乗車駅');
  });

  it('前半徒歩が単独で予算外の遠いコリドー点は guidance を引き直さない（#317）', async () => {
    const guidanceCalls: URL[] = [];
    const svc = service(inflatedMock(guidanceCalls));
    await svc.plan({
      destination: '降車駅',
      destinationLatLng: goal2,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 0 }),
      origin: origin2,
      originName: '出発',
    });

    const fromLng = (u: URL): number | null => {
      const f = u.searchParams.get('from');
      if (f === null) return null;
      const parsed = Number.parseFloat(f.replace('geo:', '').split(',')[1]);
      return Number.isNaN(parsed) ? null : parsed;
    };

    const queriedLngs = guidanceCalls.map(fromLng).filter((lng): lng is number => lng !== null);
    expect(
      queriedLngs.some((lng) => Math.abs(lng - 139.25) < 1e-6),
      '徒歩単独で予算外の遠点(139.25)を guidance 引き直ししている',
    ).toBe(false);
    expect(
      queriedLngs.some((lng) => Math.abs(lng - 139.49) < 1e-6),
      '徒歩単独で予算外の遠点(139.49)を guidance 引き直ししている',
    ).toBe(false);
  });
});

describe('plan: 乗車駅探索の実測駆動（#137 主因）', () => {
  const origin3 = new GeoPoint(35.0, 139.0);
  const goal3 = new GeoPoint(35.0, 139.05);
  const transfer = 139.025;
  const inflate = 6;

  const leg1 = (): number[][] => {
    const out: number[][] = [];
    for (let i = 0; i < 30; i++) {
      out.push([35.0, 139.001 + ((transfer - 139.001) * i) / 29]);
    }
    return out;
  };
  const leg2 = (): number[][] => {
    const out: number[][] = [];
    for (let i = 0; i < 30; i++) {
      out.push([35.0, transfer + ((139.05 - transfer) * i) / 29]);
    }
    return out;
  };

  const baseGuidance = (o: { aArr?: number; bArr?: number } = {}): JsonMap => {
    const aArr = o.aArr ?? 33000;
    const bArr = o.bArr ?? 33600;
    return guidance([
      {
        journey: {
          departureSecs: 32400,
          arrivalSecs: bArr,
          durationSecs: bArr - 32400,
          accessWalkSecs: 0,
          egressWalkSecs: 0,
          legs: [
            railLeg({
              route: '基準線A',
              fromId: 's0',
              fromName: '始発駅',
              toId: 'sT',
              toName: '乗換駅',
              dep: 32400,
              arr: aArr,
            }),
            railLeg({
              route: '基準線B',
              fromId: 'sT',
              fromName: '乗換駅',
              toId: 'sN',
              toName: '終着駅',
              dep: aArr,
              arr: bArr,
            }),
          ],
        },
        map: {
          points: [],
          segments: [
            mapSeg('transit', 's0', 'sT', 'stopOrder', leg1()),
            mapSeg('transit', 'sT', 'sN', 'stopOrder', leg2()),
          ],
        },
      },
    ]);
  };

  const secsOf = (hhmm: string): number => {
    const p = hhmm.split(':');
    return Number.parseInt(p[0], 10) * 3600 + Number.parseInt(p[1], 10) * 60;
  };

  const reentry = (lng: number, time: string): JsonMap => {
    const dep = secsOf(time);
    const remainMin = Math.round(
      (haversineKm(new GeoPoint(35.0, lng), goal3) * 1000) / trainMetersPerMinute,
    );
    const arr = dep + remainMin * 60;
    return guidance([
      {
        journey: {
          departureSecs: dep,
          arrivalSecs: arr,
          durationSecs: arr - dep,
          accessWalkSecs: 0,
          egressWalkSecs: 0,
          legs: [
            railLeg({
              route: '快速',
              fromId: 'bx',
              fromName: '乗車駅',
              toId: 'gx',
              toName: '目的駅',
              dep,
              arr,
            }),
          ],
        },
        map: {
          points: [],
          segments: [
            mapSeg('transit', 'bx', 'gx', 'stopOrder', [
              [35.0, lng],
              [35.0, 139.05],
            ]),
          ],
        },
      },
    ]);
  };

  const inflatedFromMock = (
    o: {
      aArr?: number;
      bArr?: number;
      guidanceCalls?: URL[];
      matrixDests?: number[];
      enforceMatrixLimit?: boolean;
      walkDelay?: number;
      guidanceDelay?: number;
      rateLimitFrom?: ((lng: number) => boolean) | null;
    } = {},
  ): HttpClient => {
    const walkDelay = o.walkDelay ?? 0;
    const guidanceDelay = o.guidanceDelay ?? 0;
    const parse = (raw: string | null): GeoPoint[] =>
      (raw ?? '')
        .split(';')
        .filter((s) => s.length > 0)
        .map(pt);
    const matrix = (url: URL): HttpResponse => {
      const os = parse(url.searchParams.get('origins'));
      const ds = parse(url.searchParams.get('destinations'));
      o.matrixDests?.push(ds.length);
      if (o.enforceMatrixLimit === true && os.length * ds.length > 25) {
        return json({ error: 'too many elements' }, 400);
      }
      const rows: JsonMap[] = [];
      for (let i = 0; i < os.length; i++) {
        for (let j = 0; j < ds.length; j++) {
          rows.push({
            originIndex: i,
            destinationIndex: j,
            duration: `${walkMin(os[i], ds[j]) * inflate * 60}s`,
            distanceMeters: Math.round(haversineKm(os[i], ds[j]) * 1000),
          });
        }
      }
      return json(rows);
    };

    const walk = (url: URL): HttpResponse => {
      const s = pt(url.searchParams.get('start') ?? '0,0');
      const g = pt(url.searchParams.get('goal') ?? '0,0');
      return json({
        routes: [
          {
            distanceMeters: Math.round(haversineKm(s, g) * 1000),
            duration: `${walkMin(s, g) * inflate * 60}s`,
          },
        ],
      });
    };

    return mockClient(async (url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrix(url);
      if (path.includes('googleWalkProxy')) {
        if (walkDelay > 0) await delay(walkDelay);
        return walk(url);
      }
      if (path.includes('guidance/plan')) {
        o.guidanceCalls?.push(url);
        if (guidanceDelay > 0) await delay(guidanceDelay);
        const from = url.searchParams.get('from') ?? '';
        const lng = Number.parseFloat(from.replace('geo:', '').split(',')[1]);
        const time = url.searchParams.get('time') ?? '09:00';
        if (Math.abs(lng - 139.0) < 1e-6) {
          return json(baseGuidance({ aArr: o.aArr, bArr: o.bArr }));
        }
        if (o.rateLimitFrom?.(lng) ?? false) {
          return json({ error: 'rate limited' }, 429);
        }
        return json(reentry(lng, time));
      }
      return json({}, 404);
    });
  };

  const walkMinutesOf = (plan: RoutePlan): number =>
    plan.segments.filter((s) => s.type === SegmentType.walk).reduce((a, s) => a + s.minutes, 0);

  it('楽観推定で遠い駅へ収束せず、実測で予算内・徒歩最大の乗車駅を選ぶ', async () => {
    const svc = service(inflatedFromMock());
    const plan = await svc.plan({
      destination: '目的駅',
      destinationLatLng: goal3,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 30 }),
      origin: origin3,
      originName: '出発',
    });
    expect(walkMinutesOf(plan)).toBeGreaterThan(50);
    expect(plan.totalMin).toBeLessThanOrEqual(90);
  });

  it('引き直しが 429 で落ちた点は予算外扱いにせず、徒歩最大化を縮めない（#333）', async () => {
    const walkWith = async (rateLimit: ((lng: number) => boolean) | null): Promise<number> => {
      const plan = await service(inflatedFromMock({ rateLimitFrom: rateLimit })).plan({
        destination: '目的駅',
        destinationLatLng: goal3,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 30 }),
        origin: origin3,
        originName: '出発',
      });
      expect(plan.totalMin).toBeLessThanOrEqual(90);
      return walkMinutesOf(plan);
    };

    let rateLimited = 0;
    const withFailure = await walkWith((lng) => {
      const hit = lng > 139.0022 && lng < 139.0031;
      if (hit) rateLimited++;
      return hit;
    });
    const healthy = await walkWith(null);

    expect(rateLimited, '前提: 429 の点が実際に probe されている').toBeGreaterThan(0);
    expect(healthy, '前提: 無失敗なら徒歩最大化が効いている').toBeGreaterThan(50);
    expect(withFailure, '429 が徒歩最大化の境界を決めてしまっている').toEqual(healthy);
  });

  it('絶対値の余りが大きければ相対閾値未満でも崩壊として乗車駅探索を起動する', async () => {
    const calls: URL[] = [];
    const plan = await service(
      inflatedFromMock({
        aArr: 35400,
        bArr: 38400,
        guidanceCalls: calls,
      }),
    ).plan({
      destination: '目的駅',
      destinationLatLng: goal3,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 11, m: 30 }),
      origin: origin3,
      originName: '出発',
    });
    expect(calls.length).toBeGreaterThan(1);
    expect(walkMinutesOf(plan)).toBeGreaterThan(50);
    expect(plan.totalMin).toBeLessThanOrEqual(150);
  });

  it('コリドーが密で25点超でも matrix を分割して投げる（MATRIX_MAX_ELEMENTS・#317 レビュー）', async () => {
    const dests: number[] = [];
    const svc = service(inflatedFromMock({ matrixDests: dests, enforceMatrixLimit: true }));
    await svc.plan({
      destination: '目的駅',
      destinationLatLng: goal3,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 30 }),
      origin: origin3,
      originName: '出発',
    });

    expect(dests).not.toHaveLength(0);
    expect(
      dests.every((c) => c <= 25),
      'matrix 目的地が MATRIX_MAX_ELEMENTS(25) を超えている（400 全滅の原因）',
    ).toBe(true);
    expect(
      dests.some((c) => c > 11),
      '前提: board-search の matrix プレ実測が走る',
    ).toBe(true);
  });

  it('enrich を「パス本数」と「1候補の直列段数」に分けて計上する', async () => {
    let captured: RouteSearchMetrics | null = null;
    const svc = service(inflatedFromMock({ walkDelay: 10, guidanceDelay: 20 }), {
      onMetrics: (m) => (captured = m),
    });
    await svc.plan({
      destination: '目的駅',
      destinationLatLng: goal3,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 30 }),
      origin: origin3,
      originName: '出発',
    });
    const m = captured!;
    expect(m.enrichResolveDepth).toEqual(0);
    expect(m.enrichPasses).toBeGreaterThan(0);
    expect(m.enrichCandidates).toBeGreaterThanOrEqual(m.enrichPasses);
    expect(
      m.enrichCriticalMs,
      '崩壊時の再選定は boardSearchMs 側に計上されるため両方を上界に採る',
    ).toBeLessThanOrEqual(m.enrichMs + m.boardSearchMs);
  });

  it('ラウンドごとの徒歩推移を記録し、最終徒歩と突き合わせられるようにする', async () => {
    let captured: RouteSearchMetrics | null = null;
    const svc = service(inflatedFromMock(), {
      onMetrics: (m) => (captured = m),
    });
    await svc.plan({
      destination: '目的駅',
      destinationLatLng: goal3,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 30 }),
      origin: origin3,
      originName: '出発',
    });
    const m = captured!;
    expect(m.boardSearchActivated, '前提: board-search が走る').toBe(true);
    expect(
      m.boardSearchWalkByRound.length,
      'ラウンド数と系列長は一致する（最終ラウンドも締める）',
    ).toEqual(m.boardSearchRounds);
    for (let i = 1; i < m.boardSearchWalkByRound.length; i++) {
      expect(m.boardSearchWalkByRound[i]).toBeGreaterThanOrEqual(m.boardSearchWalkByRound[i - 1]);
    }
    expect(m.finalWalkMinutes).toBeGreaterThan(0);
    expect(
      m.boardSearchWinnerRound,
      '前提: board-search 候補が確定し、同一性で引けている',
    ).toBeGreaterThanOrEqual(1);
    expect(m.boardSearchWinnerRound, 'ラウンド番号は実際に回した数を超えない').toBeLessThanOrEqual(
      m.boardSearchRounds,
    );
  });

  it('A/B 計測 (#462): A の board-search が崩壊を解いても、厳密走査の手柄にしない', async () => {
    let captured: RouteSearchMetrics | null = null;
    const svc = service(inflatedFromMock(), {
      exactWalkMaxAb: true,
      onMetrics: (m) => (captured = m),
    });
    await svc.plan({
      destination: '目的駅',
      destinationLatLng: goal3,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 30 }),
      origin: origin3,
      originName: '出発',
    });
    const m = captured!;
    expect(m.collapseFired, '前提: A は崩壊する').toBe(true);
    expect(m.boardSearchWinnerRound, '前提: board-search の候補が勝つ').toBeGreaterThanOrEqual(1);
    expect(m.exactWon).toBe(false);
    expect(m.collapseB).toBe(true);
  });

  it('プローブ内の「徒歩実測→引き直し」の直列を、同一 run の反実仮想として計上する', async () => {
    let captured: RouteSearchMetrics | null = null;
    const walkDelay = 30;
    const guidanceDelay = 60;
    const svc = service(inflatedFromMock({ walkDelay, guidanceDelay }), {
      onMetrics: (m) => (captured = m),
    });
    await svc.plan({
      destination: '目的駅',
      destinationLatLng: goal3,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 30 }),
      origin: origin3,
      originName: '出発',
    });
    const m = captured!;
    expect(m.boardSearchActivated, '前提: board-search が走る').toBe(true);
    expect(m.boardSearchProbeSerialMs).toBeGreaterThan(m.boardSearchProbeParallelMs);
    expect(
      m.boardSearchRounds,
      '前提: 2ラウンド以上回る（1ラウンドだと比例と非比例を区別できない）',
    ).toBeGreaterThanOrEqual(2);
    const nominalProbeMs = walkDelay + guidanceDelay;
    expect(m.boardSearchProbeSerialMs).toBeGreaterThanOrEqual(
      m.boardSearchRounds * nominalProbeMs * 0.8,
    );
  });

  it('matrix プレ実測のチャンクを並列に投げる（#317 レビュー）', async () => {
    const probeA = deferred<void>();
    const probeB = deferred<void>();
    const barrier = (): Promise<unknown> => Promise.all([probeA.promise, probeB.promise]);
    const parse = (raw: string | null): GeoPoint[] =>
      (raw ?? '')
        .split(';')
        .filter((s) => s.length > 0)
        .map(pt);
    const matrixRows = (url: URL): HttpResponse => {
      const os = parse(url.searchParams.get('origins'));
      const ds = parse(url.searchParams.get('destinations'));
      const rows: JsonMap[] = [];
      for (let i = 0; i < os.length; i++) {
        for (let j = 0; j < ds.length; j++) {
          rows.push({
            originIndex: i,
            destinationIndex: j,
            duration: `${walkMin(os[i], ds[j]) * inflate * 60}s`,
            distanceMeters: Math.round(haversineKm(os[i], ds[j]) * 1000),
          });
        }
      }
      return json(rows);
    };

    const client = mockClient(async (url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) {
        const ds = parse(url.searchParams.get('destinations'));
        if (ds.length > 11) {
          if (!probeA.isCompleted) {
            probeA.complete(undefined);
          } else if (!probeB.isCompleted) {
            probeB.complete(undefined);
          }
          await barrier();
        }
        return matrixRows(url);
      }
      if (path.includes('googleWalkProxy')) {
        const s = pt(url.searchParams.get('start') ?? '0,0');
        const gg = pt(url.searchParams.get('goal') ?? '0,0');
        return json({
          routes: [
            {
              distanceMeters: Math.round(haversineKm(s, gg) * 1000),
              duration: `${walkMin(s, gg) * inflate * 60}s`,
            },
          ],
        });
      }
      if (path.includes('guidance/plan')) {
        const from = url.searchParams.get('from') ?? '';
        const lng = Number.parseFloat(from.replace('geo:', '').split(',')[1]);
        const time = url.searchParams.get('time') ?? '09:00';
        return json(Math.abs(lng - 139.0) < 1e-6 ? baseGuidance() : reentry(lng, time));
      }
      return json({}, 404);
    });

    await withTimeout(
      service(client).plan({
        destination: '目的駅',
        destinationLatLng: goal3,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 30 }),
        origin: origin3,
        originName: '出発',
      }),
      5000,
      () => expect.fail('scan チャンクが同時到達しない（直列でデッドロック）'),
    );

    expect(probeA.isCompleted && probeB.isCompleted, '前提: 2チャンクが並列に発火する').toBe(true);
  });

  describe('検索の締切 (#300)', () => {
    const expiringAfterFirstGuidance = (calls: URL[]): SearchDeadline =>
      new SearchDeadline(seconds(120), {
        elapsed: () => (calls.length === 0 ? 0 : seconds(120)),
      });

    const serviceWith = (
      client: HttpClient,
      deadline: SearchDeadline,
      o: { onMetrics?: (m: RouteSearchMetrics) => void } = {},
    ): TransitRouteService =>
      new TransitRouteService({
        transitClient: client,
        proxyClient: client,
        transitBaseUrl: transitBase,
        proxyBaseUrl: proxyBase,
        clock: () => dateTime(2026, 6, 27, 9, 0),
        deadline,
        onMetrics: o.onMetrics,
      });

    it('ラウンド実行中に切れた締切も truncated にする（#332 レビュー）', async () => {
      const baseline: URL[] = [];
      await serviceWith(inflatedFromMock({ guidanceCalls: baseline }), SearchDeadline.none()).plan({
        destination: '目的駅',
        destinationLatLng: goal3,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 30 }),
        origin: origin3,
        originName: '出発',
      });
      expect(baseline.length, 'board-search が走る前提').toBeGreaterThan(1);

      const calls: URL[] = [];
      let captured: RouteSearchMetrics | null = null;
      await serviceWith(
        inflatedFromMock({ guidanceCalls: calls }),
        new SearchDeadline(seconds(120), {
          elapsed: () => (calls.length >= baseline.length ? seconds(120) : 0),
        }),
        { onMetrics: (m) => (captured = m) },
      ).plan({
        destination: '目的駅',
        destinationLatLng: goal3,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 30 }),
        origin: origin3,
        originName: '出発',
      });

      expect(captured).not.toBeNull();
      expect(captured!.boardSearchActivated).toBe(true);
      expect(captured!.boardSearchTruncated).toBe(true);
    });

    it('締切に掛かった探索の境界は truncated として記録する（#332 レビュー）', async () => {
      const calls: URL[] = [];
      let captured: RouteSearchMetrics | null = null;
      const svc = serviceWith(
        inflatedFromMock({ guidanceCalls: calls }),
        new SearchDeadline(seconds(120), {
          elapsed: () => (calls.length >= 3 ? seconds(120) : 0),
        }),
        { onMetrics: (m) => (captured = m) },
      );

      await svc.plan({
        destination: '目的駅',
        destinationLatLng: goal3,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 30 }),
        origin: origin3,
        originName: '出発',
      });

      expect(captured).not.toBeNull();
      expect(captured!.boardSearchTruncated).toBe(true);
    });

    it('締切を使い切っても確定経路は返る（引き直しの全滅で失敗させない）', async () => {
      const calls: URL[] = [];
      const svc = serviceWith(
        inflatedFromMock({ guidanceCalls: calls }),
        expiringAfterFirstGuidance(calls),
      );

      const plan = await svc.plan({
        destination: '目的駅',
        destinationLatLng: goal3,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 30 }),
        origin: origin3,
        originName: '出発',
      });

      expect(plan.segments).not.toHaveLength(0);
    });

    it('締切超過後は引き直しの HTTP を発行しない', async () => {
      const calls: URL[] = [];
      const svc = serviceWith(
        inflatedFromMock({ guidanceCalls: calls }),
        expiringAfterFirstGuidance(calls),
      );

      await svc.plan({
        destination: '目的駅',
        destinationLatLng: goal3,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 30 }),
        origin: origin3,
        originName: '出発',
      });

      expect(calls).toHaveLength(2);
    });

    it('締切超過後は board-search の matrix プレ実測も投げない（#317 レビュー）', async () => {
      const freshDests: number[] = [];
      const freshCalls: URL[] = [];
      await serviceWith(
        inflatedFromMock({
          guidanceCalls: freshCalls,
          matrixDests: freshDests,
          enforceMatrixLimit: true,
        }),
        new SearchDeadline(seconds(120), { elapsed: () => 0 }),
      ).plan({
        destination: '目的駅',
        destinationLatLng: goal3,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 30 }),
        origin: origin3,
        originName: '出発',
      });

      const expiredDests: number[] = [];
      const expiredCalls: URL[] = [];
      await serviceWith(
        inflatedFromMock({
          guidanceCalls: expiredCalls,
          matrixDests: expiredDests,
          enforceMatrixLimit: true,
        }),
        expiringAfterFirstGuidance(expiredCalls),
      ).plan({
        destination: '目的駅',
        destinationLatLng: goal3,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 30 }),
        origin: origin3,
        originName: '出発',
      });

      expect(
        freshDests.some((c) => c > 11),
        '前提: 締切内では board-search の matrix プレ実測が走る',
      ).toBe(true);
      expect(expiredDests).not.toHaveLength(0);
      expect(
        expiredDests.every((c) => c <= 11),
        '締切切れでも board-search の matrix プレ実測を投げている',
      ).toBe(true);
    });

    it('締切内なら従来どおり引き直して徒歩最大化する', async () => {
      const calls: URL[] = [];
      const svc = serviceWith(
        inflatedFromMock({ guidanceCalls: calls }),
        new SearchDeadline(seconds(120), { elapsed: () => 0 }),
      );

      const plan = await svc.plan({
        destination: '目的駅',
        destinationLatLng: goal3,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 30 }),
        origin: origin3,
        originName: '出発',
      });

      expect(calls.length).toBeGreaterThan(1);
      expect(walkMinutesOf(plan)).toBeGreaterThan(50);
    });
  });
});

describe('plan: enrich後の乗り遅れ再検証（#137 副次）', () => {
  const origin4 = new GeoPoint(35.0, 139.0);
  const goal4 = new GeoPoint(35.0, 139.02);
  const inflate = 2;

  const twoOptions = (): JsonMap =>
    guidance([
      {
        journey: {
          departureSecs: 32400,
          arrivalSecs: 33660,
          durationSecs: 1260,
          accessWalkSecs: 300,
          egressWalkSecs: 60,
          legs: [
            railLeg({
              route: '快速A',
              fromId: 'aBoard',
              fromName: '乗車A',
              toId: 'aAlight',
              toName: '降車A',
              dep: 32760,
              arr: 33600,
            }),
          ],
        },
        map: {
          points: [],
          segments: [
            mapSeg('walk', 'origin', 'aBoard', 'osmWalk', [
              [35.0, 139.0],
              [35.0, 139.004],
            ]),
            mapSeg('transit', 'aBoard', 'aAlight', 'stopOrder', [[35.0, 139.0095]]),
            mapSeg('walk', 'aAlight', 'destination', 'estimatedWalk', [
              [35.0, 139.019],
              [35.0, 139.02],
            ]),
          ],
        },
      },
      {
        journey: {
          departureSecs: 32400,
          arrivalSecs: 33840,
          durationSecs: 1440,
          accessWalkSecs: 0,
          egressWalkSecs: 60,
          legs: [
            railLeg({
              route: '快速B',
              fromId: 'bBoard',
              fromName: '乗車B',
              toId: 'bAlight',
              toName: '降車B',
              dep: 32880,
              arr: 33780,
            }),
          ],
        },
        map: {
          points: [],
          segments: [
            mapSeg('transit', 'bBoard', 'bAlight', 'stopOrder', [[35.0, 139.0099]]),
            mapSeg('walk', 'bAlight', 'destination', 'estimatedWalk', [
              [35.0, 139.019],
              [35.0, 139.02],
            ]),
          ],
        },
      },
    ]);

  const localMock = (o: { guidanceCalls?: URL[] } = {}): HttpClient => {
    const walk = (url: URL): HttpResponse => {
      const s = pt(url.searchParams.get('start') ?? '0,0');
      const g = pt(url.searchParams.get('goal') ?? '0,0');
      return json({
        routes: [
          {
            distanceMeters: Math.round(haversineKm(s, g) * 1000),
            duration: `${walkMin(s, g) * inflate * 60}s`,
          },
        ],
      });
    };

    const matrix = (url: URL): HttpResponse => {
      const parse = (raw: string | null): GeoPoint[] =>
        (raw ?? '')
          .split(';')
          .filter((s) => s.length > 0)
          .map(pt);
      const os = parse(url.searchParams.get('origins'));
      const ds = parse(url.searchParams.get('destinations'));
      const rows: JsonMap[] = [];
      for (let i = 0; i < os.length; i++) {
        for (let j = 0; j < ds.length; j++) {
          rows.push({
            originIndex: i,
            destinationIndex: j,
            duration: `${walkMin(os[i], ds[j]) * inflate * 60}s`,
            distanceMeters: Math.round(haversineKm(os[i], ds[j]) * 1000),
          });
        }
      }
      return json(rows);
    };

    return mockClient((url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrix(url);
      if (path.includes('googleWalkProxy')) return walk(url);
      if (path.includes('guidance/plan')) {
        o.guidanceCalls?.push(url);
        return json(twoOptions());
      }
      return json({}, 404);
    });
  };

  it('締切を使い切っても実測徒歩で乗り遅れる経路は確定させない (#300)', async () => {
    const guidanceCalls: URL[] = [];
    const svc = new TransitRouteService({
      transitClient: localMock({ guidanceCalls }),
      proxyClient: localMock({ guidanceCalls }),
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      clock: () => dateTime(2026, 6, 27, 9, 0),
      deadline: new SearchDeadline(seconds(120), {
        elapsed: () => (guidanceCalls.length === 0 ? 0 : seconds(120)),
      }),
    });

    const plan = await svc.plan({
      destination: '目的地',
      destinationLatLng: goal4,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 9, m: 35 }),
      origin: origin4,
      originName: '出発',
    });

    expect(
      plan.segments.some((s) => s.type === SegmentType.train),
      '締切超過で徒歩の実測を飛ばし、実際は46分かかる全徒歩を23分と誤認して確定している',
    ).toBe(true);
  });

  it('enrich で先頭電車に乗り遅れる標準乗換は除外し、乗れる次善を返す', async () => {
    const plan = await service(localMock()).plan({
      destination: '目的地',
      destinationLatLng: goal4,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 9, m: 35 }),
      origin: origin4,
      originName: '出発',
    });
    const departureAt = dateTime(2026, 6, 27, 9, 0);
    expect(firstMissedTransit(plan.segments, departureAt)).toBeNull();
    expect(plan.segments.some((s) => s.type === SegmentType.train)).toBe(true);
    expect(plan.totalMin).toBeLessThanOrEqual(35);
  });
});

describe('plan: reject後の残り候補を1並列バッチで実測 (#315 B)', () => {
  const o = new GeoPoint(35.0, 139.0);
  const g = new GeoPoint(35.0, 139.06);
  const topBoard = [35.0, 139.013];
  const midBoard = [35.0, 139.009];
  const lowBoard = [35.0, 139.006];
  const alight = [35.0, 139.058];

  const option = (a: {
    route: string;
    board: number[];
    accessSecs: number;
    dep: number;
    arr: number;
  }): JsonMap => ({
    journey: {
      departureSecs: 32400,
      arrivalSecs: a.arr,
      durationSecs: a.arr - 32400,
      accessWalkSecs: a.accessSecs,
      egressWalkSecs: 120,
      legs: [
        railLeg({
          route: a.route,
          fromId: `${a.route}:board`,
          fromName: `乗車${a.route}`,
          toId: `${a.route}:alight`,
          toName: `降車${a.route}`,
          dep: a.dep,
          arr: a.arr,
        }),
      ],
    },
    map: {
      points: [],
      segments: [
        mapSeg('walk', 'origin', `${a.route}:board`, 'osmWalk', [[o.lat, o.lng], a.board]),
        mapSeg('transit', `${a.route}:board`, `${a.route}:alight`, 'stopOrder', [alight]),
        mapSeg('walk', `${a.route}:alight`, 'destination', 'estimatedWalk', [
          alight,
          [g.lat, g.lng],
        ]),
      ],
    },
  });

  const threeOptions = (): JsonMap =>
    guidance([
      option({
        route: '快速T',
        board: topBoard,
        accessSecs: 900,
        dep: 33360,
        arr: 34500,
      }),
      option({
        route: '快速M',
        board: midBoard,
        accessSecs: 600,
        dep: 34200,
        arr: 35100,
      }),
      option({
        route: '快速L',
        board: lowBoard,
        accessSecs: 420,
        dep: 34200,
        arr: 35400,
      }),
    ]);

  it('最上位tier が全滅したら残りの予算内候補を1バッチで並行実測する', async () => {
    const probeM = deferred<void>();
    const probeL = deferred<void>();
    const barrier = (): Promise<unknown> => Promise.all([probeM.promise, probeL.promise]);
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

    const client = mockClient(async (url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) {
        const gl = pt(url.searchParams.get('goal') ?? '0,0');
        if (near(gl.lat, midBoard[0]) && near(gl.lng, midBoard[1])) {
          if (!probeM.isCompleted) probeM.complete(undefined);
          await barrier();
        } else if (near(gl.lat, lowBoard[0]) && near(gl.lng, lowBoard[1])) {
          if (!probeL.isCompleted) probeL.complete(undefined);
          await barrier();
        }
        return walkFor(url, { factor: 2.0 });
      }
      if (path.includes('guidance/plan')) return json(threeOptions());
      return json({}, 404);
    });

    const plan = await withTimeout(
      service(client).plan({
        destination: '目的地',
        destinationLatLng: g,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 0 }),
        origin: o,
        originName: '出発',
      }),
      5000,
      () =>
        expect.fail(
          'reject 後の降下先候補が1バッチで並行実測されない（tier 直列降下でデッドロック）',
        ),
    );

    expect(probeM.isCompleted, '前提: 降下先 M の access 徒歩 enrich が発火').toBe(true);
    expect(
      probeL.isCompleted,
      '一括バッチなら徒歩最大 M が勝っても徒歩少 L も同バッチで実測される',
    ).toBe(true);
    const departureAt = dateTime(2026, 6, 27, 9, 0);
    expect(firstMissedTransit(plan.segments, departureAt)).toBeNull();
    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);
    expect(train.line, '降下先で徒歩最大の生存者 M が勝者のはず').toEqual('快速M');
    expect(plan.totalMin).toBeLessThanOrEqual(60);
  });
});

describe('plan: reject多発ルートは短リスト全体を1パスで先行実測する (#318 Option A)', () => {
  const o = new GeoPoint(35.0, 139.0);
  const g = new GeoPoint(35.0, 139.1);

  const corridor = (): number[][] => {
    const out: number[][] = [];
    for (let i = 1; i <= 8; i++) out.push([35.0, 139.0 + 0.0115 * i]);
    return out;
  };

  const baseOption = (): JsonMap =>
    guidance([
      {
        journey: {
          departureSecs: 32400,
          arrivalSecs: 33600,
          durationSecs: 1200,
          accessWalkSecs: 300,
          egressWalkSecs: 300,
          legs: [
            railLeg({
              route: '各停',
              fromId: 'c:board',
              fromName: '乗車',
              toId: 'c:alight',
              toName: '降車',
              dep: 32700,
              arr: 33600,
            }),
          ],
        },
        map: {
          points: [],
          segments: [
            mapSeg('walk', 'origin', 'c:board', 'osmWalk', [[o.lat, o.lng], first(corridor())]),
            mapSeg('transit', 'c:board', 'c:alight', 'stopOrder', corridor()),
            mapSeg('walk', 'c:alight', 'destination', 'estimatedWalk', [
              last(corridor()),
              [g.lat, g.lng],
            ]),
          ],
        },
      },
    ]);

  it('予算内ハイブリッドが閾値以上なら singlePassMeasure を立て予算内に収める', async () => {
    let captured: RouteSearchMetrics | null = null;
    const svc = service(mock({ transit: baseOption() }), {
      onMetrics: (m) => (captured = m),
    });
    const plan = await svc.plan({
      destination: '目的地',
      destinationLatLng: g,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 11, m: 0 }),
      origin: o,
      originName: '出発',
    });
    expect(
      captured!.singlePassMeasure,
      '予算内ハイブリッドが閾値以上のルートは Option A で短リスト全体を先行実測する',
    ).toBe(true);
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });

  it('標準乗換のみ（ハイブリッド無し）のルートでは発火しない', async () => {
    let captured: RouteSearchMetrics | null = null;
    const svc = service(
      mock({
        transit: guidance([
          {
            journey: {
              departureSecs: 32400,
              arrivalSecs: 33600,
              durationSecs: 1200,
              accessWalkSecs: 300,
              egressWalkSecs: 300,
              legs: [
                railLeg({
                  route: '快速',
                  fromId: 's:board',
                  fromName: '乗車',
                  toId: 's:alight',
                  toName: '降車',
                  dep: 32700,
                  arr: 33600,
                }),
              ],
            },
            map: {
              points: [],
              segments: [
                mapSeg('walk', 'origin', 's:board', 'osmWalk', [
                  [o.lat, o.lng],
                  [35.0, 139.02],
                ]),
                mapSeg('transit', 's:board', 's:alight', 'stopOrder', [[35.0, 139.08]]),
                mapSeg('walk', 's:alight', 'destination', 'estimatedWalk', [
                  [35.0, 139.08],
                  [g.lat, g.lng],
                ]),
              ],
            },
          },
        ]),
      }),
      { onMetrics: (m) => (captured = m) },
    );
    await svc.plan({
      destination: '目的地',
      destinationLatLng: g,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 11, m: 0 }),
      origin: o,
      originName: '出発',
    });
    expect(captured!.singlePassMeasure).toBe(false);
  });

  const redrawMock = (redraw: (url: URL) => Promise<HttpResponse>): HttpClient => {
    const base = mock({ transit: baseOption() });
    const fromOrigin = `geo:${dartDouble(o.lat)},${dartDouble(o.lng)}`;
    return {
      get: (url) =>
        url.pathname.includes('guidance/plan') && url.searchParams.get('from') !== fromOrigin
          ? redraw(url)
          : base.get(url),
      close: () => {},
    };
  };

  const summary = (plan: RoutePlan): unknown =>
    plan.segments.map((s) => [s.type, s.line, s.minutes]);

  it('下位の候補の引き直しが返らなくても、上位で勝者が決まれば経路を返す (#497)', async () => {
    const search = {
      destination: '目的地',
      destinationLatLng: g,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 11, m: 0 }),
      origin: o,
      originName: '出発',
    };
    const expected = await service(mock({ transit: baseOption() })).plan(search);

    let captured: RouteSearchMetrics | null = null;
    let redraws = 0;
    const svc = service(
      redrawMock(() => {
        redraws++;
        return new Promise<HttpResponse>(() => {});
      }),
      { onMetrics: (m) => (captured = m) },
    );
    const plan = await withTimeout(svc.plan(search), 3000, () =>
      expect.fail('勝者が決まっているのに、下位の候補の引き直しを待ち続けている'),
    );

    expect(redraws, '前提: 下位のハイブリッドは引き直しを発行している').toBeGreaterThan(0);
    expect(summary(plan), '待たなくても確定経路は変わらない').toEqual(summary(expected));
    expect(captured!.singlePassMeasure).toBe(true);
    expect(captured!.enrichAbandoned, '応答を待たなかった候補は引き直しを発行した本数ぶん').toBe(
      redraws,
    );
  });

  it('上位の候補の引き直しが返るまでは確定しない (#497)', async () => {
    const held: { complete: (r: HttpResponse) => void }[] = [];
    const svc = service(
      redrawMock(() => {
        const d = deferred<HttpResponse>();
        held.push(d);
        return d.promise;
      }),
    );
    let done = false;
    const planning = svc
      .plan({
        destination: '目的地',
        destinationLatLng: g,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 30 }),
        origin: o,
        originName: '出発',
      })
      .then((p) => {
        done = true;
        return p;
      });
    await delay(50);
    expect(held.length, '前提: 上位のハイブリッドが引き直しを発行している').toBeGreaterThan(0);
    expect(done, '上位が生存か棄却か分かるまで下位を勝者にしない').toBe(false);

    const release = setInterval(() => {
      for (const d of held.splice(0)) d.complete(json(baseOption()));
    }, 5);
    try {
      await withTimeout(planning, 3000, () =>
        expect.fail('引き直しを全部返しても検索が終わらない'),
      );
    } finally {
      clearInterval(release);
    }
  });
});

describe('plan: 乗車駅探索は非単調コリドーでも徒歩最大を返す（#137）', () => {
  const origin5 = new GeoPoint(35.0, 139.0);
  const goal5 = new GeoPoint(35.0, 139.2);

  const leg1Lng = [139.01, 139.02, 139.03, 139.04, 139.05, 139.07, 139.06, 139.08];
  const leg2Lng = [139.08, 139.12, 139.16, 139.2];

  const legCoords = (lngs: number[]): number[][] => lngs.map((l) => [35.0, l]);

  const baseGuidance = (leg1: number[] = leg1Lng): JsonMap =>
    guidance([
      {
        journey: {
          departureSecs: 32400,
          arrivalSecs: 33600,
          durationSecs: 1200,
          accessWalkSecs: 0,
          egressWalkSecs: 0,
          legs: [
            railLeg({
              route: '基準線A',
              fromId: 's0',
              fromName: '始発駅',
              toId: 'sT',
              toName: '乗換駅',
              dep: 32400,
              arr: 33000,
            }),
            railLeg({
              route: '基準線B',
              fromId: 'sT',
              fromName: '乗換駅',
              toId: 'sN',
              toName: '終着駅',
              dep: 33000,
              arr: 33600,
            }),
          ],
        },
        map: {
          points: [],
          segments: [
            mapSeg('transit', 's0', 'sT', 'stopOrder', legCoords(leg1)),
            mapSeg('transit', 'sT', 'sN', 'stopOrder', legCoords(leg2Lng)),
          ],
        },
      },
    ]);

  const secsOf = (hhmm: string): number => {
    const p = hhmm.split(':');
    return Number.parseInt(p[0], 10) * 3600 + Number.parseInt(p[1], 10) * 60;
  };

  const reentry = (lng: number, time: string): JsonMap => {
    const dep = secsOf(time);
    const t = Math.round(
      (haversineKm(new GeoPoint(35.0, lng), goal5) * 1000) / trainMetersPerMinute,
    );
    const arr = dep + t * 60;
    return guidance([
      {
        journey: {
          departureSecs: dep,
          arrivalSecs: arr,
          durationSecs: arr - dep,
          accessWalkSecs: 0,
          egressWalkSecs: 0,
          legs: [
            railLeg({
              route: '快速',
              fromId: 'bx',
              fromName: '乗車駅',
              toId: 'gx',
              toName: '目的駅',
              dep,
              arr,
            }),
          ],
        },
        map: {
          points: [],
          segments: [
            mapSeg('transit', 'bx', 'gx', 'stopOrder', [
              [35.0, lng],
              [35.0, 139.2],
            ]),
          ],
        },
      },
    ]);
  };

  const localMock = (leg1: number[] = leg1Lng): HttpClient =>
    mockClient((url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (path.includes('guidance/plan')) {
        const from = url.searchParams.get('from') ?? '';
        const lng = Number.parseFloat(from.replace('geo:', '').split(',')[1]);
        const time = url.searchParams.get('time') ?? '09:00';
        if (Math.abs(lng - 139.0) < 1e-6) return json(baseGuidance(leg1));
        return json(reentry(lng, time));
      }
      return json({}, 404);
    });

  const walkMinutesOf = (plan: RoutePlan): number =>
    plan.segments.filter((s) => s.type === SegmentType.walk).reduce((a, s) => a + s.minutes, 0);

  it('二分探索の境界(谷)ではなく評価済みの徒歩最大点を採る', async () => {
    const plan = await service(localMock()).plan({
      destination: '目的駅',
      destinationLatLng: goal5,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 50 }),
      origin: origin5,
      originName: '出発',
    });
    expect(walkMinutesOf(plan)).toBeGreaterThan(74);
    expect(plan.totalMin).toBeLessThanOrEqual(110);
  });

  it('boardSearchBest は探索の境界でなく評価済み予算内の最遠 index（#332 レビュー）', async () => {
    const crossingValley = [139.01, 139.02, 139.03, 139.04, 139.05, 139.13, 139.06, 139.08];

    let captured: RouteSearchMetrics | null = null;
    await service(localMock(crossingValley), {
      onMetrics: (m) => (captured = m),
    }).plan({
      destination: '目的駅',
      destinationLatLng: goal5,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 50 }),
      origin: origin5,
      originName: '出発',
    });

    expect(captured).not.toBeNull();
    expect(captured!.boardSearchActivated).toBe(true);
    expect(
      captured!.boardSearchBest,
      '打ち切り側の境界(4)ではなく、評価済み予算内の最遠(6)を採る',
    ).toBeGreaterThanOrEqual(6);
  });

  it('引き直しが上流エラーで落ちた探索は境界を確定値扱いしない（#332 レビュー）', async () => {
    const oneProbeFails = mockClient((url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (path.includes('guidance/plan')) {
        const from = url.searchParams.get('from') ?? '';
        const lng = Number.parseFloat(from.replace('geo:', '').split(',')[1]);
        if (Math.abs(lng - 139.0) < 1e-6) return json(baseGuidance());
        if (Math.abs(lng - 139.05) < 1e-6) return json({}, 500);
        const time = url.searchParams.get('time') ?? '09:00';
        return json(reentry(lng, time));
      }
      return json({}, 404);
    });

    let captured: RouteSearchMetrics | null = null;
    await service(oneProbeFails, { onMetrics: (m) => (captured = m) }).plan({
      destination: '目的駅',
      destinationLatLng: goal5,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 50 }),
      origin: origin5,
      originName: '出発',
    });

    expect(captured).not.toBeNull();
    expect(captured!.boardSearchActivated).toBe(true);
    expect(captured!.boardSearchProbeFailed).toBe(true);
    expect(captured!.boardSearchTruncated).toBe(false);
  });

  it('徒歩実測が落ちて直線推定へ縮退した探索も境界を確定値扱いしない（#332 レビュー）', async () => {
    const walkProxyDown = mockClient((url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) return json({}, 500);
      if (path.includes('guidance/plan')) {
        const from = url.searchParams.get('from') ?? '';
        const lng = Number.parseFloat(from.replace('geo:', '').split(',')[1]);
        const time = url.searchParams.get('time') ?? '09:00';
        if (Math.abs(lng - 139.0) < 1e-6) return json(baseGuidance());
        return json(reentry(lng, time));
      }
      return json({}, 404);
    });

    let captured: RouteSearchMetrics | null = null;
    await service(walkProxyDown, { onMetrics: (m) => (captured = m) }).plan({
      destination: '目的駅',
      destinationLatLng: goal5,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 50 }),
      origin: origin5,
      originName: '出発',
    });

    expect(captured).not.toBeNull();
    expect(captured!.boardSearchActivated).toBe(true);
    expect(captured!.boardSearchProbeFailed).toBe(true);
  });
});

describe('plan: 引き直しは候補群から到着最早を採る（#343）', () => {
  const origin7 = new GeoPoint(35.0, 139.0);
  const goal7 = new GeoPoint(35.0, 139.2);

  const leg1Lng = [
    139.01, 139.015, 139.02, 139.025, 139.03, 139.035, 139.04, 139.045, 139.05, 139.055, 139.06,
    139.065, 139.07, 139.075, 139.08,
  ];
  const leg2Lng = [139.08, 139.12, 139.16, 139.2];

  const legCoords = (lngs: number[]): number[][] => lngs.map((l) => [35.0, l]);

  const baseGuidance = (): JsonMap =>
    guidance([
      {
        journey: {
          departureSecs: 32400,
          arrivalSecs: 33600,
          durationSecs: 1200,
          accessWalkSecs: 0,
          egressWalkSecs: 0,
          legs: [
            railLeg({
              route: '基準線A',
              fromId: 's0',
              fromName: '基準駅',
              toId: 'sT',
              toName: '基準乗換駅',
              dep: 32400,
              arr: 33000,
            }),
            railLeg({
              route: '基準線B',
              fromId: 'sT',
              fromName: '基準乗換駅',
              toId: 'sN',
              toName: '基準終着駅',
              dep: 33000,
              arr: 33600,
            }),
          ],
        },
        map: {
          points: [],
          segments: [
            mapSeg('transit', 's0', 'sT', 'stopOrder', legCoords(leg1Lng)),
            mapSeg('transit', 'sT', 'sN', 'stopOrder', legCoords(leg2Lng)),
          ],
        },
      },
    ]);

  const secsOf = (hhmm: string): number => {
    const p = hhmm.split(':');
    return Number.parseInt(p[0], 10) * 3600 + Number.parseInt(p[1], 10) * 60;
  };

  const throughOption = (lng: number, time: string): JsonMap => {
    const dep = secsOf(time);
    const t = Math.round(
      (haversineKm(new GeoPoint(35.0, lng), goal7) * 1000) / trainMetersPerMinute,
    );
    const arr = dep + t * 60;
    return {
      journey: {
        departureSecs: dep,
        arrivalSecs: arr,
        durationSecs: arr - dep,
        accessWalkSecs: 0,
        egressWalkSecs: 0,
        legs: [
          railLeg({
            route: '快速',
            fromId: 'bx',
            fromName: '乗車駅',
            toId: 'gx',
            toName: '目的駅',
            dep,
            arr,
          }),
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('transit', 'bx', 'gx', 'stopOrder', [
            [35.0, lng],
            [35.0, 139.2],
          ]),
        ],
      },
    };
  };

  const reversedOption = (lng: number, time: string): JsonMap => {
    const dep = secsOf(time) + 600;
    const arr = dep - 300;
    return {
      journey: {
        departureSecs: dep,
        arrivalSecs: arr,
        durationSecs: 300,
        accessWalkSecs: 0,
        egressWalkSecs: 0,
        legs: [
          railLeg({
            route: '不整合線',
            fromId: 'bx',
            fromName: '乗車駅',
            toId: 'gx',
            toName: '目的駅',
            dep,
            arr,
          }),
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('transit', 'bx', 'gx', 'stopOrder', [
            [35.0, lng],
            [35.0, 139.2],
          ]),
        ],
      },
    };
  };

  const brokenConnectionOption = (lng: number, time: string): JsonMap => {
    const dep = secsOf(time);
    return {
      journey: {
        departureSecs: dep,
        arrivalSecs: dep + 420,
        durationSecs: 420,
        accessWalkSecs: 0,
        egressWalkSecs: 0,
        legs: [
          railLeg({
            route: '接続不能線1',
            fromId: 'bx',
            fromName: '乗車駅',
            toId: 'cx',
            toName: '中間駅',
            dep,
            arr: dep + 300,
          }),
          railLeg({
            route: '接続不能線2',
            fromId: 'cx',
            fromName: '中間駅',
            toId: 'gx',
            toName: '目的駅',
            dep: dep + 120,
            arr: dep + 420,
          }),
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('transit', 'bx', 'cx', 'stopOrder', [
            [35.0, lng],
            [35.0, 139.15],
          ]),
          mapSeg('transit', 'cx', 'gx', 'stopOrder', [
            [35.0, 139.15],
            [35.0, 139.2],
          ]),
        ],
      },
    };
  };

  const partialNameOption = (
    lng: number,
    time: string,
    o: {
      fromName?: string;
      toName?: string;
      delayMin?: number;
      route?: string;
      omitArrival?: boolean;
    } = {},
  ): JsonMap => {
    const fromName = o.fromName ?? '';
    const toName = o.toName ?? '';
    const dep = secsOf(time) + (o.delayMin ?? 0) * 60;
    const t = Math.round(
      (haversineKm(new GeoPoint(35.0, lng), goal7) * 1000) / trainMetersPerMinute,
    );
    const arr = dep + t * 60;
    const leg: JsonMap = {
      kind: 'transit',
      mode: 'rail',
      routeName: o.route ?? '快速',
      departureSecs: dep,
    };
    if (o.omitArrival !== true) leg['arrivalSecs'] = arr;
    if (fromName.length > 0) leg['from'] = station('bx', fromName);
    if (toName.length > 0) leg['to'] = station('gx', toName);
    return {
      journey: {
        departureSecs: dep,
        arrivalSecs: arr,
        durationSecs: arr - dep,
        accessWalkSecs: 0,
        egressWalkSecs: 0,
        legs: [leg],
      },
      map: {
        points: [],
        segments: [
          mapSeg('transit', 'bx', 'gx', 'stopOrder', [
            [35.0, lng],
            [35.0, 139.2],
          ]),
        ],
      },
    };
  };

  const negativeTransferOption = (lng: number, time: string): JsonMap => {
    const dep = secsOf(time);
    return {
      journey: {
        departureSecs: dep,
        arrivalSecs: dep + 600,
        durationSecs: 600,
        accessWalkSecs: 0,
        egressWalkSecs: 0,
        legs: [
          railLeg({
            route: '負乗換線1',
            fromId: 'bx',
            fromName: '乗車駅',
            toId: 'cx',
            toName: '中間駅',
            dep,
            arr: dep + 300,
          }),
          {
            kind: 'walk',
            from: station('cx', '中間駅'),
            to: station('cy', '中間駅2'),
            departureSecs: dep + 300,
            arrivalSecs: dep + 120,
          },
          railLeg({
            route: '負乗換線2',
            fromId: 'cy',
            fromName: '中間駅2',
            toId: 'gx',
            toName: '目的駅',
            dep: dep + 360,
            arr: dep + 600,
          }),
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('transit', 'bx', 'cx', 'stopOrder', [
            [35.0, lng],
            [35.0, 139.15],
          ]),
          mapSeg('walk', 'cx', 'cy', 'osmWalk', [
            [35.0, 139.15],
            [35.0, 139.16],
          ]),
          mapSeg('transit', 'cy', 'gx', 'stopOrder', [
            [35.0, 139.16],
            [35.0, 139.2],
          ]),
        ],
      },
    };
  };

  const staleOption = (lng: number, time: string): JsonMap => {
    const dep = secsOf(time) - 3600;
    const arr = dep + 600;
    return {
      journey: {
        departureSecs: dep,
        arrivalSecs: arr,
        durationSecs: arr - dep,
        accessWalkSecs: 0,
        egressWalkSecs: 0,
        legs: [
          railLeg({
            route: '発車済線',
            fromId: 'bx',
            fromName: '乗車駅',
            toId: 'gx',
            toName: '目的駅',
            dep,
            arr,
          }),
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('transit', 'bx', 'gx', 'stopOrder', [
            [35.0, lng],
            [35.0, 139.2],
          ]),
        ],
      },
    };
  };

  const strandedOption = (lng: number, time: string): JsonMap => {
    const dep = secsOf(time);
    const arr = dep + 600;
    return {
      journey: {
        departureSecs: dep,
        arrivalSecs: arr,
        durationSecs: arr - dep + 9960,
        accessWalkSecs: 0,
        egressWalkSecs: 9960,
        legs: [
          railLeg({
            route: '各停',
            fromId: 'bx',
            fromName: '乗車駅',
            toId: 'mx',
            toName: '取り残し駅',
            dep,
            arr,
          }),
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('transit', 'bx', 'mx', 'stopOrder', [
            [35.0, lng],
            [35.0, 139.1],
          ]),
          mapSeg('walk', 'mx', 'destination', 'estimatedWalk', [
            [35.0, 139.1],
            [35.0, 139.2],
          ]),
        ],
      },
    };
  };

  const partialTimeOption = (lng: number, time: string): JsonMap => {
    const dep = secsOf(time);
    return {
      journey: {
        departureSecs: dep,
        durationSecs: 600,
        accessWalkSecs: 0,
        egressWalkSecs: 0,
        legs: [
          {
            kind: 'transit',
            mode: 'rail',
            routeName: '到着時刻なし線',
            from: station('bx', '乗車駅'),
            to: station('gx', '目的駅'),
            departureSecs: dep,
          },
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('transit', 'bx', 'gx', 'stopOrder', [
            [35.0, lng],
            [35.0, 139.2],
          ]),
        ],
      },
    };
  };

  const laterTwinOption = (lng: number, time: string, o: { delayMin?: number } = {}): JsonMap => {
    const dep = secsOf(time) + (o.delayMin ?? 10) * 60;
    const t = Math.round(
      (haversineKm(new GeoPoint(35.0, lng), goal7) * 1000) / trainMetersPerMinute,
    );
    const arr = dep + t * 60;
    return {
      journey: {
        departureSecs: dep,
        arrivalSecs: arr,
        durationSecs: arr - dep,
        accessWalkSecs: 0,
        egressWalkSecs: 0,
        legs: [
          railLeg({
            route: '後続',
            fromId: 'bx',
            fromName: '乗車駅',
            toId: 'gx',
            toName: '目的駅',
            dep,
            arr,
          }),
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('transit', 'bx', 'gx', 'stopOrder', [
            [35.0, lng],
            [35.0, 139.2],
          ]),
        ],
      },
    };
  };

  const walkierOption = (lng: number, time: string): JsonMap => {
    const alight = new GeoPoint(35.0, 139.165);
    const dep = secsOf(time);
    const ride = Math.round(
      (haversineKm(new GeoPoint(35.0, lng), alight) * 1000) / trainMetersPerMinute,
    );
    const arr = dep + ride * 60;
    const egress = Math.round((haversineKm(alight, goal7) * 1000) / walkMetersPerMinute);
    return {
      journey: {
        departureSecs: dep,
        arrivalSecs: arr,
        durationSecs: arr - dep + egress * 60,
        accessWalkSecs: 0,
        egressWalkSecs: egress * 60,
        legs: [
          railLeg({
            route: '各停',
            fromId: 'bx',
            fromName: '乗車駅',
            toId: 'wx',
            toName: '手前駅',
            dep,
            arr,
          }),
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('transit', 'bx', 'wx', 'stopOrder', [
            [35.0, lng],
            [alight.lat, alight.lng],
          ]),
          mapSeg('walk', 'wx', 'destination', 'estimatedWalk', [
            [alight.lat, alight.lng],
            [goal7.lat, goal7.lng],
          ]),
        ],
      },
    };
  };

  const timelessOption = (lng: number): JsonMap => ({
    journey: {
      durationSecs: 600,
      accessWalkSecs: 0,
      egressWalkSecs: 0,
      legs: [
        {
          kind: 'transit',
          mode: 'rail',
          routeName: '時刻なし線',
          from: station('bx', '時刻なし乗車駅'),
          to: station('gx', '目的駅'),
        },
      ],
    },
    map: {
      points: [],
      segments: [
        mapSeg('transit', 'bx', 'gx', 'stopOrder', [
          [35.0, lng],
          [35.0, 139.2],
        ]),
      ],
    },
  });

  const localMock = (
    o: {
      poisonLng?: number;
      walkier?: boolean;
      timelessFrom?: number;
      laterTwinFirst?: boolean;
      partialTimes?: boolean;
      reversedFirst?: boolean;
      staleFrom?: number;
      brokenConnectionFrom?: number;
      negativeTransferFrom?: number;
      unnamedEarliest?: boolean;
      oneSidedNames?: boolean;
      allMalformedFrom?: number;
      namedSameLineHasNoArrival?: boolean;
    } = {},
  ): HttpClient =>
    mockClient((url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (path.includes('guidance/plan')) {
        const from = url.searchParams.get('from') ?? '';
        const lng = Number.parseFloat(from.replace('geo:', '').split(',')[1]);
        if (Math.abs(lng - 139.0) < 1e-6) return json(baseGuidance());
        const time = url.searchParams.get('time') ?? '09:00';
        const poisoned = o.poisonLng !== undefined && Math.abs(lng - o.poisonLng) < 1e-6;
        if (o.allMalformedFrom !== undefined && lng >= o.allMalformedFrom - 1e-6) {
          return json(guidance([staleOption(lng, time), reversedOption(lng, time)]));
        }
        if (o.namedSameLineHasNoArrival === true) {
          return json(
            guidance([
              partialNameOption(lng, time),
              partialNameOption(lng, time, {
                fromName: '同一路線の駅',
                toName: '同一路線の降車駅',
                delayMin: 5,
                omitArrival: true,
              }),
              partialNameOption(lng, time, {
                fromName: '別路線の駅',
                toName: '別路線の降車駅',
                delayMin: 10,
                route: '別路線',
              }),
            ]),
          );
        }
        const options: JsonMap[] = [];
        if (poisoned) options.push(strandedOption(lng, time));
        if (o.timelessFrom !== undefined && lng >= o.timelessFrom - 1e-6) {
          options.push(timelessOption(lng));
        }
        if (o.laterTwinFirst === true) options.push(laterTwinOption(lng, time));
        if (o.partialTimes === true) options.push(partialTimeOption(lng, time));
        if (o.reversedFirst === true) options.push(reversedOption(lng, time));
        if (o.staleFrom !== undefined && lng >= o.staleFrom - 1e-6) {
          options.push(staleOption(lng, time));
        }
        if (o.brokenConnectionFrom !== undefined && lng >= o.brokenConnectionFrom - 1e-6) {
          options.push(brokenConnectionOption(lng, time));
        }
        if (o.negativeTransferFrom !== undefined && lng >= o.negativeTransferFrom - 1e-6) {
          options.push(negativeTransferOption(lng, time));
        }
        if (o.unnamedEarliest === true) {
          options.push(
            partialNameOption(lng, time),
            partialNameOption(lng, time, {
              fromName: '名前つき乗車駅',
              toName: '名前つき目的駅',
              delayMin: 5,
            }),
          );
        } else if (o.oneSidedNames === true) {
          options.push(
            partialNameOption(lng, time, { toName: '着駅A' }),
            partialNameOption(lng, time, {
              fromName: '名前つき乗車駅',
              delayMin: 5,
            }),
          );
        } else {
          options.push(throughOption(lng, time));
        }
        if (o.walkier === true) options.push(walkierOption(lng, time));
        return json(guidance(options));
      }
      return json({}, 404);
    });

  const walkMinutesOf = (plan: RoutePlan): number =>
    plan.segments.filter((s) => s.type === SegmentType.walk).reduce((a, s) => a + s.minutes, 0);

  const planWith = (
    client: HttpClient,
    o: {
      onMetrics?: (m: RouteSearchMetrics) => void;
      arrival?: TimeValue;
    } = {},
  ): Promise<RoutePlan> =>
    service(client, { onMetrics: o.onMetrics }).plan({
      destination: '目的駅',
      destinationLatLng: goal7,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: o.arrival ?? new TimeValue({ h: 10, m: 50 }),
      origin: origin7,
      originName: '出発',
    });

  it('悪い便が先頭に来た地点でも探索を打ち切らず、奥の乗車駅まで歩く', async () => {
    let captured: RouteSearchMetrics | null = null;
    const plan = await planWith(localMock({ poisonLng: 139.07 }), {
      onMetrics: (m) => (captured = m),
    });

    expect(captured!.boardSearchActivated).toBe(true);
    expect(
      captured!.boardSearchBest,
      '打ち切られると index 11 で頭打ちになり、奥の3点は評価されない',
    ).toBeGreaterThanOrEqual(13);
    expect(walkMinutesOf(plan), '奥を切り捨てると徒歩は74分で頭打ちになる').toBeGreaterThan(74);
    expect(plan.totalMin).toBeLessThanOrEqual(110);
  });

  it('駅名・実時刻の引き直しも到着最早の便から採る', async () => {
    const goalNight = new GeoPoint(35.0, 139.3);
    const stops = [
      [35.0, 139.0],
      [35.0, 139.075],
      [35.0, 139.15],
      [35.0, 139.225],
      [35.0, 139.3],
    ];

    const nightOption = (a: {
      dep: number;
      arr: number;
      route: string;
      boardName: string;
      alightName: string;
    }): JsonMap => ({
      journey: {
        departureSecs: a.dep,
        arrivalSecs: a.arr,
        durationSecs: a.arr - a.dep + 120,
        accessWalkSecs: 60,
        egressWalkSecs: 60,
        legs: [
          railLeg({
            route: a.route,
            fromId: 's0',
            fromName: a.boardName,
            toId: 's1',
            toName: a.alightName,
            dep: a.dep,
            arr: a.arr,
          }),
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('walk', 'origin', 's0', 'osmWalk', [
            [35.0, 139.0],
            [35.0, 139.0],
          ]),
          mapSeg('transit', 's0', 's1', 'stopOrder', stops),
          mapSeg('walk', 's1', 'destination', 'estimatedWalk', [
            [35.0, 139.3],
            [35.0, 139.3],
          ]),
        ],
      },
    });

    const client = mockClient((url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (path.includes('guidance/plan')) {
        const time = url.searchParams.get('time') ?? '00:00';
        const hm = time.split(':');
        const secs = Number.parseInt(hm[0], 10) * 3600 + Number.parseInt(hm[1], 10) * 60;
        const dep = secs > 18000 ? secs : 18000;
        const from = url.searchParams.get('from') ?? '';
        const lng = Number.parseFloat(from.replace('geo:', '').split(',')[1]);
        const body =
          Math.abs(lng - 139.0) < 1e-6
            ? guidance([
                nightOption({
                  dep,
                  arr: dep + 1800,
                  route: '夜行線',
                  boardName: '基準駅',
                  alightName: '基準終着駅',
                }),
              ])
            : guidance([
                nightOption({
                  dep: dep + 1800,
                  arr: dep + 3600,
                  route: '各停',
                  boardName: '遅い便の駅',
                  alightName: '遅い便の降車駅',
                }),
                nightOption({
                  dep,
                  arr: dep + 1800,
                  route: '快速',
                  boardName: '最早便の駅',
                  alightName: '最早便の降車駅',
                }),
              ]);
        body['date'] = url.searchParams.get('date');
        return json(body);
      }
      return json({}, 404);
    });

    const plan = await new TransitRouteService({
      transitClient: client,
      proxyClient: client,
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      clock: () => dateTime(2026, 6, 27, 2, 0),
    }).plan({
      destination: '終着駅',
      destinationLatLng: goalNight,
      departure: new TimeValue({ h: 2, m: 0 }),
      arrival: new TimeValue({ h: 7, m: 0 }),
      origin: origin7,
      originName: '出発',
    });

    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);
    expect(train.fromName, '別経路（遅い便）の駅名を貼らない').toEqual('最早便の駅');
    expect(train.depTime).not.toBeNull();
    expect(train.depTime!.getHours()).toEqual(5);
    expect(train.depTime!.getMinutes(), '30分後発の遅い便の時刻を貼らない').toEqual(0);
  });

  it('区間の引き直しは、歩いて別駅へ回る便から時刻・駅名を採らない（レビュー指摘）', async () => {
    const goalNight = new GeoPoint(35.0, 139.3);
    const stops = [
      [35.0, 139.0],
      [35.0, 139.075],
      [35.0, 139.15],
      [35.0, 139.225],
      [35.0, 139.3],
    ];

    const nightOption = (a: {
      dep: number;
      arr: number;
      route: string;
      boardName: string;
      accessWalkSecs: number;
    }): JsonMap => ({
      journey: {
        departureSecs: a.dep,
        arrivalSecs: a.arr,
        durationSecs: a.arr - a.dep + a.accessWalkSecs + 60,
        accessWalkSecs: a.accessWalkSecs,
        egressWalkSecs: 60,
        legs: [
          railLeg({
            route: a.route,
            fromId: 's0',
            fromName: a.boardName,
            toId: 's1',
            toName: `${a.boardName}-降車`,
            dep: a.dep,
            arr: a.arr,
          }),
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('walk', 'origin', 's0', 'osmWalk', [
            [35.0, 139.0],
            [35.0, 139.0],
          ]),
          mapSeg('transit', 's0', 's1', 'stopOrder', stops),
          mapSeg('walk', 's1', 'destination', 'estimatedWalk', [
            [35.0, 139.3],
            [35.0, 139.3],
          ]),
        ],
      },
    });

    const client = mockClient((url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (path.includes('guidance/plan')) {
        const time = url.searchParams.get('time') ?? '00:00';
        const hm = time.split(':');
        const secs = Number.parseInt(hm[0], 10) * 3600 + Number.parseInt(hm[1], 10) * 60;
        const dep = secs > 18000 ? secs : 18000;
        const from = url.searchParams.get('from') ?? '';
        const lng = Number.parseFloat(from.replace('geo:', '').split(',')[1]);
        const body =
          Math.abs(lng - 139.0) < 1e-6
            ? guidance([
                nightOption({
                  dep,
                  arr: dep + 1800,
                  route: '夜行線',
                  boardName: '基準駅',
                  accessWalkSecs: 60,
                }),
              ])
            : guidance([
                nightOption({
                  dep,
                  arr: dep + 600,
                  route: '迂回快速',
                  boardName: '迂回駅',
                  accessWalkSecs: 1200,
                }),
                nightOption({
                  dep,
                  arr: dep + 1800,
                  route: '各停',
                  boardName: '区間の駅',
                  accessWalkSecs: 60,
                }),
              ]);
        body['date'] = url.searchParams.get('date');
        return json(body);
      }
      return json({}, 404);
    });

    const plan = await new TransitRouteService({
      transitClient: client,
      proxyClient: client,
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      clock: () => dateTime(2026, 6, 27, 2, 0),
    }).plan({
      destination: '終着駅',
      destinationLatLng: goalNight,
      departure: new TimeValue({ h: 2, m: 0 }),
      arrival: new TimeValue({ h: 7, m: 0 }),
      origin: origin7,
      originName: '出発',
    });

    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);
    expect(train.fromName, '迂回便の駅名を貼らない').toEqual('区間の駅');
    expect(train.minutes, '迂回便の乗車10分を貼ると、捨てた徒歩20分が所要から消える').toEqual(30);
  });

  it('区間の引き直しは、徒歩最小より先に時刻の使えない便を落とす（レビュー指摘）', async () => {
    const goalNight = new GeoPoint(35.0, 139.3);
    const stops = [
      [35.0, 139.0],
      [35.0, 139.075],
      [35.0, 139.15],
      [35.0, 139.225],
      [35.0, 139.3],
    ];

    const nightOption = (a: {
      dep: number;
      arr: number;
      route: string;
      boardName: string;
      accessWalkSecs: number;
    }): JsonMap => ({
      journey: {
        departureSecs: a.dep,
        arrivalSecs: a.arr,
        durationSecs: 1800 + a.accessWalkSecs + 60,
        accessWalkSecs: a.accessWalkSecs,
        egressWalkSecs: 60,
        legs: [
          railLeg({
            route: a.route,
            fromId: 's0',
            fromName: a.boardName,
            toId: 's1',
            toName: `${a.boardName}-降車`,
            dep: a.dep,
            arr: a.arr,
          }),
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('walk', 'origin', 's0', 'osmWalk', [
            [35.0, 139.0],
            [35.0, 139.0],
          ]),
          mapSeg('transit', 's0', 's1', 'stopOrder', stops),
          mapSeg('walk', 's1', 'destination', 'estimatedWalk', [
            [35.0, 139.3],
            [35.0, 139.3],
          ]),
        ],
      },
    });

    const client = mockClient((url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (path.includes('guidance/plan')) {
        const time = url.searchParams.get('time') ?? '00:00';
        const hm = time.split(':');
        const secs = Number.parseInt(hm[0], 10) * 3600 + Number.parseInt(hm[1], 10) * 60;
        const dep = secs > 18000 ? secs : 18000;
        const from = url.searchParams.get('from') ?? '';
        const lng = Number.parseFloat(from.replace('geo:', '').split(',')[1]);
        const body =
          Math.abs(lng - 139.0) < 1e-6
            ? guidance([
                nightOption({
                  dep,
                  arr: dep + 1800,
                  route: '夜行線',
                  boardName: '基準駅',
                  accessWalkSecs: 60,
                }),
              ])
            : guidance([
                nightOption({
                  dep,
                  arr: dep - 300,
                  route: '不整合線',
                  boardName: '不整合駅',
                  accessWalkSecs: 60,
                }),
                nightOption({
                  dep,
                  arr: dep + 1800,
                  route: '各停',
                  boardName: '整合駅',
                  accessWalkSecs: 180,
                }),
              ]);
        body['date'] = url.searchParams.get('date');
        return json(body);
      }
      return json({}, 404);
    });

    const plan = await new TransitRouteService({
      transitClient: client,
      proxyClient: client,
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      clock: () => dateTime(2026, 6, 27, 2, 0),
    }).plan({
      destination: '終着駅',
      destinationLatLng: goalNight,
      departure: new TimeValue({ h: 2, m: 0 }),
      arrival: new TimeValue({ h: 7, m: 0 }),
      origin: origin7,
      originName: '出発',
    });

    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);
    expect(train.fromName, '徒歩最小でも時刻が使えない便は採らない').toEqual('整合駅');
    expect(train.depTime).not.toBeNull();
    expect(
      train.arrTime!.getTime() < train.depTime!.getTime(),
      '到着が発車より前の時刻を区間へ貼ってはならない',
    ).toBe(false);
  });

  it('区間の引き直しは、同じ駅間を走る別路線の時刻を貼らない（レビュー指摘）', async () => {
    const goalNight = new GeoPoint(35.0, 139.3);
    const stops = [
      [35.0, 139.0],
      [35.0, 139.075],
      [35.0, 139.15],
      [35.0, 139.225],
      [35.0, 139.3],
    ];

    const nightOption = (a: {
      dep: number;
      arr: number;
      route: string;
      boardName: string;
    }): JsonMap => ({
      journey: {
        departureSecs: a.dep,
        arrivalSecs: a.arr,
        durationSecs: a.arr - a.dep + 120,
        accessWalkSecs: 60,
        egressWalkSecs: 60,
        legs: [
          railLeg({
            route: a.route,
            fromId: 's0',
            fromName: a.boardName,
            toId: 's1',
            toName: `${a.boardName}-降車`,
            dep: a.dep,
            arr: a.arr,
          }),
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('walk', 'origin', 's0', 'osmWalk', [
            [35.0, 139.0],
            [35.0, 139.0],
          ]),
          mapSeg('transit', 's0', 's1', 'stopOrder', stops),
          mapSeg('walk', 's1', 'destination', 'estimatedWalk', [
            [35.0, 139.3],
            [35.0, 139.3],
          ]),
        ],
      },
    });

    const client = mockClient((url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (path.includes('guidance/plan')) {
        const time = url.searchParams.get('time') ?? '00:00';
        const hm = time.split(':');
        const secs = Number.parseInt(hm[0], 10) * 3600 + Number.parseInt(hm[1], 10) * 60;
        const dep = secs > 18000 ? secs : 18000;
        const from = url.searchParams.get('from') ?? '';
        const lng = Number.parseFloat(from.replace('geo:', '').split(',')[1]);
        const body =
          Math.abs(lng - 139.0) < 1e-6
            ? guidance([
                nightOption({
                  dep,
                  arr: dep + 1800,
                  route: '夜行線',
                  boardName: '基準駅',
                }),
              ])
            : guidance([
                nightOption({
                  dep,
                  arr: dep + 600,
                  route: '別路線',
                  boardName: '別路線の駅',
                }),
                nightOption({
                  dep,
                  arr: dep + 1800,
                  route: '夜行線',
                  boardName: '同一路線の駅',
                }),
              ]);
        body['date'] = url.searchParams.get('date');
        return json(body);
      }
      return json({}, 404);
    });

    const plan = await new TransitRouteService({
      transitClient: client,
      proxyClient: client,
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      clock: () => dateTime(2026, 6, 27, 2, 0),
    }).plan({
      destination: '終着駅',
      destinationLatLng: goalNight,
      departure: new TimeValue({ h: 2, m: 0 }),
      arrival: new TimeValue({ h: 7, m: 0 }),
      origin: origin7,
      originName: '出発',
    });

    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);
    expect(train.fromName, '別路線の乗車駅を貼らない').toEqual('同一路線の駅');
    expect(
      train.minutes,
      '路線名は元のままなので、別路線の10分を貼ると表示と中身が食い違う',
    ).toEqual(30);
  });

  it('区間の引き直しは、乗換を含む便を直通の1区間として貼らない（レビュー指摘）', async () => {
    const goalNight = new GeoPoint(35.0, 139.3);
    const stops = [
      [35.0, 139.0],
      [35.0, 139.075],
      [35.0, 139.15],
      [35.0, 139.225],
      [35.0, 139.3],
    ];

    const baseSegs = (): JsonMap => ({
      points: [],
      segments: [
        mapSeg('walk', 'origin', 's0', 'osmWalk', [
          [35.0, 139.0],
          [35.0, 139.0],
        ]),
        mapSeg('transit', 's0', 's1', 'stopOrder', stops),
        mapSeg('walk', 's1', 'destination', 'estimatedWalk', [
          [35.0, 139.3],
          [35.0, 139.3],
        ]),
      ],
    });

    const singleLeg = (a: {
      dep: number;
      arr: number;
      route: string;
      boardName: string;
    }): JsonMap => ({
      journey: {
        departureSecs: a.dep,
        arrivalSecs: a.arr,
        durationSecs: a.arr - a.dep + 120,
        accessWalkSecs: 60,
        egressWalkSecs: 60,
        legs: [
          railLeg({
            route: a.route,
            fromId: 's0',
            fromName: a.boardName,
            toId: 's1',
            toName: `${a.boardName}-降車`,
            dep: a.dep,
            arr: a.arr,
          }),
        ],
      },
      map: baseSegs(),
    });

    const twoLegs = (dep: number): JsonMap => ({
      journey: {
        departureSecs: dep,
        arrivalSecs: dep + 1200,
        durationSecs: 1320,
        accessWalkSecs: 60,
        egressWalkSecs: 60,
        legs: [
          railLeg({
            route: '乗換線1',
            fromId: 's0',
            fromName: '乗換便の駅',
            toId: 'sc',
            toName: '中間駅',
            dep,
            arr: dep + 600,
          }),
          railLeg({
            route: '乗換線2',
            fromId: 'sc',
            fromName: '中間駅',
            toId: 's1',
            toName: '乗換便の降車駅',
            dep: dep + 600,
            arr: dep + 1200,
          }),
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('walk', 'origin', 's0', 'osmWalk', [
            [35.0, 139.0],
            [35.0, 139.0],
          ]),
          mapSeg('transit', 's0', 'sc', 'stopOrder', [
            [35.0, 139.0],
            [35.0, 139.15],
          ]),
          mapSeg('transit', 'sc', 's1', 'stopOrder', [
            [35.0, 139.15],
            [35.0, 139.3],
          ]),
          mapSeg('walk', 's1', 'destination', 'estimatedWalk', [
            [35.0, 139.3],
            [35.0, 139.3],
          ]),
        ],
      },
    });

    const client = mockClient((url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (path.includes('guidance/plan')) {
        const time = url.searchParams.get('time') ?? '00:00';
        const hm = time.split(':');
        const secs = Number.parseInt(hm[0], 10) * 3600 + Number.parseInt(hm[1], 10) * 60;
        const dep = secs > 18000 ? secs : 18000;
        const from = url.searchParams.get('from') ?? '';
        const lng = Number.parseFloat(from.replace('geo:', '').split(',')[1]);
        const body =
          Math.abs(lng - 139.0) < 1e-6
            ? guidance([
                singleLeg({
                  dep,
                  arr: dep + 1800,
                  route: '夜行線',
                  boardName: '基準駅',
                }),
              ])
            : guidance([
                twoLegs(dep),
                singleLeg({
                  dep,
                  arr: dep + 1800,
                  route: '各停',
                  boardName: '直通の駅',
                }),
              ]);
        body['date'] = url.searchParams.get('date');
        return json(body);
      }
      return json({}, 404);
    });

    const plan = await new TransitRouteService({
      transitClient: client,
      proxyClient: client,
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      clock: () => dateTime(2026, 6, 27, 2, 0),
    }).plan({
      destination: '終着駅',
      destinationLatLng: goalNight,
      departure: new TimeValue({ h: 2, m: 0 }),
      arrival: new TimeValue({ h: 7, m: 0 }),
      origin: origin7,
      originName: '出発',
    });

    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);
    expect(train.fromName, '乗換便の乗車駅を直通区間へ貼らない').toEqual('直通の駅');
    expect(train.minutes, '乗換待ちと2本目の乗車を含む20分を直通の所要として貼らない').toEqual(30);
  });

  it('予算内に収まる範囲では到着最早でなく徒歩の多い便を候補にする（レビュー指摘）', async () => {
    const plan = await planWith(localMock({ walkier: true }), {
      arrival: new TimeValue({ h: 11, m: 20 }),
    });
    expect(
      walkMinutesOf(plan),
      '到着最早で潰すと乗り通し（徒歩91分以下）で確定してしまう',
    ).toBeGreaterThan(100);
    expect(plan.totalMin).toBeLessThanOrEqual(140);
  });

  it('時刻を欠く便は到着最早の比較で最速に化けさせない（レビュー指摘）', async () => {
    const plan = await planWith(localMock({ timelessFrom: 139.06 }));
    expect(
      walkMinutesOf(plan),
      '時刻なし便を採ると奥の地点が確定できず手前へ落ちる',
    ).toBeGreaterThan(74);
    expect(plan.totalMin).toBeLessThanOrEqual(110);
  });

  it('徒歩が並んだ便は上流の並び順でなく到着最早で決める（レビュー指摘）', async () => {
    const plan = await planWith(localMock({ laterTwinFirst: true }), {
      arrival: new TimeValue({ h: 11, m: 20 }),
    });
    expect(plan.totalMin, '上流順で残すと10分後発の双子が確定し、到着がその分遅れる').toBeLessThan(
      120,
    );
  });

  it('到着時刻を欠く便も到着最早の比較で最速に化けさせない（レビュー指摘）', async () => {
    const plan = await planWith(localMock({ partialTimes: true }));
    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);

    expect(train.arrTime, '到着時刻の無い便を確定してはならない').not.toBeNull();
    expect(train.minutes, '所要0分の便を採ると乗車時間が到着へ入らない').toBeGreaterThan(0);
    expect(plan.totalMin).toBeLessThanOrEqual(110);
  });

  it('到着が発車より前の壊れた便を比較に混ぜない（レビュー指摘）', async () => {
    const plan = await planWith(localMock({ reversedFirst: true }));
    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);

    expect(train.minutes, '所要が負の便を確定してはならない').toBeGreaterThan(0);
    expect(
      plan.totalMin,
      '到着が徒歩の合計を下回るのは時間が巻き戻っている',
    ).toBeGreaterThanOrEqual(walkMinutesOf(plan));
  });

  it('照会時刻より前に発車済みの便を比較に混ぜない（レビュー指摘）', async () => {
    const plan = await planWith(localMock({ staleFrom: 139.06 }));
    expect(
      walkMinutesOf(plan),
      '発車済みの便を掴むと奥の地点が確定できず手前へ落ちる',
    ).toBeGreaterThan(74);
    expect(plan.totalMin).toBeLessThanOrEqual(110);
  });

  it('区間をまたいで乗り継げない便を比較に混ぜない（レビュー指摘）', async () => {
    const plan = await planWith(localMock({ brokenConnectionFrom: 139.06 }));
    expect(
      walkMinutesOf(plan),
      '乗り継げない便を掴むと奥の地点が確定できず手前へ落ちる',
    ).toBeGreaterThan(74);
    expect(
      firstMissedTransit(plan.segments, dateTime(2026, 6, 27, 9, 0)),
      '乗り継げない便を確定してはならない',
    ).toBeNull();
  });

  it('乗換徒歩の所要が負の便を比較に混ぜない（レビュー指摘）', async () => {
    let captured: RouteSearchMetrics | null = null;
    const plan = await planWith(localMock({ negativeTransferFrom: 139.08 }), {
      onMetrics: (m) => (captured = m),
    });
    expect(
      captured!.boardSearchBest,
      '予算外の 14/15 を予算内と誤判定すると境界が 15 まで伸びる',
    ).toEqual(13);
    expect(
      plan.segments.every((s) => s.minutes >= 0),
      '所要が負の区間を確定経路に出してはならない',
    ).toBe(true);
    expect(plan.totalMin).toBeLessThanOrEqual(110);
  });

  it('駅名復元の引き直しは、名前を持つ便を優先する（レビュー指摘）', async () => {
    const plan = await planWith(localMock({ unnamedEarliest: true }));
    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);

    expect(train.fromName, '名前の無い便を採ると駅名が空のまま残る').toEqual('名前つき乗車駅');
    expect(plan.totalMin).toBeLessThanOrEqual(110);
  });

  it('駅名復元は、欠けている側を埋められる便を採る（レビュー指摘）', async () => {
    const plan = await planWith(localMock({ oneSidedNames: true }));
    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);

    expect(train.fromName, '欠けている乗車地名を埋められる便を採るべき').toEqual('名前つき乗車駅');
    expect(train.toName, '既に埋まっている側は上書きしない').toEqual('着駅A');
  });

  it('壊れた便しか無い地点では、それらを並べて選び直さない（レビュー指摘）', async () => {
    const plan = await planWith(localMock({ allMalformedFrom: 139.06 }));
    expect(
      plan.segments.every((s) => s.minutes >= 0),
      '壊れた候補群を到着で並べ替えると負の所要の便が勝つ',
    ).toBe(true);
  });

  it('駅名復元は時刻の欠落で候補を捨てない（レビュー指摘）', async () => {
    const plan = await planWith(localMock({ namedSameLineHasNoArrival: true }));
    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);

    expect(
      train.fromName,
      '時刻を欠くだけの同一路線の便を、駅名の候補から外してはならない',
    ).toEqual('同一路線の駅');
    expect(train.arrTime, '駅名を借りても、区間の時刻は時刻の揃った便のまま').not.toBeNull();
  });

  it('上流が1本しか返さない地点でも従来どおり徒歩最大へ収束する', async () => {
    const plan = await planWith(localMock());
    expect(walkMinutesOf(plan)).toBeGreaterThan(74);
    expect(plan.totalMin).toBeLessThanOrEqual(110);
  });
});

describe('plan: 時刻なしハイブリッドの実発車時刻検証（approach A・深夜の幽霊便対策）', () => {
  const origin6 = new GeoPoint(35.0, 139.0);
  const goal6 = new GeoPoint(35.0, 139.3);

  const nightMock = (
    o: {
      firstTrainSecs?: number;
      rideSecs?: number;
      delay?: number;
      breakWalk?: (url: URL) => boolean;
    } = {},
  ): HttpClient => {
    const firstTrainSecs = o.firstTrainSecs ?? 18000;
    const rideSecs = o.rideSecs ?? 1800;
    const optionFor = (reqSecs: number): JsonMap => {
      const dep = reqSecs > firstTrainSecs ? reqSecs : firstTrainSecs;
      const arr = dep + rideSecs;
      const stops = [
        [35.0, 139.0],
        [35.0, 139.075],
        [35.0, 139.15],
        [35.0, 139.225],
        [35.0, 139.3],
      ];
      return {
        journey: {
          departureSecs: dep,
          arrivalSecs: arr,
          durationSecs: arr - dep + 120,
          accessWalkSecs: 60,
          egressWalkSecs: 60,
          legs: [
            railLeg({
              route: '夜行線',
              fromId: 's0',
              fromName: '始発駅',
              toId: 's1',
              toName: '終着駅',
              dep,
              arr,
            }),
          ],
        },
        map: {
          points: [],
          segments: [
            mapSeg('walk', 'origin', 's0', 'osmWalk', [
              [35.0, 139.0],
              [35.0, 139.0],
            ]),
            mapSeg('transit', 's0', 's1', 'stopOrder', stops),
            mapSeg('walk', 's1', 'destination', 'estimatedWalk', [
              [35.0, 139.3],
              [35.0, 139.3],
            ]),
          ],
        },
      };
    };

    return mockClient(async (url) => {
      if (o.delay !== undefined) await delay(o.delay);
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) {
        if (o.breakWalk?.(url) ?? false) {
          return json({ routes: 3 });
        }
        return walkFor(url);
      }
      if (path.includes('guidance/plan')) {
        const time = url.searchParams.get('time') ?? '00:00';
        const hm = time.split(':');
        const secs = Number.parseInt(hm[0], 10) * 3600 + Number.parseInt(hm[1], 10) * 60;
        const body = guidance([optionFor(secs)]);
        body['date'] = url.searchParams.get('date');
        return json(body);
      }
      return json({}, 404);
    });
  };

  const nightService = (
    client: HttpClient,
    onMetrics?: (m: RouteSearchMetrics) => void,
  ): TransitRouteService =>
    new TransitRouteService({
      transitClient: client,
      proxyClient: client,
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      clock: () => dateTime(2026, 6, 27, 2, 0),
      onMetrics,
    });

  it('固定応答で確定経路・上流への要求・計測が変わらない: best-effort 縮退（#486）', async () => {
    expect(
      await characterize(nightMock(), (client, onMetrics) =>
        nightService(client, onMetrics).plan({
          destination: '終着駅',
          destinationLatLng: goal6,
          departure: new TimeValue({ h: 2, m: 0 }),
          arrival: new TimeValue({ h: 2, m: 50 }),
          origin: origin6,
          originName: '出発',
        }),
      ),
    ).toMatchSnapshot();
  });

  it('固定応答で確定経路・上流への要求・計測が変わらない: 時刻なしハイブリッドの実時刻検証（#486）', async () => {
    expect(
      await characterize(nightMock(), (client, onMetrics) =>
        nightService(client, onMetrics).plan({
          destination: '終着駅',
          destinationLatLng: goal6,
          departure: new TimeValue({ h: 2, m: 0 }),
          arrival: new TimeValue({ h: 7, m: 0 }),
          origin: origin6,
          originName: '出発',
        }),
      ),
    ).toMatchSnapshot();
  });

  it('深夜のハイブリッドは始発05:00の実発車時刻が当たり乗車待ちが到着へ入る', async () => {
    const plan = await nightService(nightMock()).plan({
      destination: '終着駅',
      destinationLatLng: goal6,
      departure: new TimeValue({ h: 2, m: 0 }),
      arrival: new TimeValue({ h: 7, m: 0 }),
      origin: origin6,
      originName: '出発',
    });
    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);
    expect(train.depTime, '実発車時刻が当たるべき').not.toBeNull();
    expect(train.depTime!.getHours(), '02:00出発でも始発05:00より前には乗れない').toEqual(5);
    expect(plan.totalMin).toBeGreaterThanOrEqual(180);
  });

  it('縮退はプール全体を解決し、それを bestEffort* が計上する（測定口の外）', async () => {
    let captured: RouteSearchMetrics | null = null;
    const client = nightMock({ delay: 2 });
    await new TransitRouteService({
      transitClient: client,
      proxyClient: client,
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      clock: () => dateTime(2026, 6, 27, 2, 0),
      onMetrics: (m) => (captured = m),
    }).plan({
      destination: '終着駅',
      destinationLatLng: goal6,
      departure: new TimeValue({ h: 2, m: 0 }),
      arrival: new TimeValue({ h: 2, m: 50 }),
      origin: origin6,
      originName: '出発',
    });
    const m = captured!;
    expect(m.bestEffortEntries, '前提: 縮退へ落ちる').toBeGreaterThan(0);
    expect(m.bestEffortCandidates).toBeGreaterThan(0);
    expect(m.bestEffortMs).toBeGreaterThan(0);
  });

  it('A/B 計測 (#462): A が縮退へ落ちても、B は A の実時刻解決を引き直さない', async () => {
    const guidanceCalls = async (exactWalkMaxAb: boolean) => {
      const log: URL[] = [];
      const night = nightMock();
      const client: HttpClient = {
        get: (url) => {
          log.push(url);
          return night.get(url);
        },
        close: () => night.close(),
      };
      let captured: RouteSearchMetrics | null = null;
      await new TransitRouteService({
        transitClient: client,
        proxyClient: client,
        transitBaseUrl: transitBase,
        proxyBaseUrl: proxyBase,
        clock: () => dateTime(2026, 6, 27, 2, 0),
        exactWalkMaxAb,
        onMetrics: (m) => (captured = m),
      }).plan({
        destination: '終着駅',
        destinationLatLng: goal6,
        departure: new TimeValue({ h: 2, m: 0 }),
        arrival: new TimeValue({ h: 2, m: 50 }),
        origin: origin6,
        originName: '出発',
      });
      return {
        calls: log.filter((u) => u.pathname.includes('guidance/plan')).length,
        m: captured!,
      };
    };
    const plain = await guidanceCalls(false);
    const ab = await guidanceCalls(true);
    expect(plain.m.bestEffortEntries, '前提: 縮退へ落ちる').toBeGreaterThan(0);
    expect(ab.calls).toEqual(plain.calls);
    expect(ab.m.walkB).toEqual(ab.m.walkA);
  });

  it('A/B 計測 (#462): A の縮退で落ちた徒歩実測を、B が引き直さない', async () => {
    const walkRequests = async (exactWalkMaxAb: boolean): Promise<number> => {
      let walks = 0;
      const night = nightMock();
      const client: HttpClient = {
        get: (url) => {
          if (url.pathname.includes('googleWalkProxy') && walks++ === 0) {
            return Promise.resolve(json({}, 429));
          }
          return night.get(url);
        },
        close: () => night.close(),
      };
      let captured: RouteSearchMetrics | null = null;
      await new TransitRouteService({
        transitClient: client,
        proxyClient: client,
        transitBaseUrl: transitBase,
        proxyBaseUrl: proxyBase,
        clock: () => dateTime(2026, 6, 27, 2, 0),
        exactWalkMaxAb,
        onMetrics: (m) => (captured = m),
      }).plan({
        destination: '終着駅',
        destinationLatLng: goal6,
        departure: new TimeValue({ h: 2, m: 0 }),
        arrival: new TimeValue({ h: 2, m: 50 }),
        origin: origin6,
        originName: '出発',
      });
      expect(captured!.bestEffortEntries, '前提: 縮退へ落ちる').toBeGreaterThan(0);
      return walks;
    };
    const plain = await walkRequests(false);
    expect(plain, '前提: 縮退の徒歩実測が走る').toBeGreaterThan(0);
    expect(await walkRequests(true)).toEqual(plain);
  });

  it('実測が例外で落ちた候補も enrich 台帳へ計上する (#309)', async () => {
    const run = async (
      o: { breakWalk?: (url: URL) => boolean } = {},
    ): Promise<RouteSearchMetrics> => {
      let captured: RouteSearchMetrics | null = null;
      const client = nightMock({ delay: 2, breakWalk: o.breakWalk });
      await new TransitRouteService({
        transitClient: client,
        proxyClient: client,
        transitBaseUrl: transitBase,
        proxyBaseUrl: proxyBase,
        clock: () => dateTime(2026, 6, 27, 2, 0),
        onMetrics: (m) => (captured = m),
      }).plan({
        destination: '終着駅',
        destinationLatLng: goal6,
        departure: new TimeValue({ h: 2, m: 0 }),
        arrival: new TimeValue({ h: 7, m: 0 }),
        origin: origin6,
        originName: '出発',
      });
      return captured!;
    };

    const healthy = await run();
    const broken = await run({
      breakWalk: (url) => {
        const legs = [url.searchParams.get('start') ?? '', url.searchParams.get('goal') ?? ''].join(
          ' ',
        );
        return legs.includes('139.075') || legs.includes('139.15');
      },
    });
    expect(healthy.enrichCandidates, '前提: 実測している').toBeGreaterThan(0);
    expect(broken.enrichCandidates, '例外で落ちた候補も測定の幅に数える').toBeGreaterThanOrEqual(
      healthy.enrichCandidates,
    );
    expect(broken.enrichCriticalMs, '払った壁時計を計上する').toBeGreaterThan(0);
  });

  it('時刻なし区間の引き直しを enrichResolveDepth が段数として数える', async () => {
    let captured: RouteSearchMetrics | null = null;
    const client = nightMock({ delay: 2 });
    await new TransitRouteService({
      transitClient: client,
      proxyClient: client,
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      clock: () => dateTime(2026, 6, 27, 2, 0),
      onMetrics: (m) => (captured = m),
    }).plan({
      destination: '終着駅',
      destinationLatLng: goal6,
      departure: new TimeValue({ h: 2, m: 0 }),
      arrival: new TimeValue({ h: 7, m: 0 }),
      origin: origin6,
      originName: '出発',
    });
    expect(captured!.enrichResolveDepth).toBeGreaterThan(0);
    expect(captured!.enrichCandidates).toBeGreaterThan(0);
    expect(captured!.enrichCriticalMs).toBeGreaterThan(0);
  });

  it('予算外で best-effort へ落ちても始発前の幻バス便を提示しない', async () => {
    const plan = await nightService(nightMock()).plan({
      destination: '終着駅',
      destinationLatLng: goal6,
      departure: new TimeValue({ h: 2, m: 0 }),
      arrival: new TimeValue({ h: 2, m: 50 }),
      origin: origin6,
      originName: '出発',
    });
    const ghostTrains = plan.segments.filter(
      (s) => s.type === SegmentType.train && s.depTime === null,
    );
    expect(ghostTrains, '時刻なしの幻電車を提示してはならない').toHaveLength(0);
  });

  const localOrigin = new GeoPoint(35.0, 139.0);
  const localGoal = new GeoPoint(35.0, 139.127);

  const nightMockNoReentryTrain = (o: { firstTrainSecs?: number } = {}): HttpClient => {
    const firstTrainSecs = o.firstTrainSecs ?? 18000;
    const stops = [
      [35.0, 139.027],
      [35.0, 139.05],
      [35.0, 139.075],
      [35.0, 139.1],
    ];
    const trainBase = (reqSecs: number): JsonMap => {
      const dep = reqSecs > firstTrainSecs ? reqSecs : firstTrainSecs;
      const arr = dep + 1800;
      return {
        journey: {
          departureSecs: dep,
          arrivalSecs: arr,
          durationSecs: arr - dep + 120,
          accessWalkSecs: 60,
          egressWalkSecs: 60,
          legs: [
            railLeg({
              route: '夜行線',
              fromId: 's0',
              fromName: '始発駅',
              toId: 's1',
              toName: '終着駅',
              dep,
              arr,
            }),
          ],
        },
        map: {
          points: [],
          segments: [
            mapSeg('walk', 'origin', 's0', 'osmWalk', [
              [35.0, 139.0],
              [35.0, 139.027],
            ]),
            mapSeg('transit', 's0', 's1', 'stopOrder', stops),
            mapSeg('walk', 's1', 'destination', 'estimatedWalk', [
              [35.0, 139.1],
              [35.0, 139.127],
            ]),
          ],
        },
      };
    };

    const walkOnly = (): JsonMap => ({
      journey: {
        departureSecs: 0,
        arrivalSecs: 600,
        durationSecs: 600,
        legs: [{ kind: 'walk', departureSecs: 0, arrivalSecs: 600 }],
      },
      map: {
        points: [],
        segments: [
          mapSeg('walk', 'a', 'b', 'osmWalk', [
            [35.0, 139.1],
            [35.0, 139.2],
          ]),
        ],
      },
    });

    return mockClient((url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (path.includes('guidance/plan')) {
        const from = url.searchParams.get('from') ?? '';
        const lng = Number.parseFloat(from.replace('geo:', '').split(',')[1]);
        const time = url.searchParams.get('time') ?? '00:00';
        const hm = time.split(':');
        const secs = Number.parseInt(hm[0], 10) * 3600 + Number.parseInt(hm[1], 10) * 60;
        const body =
          Math.abs(lng - 139.0) < 1e-6 ? guidance([trainBase(secs)]) : guidance([walkOnly()]);
        body['date'] = url.searchParams.get('date');
        return json(body);
      }
      return json({}, 404);
    });
  };

  it('引き直しで電車便を確認できない時刻なし電車は best-effort に出さない', async () => {
    const plan = await nightService(nightMockNoReentryTrain()).plan({
      destination: '終着駅',
      destinationLatLng: localGoal,
      departure: new TimeValue({ h: 2, m: 0 }),
      arrival: new TimeValue({ h: 2, m: 50 }),
      origin: localOrigin,
      originName: '出発',
    });
    const ghostTrains = plan.segments.filter(
      (s) => s.type === SegmentType.train && s.depTime === null,
    );
    expect(ghostTrains, '実時刻を確認できない時刻なし電車を提示してはならない').toHaveLength(0);
  });

  it('予算内に見えても引き直しで便を確認できない時刻なし電車は確定しない', async () => {
    const plan = await nightService(nightMockNoReentryTrain()).plan({
      destination: '終着駅',
      destinationLatLng: localGoal,
      departure: new TimeValue({ h: 2, m: 0 }),
      arrival: new TimeValue({ h: 4, m: 30 }),
      origin: localOrigin,
      originName: '出発',
    });
    const ghostTrains = plan.segments.filter(
      (s) => s.type === SegmentType.train && s.depTime === null,
    );
    expect(ghostTrains, '予算内でも未確認の時刻なし電車を確定してはならない').toHaveLength(0);
  });
});

describe('plan: バス last-resort 再照会 (#250)', () => {
  const busOrigin = new GeoPoint(35.0, 139.0);
  const busGoal = new GeoPoint(35.0, 139.127);

  const slowTrainOption = (): JsonMap => {
    const stops = [
      [35.0, 139.027],
      [35.0, 139.05],
      [35.0, 139.075],
      [35.0, 139.1],
    ];
    return {
      journey: {
        departureSecs: 35400,
        arrivalSecs: 37200,
        durationSecs: 1920,
        accessWalkSecs: 60,
        egressWalkSecs: 60,
        legs: [
          railLeg({
            route: '各停線',
            fromId: 's0',
            fromName: '始発駅',
            toId: 's1',
            toName: '終着駅',
            dep: 35400,
            arr: 37200,
          }),
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('walk', 'origin', 's0', 'osmWalk', [
            [35.0, 139.0],
            [35.0, 139.027],
          ]),
          mapSeg('transit', 's0', 's1', 'stopOrder', stops),
          mapSeg('walk', 's1', 'destination', 'estimatedWalk', [
            [35.0, 139.1],
            [35.0, 139.127],
          ]),
        ],
      },
    };
  };

  const busOption = (o: { dep?: number | null; arr?: number | null } = {}): JsonMap => {
    const dep = o.dep === undefined ? 32700 : o.dep;
    const arr = o.arr === undefined ? 34500 : o.arr;
    const leg: JsonMap = {
      kind: 'transit',
      mode: 'bus',
      routeName: '渋谷01',
      from: station('bs:0', 'A停留所'),
      to: station('bs:1', 'B停留所'),
    };
    if (dep !== null) leg['departureSecs'] = dep;
    if (arr !== null) leg['arrivalSecs'] = arr;
    return {
      journey: {
        departureSecs: dep ?? 0,
        arrivalSecs: arr ?? 0,
        durationSecs: 1800,
        accessWalkSecs: 0,
        egressWalkSecs: 0,
        legs: [leg],
      },
      map: {
        points: [],
        segments: [
          mapSeg('transit', 'bs:0', 'bs:1', 'gtfsShape', [
            [35.0, 139.0],
            [35.0, 139.127],
          ]),
        ],
      },
    };
  };

  const corridorTrainOption = (lng: number): JsonMap => ({
    journey: {
      departureSecs: 33000,
      arrivalSecs: 33600,
      durationSecs: 600,
      accessWalkSecs: 0,
      egressWalkSecs: 0,
      legs: [
        railLeg({
          route: '各停線',
          fromId: 'c0',
          fromName: '途中駅',
          toId: 'c1',
          toName: '終着駅',
          dep: 33000,
          arr: 33600,
        }),
      ],
    },
    map: {
      points: [],
      segments: [
        mapSeg('transit', 'c0', 'c1', 'stopOrder', [
          [35.0, lng],
          [35.0, 139.127],
        ]),
      ],
    },
  });

  const missedTrainOption = (): JsonMap => ({
    journey: {
      departureSecs: 33600,
      arrivalSecs: 34200,
      durationSecs: 660,
      accessWalkSecs: 60,
      egressWalkSecs: 0,
      legs: [
        railLeg({
          route: '各停線',
          fromId: 's0',
          fromName: '始発駅',
          toId: 's1',
          toName: '終着駅',
          dep: 33600,
          arr: 34200,
        }),
      ],
    },
    map: {
      points: [],
      segments: [
        mapSeg('walk', 'origin', 's0', 'osmWalk', [
          [35.0, 139.0],
          [35.0, 139.027],
        ]),
        mapSeg('transit', 's0', 's1', 'stopOrder', [
          [35.0, 139.027],
          [35.0, 139.127],
        ]),
      ],
    },
  });

  const walkOnlyOption = (): JsonMap => ({
    journey: {
      departureSecs: 0,
      arrivalSecs: 600,
      durationSecs: 600,
      legs: [{ kind: 'walk', departureSecs: 0, arrivalSecs: 600 }],
    },
    map: {
      points: [],
      segments: [
        mapSeg('walk', 'a', 'b', 'osmWalk', [
          [35.0, 139.1],
          [35.0, 139.2],
        ]),
      ],
    },
  });

  const busMock = (a: {
    busOption: JsonMap;
    originOption?: JsonMap;
    corridorOption?: (lng: number) => JsonMap;
    log?: URL[];
    busDelay?: number;
    corridorDelay?: number;
    corridorFailsFirst?: boolean;
  }): HttpClient => {
    const corridorSeen = new Set<string>();
    return mockClient(async (url) => {
      a.log?.push(url);
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (path.includes('guidance/plan')) {
        const allowsBus = !(url.searchParams.get('avoidModes') ?? '').includes('bus');
        const from = url.searchParams.get('from') ?? '';
        const lng = Number.parseFloat(from.replace('geo:', '').split(',')[1]);
        const fromOrigin = Math.abs(lng - 139.0) < 1e-6;
        if (allowsBus && (a.busDelay ?? 0) > 0) await delay(a.busDelay!);
        if (!allowsBus && !fromOrigin && (a.corridorFailsFirst ?? false)) {
          if (!corridorSeen.has(url.href)) {
            corridorSeen.add(url.href);
            return json({}, 503);
          }
        }
        if (!allowsBus && !fromOrigin && (a.corridorDelay ?? 0) > 0) {
          await delay(a.corridorDelay!);
        }
        const body = allowsBus
          ? guidance([a.busOption])
          : guidance([
              fromOrigin
                ? (a.originOption ?? slowTrainOption())
                : (a.corridorOption?.(lng) ?? walkOnlyOption()),
            ]);
        body['date'] = url.searchParams.get('date');
        return json(body);
      }
      return json({}, 404);
    });
  };

  it('バス照会を縮退プール解決と並行に発行し、直列の段を消す', async () => {
    let captured: RouteSearchMetrics | null = null;
    const svc = service(
      busMock({
        busOption: busOption(),
        originOption: missedTrainOption(),
        busDelay: 60,
        corridorDelay: 200,
        corridorFailsFirst: true,
      }),
      { onMetrics: (m) => (captured = m) },
    );
    const plan = await svc.plan({
      destination: '目的地',
      destinationLatLng: busGoal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 0 }),
      origin: busOrigin,
    });
    expect(
      plan.segments.filter((s) => s.type === SegmentType.bus),
      '前提: バスが採用される（LastResortBus.adopt が await される）',
    ).not.toHaveLength(0);
    expect(
      captured!.busLastResortMs,
      '投機発行が間に合っていれば残りの直列待ちはほぼ 0（直列なら 60ms 前後）',
    ).toBeLessThan(30);
  });

  it('電車が予算内なら バス許容照会は一度も発行しない（速度不変）', async () => {
    const log: URL[] = [];
    const svc = service(
      mock({
        transit: guidance([singleTrainOption({ dep: 33300, arr: 35100 })]),
        log,
      }),
    );
    const plan = await svc.plan({
      destination: '新宿',
      destinationLatLng: goal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 9, m: 50 }),
      origin,
    });
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
    expect(
      firstMissedTransit(plan.segments, dateTime(2026, 6, 27, 9, 0)),
      '前提: 実際に乗れる電車で予算内に収まっている',
    ).toBeNull();
    const busQueries = log.filter(
      (u) =>
        u.pathname.includes('guidance/plan') &&
        !(u.searchParams.get('avoidModes') ?? '').includes('bus'),
    );
    expect(busQueries, '予算内なら再照会してはならない').toHaveLength(0);
  });

  it('電車が予算外でもバスなら間に合うとき、バス候補を提示する', async () => {
    const svc = service(busMock({ busOption: busOption() }));
    const plan = await svc.plan({
      destination: '目的地',
      destinationLatLng: busGoal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 0 }),
      origin: busOrigin,
    });
    const bus = firstWhere(plan.segments, (s) => s.type === SegmentType.bus);
    expect(bus.line).toEqual('渋谷01');
    expect(bus.depTime).toEqual(dateTime(2026, 6, 27, 9, 5));
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });

  it('時刻を持たないバス便は幽霊バスとして提示しない', async () => {
    const svc = service(busMock({ busOption: busOption({ dep: null, arr: null }) }));
    const plan = await svc.plan({
      destination: '目的地',
      destinationLatLng: busGoal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 0 }),
      origin: busOrigin,
    });
    const ghostBuses = plan.segments.filter(
      (s) => s.type === SegmentType.bus && s.depTime === null,
    );
    expect(ghostBuses, '時刻なしの幽霊バスを提示してはならない').toHaveLength(0);
  });

  it('乗車待ちが予算を超えるバスは best-effort でも選ばれない', async () => {
    const svc = service(busMock({ busOption: busOption({ dep: 36300, arr: 36900 }) }));
    const plan = await svc.plan({
      destination: '目的地',
      destinationLatLng: busGoal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 0 }),
      origin: busOrigin,
    });
    expect(
      plan.segments.filter((s) => s.type === SegmentType.bus),
      '今夜（今日）乗れないバスを提示してはならない',
    ).toHaveLength(0);
  });

  it('固定応答で確定経路・上流への要求・計測が変わらない: last-resort のバス採用（#486）', async () => {
    expect(
      await characterize(busMock({ busOption: busOption() }), (client, onMetrics) =>
        service(client, { onMetrics }).plan({
          destination: '目的地',
          destinationLatLng: busGoal,
          departure: new TimeValue({ h: 9, m: 0 }),
          arrival: new TimeValue({ h: 10, m: 0 }),
          origin: busOrigin,
        }),
      ),
    ).toMatchSnapshot();
  });

  it('固定応答で確定経路・上流への要求・計測が変わらない: バス採用後の崩壊と board-search（#486）', async () => {
    expect(
      await characterize(
        busMock({ busOption: busOption(), corridorOption: corridorTrainOption }),
        (client, onMetrics) =>
          service(client, { onMetrics }).plan({
            destination: '目的地',
            destinationLatLng: busGoal,
            departure: new TimeValue({ h: 9, m: 0 }),
            arrival: new TimeValue({ h: 10, m: 0 }),
            origin: busOrigin,
          }),
      ),
    ).toMatchSnapshot();
  });

  it('固定応答で確定経路・上流への要求・計測が変わらない: 乗り遅れる best-effort からのバス（#486）', async () => {
    expect(
      await characterize(
        busMock({ busOption: busOption(), originOption: missedTrainOption() }),
        (client, onMetrics) =>
          service(client, { onMetrics }).plan({
            destination: '目的地',
            destinationLatLng: busGoal,
            departure: new TimeValue({ h: 9, m: 0 }),
            arrival: new TimeValue({ h: 10, m: 0 }),
            origin: busOrigin,
          }),
      ),
    ).toMatchSnapshot();
  });

  it('collapse→board-search が全滅してもバス候補を取り下げない', async () => {
    const svc = service(
      busMock({
        busOption: busOption(),
        corridorOption: corridorTrainOption,
      }),
    );
    const plan = await svc.plan({
      destination: '目的地',
      destinationLatLng: busGoal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 0 }),
      origin: busOrigin,
    });
    expect(
      plan.segments.filter((s) => s.type === SegmentType.bus),
      'board-search が全滅したら last-resort のバスへ戻るべき',
    ).not.toHaveLength(0);
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });

  it('best-effort が予算内でも乗り遅れならバスを引く', async () => {
    const svc = service(busMock({ busOption: busOption(), originOption: missedTrainOption() }));
    const plan = await svc.plan({
      destination: '目的地',
      destinationLatLng: busGoal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 0 }),
      origin: busOrigin,
    });
    expect(
      plan.segments.filter((s) => s.type === SegmentType.bus),
      '乗り遅れる電車しか無いならバスを引くべき',
    ).not.toHaveLength(0);
    expect(
      firstMissedTransit(plan.segments, dateTime(2026, 6, 27, 9, 0)),
      '乗り遅れる便を確定してはならない',
    ).toBeNull();
  });
});

describe('plan: バス corridor の徒歩最大化 (#251)', () => {
  const busOrigin = new GeoPoint(35.0, 139.0);
  const busGoal = new GeoPoint(35.0, 139.127);
  const bs0 = 139.012;
  const corridor = [bs0, 139.05, 139.09, 139.11, 139.127];
  const busDep = 33300;

  const detourLat = 35.02;

  const rideMin = (a: GeoPoint, b: GeoPoint, metersPerMinute?: number): number =>
    Math.round((haversineKm(a, b) * 1000) / (metersPerMinute ?? trainMetersPerMinute));

  const slowTrainOption = (): JsonMap => ({
    journey: {
      departureSecs: 35400,
      arrivalSecs: 37200,
      durationSecs: 1920,
      accessWalkSecs: 0,
      egressWalkSecs: 60,
      legs: [
        railLeg({
          route: '各停線',
          fromId: 's0',
          fromName: '始発駅',
          toId: 's1',
          toName: '終着駅',
          dep: 35400,
          arr: 37200,
        }),
      ],
    },
    map: {
      points: [],
      segments: [
        mapSeg('transit', 's0', 's1', 'stopOrder', [
          [35.0, 139.0],
          [35.0, 139.1],
        ]),
        mapSeg('walk', 's1', 'destination', 'estimatedWalk', [
          [35.0, 139.1],
          [35.0, 139.127],
        ]),
      ],
    },
  });

  const busDoorToDoor = (): JsonMap => ({
    journey: {
      departureSecs: busDep,
      arrivalSecs: busDep + rideMin(new GeoPoint(35.0, bs0), busGoal) * 60,
      durationSecs: 2160,
      accessWalkSecs: 840,
      egressWalkSecs: 0,
      legs: [
        {
          kind: 'transit',
          mode: 'bus',
          routeName: 'バス01',
          from: station('bs:0', 'A停留所'),
          to: station('bs:1', 'B停留所'),
          departureSecs: busDep,
          arrivalSecs: busDep + rideMin(new GeoPoint(35.0, bs0), busGoal) * 60,
        },
      ],
    },
    map: {
      points: [],
      segments: [
        mapSeg('walk', 'origin', 'bs:0', 'osmWalk', [
          [35.0, 139.0],
          [35.0, bs0],
        ]),
        mapSeg(
          'transit',
          'bs:0',
          'bs:1',
          'gtfsShape',
          corridor.map((lng) => [35.0, lng]),
        ),
      ],
    },
  });

  const detourBus = (): JsonMap => ({
    journey: {
      departureSecs: busDep,
      arrivalSecs: busDep + 960,
      durationSecs: 960,
      accessWalkSecs: 0,
      egressWalkSecs: 0,
      legs: [
        {
          kind: 'transit',
          mode: 'bus',
          routeName: 'バス02',
          from: station('bs:n0', 'N停留所'),
          to: station('bs:n1', 'M停留所'),
          departureSecs: busDep,
          arrivalSecs: busDep + 960,
        },
      ],
    },
    map: {
      points: [],
      segments: [
        mapSeg('transit', 'bs:n0', 'bs:n1', 'gtfsShape', [
          [35.0, 139.0],
          [detourLat, 139.06],
          [35.0, 139.127],
        ]),
      ],
    },
  });

  const busLegFrom = (
    from: GeoPoint,
    to: GeoPoint,
    at: Date,
    o: { busSpeed?: number } = {},
  ): JsonMap => {
    const atSecs = at.getHours() * 3600 + at.getMinutes() * 60;
    const dep = atSecs <= busDep ? busDep : atSecs + 300;
    const arr = dep + rideMin(from, to, o.busSpeed) * 60;
    return {
      journey: {
        departureSecs: dep,
        arrivalSecs: arr,
        durationSecs: arr - dep,
        accessWalkSecs: 0,
        egressWalkSecs: 0,
        legs: [
          {
            kind: 'transit',
            mode: 'bus',
            routeName: 'バス01',
            from: station('bs:x', 'X停留所'),
            to: station('bs:y', 'Y停留所'),
            departureSecs: dep,
            arrivalSecs: arr,
          },
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('transit', 'bs:x', 'bs:y', 'gtfsShape', [
            [from.lat, from.lng],
            [to.lat, to.lng],
          ]),
        ],
      },
    };
  };

  const trainThenBusFrom = (from: GeoPoint, to: GeoPoint, at: Date): JsonMap => {
    const atSecs = at.getHours() * 3600 + at.getMinutes() * 60;
    const mid = new GeoPoint(from.lat, (from.lng + to.lng) / 2);
    return {
      journey: {
        departureSecs: atSecs,
        arrivalSecs: atSecs + 300,
        durationSecs: 300,
        accessWalkSecs: 0,
        egressWalkSecs: 0,
        legs: [
          railLeg({
            route: '特急線',
            fromId: 'mx:0',
            fromName: 'P駅',
            toId: 'mx:1',
            toName: 'Q駅',
            dep: atSecs,
            arr: atSecs + 120,
          }),
          {
            kind: 'transit',
            mode: 'bus',
            routeName: 'バス09',
            from: station('bs:m', 'M停留所'),
            to: station('bs:n', 'N停留所'),
            departureSecs: atSecs + 180,
            arrivalSecs: atSecs + 300,
          },
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('transit', 'mx:0', 'mx:1', 'stopOrder', [
            [from.lat, from.lng],
            [mid.lat, mid.lng],
          ]),
          mapSeg('transit', 'bs:m', 'bs:n', 'gtfsShape', [
            [mid.lat, mid.lng],
            [to.lat, to.lng],
          ]),
        ],
      },
    };
  };

  const walkOnlyOption = (): JsonMap => ({
    journey: {
      departureSecs: 0,
      arrivalSecs: 600,
      durationSecs: 600,
      legs: [{ kind: 'walk', departureSecs: 0, arrivalSecs: 600 }],
    },
    map: {
      points: [],
      segments: [
        mapSeg('walk', 'a', 'b', 'osmWalk', [
          [35.0, 139.1],
          [35.0, 139.2],
        ]),
      ],
    },
  });

  const corridorMock = (
    o: {
      log?: URL[];
      withDetourBus?: boolean;
      withMixedTrainBus?: boolean;
      busSpeed?: number;
    } = {},
  ): HttpClient =>
    mockClient((url) => {
      o.log?.push(url);
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (path.includes('guidance/plan')) {
        const q = url.searchParams;
        const allowsBus = !(q.get('avoidModes') ?? '').includes('bus');
        const from = pt((q.get('from') ?? '').replace('geo:', ''));
        const to = pt((q.get('to') ?? '').replace('geo:', ''));
        const hm = (q.get('time') ?? '09:00').split(':');
        const at = dateTime(2026, 6, 27, Number.parseInt(hm[0], 10), Number.parseInt(hm[1], 10));
        const fromOrigin =
          Math.abs(from.lat - busOrigin.lat) < 1e-9 && Math.abs(from.lng - busOrigin.lng) < 1e-9;
        const options: JsonMap[] = [];
        if (allowsBus) {
          if (fromOrigin) {
            options.push(busDoorToDoor());
            if (o.withDetourBus === true) options.push(detourBus());
          } else {
            if (o.withMixedTrainBus === true && Math.abs(to.lng - busGoal.lng) > 1e-9) {
              options.push(trainThenBusFrom(from, to, at));
            }
            options.push(busLegFrom(from, to, at, { busSpeed: o.busSpeed }));
          }
        } else if (fromOrigin) {
          options.push(slowTrainOption());
        } else {
          options.push(walkOnlyOption());
        }
        const body = guidance(options);
        body['date'] = q.get('date');
        return json(body);
      }
      return json({}, 404);
    });

  const corridorBusQueries = (log: URL[]): URL[] =>
    log.filter(
      (u) =>
        u.pathname.includes('guidance/plan') &&
        !(u.searchParams.get('avoidModes') ?? '').includes('bus') &&
        u.searchParams.get('from') !==
          `geo:${dartDouble(busOrigin.lat)},${dartDouble(busOrigin.lng)}`,
    );

  const runPlan = (client: HttpClient): Promise<RoutePlan> =>
    service(client).plan({
      destination: '目的地',
      destinationLatLng: busGoal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 5 }),
      origin: busOrigin,
    });

  it('バス区間の引き直しは電車混じりの早着便から時刻・停留所名を採らない（レビュー指摘）', async () => {
    const plan = await runPlan(corridorMock({ withMixedTrainBus: true }));
    const bus = firstWhere(plan.segments, (s) => s.type === SegmentType.bus);

    expect(bus.fromName, '混合便のバス停名（M停留所）を貼ってはならない').toEqual('X停留所');
    expect(bus.depTime, 'バスのみの便から実発車時刻が当たるべき').not.toBeNull();
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });

  it('バスが last-resort で勝つとき、手前のバス停で降りて歩く候補を選ぶ', async () => {
    const plan = await runPlan(corridorMock());
    const walkMinutes = plan.segments
      .filter((s) => s.type === SegmentType.walk)
      .reduce((a, s) => a + s.minutes, 0);

    expect(
      plan.segments.filter((s) => s.type === SegmentType.bus),
      'last-resort のバスは残る',
    ).not.toHaveLength(0);
    expect(last(plan.segments).type, '手前のバス停で降りて goal まで歩く').toEqual(
      SegmentType.walk,
    );
    expect(
      last(plan.segments).minutes,
      '降車後の徒歩が0分ならバスに乗り通している',
    ).toBeGreaterThan(0);
    expect(walkMinutes, 'door-to-door バス（徒歩14分）より歩く候補を選ぶべき').toBeGreaterThan(14);
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });

  it('バス corridor 起点の引き直しはバスを許容する', async () => {
    const log: URL[] = [];
    await runPlan(corridorMock({ log }));
    expect(
      corridorBusQueries(log),
      'origin 以外（バス停）を起点にバス許容で引き直しているはず',
    ).not.toHaveLength(0);
  });

  it('基準にするのは最短のバス option ではなく徒歩最大化で勝ったバス option', async () => {
    const log: URL[] = [];
    const plan = await runPlan(corridorMock({ log, withDetourBus: true }));

    const fromDetour = corridorBusQueries(log).filter((u) =>
      (u.searchParams.get('from') ?? '').startsWith(`geo:${dartDouble(detourLat)},`),
    );
    expect(fromDetour, '勝者でない迂回バスの corridor を基準にしてはならない').toHaveLength(0);
    const fromWinner = corridorBusQueries(log).filter((u) =>
      (u.searchParams.get('from') ?? '').startsWith('geo:35.0,'),
    );
    expect(fromWinner, '勝ったバス option の corridor 上のバス停から引き直すはず').not.toHaveLength(
      0,
    );
    expect(
      last(plan.segments).type,
      '勝者 corridor で徒歩最大化できているので手前で降りて歩く',
    ).toEqual(SegmentType.walk);
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });

  it('バスの実ダイヤが見積りより遅ければ ハイブリッドは実時刻検証で落ち乗り通しへ戻る', async () => {
    const plan = await runPlan(corridorMock({ busSpeed: trainMetersPerMinute / 2 }));
    const walkMinutes = plan.segments
      .filter((s) => s.type === SegmentType.walk)
      .reduce((a, s) => a + s.minutes, 0);

    expect(last(plan.segments).type, '乗り通しへ戻る').toEqual(SegmentType.bus);
    expect(walkMinutes, 'door-to-door バスのアクセス徒歩そのもの').toEqual(14);
    expect(plan.totalMin, '遅いハイブリッドを掴んで予算超過してはならない').toBeLessThanOrEqual(
      plan.budgetMin,
    );
  });

  it('電車が予算内なら バス corridor 化は起きずバス許容照会も出ない', async () => {
    const log: URL[] = [];
    const svc = service(
      mock({
        transit: guidance([singleTrainOption({ dep: 33300, arr: 35100 })]),
        log,
      }),
    );
    const plan = await svc.plan({
      destination: '新宿',
      destinationLatLng: goal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 9, m: 50 }),
      origin,
    });
    expect(plan.segments.filter((s) => s.type === SegmentType.bus)).toHaveLength(0);
    const busAware = log.filter(
      (u) =>
        u.pathname.includes('guidance/plan') &&
        !(u.searchParams.get('avoidModes') ?? '').includes('bus'),
    );
    expect(busAware, '電車 corridor の引き直しはバスを除外したまま').toHaveLength(0);
  });
});

describe('plan: 確定境界の乗り遅れ再判定 (#254)', () => {
  const departureAt = dateTime(2026, 6, 27, 9, 0);

  it('best-effort 縮退は実測徒歩で乗り遅れる経路を確定しない', async () => {
    const svc = service(mock({ transit: guidance([singleTrainOption()]) }));
    const plan = await svc.plan({
      destination: '新宿',
      destinationLatLng: goal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 9, m: 50 }),
      origin,
    });
    expect(
      firstMissedTransit(plan.segments, departureAt),
      '実測徒歩で発車後に駅着する便を best-effort で確定してはならない',
    ).toBeNull();
  });

  const twoStopOption = (): JsonMap => {
    const stops = [
      [35.6812, 139.7671],
      [35.6909, 139.7003],
    ];
    return {
      journey: {
        departureSecs: 32760,
        arrivalSecs: 34560,
        durationSecs: 2400,
        accessWalkSecs: 300,
        egressWalkSecs: 60,
        legs: [
          railLeg({
            route: '中央線快速',
            fromId: 'jr:Tokyo',
            fromName: '東京',
            toId: 'jr:Shinjuku',
            toName: '新宿',
            dep: 32760,
            arr: 34560,
          }),
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('walk', 'origin', 'jr:Tokyo', 'osmWalk', [[35.68, 139.76], stops[0]]),
          mapSeg('transit', 'jr:Tokyo', 'jr:Shinjuku', 'stopOrder', stops),
          mapSeg('walk', 'jr:Shinjuku', 'destination', 'estimatedWalk', [
            stops[stops.length - 1],
            [35.69, 139.7],
          ]),
        ],
      },
    };
  };

  it('プールが1件に痩せても enrich 実測の乗り遅れを素通りさせない', async () => {
    const svc = service(mock({ transit: guidance([twoStopOption()]), walkFactor: 1.3 }));
    const plan = await svc.plan({
      destination: '新宿',
      destinationLatLng: goal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 15 }),
      origin,
    });
    expect(
      firstMissedTransit(plan.segments, departureAt),
      'プールが1件でも乗り遅れる便を確定してはならない',
    ).toBeNull();
  });

  it('乗り遅れ候補が試行上限より多くても全徒歩まで縮退しきる', async () => {
    const options: JsonMap[] = [];
    for (let i = 0; i < 9; i++) {
      options.push(singleTrainOption({ arr: 34560 + i * 60 }));
    }
    const svc = service(mock({ transit: guidance(options) }));
    const plan = await svc.plan({
      destination: '新宿',
      destinationLatLng: goal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 9, m: 50 }),
      origin,
    });
    expect(
      firstMissedTransit(plan.segments, departureAt),
      '乗り遅れ候補を数で押しても乗れない便を確定してはならない',
    ).toBeNull();
    expect(
      plan.segments.every((s) => s.type === SegmentType.walk),
      '乗れる電車が1本も無いのだから全徒歩へ縮退するはず',
    ).toBe(true);
  });
});

describe('plan: 崩壊見込みの board-search を enrich と並行に起動する (#341)', () => {
  const origin4 = new GeoPoint(35.0, 139.0);
  const goal4 = new GeoPoint(35.0, 139.5);

  const geoOf = (raw: string | null): GeoPoint => pt((raw ?? '0,0').replace('geo:', ''));
  const same = (a: GeoPoint, b: GeoPoint): boolean =>
    Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lng - b.lng) < 1e-6;

  const trackingMock = (
    o: {
      onEnrichWalk?: () => Promise<void>;
      onBoardProbe?: (url: URL) => Promise<void>;
      walkFactor?: number;
    } = {},
  ): HttpClient => {
    const walkFactor = o.walkFactor ?? 3;
    const parse = (raw: string | null): GeoPoint[] =>
      (raw ?? '')
        .split(';')
        .filter((s) => s.length > 0)
        .map(pt);
    const transit = collapseGuidance();
    return mockClient(async (url) => {
      const path = url.pathname;
      const q = url.searchParams;
      if (path.includes('googleWalkMatrixProxy')) {
        const os = parse(q.get('origins'));
        const ds = parse(q.get('destinations'));
        const rows: JsonMap[] = [];
        for (let i = 0; i < os.length; i++) {
          for (let j = 0; j < ds.length; j++) {
            rows.push({
              originIndex: i,
              destinationIndex: j,
              duration: `${walkMin(os[i], ds[j]) * 3 * 60}s`,
              distanceMeters: Math.round(haversineKm(os[i], ds[j]) * 1000),
            });
          }
        }
        return json(rows);
      }
      if (path.includes('googleWalkProxy')) {
        if (!same(pt(q.get('start') ?? '0,0'), origin4) && o.onEnrichWalk !== undefined) {
          await o.onEnrichWalk();
        }
        return walkFor(url, { factor: walkFactor });
      }
      if (!path.includes('guidance/plan')) return json({}, 404);
      if (
        !same(geoOf(q.get('from')), origin4) &&
        same(geoOf(q.get('to')), goal4) &&
        o.onBoardProbe !== undefined
      ) {
        await o.onBoardProbe(url);
      }
      return json(transit);
    });
  };

  const planWith = (
    client: HttpClient,
    o: { onMetrics?: (m: RouteSearchMetrics) => void } = {},
  ): Promise<RoutePlan> =>
    service(client, { onMetrics: o.onMetrics }).plan({
      destination: '降車駅',
      destinationLatLng: goal4,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 0 }),
      origin: origin4,
      originName: '出発',
    });

  it('board-search の引き直しと enrich の徒歩実測が同時に上流へ到達する', async () => {
    const enrichWalk = deferred<void>();
    const boardProbe = deferred<void>();
    const barrier = (): Promise<void> =>
      Promise.all([enrichWalk.promise, boardProbe.promise]).then(() => undefined);
    const earlyRedraws: URL[] = [];

    await withTimeout(
      planWith(
        trackingMock({
          onEnrichWalk: () => {
            if (!enrichWalk.isCompleted) enrichWalk.complete(undefined);
            return barrier();
          },
          onBoardProbe: (url) => {
            earlyRedraws.push(url);
            if (!boardProbe.isCompleted) boardProbe.complete(undefined);
            return barrier();
          },
        }),
      ),
      5000,
      () => expect.fail('board-search の引き直しが enrich の完了を待っている（直列）'),
    );

    expect(enrichWalk.isCompleted, '前提: enrich の徒歩実測が走る').toBe(true);
    expect(boardProbe.isCompleted, '前提: board-search が引き直す').toBe(true);
    for (const u of earlyRedraws) {
      expect(
        u.searchParams.get('avoidModes') ?? '',
        'バス系 board-search は勝者確定後のまま（busBase は enrich 依存）',
      ).toContain('bus');
    }
  });

  it('崩壊すれば投機の結果を使い、徒歩最大化は実測の境界で決まる', async () => {
    let captured: RouteSearchMetrics | null = null;
    const plan = await planWith(trackingMock(), {
      onMetrics: (m) => (captured = m),
    });
    const m = captured!;
    expect(m.boardSearchSpeculated, '前提: 投機経路を通っている').toBe(true);
    expect(m.collapseFired, '前提: 崩壊して board-search を使う').toBe(true);
    expect(m.boardSearchActivated).toBe(true);
    expect(m.boardSearchSpeculationWasted, '当たった投機は空振りでない').toBe(false);
    expect(m.boardSearchProbeFailed, '境界が実測で決まっていない').toBe(false);
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });

  it('固定応答で確定経路・上流への要求・計測が変わらない: 投機した board-search が当たる崩壊（#486）', async () => {
    expect(
      await characterize(trackingMock(), (client, onMetrics) => planWith(client, { onMetrics })),
    ).toMatchSnapshot();
  });

  it('固定応答で確定経路・計測が変わらない: 投機した board-search の空振り（#486）', async () => {
    expect(
      await characterize(
        trackingMock({ walkFactor: 20 }),
        (client, onMetrics) => planWith(client, { onMetrics }),
        { timingDependent: ['requests', 'boardSearchSpeculationProbes'] },
      ),
    ).toMatchSnapshot();
  });

  it('崩壊しなければ結果を捨て、空振りを probe 本数で計上する', async () => {
    const firstProbe = deferred<void>();
    let captured: RouteSearchMetrics | null = null;
    await withTimeout(
      planWith(
        trackingMock({
          walkFactor: 20,
          onEnrichWalk: () => firstProbe.promise,
          onBoardProbe: async () => {
            if (!firstProbe.isCompleted) firstProbe.complete(undefined);
          },
        }),
        { onMetrics: (m) => (captured = m) },
      ),
      5000,
      () => expect.fail('崩壊が見込まれるのに board-search を投機起動していない'),
    );

    const m = captured!;
    expect(m.boardSearchSpeculated, '前提: 見積りでは崩壊が見込まれる').toBe(true);
    expect(m.collapseFired, '前提: 実測後は崩壊が成立しない').toBe(false);
    expect(
      m.boardSearchActivated,
      '捨てた投機を board-search 起動に数えると本体の発火率が読めなくなる',
    ).toBe(false);
    expect(m.boardSearchSpeculationWasted).toBe(true);
    expect(
      m.boardSearchSpeculationProbes,
      '空振りの対価（上流へ打ち上げた往復本数）が計上されていない',
    ).toBeGreaterThan(0);
  });

  it('投機中のキャンセルを握り潰さず plan ごと落とす', async () => {
    await expectThrowsA(
      () =>
        planWith(
          trackingMock({
            onBoardProbe: async () => {
              throw new SearchCanceledException();
            },
          }),
        ),
      SearchCanceledException,
    );
  });
});

describe('plan: 独立IOの並列化 (#304)', () => {
  it('崩壊時の電車/バス2系統 board-search は並列に照会する', async () => {
    const o = new GeoPoint(35.0, 139.0);
    const g = new GeoPoint(35.0, 139.127);
    const trainLat = 35.0;
    const busLat = 35.001;
    const trainCorridorLngs = [139.02, 139.05, 139.08, 139.1];
    const busCorridorLngs = [139.012, 139.05, 139.09, 139.127];
    const busRideMin = Math.round(
      (haversineKm(new GeoPoint(busLat, 139.012), new GeoPoint(busLat, 139.127)) * 1000) /
        trainMetersPerMinute,
    );

    const slowTrainOption = (): JsonMap => ({
      journey: {
        departureSecs: 35400,
        arrivalSecs: 37200,
        durationSecs: 1920,
        accessWalkSecs: 60,
        egressWalkSecs: 60,
        legs: [
          railLeg({
            route: '各停線',
            fromId: 's0',
            fromName: '始発駅',
            toId: 's1',
            toName: '終着駅',
            dep: 35400,
            arr: 37200,
          }),
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('walk', 'origin', 's0', 'osmWalk', [
            [35.0, 139.0],
            [trainLat, 139.02],
          ]),
          mapSeg(
            'transit',
            's0',
            's1',
            'stopOrder',
            trainCorridorLngs.map((lng) => [trainLat, lng]),
          ),
          mapSeg('walk', 's1', 'destination', 'estimatedWalk', [
            [trainLat, 139.1],
            [35.0, 139.127],
          ]),
        ],
      },
    });

    const busDoorToDoor = (): JsonMap => ({
      journey: {
        departureSecs: 33300,
        arrivalSecs: 33300 + busRideMin * 60,
        durationSecs: 840 + busRideMin * 60 + 60,
        accessWalkSecs: 840,
        egressWalkSecs: 60,
        legs: [
          {
            kind: 'transit',
            mode: 'bus',
            routeName: 'バス01',
            from: station('bs:0', 'A停留所'),
            to: station('bs:1', 'B停留所'),
            departureSecs: 33300,
            arrivalSecs: 33300 + busRideMin * 60,
          },
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('walk', 'origin', 'bs:0', 'osmWalk', [
            [35.0, 139.0],
            [busLat, 139.012],
          ]),
          mapSeg(
            'transit',
            'bs:0',
            'bs:1',
            'gtfsShape',
            busCorridorLngs.map((lng) => [busLat, lng]),
          ),
          mapSeg('walk', 'bs:1', 'destination', 'estimatedWalk', [
            [busLat, 139.127],
            [35.0, 139.127],
          ]),
        ],
      },
    });

    const walkOnlyOption = (): JsonMap => ({
      journey: {
        departureSecs: 0,
        arrivalSecs: 600,
        durationSecs: 600,
        legs: [{ kind: 'walk', departureSecs: 0, arrivalSecs: 600 }],
      },
      map: {
        points: [],
        segments: [
          mapSeg('walk', 'a', 'b', 'osmWalk', [
            [35.0, 139.1],
            [35.0, 139.2],
          ]),
        ],
      },
    });

    const trainProbe = deferred<void>();
    const busProbe = deferred<void>();
    const barrier = (): Promise<void> =>
      Promise.all([trainProbe.promise, busProbe.promise]).then(() => undefined);
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

    const client = mockClient(async (url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (!path.includes('guidance/plan')) return json({}, 404);
      const q = url.searchParams;
      const allowsBus = !(q.get('avoidModes') ?? '').includes('bus');
      const from = (q.get('from') ?? '').replace('geo:', '').split(',');
      const to = (q.get('to') ?? '').replace('geo:', '').split(',');
      const fromLat = Number.parseFloat(from[0]);
      const fromLng = Number.parseFloat(from[1]);
      const fromOrigin = near(fromLat, o.lat) && near(fromLng, o.lng);
      const toGoal = near(Number.parseFloat(to[0]), g.lat) && near(Number.parseFloat(to[1]), g.lng);
      let body: JsonMap;
      if (fromOrigin) {
        body = guidance([allowsBus ? busDoorToDoor() : slowTrainOption()]);
      } else if (toGoal && !allowsBus && near(fromLat, trainLat)) {
        if (!trainProbe.isCompleted) trainProbe.complete(undefined);
        await barrier();
        body = guidance([walkOnlyOption()]);
      } else if (toGoal && allowsBus && near(fromLat, busLat)) {
        if (!busProbe.isCompleted) busProbe.complete(undefined);
        await barrier();
        body = guidance([walkOnlyOption()]);
      } else {
        body = guidance([walkOnlyOption()]);
      }
      body['date'] = q.get('date');
      return json(body);
    });

    const plan = await withTimeout(
      service(client).plan({
        destination: '目的地',
        destinationLatLng: g,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 0 }),
        origin: o,
        originName: '出発',
      }),
      5000,
      () =>
        expect.fail('電車系とバス系の board-search 照会が同時到達しない（逐次実行でデッドロック）'),
    );

    expect(trainProbe.isCompleted, '前提: 電車系 board-search が発火').toBe(true);
    expect(busProbe.isCompleted, '前提: バス系 board-search が発火').toBe(true);
    const bus = firstWhere(plan.segments, (s) => s.type === SegmentType.bus);
    expect(bus.line).toEqual('バス01');
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });

  it('_finalizeStationNames は未命名 transit 区間を並列に照会する', async () => {
    const o = new GeoPoint(35.68, 139.76);
    const g = new GeoPoint(35.69, 139.7);
    const a1 = [35.6812, 139.7671];
    const a2 = [35.686, 139.735];
    const a3 = [35.6909, 139.7003];

    const unnamedTwoLegOption = (): JsonMap => ({
      journey: {
        departureSecs: 33000,
        arrivalSecs: 34200,
        durationSecs: 1800,
        accessWalkSecs: 300,
        egressWalkSecs: 300,
        legs: [
          {
            kind: 'transit',
            mode: 'rail',
            routeName: '甲線',
            from: { id: 'x:1' },
            to: { id: 'x:2' },
            departureSecs: 33000,
            arrivalSecs: 33600,
          },
          {
            kind: 'transit',
            mode: 'rail',
            routeName: '乙線',
            from: { id: 'x:2' },
            to: { id: 'x:3' },
            departureSecs: 33660,
            arrivalSecs: 34200,
          },
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('walk', 'origin', 'x:1', 'osmWalk', [[35.68, 139.76], a1]),
          mapSeg('transit', 'x:1', 'x:2', 'stopOrder', [a1, a2]),
          mapSeg('transit', 'x:2', 'x:3', 'stopOrder', [a2, a3]),
          mapSeg('walk', 'x:3', 'destination', 'estimatedWalk', [a3, [35.69, 139.7]]),
        ],
      },
    });

    const namedOption = (
      fromName: string,
      toName: string,
      pf: number[],
      ptTo: number[],
    ): JsonMap => ({
      journey: {
        departureSecs: 33000,
        arrivalSecs: 33600,
        durationSecs: 600,
        accessWalkSecs: 0,
        egressWalkSecs: 0,
        legs: [
          railLeg({
            route: '甲線',
            fromId: 'e0',
            fromName,
            toId: 'e1',
            toName,
            dep: 33000,
            arr: 33600,
          }),
        ],
      },
      map: {
        points: [],
        segments: [mapSeg('transit', 'e0', 'e1', 'stopOrder', [pf, ptTo])],
      },
    });

    const walkOnlyOption = (): JsonMap => ({
      journey: {
        departureSecs: 0,
        arrivalSecs: 600,
        durationSecs: 600,
        legs: [{ kind: 'walk', departureSecs: 0, arrivalSecs: 600 }],
      },
      map: {
        points: [],
        segments: [
          mapSeg('walk', 'a', 'b', 'osmWalk', [
            [35.68, 139.76],
            [35.69, 139.7],
          ]),
        ],
      },
    });

    const probeLeg1 = deferred<void>();
    const probeLeg2 = deferred<void>();
    const barrier = (): Promise<void> =>
      Promise.all([probeLeg1.promise, probeLeg2.promise]).then(() => undefined);
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

    const client = mockClient(async (url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (!path.includes('guidance/plan')) return json({}, 404);
      const q = url.searchParams;
      const from = (q.get('from') ?? '').replace('geo:', '').split(',');
      const fromLat = Number.parseFloat(from[0]);
      const fromLng = Number.parseFloat(from[1]);
      const fromOrigin = near(fromLat, o.lat) && near(fromLng, o.lng);
      let body: JsonMap;
      if (fromOrigin) {
        body = guidance([unnamedTwoLegOption()]);
      } else if (q.get('time') === '09:00' && near(fromLng, a1[1])) {
        if (!probeLeg1.isCompleted) probeLeg1.complete(undefined);
        await barrier();
        body = guidance([namedOption('駅一', '駅二', a1, a2)]);
      } else if (q.get('time') === '09:00' && near(fromLng, a2[1])) {
        if (!probeLeg2.isCompleted) probeLeg2.complete(undefined);
        await barrier();
        body = guidance([namedOption('駅二', '駅三', a2, a3)]);
      } else {
        body = guidance([walkOnlyOption()]);
      }
      body['date'] = q.get('date');
      return json(body);
    });

    let captured: RouteSearchMetrics | null = null;
    const plan = await withTimeout(
      service(client, { onMetrics: (m) => (captured = m) }).plan({
        destination: '目的地',
        destinationLatLng: g,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 9, m: 45 }),
        origin: o,
        originName: '出発',
      }),
      5000,
      () => expect.fail('未命名2区間の駅名復元照会が同時到達しない（逐次実行でデッドロック）'),
    );

    expect(probeLeg1.isCompleted, '前提: leg1 の駅名復元照会が発火').toBe(true);
    expect(probeLeg2.isCompleted, '前提: leg2 の駅名復元照会が発火').toBe(true);
    const trains = plan.segments.filter((s) => s.type === SegmentType.train);
    expect(trains).toHaveLength(2);
    expect(trains[0].fromName).toEqual('駅一');
    expect(trains[0].toName).toEqual('駅二');
    expect(trains[1].fromName).toEqual('駅二');
    expect(trains[1].toName).toEqual('駅三');
    expect(captured!.guidanceNames, '駅名の補完の照会を用途別に数える (#546)').toEqual(2);
  });
});

describe('plan: 候補間並列の例外境界と共有レッグ (#316)', () => {
  const o = new GeoPoint(35.0, 139.0);
  const g = new GeoPoint(35.0, 139.03);
  const alight = [35.0, 139.029];

  const option = (a: {
    route: string;
    board: number[];
    accessSecs: number;
    dep: number;
    arr: number;
  }): JsonMap => ({
    journey: {
      departureSecs: 32400,
      arrivalSecs: a.arr,
      durationSecs: a.arr - 32400,
      accessWalkSecs: a.accessSecs,
      egressWalkSecs: 60,
      legs: [
        railLeg({
          route: a.route,
          fromId: `${a.route}:board`,
          fromName: `乗車${a.route}`,
          toId: `${a.route}:alight`,
          toName: `降車${a.route}`,
          dep: a.dep,
          arr: a.arr,
        }),
      ],
    },
    map: {
      points: [],
      segments: [
        mapSeg('walk', 'origin', `${a.route}:board`, 'osmWalk', [[o.lat, o.lng], a.board]),
        mapSeg('transit', `${a.route}:board`, `${a.route}:alight`, 'stopOrder', [alight]),
        mapSeg('walk', `${a.route}:alight`, 'destination', 'estimatedWalk', [
          alight,
          [g.lat, g.lng],
        ]),
      ],
    },
  });

  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

  it('先行実測中のキャンセルは握り潰さず伝播する', async () => {
    const wBoard = [35.0, 139.01];
    const vBoard = [35.0, 139.005];
    const body = guidance([
      option({
        route: '快速W',
        board: wBoard,
        accessSecs: 840,
        dep: 33300,
        arr: 34020,
      }),
      option({
        route: '快速V',
        board: vBoard,
        accessSecs: 420,
        dep: 33000,
        arr: 33600,
      }),
    ]);

    const client = mockClient((url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) {
        const s = pt(url.searchParams.get('start') ?? '0,0');
        const gl = pt(url.searchParams.get('goal') ?? '0,0');
        if (
          near(s.lat, o.lat) &&
          near(s.lng, o.lng) &&
          near(gl.lat, wBoard[0]) &&
          near(gl.lng, wBoard[1])
        ) {
          throw new SearchCanceledException();
        }
        return walkFor(url);
      }
      if (path.includes('guidance/plan')) return json(body);
      return json({}, 404);
    });

    await expectThrowsA(
      () =>
        service(client).plan({
          destination: '目的地',
          destinationLatLng: g,
          departure: new TimeValue({ h: 9, m: 0 }),
          arrival: new TimeValue({ h: 9, m: 30 }),
          origin: o,
          originName: '出発',
        }),
      SearchCanceledException,
    );
  });

  it('同tier 非勝者の壊れた応答は当該候補だけ落として勝者を返す', async () => {
    const aBoard = [35.001, 139.01];
    const bBoard = [34.999, 139.01];
    const body = guidance([
      option({
        route: '快速A',
        board: aBoard,
        accessSecs: 720,
        dep: 33300,
        arr: 33900,
      }),
      option({
        route: '快速B',
        board: bBoard,
        accessSecs: 720,
        dep: 33600,
        arr: 34080,
      }),
    ]);

    const client = mockClient((url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) {
        const s = pt(url.searchParams.get('start') ?? '0,0');
        const gl = pt(url.searchParams.get('goal') ?? '0,0');
        if (
          near(s.lat, o.lat) &&
          near(s.lng, o.lng) &&
          near(gl.lat, bBoard[0]) &&
          near(gl.lng, bBoard[1])
        ) {
          throw new SyntaxError('malformed walk response');
        }
        return walkFor(url);
      }
      if (path.includes('guidance/plan')) return json(body);
      return json({}, 404);
    });

    const plan = await service(client).plan({
      destination: '目的地',
      destinationLatLng: g,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 9, m: 30 }),
      origin: o,
      originName: '出発',
    });

    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);
    expect(train.line, '壊れた B を落として同tier の勝者 A を返すはず').toEqual('快速A');
    expect(plan.totalMin).toBeLessThanOrEqual(30);
  });

  it('A/B 計測 (#462): A で壊れた応答に落ちた実測を、B が上流へ引き直さない', async () => {
    const aBoard = [35.001, 139.01];
    const bBoard = [34.999, 139.01];
    const body = guidance([
      option({ route: '快速A', board: aBoard, accessSecs: 720, dep: 33300, arr: 33900 }),
      option({ route: '快速B', board: bBoard, accessSecs: 720, dep: 33600, arr: 34080 }),
    ]);
    const run = async (exactWalkMaxAb: boolean, failFirst: number) => {
      let bAccess = 0;
      const client = mockClient((url) => {
        const path = url.pathname;
        if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
        if (path.includes('googleWalkProxy')) {
          const s = pt(url.searchParams.get('start') ?? '0,0');
          const gl = pt(url.searchParams.get('goal') ?? '0,0');
          if (near(s.lat, o.lat) && near(gl.lat, bBoard[0]) && near(gl.lng, bBoard[1])) {
            if (bAccess++ < failFirst) throw new SyntaxError('malformed walk response');
          }
          return walkFor(url);
        }
        if (path.includes('guidance/plan')) return json(body);
        return json({}, 404);
      });
      let captured: RouteSearchMetrics | null = null;
      await service(client, { exactWalkMaxAb, onMetrics: (m) => (captured = m) }).plan({
        destination: '目的地',
        destinationLatLng: g,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 9, m: 30 }),
        origin: o,
        originName: '出発',
      });
      return { bAccess, m: captured! };
    };
    const plain = await run(false, Number.POSITIVE_INFINITY);
    expect(plain.bAccess, '前提: B の access を実測する').toBeGreaterThan(0);
    const ab = await run(true, plain.bAccess);
    expect(ab.bAccess).toEqual(plain.bAccess);
    expect(ab.m.walkB).toEqual(ab.m.walkA);
  });

  it('同一 egress レッグは in-flight でも1回だけ実測する', async () => {
    const wBoard = [35.0, 139.01];
    const vBoard = [35.0, 139.005];
    const body = guidance([
      option({
        route: '快速W',
        board: wBoard,
        accessSecs: 840,
        dep: 33300,
        arr: 34020,
      }),
      option({
        route: '快速V',
        board: vBoard,
        accessSecs: 420,
        dep: 33000,
        arr: 33600,
      }),
    ]);

    let sharedEgressCalls = 0;
    const client = mockClient((url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) {
        const s = pt(url.searchParams.get('start') ?? '0,0');
        const gl = pt(url.searchParams.get('goal') ?? '0,0');
        if (
          near(s.lat, alight[0]) &&
          near(s.lng, alight[1]) &&
          near(gl.lat, g.lat) &&
          near(gl.lng, g.lng)
        ) {
          sharedEgressCalls++;
        }
        return walkFor(url);
      }
      if (path.includes('guidance/plan')) return json(body);
      return json({}, 404);
    });

    await service(client).plan({
      destination: '目的地',
      destinationLatLng: g,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 9, m: 30 }),
      origin: o,
      originName: '出発',
    });

    expect(
      sharedEgressCalls,
      '共有 egress レッグは in-flight を単一化して1回だけ実測されるはず',
    ).toEqual(1);
  });
});

describe('plan: 到着アンカー第2波 (#376)', () => {
  const o = familyOrigin;
  const g = familyGoal;

  const run = (
    client: HttpClient,
    opts: {
      onMetrics?: (m: RouteSearchMetrics) => void;
      arrivalWaveGrace?: number | null;
    } = {},
  ): Promise<RoutePlan> =>
    service(client, {
      onMetrics: opts.onMetrics,
      arrivalWaveGrace: opts.arrivalWaveGrace,
    }).plan({
      destination: '目的地',
      destinationLatLng: g,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 40 }),
      origin: o,
      originName: '出発',
    });

  const walkOf = (plan: RoutePlan): number =>
    plan.segments.filter((s) => s.type === SegmentType.walk).reduce((a, s) => a + s.minutes, 0);

  it('固定応答で確定経路・上流への要求・計測が変わらない: 第2波だけが持つ base（#486）', async () => {
    expect(
      await characterize(
        waveMock({ departure: guidance([familyA()]), arrival: guidance([familyB()]) }),
        (client, onMetrics) => run(client, { onMetrics }),
      ),
    ).toMatchSnapshot();
  });

  it('arrival 波が締切（出発+予算）をアンカーに type=arrival で発行される', async () => {
    const log: URL[] = [];
    await run(
      waveMock({
        departure: guidance([familyA()]),
        arrival: guidance([]),
        log,
      }),
    );
    const wave = singleWhere(
      log,
      (u) => u.pathname.includes('guidance/plan') && u.searchParams.get('type') === 'arrival',
    );
    expect(wave.searchParams.get('from')).toEqual('geo:35.0,139.0');
    expect(wave.searchParams.get('to')).toEqual('geo:35.0,139.1');
    expect(wave.searchParams.get('date')).toEqual('20260627');
    expect(wave.searchParams.get('time')).toEqual('10:40');
    expect(wave.searchParams.get('avoidModes')).toEqual('bus,ferry,air');
  });

  it('月末をまたぐ dateOffset は date=翌月1日へ暦正規化される', async () => {
    const log: URL[] = [];
    await service(
      waveMock({
        departure: guidance([familyA()]),
        arrival: guidance([]),
        log,
      }),
      { clock: () => dateTime(2026, 8, 31, 9, 0) },
    ).plan({
      destination: '目的地',
      destinationLatLng: g,
      departure: new TimeValue({ h: 9, m: 0, dateOffset: 1 }),
      arrival: new TimeValue({ h: 10, m: 40, dateOffset: 1 }),
      origin: o,
      originName: '出発',
    });
    const dates = new Set(
      log
        .filter((u) => u.pathname.includes('guidance/plan'))
        .map((u) => u.searchParams.get('date')),
    );
    expect(dates).toEqual(new Set(['20260901']));
  });

  it('年末をまたぐ dateOffset は date=翌年1月1日へ暦正規化される', async () => {
    const log: URL[] = [];
    await service(
      waveMock({
        departure: guidance([familyA()]),
        arrival: guidance([]),
        log,
      }),
      { clock: () => dateTime(2026, 12, 31, 9, 0) },
    ).plan({
      destination: '目的地',
      destinationLatLng: g,
      departure: new TimeValue({ h: 9, m: 0, dateOffset: 1 }),
      arrival: new TimeValue({ h: 10, m: 40, dateOffset: 1 }),
      origin: o,
      originName: '出発',
    });
    const dates = new Set(
      log
        .filter((u) => u.pathname.includes('guidance/plan'))
        .map((u) => u.searchParams.get('date')),
    );
    expect(dates).toEqual(new Set(['20270101']));
  });

  it('arrival 波だけが返す別系統が base になりそのコリドーから勝者が出る', async () => {
    const plan = await run(
      waveMock({
        departure: guidance([familyA()]),
        arrival: guidance([familyB()]),
      }),
    );
    expect(walkOf(plan)).toBeGreaterThan(40);
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
    expect(
      plan.segments.some((s) => s.type === SegmentType.train && s.line === '各停線'),
      'arrival 波の option が base に採られた証拠',
    ).toBe(true);
  });

  it('arrival 波が非200で落ちても departure 波だけで従来どおり確定する', async () => {
    const plan = await run(
      waveMock({
        departure: guidance([familyA(), familyB()]),
        onArrival: async () => json({}, 503),
      }),
    );
    expect(walkOf(plan)).toBeGreaterThan(40);
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
    expect(plan.segments.some((s) => s.type === SegmentType.train && s.line === '各停線')).toBe(
      true,
    );
  });

  it('猶予内に返らない arrival 波は待たずに departure 波だけで確定する', async () => {
    const gate = deferred<HttpResponse>();
    let captured: RouteSearchMetrics | null = null;
    const plan = await run(
      waveMock({
        departure: guidance([familyA(), familyB()]),
        onArrival: () => gate.promise,
      }),
      { onMetrics: (m) => (captured = m), arrivalWaveGrace: 20 },
    );

    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
    const m = captured!;
    expect(m.arrivalWaveOutcome).toEqual(ArrivalWaveOutcome.timeout);
    expect(m.arrivalWaveOptions).toEqual(0);
    expect(m.arrivalWaveBaseUsed).toBe(false);
    expect(m.arrivalWaveWon).toBe(false);

    gate.complete(json(guidance([familyA(), familyB()])));
  });

  it('arrival 波がタイムアウトしても departure 波だけで確定する', async () => {
    const plan = await run(
      waveMock({
        departure: guidance([familyA(), familyB()]),
        onArrival: async () => {
          throw new TimeoutException('no response');
        },
      }),
    );
    expect(walkOf(plan)).toBeGreaterThan(40);
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });

  it('departure 波が落ちれば arrival 波が生きていても検索ごと失敗する', async () => {
    const client = mockClient((url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (path.includes('guidance/plan')) {
        return url.searchParams.get('type') === 'arrival'
          ? json(guidance([familyA(), familyB()]))
          : json({}, 503);
      }
      return json({}, 404);
    });
    await expectThrowsA(() => run(client), RouteException);
  });

  it('同一路線・同一乗降でも別便なら重複除去で落とさない', async () => {
    const sameLineRun = (a: { dep: number; arr: number }): JsonMap => ({
      journey: {
        departureSecs: a.dep,
        arrivalSecs: a.arr,
        durationSecs: a.arr - a.dep + 240,
        accessWalkSecs: 120,
        egressWalkSecs: 120,
        legs: [
          railLeg({
            route: '本線',
            fromId: 'm:board',
            fromName: 'M乗車',
            toId: 'm:alight',
            toName: 'M降車',
            dep: a.dep,
            arr: a.arr,
          }),
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('walk', 'origin', 'm:board', 'osmWalk', [
            [35.0, 139.0],
            [35.0, 139.002],
          ]),
          mapSeg('transit', 'm:board', 'm:alight', 'stopOrder', [
            [35.0, 139.002],
            [35.0, 139.098],
          ]),
          mapSeg('walk', 'm:alight', 'destination', 'estimatedWalk', [
            [35.0, 139.098],
            [35.0, 139.1],
          ]),
        ],
      },
    });

    let captured: RouteSearchMetrics | null = null;
    const plan = await run(
      waveMock({
        departure: guidance([sameLineRun({ dep: 32580, arr: 39000 })]),
        arrival: guidance([sameLineRun({ dep: 34200, arr: 35400 })]),
      }),
      { onMetrics: (m) => (captured = m) },
    );

    expect(plan.totalMin, '急行が生き残れば予算内で確定できる').toBeLessThanOrEqual(plan.budgetMin);
    const trains = plan.segments.filter((s) => s.type === SegmentType.train);
    expect(trains).toHaveLength(1);
    expect(first(trains).depTime).toEqual(dateTime(2026, 6, 27, 9, 30));
    expect(first(trains).arrTime).toEqual(dateTime(2026, 6, 27, 9, 50));
    expect(captured!.arrivalWaveOptions, '別便なので純増1本').toEqual(1);
  });

  it('arrival 波の出発済み便は既存の不変条件が弾き確定に出ない', async () => {
    const departed = (): JsonMap => ({
      journey: {
        departureSecs: 28800,
        arrivalSecs: 29400,
        durationSecs: 29400 - 28800 + 3540,
        accessWalkSecs: 3420,
        egressWalkSecs: 120,
        legs: [
          railLeg({
            route: '幽霊特急',
            fromId: 'x:board',
            fromName: 'X乗車',
            toId: 'x:alight',
            toName: 'X降車',
            dep: 28800,
            arr: 29400,
          }),
        ],
      },
      map: {
        points: [],
        segments: [
          mapSeg('walk', 'origin', 'x:board', 'osmWalk', [
            [35.0, 139.0],
            [35.0, 139.05],
          ]),
          mapSeg('transit', 'x:board', 'x:alight', 'stopOrder', [
            [35.0, 139.05],
            [35.0, 139.098],
          ]),
          mapSeg('walk', 'x:alight', 'destination', 'estimatedWalk', [
            [35.0, 139.098],
            [35.0, 139.1],
          ]),
        ],
      },
    });

    const plan = await run(
      waveMock({
        departure: guidance([familyA()]),
        arrival: guidance([departed()]),
      }),
    );
    expect(
      plan.segments.some((s) => s.line === '幽霊特急'),
      '出発済みの便は乗れない＝確定に出してはいけない',
    ).toBe(false);
    expect(
      walkOf(plan),
      '徒歩59分の幽霊特急を掴んでいないこと（掴めば徒歩は59分近辺になる）',
    ).toBeLessThan(50);
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });

  it('両波が同じ便を返しても候補も実測ファンアウトも増えない', async () => {
    const runWith = async (arrival: JsonMap): Promise<URL[]> => {
      const log: URL[] = [];
      await run(
        waveMock({
          departure: guidance([familyA(), familyB()]),
          arrival,
          log,
        }),
      );
      return log;
    };

    const countOf = (log: URL[], path: string): number =>
      log.filter((u) => u.pathname.includes(path)).length;

    const dup = await runWith(guidance([familyA(), familyB()]));
    const empty = await runWith(guidance([]));
    expect(
      countOf(dup, 'googleWalkProxy'),
      '同一便は dedup されるので徒歩実測は増えないはず',
    ).toEqual(countOf(empty, 'googleWalkProxy'));
    expect(
      countOf(dup, 'googleWalkMatrixProxy'),
      '同一便は base を増やさないのでマトリクスも増えないはず',
    ).toEqual(countOf(empty, 'googleWalkMatrixProxy'));
    expect(countOf(dup, 'guidance/plan'), 'arrival 波の1本は両方に載る＝差は出ないはず').toEqual(
      countOf(empty, 'guidance/plan'),
    );
  });

  describe('採用状況の計測', () => {
    it('base に採られ勝者にもなれば BaseUsed / Won が立つ', async () => {
      let captured: RouteSearchMetrics | null = null;
      await run(
        waveMock({
          departure: guidance([familyA()]),
          arrival: guidance([familyB()]),
        }),
        { onMetrics: (m) => (captured = m) },
      );
      const m = captured!;
      expect(m.arrivalWaveOutcome).toEqual(ArrivalWaveOutcome.ok);
      expect(m.arrivalWaveOptions, 'dedup 後の純増分').toEqual(1);
      expect(m.arrivalWaveBaseUsed).toBe(true);
      expect(m.arrivalWaveWon).toBe(true);
      expect(m.guidanceCalls).toBeGreaterThanOrEqual(2);
    });

    it('arrival 波が落ちれば計測はすべて立たない', async () => {
      let captured: RouteSearchMetrics | null = null;
      await run(
        waveMock({
          departure: guidance([familyA(), familyB()]),
          onArrival: async () => json({}, 503),
        }),
        { onMetrics: (m) => (captured = m) },
      );
      const m = captured!;
      expect(m.arrivalWaveOutcome).toEqual(ArrivalWaveOutcome.error);
      expect(m.arrivalWaveOptions).toEqual(0);
      expect(m.arrivalWaveBaseUsed).toBe(false);
      expect(m.arrivalWaveWon).toBe(false);
    });

    it('200 でも option が0本なら空応答として区別する', async () => {
      let captured: RouteSearchMetrics | null = null;
      await run(
        waveMock({
          departure: guidance([familyA(), familyB()]),
          arrival: guidance([]),
        }),
        { onMetrics: (m) => (captured = m) },
      );
      const m = captured!;
      expect(m.arrivalWaveOutcome).toEqual(ArrivalWaveOutcome.empty);
      expect(m.arrivalWaveOptions).toEqual(0);
    });

    it('重複便しか返らなければ Ok だけ立ち純増0・不採用', async () => {
      let captured: RouteSearchMetrics | null = null;
      await run(
        waveMock({
          departure: guidance([familyA(), familyB()]),
          arrival: guidance([familyA(), familyB()]),
        }),
        { onMetrics: (m) => (captured = m) },
      );
      const m = captured!;
      expect(m.arrivalWaveOutcome, '応答自体は有効だった').toEqual(ArrivalWaveOutcome.ok);
      expect(m.arrivalWaveOptions, '全て dedup で消える').toEqual(0);
      expect(m.arrivalWaveBaseUsed).toBe(false);
      expect(m.arrivalWaveWon).toBe(false);
    });

    it('計測は1行ログにも出る', () => {
      const line = new RouteSearchMetrics().toLogLine();
      expect(line).toContain('arrivalWaveOutcome=-1');
      expect(line).toContain('arrivalWaveOptions=0');
      expect(line).toContain('arrivalWaveBaseUsed=0');
      expect(line).toContain('arrivalWaveWon=0');
    });
  });

  it('arrival 波 in-flight のキャンセルは握り潰さず伝播する', async () => {
    await expectThrowsA(
      () =>
        run(
          waveMock({
            departure: guidance([familyA(), familyB()]),
            onArrival: async () => {
              throw new SearchCanceledException();
            },
          }),
        ),
      SearchCanceledException,
    );
  });
});

describe('plan: 厳密走査の候補 exactWalkMax (#460)', () => {
  const o = familyOrigin;
  const g = familyGoal;

  const boardPt = new GeoPoint(35.0, 139.04);
  const alightPt = new GeoPoint(35.0, 139.065);

  const at = (h: number, m: number): string =>
    `2026-06-27T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`;

  const exactCandidate = (a: {
    board: string;
    alight: string;
    accessMin?: number;
    egressMin?: number;
  }): JsonMap => ({
    board: { name: '厳密乗車', lat: boardPt.lat, lng: boardPt.lng },
    alight: { name: '厳密降車', lat: alightPt.lat, lng: alightPt.lng },
    route: '厳密線',
    headsign: null,
    boardAt: a.board,
    alightAt: a.alight,
    stops: [
      { lat: boardPt.lat, lng: boardPt.lng },
      { lat: alightPt.lat, lng: alightPt.lng },
    ],
    accessWalk: {
      durationSec: (a.accessMin ?? walkMin(o, boardPt)) * 60,
      distanceMeters: Math.round(haversineKm(o, boardPt) * 1000),
    },
    egressWalk: {
      durationSec: (a.egressMin ?? walkMin(alightPt, g)) * 60,
      distanceMeters: Math.round(haversineKm(alightPt, g) * 1000),
    },
  });

  const exactBody = (
    candidates: JsonMap[],
    feeds: JsonMap[] = [],
    transferCandidates: JsonMap[] = [],
  ): JsonMap => ({
    candidates,
    transferCandidates,
    feeds,
    stats: { tripsScanned: 10, elementsMeasured: 2, truncated: false },
  });

  const exactMock = (a: {
    onExact: () => HttpResponse | Promise<HttpResponse>;
    log?: URL[];
  }): HttpClient =>
    mockClient((url) => {
      a.log?.push(url);
      const path = url.pathname;
      if (path.includes('exactWalkMax')) return a.onExact();
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (path.includes('guidance/plan')) return json(guidance([familyA(), familyB()]));
      return json({}, 404);
    });

  const run = (
    client: HttpClient,
    opts: { exactWalkMax?: boolean; exactWalkMaxGrace?: number | null } = {},
  ): Promise<RoutePlan> =>
    service(client, {
      exactWalkMax: opts.exactWalkMax ?? true,
      exactWalkMaxGrace: opts.exactWalkMaxGrace,
    }).plan({
      destination: '目的地',
      destinationLatLng: g,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 40 }),
      origin: o,
      originName: '出発',
    });

  const walkOf = (plan: RoutePlan): number =>
    plan.segments.filter((s) => s.type === SegmentType.walk).reduce((a, s) => a + s.minutes, 0);

  const enrichedExact = (log: URL[]): boolean =>
    log.some(
      (u) =>
        u.pathname.includes('googleWalkProxy') &&
        u.searchParams.get('goal') === `${dartDouble(boardPt.lat)},${dartDouble(boardPt.lng)}`,
    );

  const rides = (plan: RoutePlan): (string | null)[] =>
    plan.segments.filter((s) => s.type !== SegmentType.walk).map((s) => s.line);

  const baseline = (): Promise<RoutePlan> =>
    run(exactMock({ onExact: () => json(exactBody([])) }), { exactWalkMax: false });

  it('origin・goal・出発時刻（JST）・予算を exactWalkMax へ送る', async () => {
    const log: URL[] = [];
    await run(exactMock({ onExact: () => json(exactBody([])), log }));
    const req = singleWhere(log, (u) => u.pathname.includes('exactWalkMax'));
    expect(req.origin).toEqual(proxyBase);
    expect(req.searchParams.get('origin')).toEqual('35.0,139.0');
    expect(req.searchParams.get('goal')).toEqual('35.0,139.1');
    expect(req.searchParams.get('departAt')).toEqual('2026-06-27T09:00:00+09:00');
    expect(req.searchParams.get('budgetMin')).toEqual('100');
  });

  it('通常の検索は乗換つきの候補を読まないので、exactWalkMax に要求しない（#484）', async () => {
    const log: URL[] = [];
    await run(exactMock({ onExact: () => json(exactBody([])), log }));
    const req = singleWhere(log, (u) => u.pathname.includes('exactWalkMax'));
    expect(req.searchParams.has('transfers')).toBe(false);
  });

  describe('時刻表の出典（#461）', () => {
    const feeds = [{ id: 'Toei', fetchedAt: '2026-06-27T04:23:10.000Z' }];
    const toei = [{ feedId: 'Toei', fetchedAt: new Date(Date.UTC(2026, 5, 27, 4, 23, 10)) }];

    it('応答が返れば、フィードの取得日時を RoutePlan に載せる', async () => {
      const plan = await run(
        exactMock({
          onExact: () =>
            json(exactBody([exactCandidate({ board: at(9, 50), alight: at(9, 53) })], feeds)),
        }),
      );
      expect(rides(plan)).toEqual(['厳密線']);
      expect(plan.timetableSources).toEqual(toei);
    });

    it('厳密走査の候補が採用されなくても載せる（比較に使っている）', async () => {
      const plan = await run(exactMock({ onExact: () => json(exactBody([], feeds)) }));
      expect(rides(plan)).not.toContain('厳密線');
      expect(plan.timetableSources).toEqual(toei);
    });

    it('厳密走査を切っていれば空', async () => {
      const plan = await run(exactMock({ onExact: () => json(exactBody([], feeds)) }), {
        exactWalkMax: false,
      });
      expect(plan.timetableSources).toEqual([]);
    });

    it('エンドポイントが失敗すれば空', async () => {
      const plan = await run(exactMock({ onExact: () => json({}, 503) }));
      expect(plan.timetableSources).toEqual([]);
    });

    it('猶予内に返らなければ空', async () => {
      const gate = deferred<HttpResponse>();
      const plan = await run(exactMock({ onExact: () => gate.promise }), {
        exactWalkMaxGrace: 20,
      });
      expect(plan.timetableSources).toEqual([]);
      gate.complete(json(exactBody([], feeds)));
    });
  });

  it('厳密走査の候補が徒歩最大なら、それが確定する', async () => {
    const plan = await run(
      exactMock({
        onExact: () => json(exactBody([exactCandidate({ board: at(9, 50), alight: at(9, 53) })])),
      }),
    );
    expect(rides(plan)).toEqual(['厳密線']);
    expect(walkOf(plan)).toEqual(86);
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
    const ride = singleWhere(plan.segments, (s) => s.type === SegmentType.train);
    expect(ride.fromName).toEqual('厳密乗車');
    expect(ride.toName).toEqual('厳密降車');
    expect(ride.depTime).toEqual(dateTime(2026, 6, 27, 9, 50));
  });

  it('enrich で乗り遅れが分かった厳密走査の候補は落ち、次善に選び直す', async () => {
    const log: URL[] = [];
    const plan = await run(
      exactMock({
        log,
        onExact: () =>
          json(exactBody([exactCandidate({ board: at(9, 44), alight: at(9, 47), accessMin: 43 })])),
      }),
    );
    const before = await baseline();
    expect(enrichedExact(log)).toBe(true);
    expect(rides(plan)).not.toContain('厳密線');
    expect(rides(plan)).toEqual(rides(before));
    expect(walkOf(plan)).toEqual(walkOf(before));
  });

  it('enrich で予算超過が分かった厳密走査の候補は落ち、次善に選び直す', async () => {
    const log: URL[] = [];
    const plan = await run(
      exactMock({
        log,
        onExact: () =>
          json(exactBody([exactCandidate({ board: at(9, 50), alight: at(10, 1), egressMin: 37 })])),
      }),
    );
    const before = await baseline();
    expect(enrichedExact(log)).toBe(true);
    expect(rides(plan)).not.toContain('厳密線');
    expect(rides(plan)).toEqual(rides(before));
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });

  it('エンドポイントが失敗しても、今と同じ経路が返る', async () => {
    const before = await baseline();
    for (const status of [400, 429, 502, 503]) {
      const plan = await run(exactMock({ onExact: () => json({}, status) }));
      expect(rides(plan), `HTTP ${status}`).toEqual(rides(before));
      expect(walkOf(plan), `HTTP ${status}`).toEqual(walkOf(before));
    }
  });

  it('応答の形が崩れていても、今と同じ経路が返る', async () => {
    const before = await baseline();
    const plan = await run(exactMock({ onExact: () => json(['not', 'a', 'map']) }));
    expect(rides(plan)).toEqual(rides(before));
    expect(walkOf(plan)).toEqual(walkOf(before));
  });

  it('猶予内に返らなければ待たずに、今と同じ経路が返る', async () => {
    const gate = deferred<HttpResponse>();
    const before = await baseline();
    const plan = await run(exactMock({ onExact: () => gate.promise }), {
      exactWalkMaxGrace: 20,
    });
    expect(rides(plan)).toEqual(rides(before));
    expect(walkOf(plan)).toEqual(walkOf(before));
    gate.complete(json(exactBody([])));
  });

  it('猶予は arrival 波を待ち終えてからではなく、departure 波の確定から数える', async () => {
    vi.useFakeTimers();
    try {
      const arrival = deferred<HttpResponse>();
      const exact = deferred<HttpResponse>();
      const client = mockClient((url) => {
        const path = url.pathname;
        if (path.includes('exactWalkMax')) return exact.promise;
        if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
        if (path.includes('googleWalkProxy')) return walkFor(url);
        if (path.includes('guidance/plan')) {
          return url.searchParams.get('type') === 'arrival'
            ? arrival.promise
            : json(guidance([familyA(), familyB()]));
        }
        return json({}, 404);
      });
      const pending = service(client, {
        exactWalkMax: true,
        exactWalkMaxGrace: 100,
        arrivalWaveGrace: 100,
      }).plan({
        destination: '目的地',
        destinationLatLng: g,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 40 }),
        origin: o,
        originName: '出発',
      });
      await vi.advanceTimersByTimeAsync(100);
      exact.complete(json(exactBody([exactCandidate({ board: at(9, 50), alight: at(9, 53) })])));
      await vi.advanceTimersByTimeAsync(200);
      const plan = await pending;
      expect(rides(plan)).not.toContain('厳密線');
      arrival.complete(json(guidance([])));
    } finally {
      vi.useRealTimers();
    }
  });

  it('キャンセルは握り潰されない', async () => {
    await expectThrowsA(
      () =>
        run(
          exactMock({
            onExact: async () => {
              throw new SearchCanceledException();
            },
          }),
        ),
      SearchCanceledException,
    );
  });

  describe('計測', () => {
    const measure = async (
      client: HttpClient,
      opts: { exactWalkMax?: boolean; exactWalkMaxGrace?: number | null } = {},
    ): Promise<RouteSearchMetrics> => {
      let captured: RouteSearchMetrics | null = null;
      await service(client, {
        exactWalkMax: opts.exactWalkMax ?? true,
        exactWalkMaxGrace: opts.exactWalkMaxGrace,
        onMetrics: (m) => (captured = m),
      }).plan({
        destination: '目的地',
        destinationLatLng: g,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 40 }),
        origin: o,
        originName: '出発',
      });
      return captured!;
    };

    it('勝てば exactWon が立ち、足した候補数と打ち切りの有無を記録する', async () => {
      const m = await measure(
        exactMock({
          onExact: () =>
            json({
              ...exactBody([exactCandidate({ board: at(9, 50), alight: at(9, 53) })]),
              stats: { tripsScanned: 10, elementsMeasured: 24, truncated: true },
            }),
        }),
      );
      expect(m.exactCandidates).toEqual(1);
      expect(m.exactCapped).toBe(true);
      expect(m.exactWon).toBe(true);
      expect(m.exactCalls).toEqual(1);
      expect(m.exactMs).toBeGreaterThanOrEqual(0);
    });

    it('enrich で落ちれば exactWon は立たない', async () => {
      const m = await measure(
        exactMock({
          onExact: () =>
            json(
              exactBody([exactCandidate({ board: at(9, 44), alight: at(9, 47), accessMin: 43 })]),
            ),
        }),
      );
      expect(m.exactCandidates).toEqual(1);
      expect(m.exactCapped).toBe(false);
      expect(m.exactWon).toBe(false);
    });

    it('200 で候補0件なら exactCandidates=0（失敗の -1 と区別する）', async () => {
      const m = await measure(exactMock({ onExact: () => json(exactBody([])) }));
      expect(m.exactCandidates).toEqual(0);
      expect(m.exactWon).toBe(false);
    });

    it('失敗・猶予切れは exactCandidates=-1', async () => {
      const failed = await measure(exactMock({ onExact: () => json({}, 503) }));
      expect(failed.exactCandidates).toEqual(-1);
      expect(failed.exactCalls).toEqual(1);

      const gate = deferred<HttpResponse>();
      const late = await measure(exactMock({ onExact: () => gate.promise }), {
        exactWalkMaxGrace: 20,
      });
      expect(late.exactCandidates).toEqual(-1);
      expect(late.exactWon).toBe(false);
      gate.complete(json(exactBody([])));
    });

    it('フラグを切れば何も記録しない', async () => {
      const m = await measure(exactMock({ onExact: () => json(exactBody([])) }), {
        exactWalkMax: false,
      });
      expect(m.exactCalls).toEqual(0);
      expect(m.exactMs).toEqual(0);
      expect(m.exactCandidates).toEqual(-1);
      expect(m.exactCapped).toBe(false);
      expect(m.exactWon).toBe(false);
    });
  });

  it('フラグを切れば exactWalkMax を呼ばない', async () => {
    const log: URL[] = [];
    await run(
      exactMock({
        onExact: () => json(exactBody([exactCandidate({ board: at(9, 50), alight: at(9, 53) })])),
        log,
      }),
      { exactWalkMax: false },
    );
    expect(log.some((u) => u.pathname.includes('exactWalkMax'))).toBe(false);
  });

  describe('同じ実行の中の A/B 計測 exactWalkMaxAb (#462)', () => {
    const runAb = async (
      client: HttpClient,
    ): Promise<{ plan: RoutePlan; m: RouteSearchMetrics }> => {
      let captured: RouteSearchMetrics | null = null;
      const plan = await service(client, {
        exactWalkMaxAb: true,
        onMetrics: (m) => (captured = m),
      }).plan({
        destination: '目的地',
        destinationLatLng: g,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 40 }),
        origin: o,
        originName: '出発',
      });
      return { plan, m: captured! };
    };

    const winning = (): JsonMap =>
      exactBody([exactCandidate({ board: at(9, 50), alight: at(9, 53) })]);

    it('A は厳密走査の候補を混ぜない今の経路、B は足して選び直した経路で、B を返す', async () => {
      const before = await baseline();
      const { plan, m } = await runAb(exactMock({ onExact: () => json(winning()) }));
      expect(m.walkA).toEqual(walkOf(before));
      expect(m.walkB).toEqual(86);
      expect(rides(plan)).toEqual(['厳密線']);
      expect(walkOf(plan)).toEqual(m.walkB);
      expect(m.exactWon).toBe(true);
      expect(m.coveredBase).toBe(true);
      expect(m.collapseB).toBe(false);
    });

    it("A/B モードは B' が読む乗換つきの候補を exactWalkMax に要求する（#484）", async () => {
      const log: URL[] = [];
      await runAb(exactMock({ onExact: () => json(winning()), log }));
      const req = singleWhere(log, (u) => u.pathname.includes('exactWalkMax'));
      expect(req.searchParams.get('transfers')).toEqual('1');
    });

    it('A/B モードでも厳密走査は1回だけ発行し、A の上流応答を B で引き直さない', async () => {
      const log: URL[] = [];
      const { m } = await runAb(exactMock({ onExact: () => json(winning()), log }));
      expect(log.filter((u) => u.pathname.includes('exactWalkMax'))).toHaveLength(1);
      const baselineLog: URL[] = [];
      await run(exactMock({ onExact: () => json(exactBody([])), log: baselineLog }), {
        exactWalkMax: false,
      });
      const guidanceOf = (l: URL[]): number =>
        l.filter((u) => u.pathname.includes('guidance/plan')).length;
      expect(guidanceOf(log)).toEqual(guidanceOf(baselineLog));
      expect(m.abMs).toBeGreaterThanOrEqual(0);
    });

    it('B で厳密走査の候補が落ちれば、B は A と同じ経路になる', async () => {
      const before = await baseline();
      const { plan, m } = await runAb(
        exactMock({
          onExact: () =>
            json(
              exactBody([exactCandidate({ board: at(9, 44), alight: at(9, 47), accessMin: 43 })]),
            ),
        }),
      );
      expect(m.walkB).toEqual(m.walkA);
      expect(m.exactWon).toBe(false);
      expect(m.coveredBase).toBe(true);
      expect(rides(plan)).toEqual(rides(before));
    });

    it('厳密走査が失敗すれば coveredBase は立たず、B は A と同じ', async () => {
      const { m } = await runAb(exactMock({ onExact: () => json({}, 503) }));
      expect(m.exactCandidates).toEqual(-1);
      expect(m.coveredBase).toBe(false);
      expect(m.walkB).toEqual(m.walkA);
    });

    it('A は厳密走査の応答を待たずに選定まで走る（待ちを A の所要へ混ぜない）', async () => {
      const gate = deferred<HttpResponse>();
      let captured: RouteSearchMetrics | null = null;
      const client = mockClient((url) => {
        const path = url.pathname;
        if (path.includes('exactWalkMax')) return gate.promise;
        if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
        if (path.includes('googleWalkProxy')) {
          gate.complete(json(winning()));
          return walkFor(url);
        }
        if (path.includes('guidance/plan')) return json(guidance([familyA(), familyB()]));
        return json({}, 404);
      });
      const plan = await service(client, {
        exactWalkMaxAb: true,
        exactWalkMaxGrace: 200,
        onMetrics: (m) => (captured = m),
      }).plan({
        destination: '目的地',
        destinationLatLng: g,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 40 }),
        origin: o,
        originName: '出発',
      });
      const m = captured!;
      expect(m.exactCandidates).toEqual(1);
      expect(m.exactWon).toBe(true);
      expect(rides(plan)).toEqual(['厳密線']);
    });

    it('A の駅名復元は A の所要に入り、B の駅名復元は abMs に入る', async () => {
      let captured: RouteSearchMetrics | null = null;
      let departures = 0;
      const client = mockClient(async (url) => {
        const path = url.pathname;
        if (path.includes('exactWalkMax')) return json(winning());
        if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
        if (path.includes('googleWalkProxy')) return walkFor(url);
        if (path.includes('guidance/plan')) {
          await delay(30);
          const body = guidance([familyA(), familyB()]);
          const first = url.searchParams.get('type') === 'arrival' || departures++ === 0;
          return first
            ? json(body)
            : json(JSON.parse(JSON.stringify(body).replace(/"name":"[^"]*"/g, '"name":""')));
        }
        return json({}, 404);
      });
      await service(client, {
        exactWalkMaxAb: true,
        onMetrics: (m) => (captured = m),
      }).plan({
        destination: '目的地',
        destinationLatLng: g,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 40 }),
        origin: o,
        originName: '出発',
      });
      const m = captured!;
      expect(m.exactWon, '前提: B は厳密走査の候補').toBe(true);
      expect(m.finalizeMs, 'A の駅名復元（guidance 1往復）を測っている').toBeGreaterThanOrEqual(25);
    });

    describe("乗換つきの候補を足す B' (#474)", () => {
      const transferFrom = new GeoPoint(35.0, 139.05);
      const transferTo = new GeoPoint(35.0, 139.052);
      const leg = (a: {
        from: GeoPoint;
        to: GeoPoint;
        name: string;
        board: string;
        alight: string;
      }): JsonMap => ({
        board: { name: `${a.name}乗車`, lat: a.from.lat, lng: a.from.lng },
        alight: { name: `${a.name}降車`, lat: a.to.lat, lng: a.to.lng },
        route: a.name,
        headsign: null,
        boardAt: a.board,
        alightAt: a.alight,
        stops: [
          { lat: a.from.lat, lng: a.from.lng },
          { lat: a.to.lat, lng: a.to.lng },
        ],
      });
      const transferCandidate = (
        a: { secondBoard?: string; transferSec?: number; sameStation?: boolean } = {},
      ): JsonMap => ({
        legs: [
          leg({
            from: boardPt,
            to: transferFrom,
            name: '一本目線',
            board: at(9, 50),
            alight: at(9, 52),
          }),
          leg({
            from: transferTo,
            to: alightPt,
            name: '二本目線',
            board: a.secondBoard ?? at(9, 55),
            alight: at(9, 57),
          }),
        ],
        accessWalk: { durationSec: walkMin(o, boardPt) * 60, distanceMeters: 3650 },
        transferWalk: {
          durationSec: a.transferSec ?? walkMin(transferFrom, transferTo) * 60,
          distanceMeters: 180,
        },
        sameStation: a.sameStation ?? false,
        egressWalk: { durationSec: walkMin(alightPt, g) * 60, distanceMeters: 3200 },
      });
      const withTransfer = (...transfers: JsonMap[]): JsonMap =>
        exactBody([exactCandidate({ board: at(9, 50), alight: at(9, 53) })], [], transfers);

      const characterizeExact = (body: JsonMap, ab: boolean): Promise<unknown> =>
        characterize(exactMock({ onExact: () => json(body) }), (client, onMetrics) =>
          service(client, {
            exactWalkMax: !ab,
            exactWalkMaxAb: ab,
            onMetrics,
          }).plan({
            destination: '目的地',
            destinationLatLng: g,
            departure: new TimeValue({ h: 9, m: 0 }),
            arrival: new TimeValue({ h: 10, m: 40 }),
            origin: o,
            originName: '出発',
          }),
        );

      it('固定応答で確定経路・上流への要求・計測が変わらない: 厳密走査の候補が勝つ（#486）', async () => {
        expect(await characterizeExact(withTransfer(transferCandidate()), false)).toMatchSnapshot();
      });

      it("固定応答で確定経路・上流への要求・計測が変わらない: A/B で B' が勝つ（#486）", async () => {
        expect(await characterizeExact(withTransfer(transferCandidate()), true)).toMatchSnapshot();
      });

      it("固定応答で確定経路・上流への要求・計測が変わらない: A/B で B' が落ちて B を保つ（#486）", async () => {
        expect(
          await characterizeExact(
            withTransfer(transferCandidate({ secondBoard: at(9, 53), transferSec: 0 })),
            true,
          ),
        ).toMatchSnapshot();
      });

      it("B' は B の勝者と乗換つきから選び直し、勝てば B' を返す", async () => {
        const { plan, m } = await runAb(
          exactMock({ onExact: () => json(withTransfer(transferCandidate())) }),
        );

        expect(m.walkB).toEqual(86);
        expect(m.walkBPrime).toEqual(88);
        expect(m.transferCandidates).toEqual(1);
        expect(m.transferDropped).toEqual(0);
        expect(m.transferWon).toBe(true);
        expect(m.exactWon, 'exactWon は B の確定候補を見る').toBe(true);
        expect(rides(plan)).toEqual(['一本目線', '二本目線']);
        expect(walkOf(plan)).toEqual(m.walkBPrime);
      });

      it('見積り0分の別駅への乗換は実測で伸び、2本目に乗り遅れれば落ちて B のまま', async () => {
        const { plan, m } = await runAb(
          exactMock({
            onExact: () =>
              json(withTransfer(transferCandidate({ secondBoard: at(9, 53), transferSec: 0 }))),
          }),
        );

        expect(m.transferDropped).toEqual(1);
        expect(m.transferWon).toBe(false);
        expect(m.walkBPrime).toEqual(m.walkB);
        expect(rides(plan)).toEqual(['厳密線']);
      });

      it('乗換の徒歩を実測できなければ、見積りで乗れても採用しない', async () => {
        const client = mockClient((url) => {
          const path = url.pathname;
          if (path.includes('exactWalkMax')) {
            return json(
              withTransfer(transferCandidate({ secondBoard: at(9, 53), transferSec: 0 })),
            );
          }
          if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
          if (path.includes('googleWalkProxy')) {
            const goal = `${dartDouble(transferTo.lat)},${dartDouble(transferTo.lng)}`;
            return url.searchParams.get('goal') === goal ? json({}, 503) : walkFor(url);
          }
          if (path.includes('guidance/plan')) return json(guidance([familyA(), familyB()]));
          return json({}, 404);
        });

        const { plan, m } = await runAb(client);

        expect(m.transferWon).toBe(false);
        expect(m.transferDropped).toEqual(1);
        expect(m.walkBPrime).toEqual(m.walkB);
        expect(rides(plan)).toEqual(['厳密線']);
      });

      it('乗換つきが全部落ちても、B で検証済みの勝者を実測の上限で失わない', async () => {
        const failing = Array.from({ length: 8 }, () =>
          exactCandidate({ board: at(9, 45), alight: at(9, 53), accessMin: 47 }),
        );
        const failingTransfers = Array.from({ length: 5 }, () => ({
          ...transferCandidate({ secondBoard: at(9, 53), transferSec: 0 }),
          accessWalk: { durationSec: 47 * 60, distanceMeters: 3650 },
        }));
        const body = exactBody(
          [...failing, exactCandidate({ board: at(9, 50), alight: at(9, 53) })],
          [],
          failingTransfers,
        );

        const { plan, m } = await runAb(exactMock({ onExact: () => json(body) }));

        expect(m.walkB).toEqual(86);
        expect(m.walkBPrime).toEqual(86);
        expect(m.transferDropped).toEqual(5);
        expect(rides(plan)).toEqual(['厳密線']);
      });

      it('実測まで届かなかった乗換つきの候補は、落ちた数に入れない', async () => {
        const short = transferCandidate();
        const { m } = await runAb(
          exactMock({
            onExact: () =>
              json(
                withTransfer(transferCandidate(), {
                  ...short,
                  accessWalk: { durationSec: 40 * 60, distanceMeters: 3200 },
                }),
              ),
          }),
        );

        expect(m.transferCandidates).toEqual(2);
        expect(m.transferDropped).toEqual(0);
      });

      it("B' も A の上流応答を引き直さず、足す往復は乗換の徒歩の実測だけ", async () => {
        const log: URL[] = [];
        await runAb(exactMock({ onExact: () => json(withTransfer(transferCandidate())), log }));
        const without: URL[] = [];
        await runAb(exactMock({ onExact: () => json(withTransfer()), log: without }));

        const guidanceOf = (l: URL[]): number =>
          l.filter((u) => u.pathname.includes('guidance/plan')).length;
        const transferWalks = log.filter(
          (u) =>
            u.pathname.includes('googleWalkProxy') &&
            u.searchParams.get('goal') ===
              `${dartDouble(transferTo.lat)},${dartDouble(transferTo.lng)}`,
        );
        expect(guidanceOf(log)).toEqual(guidanceOf(without));
        expect(transferWalks).toHaveLength(1);
      });

      it("乗換つきの候補が無ければ B' は B と同じで、選び直さない", async () => {
        const { m } = await runAb(exactMock({ onExact: () => json(winning()) }));

        expect(m.transferCandidates).toEqual(0);
        expect(m.walkBPrime).toEqual(m.walkB);
        expect(m.transferWon).toBe(false);
      });

      it('厳密走査が失敗すれば transferCandidates は -1', async () => {
        const { m } = await runAb(exactMock({ onExact: () => json({}, 503) }));

        expect(m.transferCandidates).toEqual(-1);
        expect(m.walkBPrime).toEqual(m.walkB);
      });

      it('1行ログに出す', async () => {
        const { m } = await runAb(
          exactMock({ onExact: () => json(withTransfer(transferCandidate())) }),
        );

        expect(m.toLogLine()).toContain(
          'walkBPrime=88 transferCandidates=1 transferDropped=0 transferWon=1',
        );
      });

      it('A/B モードでなければ乗換つきの候補を読まず、経路にも出さない', async () => {
        let captured: RouteSearchMetrics | null = null;
        const plan = await service(
          exactMock({ onExact: () => json(withTransfer(transferCandidate())) }),
          { exactWalkMax: true, onMetrics: (m) => (captured = m) },
        ).plan({
          destination: '目的地',
          destinationLatLng: g,
          departure: new TimeValue({ h: 9, m: 0 }),
          arrival: new TimeValue({ h: 10, m: 40 }),
          origin: o,
          originName: '出発',
        });

        const m = captured!;
        expect(rides(plan)).toEqual(['厳密線']);
        expect(m.walkBPrime).toEqual(-1);
        expect(m.transferCandidates).toEqual(-1);
        expect(m.transferWon).toBe(false);
      });
    });

    it('A/B モードでなければ walkA・walkB は -1、collapseB は null', async () => {
      let captured: RouteSearchMetrics | null = null;
      await service(exactMock({ onExact: () => json(winning()) }), {
        exactWalkMax: true,
        onMetrics: (m) => (captured = m),
      }).plan({
        destination: '目的地',
        destinationLatLng: g,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 40 }),
        origin: o,
        originName: '出発',
      });
      const m = captured!;
      expect(m.walkA).toEqual(-1);
      expect(m.walkB).toEqual(-1);
      expect(m.collapseB).toBeNull();
      expect(m.abMs).toEqual(0);
    });
  });
});

describe('plan: Transit API のずれた駅座標を補正する（#515）', () => {
  const tokyo = [35.681236, 139.767125];
  const kukiJrRaw = [36.06301, 139.66734];
  const kukiGoal = new GeoPoint(36.0656, 139.6775);

  const tokyoToKukiJr = (): JsonMap =>
    guidance([
      {
        journey: {
          departureSecs: 62940,
          arrivalSecs: 66360,
          durationSecs: 3420 + 15 + 996,
          accessWalkSecs: 15,
          egressWalkSecs: 996,
          legs: [
            railLeg({
              route: '宇都宮線（宇都宮方面）',
              fromId: 'jr-u:Tokyo',
              fromName: '東京',
              toId: 'jr-u:Kuki',
              toName: '久喜',
              dep: 62940,
              arr: 66360,
            }),
          ],
        },
        map: {
          points: [],
          segments: [
            mapSeg('walk', 'origin', 'jr-u:Tokyo', 'osmWalk', [tokyo, tokyo]),
            mapSeg('transit', 'jr-u:Tokyo', 'jr-u:Kuki', 'stopOrder', [
              tokyo,
              [35.9, 139.62],
              kukiJrRaw,
            ]),
            mapSeg('walk', 'jr-u:Kuki', 'destination', 'estimatedWalk', [
              kukiJrRaw,
              [kukiGoal.lat, kukiGoal.lng],
            ]),
          ],
        },
      },
    ]);

  const planKuki = async (log: URL[]): Promise<RoutePlan> =>
    service(mock({ transit: tokyoToKukiJr(), log })).plan({
      destination: '久喜駅',
      destinationLatLng: kukiGoal,
      departure: new TimeValue({ h: 17, m: 20 }),
      arrival: new TimeValue({ h: 18, m: 40 }),
      origin: pt(`${tokyo[0]},${tokyo[1]}`),
    });

  it('東京→久喜駅: 久喜で降りたあと「久喜駅」まで17分歩く区間を出さない', async () => {
    const plan = await planKuki([]);
    const lastTrain = plan.segments.findLastIndex((s) => s.type === SegmentType.train);
    expect(plan.segments[lastTrain].toName).toEqual('久喜');
    const afterAlight = plan.segments.slice(lastTrain + 1).reduce((sum, s) => sum + s.minutes, 0);
    expect(afterAlight).toBeLessThanOrEqual(2);
  });

  it('徒歩の実測・引き直しに、ずれた座標を1度も渡さない', async () => {
    const log: URL[] = [];
    await planKuki(log);
    const raw = `${kukiJrRaw[0]},${kukiJrRaw[1]}`;
    const sent = log.flatMap((u) => [...u.searchParams.values()]);
    expect(sent.filter((v) => v.includes(raw))).toEqual([]);
  });
});
