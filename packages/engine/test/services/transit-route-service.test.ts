// 移植元: test/core/services/transit_route_service_test.dart

import { describe, expect, it } from 'vitest';

import type { JsonMap } from '../../src/json';
import { GeoPoint } from '../../src/models/geo-point';
import {
  RouteSegment,
  SegmentType,
  type RoutePlan,
} from '../../src/models/route-plan';
import { TimeValue } from '../../src/models/time-value';
import {
  CancellationToken,
  SearchCanceledException,
} from '../../src/services/cancellation';
import {
  haversineKm,
  RouteCandidate,
} from '../../src/services/hybrid-route-selector';
import {
  TimeoutException,
  type HttpClient,
  type HttpResponse,
} from '../../src/services/http-client';
import {
  ArrivalWaveOutcome,
  RouteSearchMetrics,
} from '../../src/services/route-diagnostics';
import {
  firstMissedTransit,
  trainMetersPerMinute,
  walkMetersPerMinute,
} from '../../src/services/route-plan-builder';
import { RouteException } from '../../src/services/route-service';
import { SearchDeadline } from '../../src/services/search-deadline';
import {
  TransitCorridor,
  TransitOption,
} from '../../src/services/transit-plan-parser';
import { TransitRouteService } from '../../src/services/transit-route-service';
import { dateTime, seconds } from '../../src/time';
import { dartDouble } from '../support/dart-number';
import { deferred } from '../support/deferred';
import { delay } from '../support/delay';
import { expectThrowsA } from '../support/expect';
import {
  first,
  firstWhere,
  last,
  single,
  singleWhere,
} from '../support/iterable';
import { jsonResponse, mockClient } from '../support/mock-client';
import { withTimeout } from '../support/timeout';

const transitBase = 'https://transit.example.com';
const proxyBase = 'https://proxy.example.com';

const json = (body: unknown, status = 200): HttpResponse =>
  jsonResponse(body, status);

const pt = (s: string): GeoPoint => {
  const p = s.split(',');
  return new GeoPoint(Number.parseFloat(p[0]), Number.parseFloat(p[1]));
};

const walkMin = (a: GeoPoint, b: GeoPoint): number =>
  Math.round((haversineKm(a, b) * 1000) / walkMetersPerMinute);

// ---- guidance/plan レスポンス組み立てヘルパ ----

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

const poly = (latLon: number[][]): JsonMap[] =>
  latLon.map((p) => ({ lat: p[0], lon: p[1] }));

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

/// 単一電車 option（access/egress 徒歩あり）。発着秒は 09:06→09:36 を既定にする。
const singleTrainOption = (
  o: { dep?: number; arr?: number; access?: number; egress?: number } = {},
): JsonMap => {
  const dep = o.dep ?? 32760; // 09:06
  const arr = o.arr ?? 34560; // 09:36
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
        mapSeg('walk', 'origin', 'jr:Tokyo', 'osmWalk', [
          [35.68, 139.76],
          stops[0],
        ]),
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

/// computeRouteMatrix プロキシ応答を直線距離（80m/分）で近似して組む。
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

/// computeRoutes(WALK) プロキシ応答を直線距離で近似（enrich が選定と整合するように）。
/// [factor] を上げると「Google 実街路は直線見積りより長い」現実の条件を再現できる
/// （enrich で徒歩が伸び、選定時は予算内だった候補が超過・乗り遅れへ転じる）。
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

/// transit（guidance/plan）と proxy（google walk）をパスで振り分けるモック。
/// [walkFactor] は enrich（computeRoutes WALK）にのみ効き、候補構築の見積り
/// （matrix / guidance）は据え置く。
const mock = (a: {
  transit: JsonMap;
  log?: URL[];
  walkFactor?: number;
}): HttpClient =>
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

/// departure 波と arrival 波（#376）で別の応答を返すモック。`type=arrival` の照会だけ
/// [arrival]（または [onArrival]）へ振り、初回 departure 波も引き直しも [departure] を返す。
///
/// [mock] と分けてあるのは、あちらが**全 guidance 照会へ同一 body を返す**ため——既存
/// テストでは両波の応答が一致して合流が丸ごと dedup され、振る舞いが #376 前と一致する
/// （それ自体が dedup の固定になっている）。波ごとの差を作るテストだけがこちらを使う。
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

/// 崩壊（徒歩最大化の不達）を再現する door-to-door 応答。origin(35.0,139.0) →
/// goal(35.0,139.5)、コリドー3点。ハイブリッドは乗車時間が長く予算外になるので、予算内
/// 候補は徒歩の短い標準乗換だけ＝崩壊状況になる。
///
/// 乗車駅は origin から直線3分（実街路3倍で9分）。09:10 発なので実測徒歩でも間に合う。
/// 乗車駅を遠く（直線11分＝実測33分）に置くと、09:10 発には物理的に乗れない経路になり、
/// 確定境界の乗り遅れ再判定（#254）で全徒歩へ縮退して崩壊判定まで到達しない。
const collapseGuidance = (): JsonMap => {
  const stops = [
    [35.0, 139.003],
    [35.0, 139.25],
    [35.0, 139.49],
  ];
  return guidance([
    {
      journey: {
        departureSecs: 33000, // 09:10
        arrivalSecs: 33900, // 09:25（乗車15分）
        durationSecs: 1500,
        accessWalkSecs: 300, // guidance 見積り 5分
        egressWalkSecs: 300, // guidance 見積り 5分
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

/// 路線ファミリ2種（[familyA] / [familyB]）の共通 origin / goal。
const familyOrigin = new GeoPoint(35.0, 139.0);
const familyGoal = new GeoPoint(35.0, 139.1);

/// ファミリA「特急線」= 総所要最小の単一 base。コリドー2点[近origin, 近goal]で途中乗車の
/// 余地がなく、生成できるハイブリッドの徒歩は access+egress の ~4分止まり。
///
/// 09:03発。勝者(B0→B1)の乗車座標到達は 09:02（前半徒歩2分）なので、実発車時刻検証
/// （approach A）で dep >= boardAt を満たし、時刻なし電車の幽霊便除外に掛からない。
const familyA = (): JsonMap => ({
  journey: {
    departureSecs: 32580, // 09:03
    arrivalSecs: 32880, // 09:08
    durationSecs: 32880 - 32580 + 240,
    accessWalkSecs: 120, // origin->139.002 ≒ 2分
    egressWalkSecs: 120, // 139.098->goal ≒ 2分
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

/// ファミリB「各停線」= Aよりやや遅い（base 順は A→B）。コリドー3点[近origin, 中間,
/// 近goal]。中間で降りて goal まで歩くと徒歩82分・実到着 ~88分（予算100分内）。
const familyB = (): JsonMap => ({
  journey: {
    departureSecs: 32580, // 09:03
    arrivalSecs: 33480, // 09:18（Aより遅い＝base 順は A→B）
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
  });

const origin = new GeoPoint(35.68, 139.76);
const goal = new GeoPoint(35.69, 139.7);

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
    // 全徒歩は origin→goal 直線 ≒70分で予算超過。電車を含む候補が選ばれる。
    // 09:15 発にして「実測徒歩8分で駅着 → 7分待って乗車」と実際に乗れる電車にする。既定の
    // 09:06 発では実測徒歩が見積り5分から8分へ伸びて発車後に駅着＝乗り遅れとなり、確定境界の
    // 再判定（#254）で全徒歩へ縮退する＝「電車を含む経路を返す」前提が崩れる。
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
    // 運賃は Transit API では取得不可（§5）。
    expect(train.fare).toBeNull();
    // 予算内に収まっている。
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });

  it('guidance/plan に geo from/to・date/time・type=departure を送る', async () => {
    const log: URL[] = [];
    const svc = service(
      mock({ transit: guidance([singleTrainOption()]), log }),
    );
    await svc.plan({
      destination: '新宿',
      destinationLatLng: goal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 12, m: 0 }),
      origin,
    });
    // 到着アンカー波（#376）が先に並ぶので、departure 波を型で拾う。
    const g = firstWhere(
      log,
      (u) =>
        u.pathname.includes('guidance/plan') &&
        u.searchParams.get('type') === 'departure',
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
      arrival: new TimeValue({ h: 9, m: 50 }), // 予算が小さく余りが出ない＝非崩壊
      origin,
      originName: '東京駅',
    });
    const m = captured!;
    expect(m.collapseFired).toBe(false);
    expect(m.boardSearchActivated).toBe(false);
    expect(m.boardSearchMs).toEqual(0);
    // 崩壊しなくても初回 guidance の1本は必ず往復している。
    expect(m.guidanceCalls).toBeGreaterThanOrEqual(1);
    expect(m.httpRoundTrips).toBeGreaterThanOrEqual(1);
  });
});

describe('plan: 徒歩最大化', () => {
  it('予算が大きいと標準乗換（access+egress のみ）より歩く候補を選ぶ', async () => {
    // 標準乗換の徒歩は access+egress=10分。予算を広く取れば、コリドー上の駅まで
    // 歩いて乗る・降りて歩くハイブリッド／全徒歩で徒歩が増える。
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
  // 1回の guidance/plan レスポンスに路線ファミリを2種入れる。
  // ・ファミリA「特急線」= 総所要最小の単一 base。コリドー2点[近origin, 近goal]で
  //   途中乗車の余地がなく、生成できるハイブリッドの徒歩は access+egress の ~4分止まり。
  // ・ファミリB「各停線」= やや遅い。コリドー3点[近origin, 中間, 近goal]。中間で降りて
  //   goal まで歩くと徒歩82分・実到着 ~88分（予算100分内）。
  // 単一最速 base（=A）だけを土台にすると B のコリドー由来ハイブリッドは原理的に
  // 生成されず、徒歩は A の ~4分へ縮退する。複数 base に拡張して初めて B の徒歩82分
  // 候補がプールに入り選定対象になる。全徒歩(114分)は予算外なので勝てない。
  const o = familyOrigin;
  const g = familyGoal;

  it('別路線ファミリのコリドー由来の徒歩多め候補が選ばれる', async () => {
    const svc = service(mock({ transit: guidance([familyA(), familyB()]) }));
    const plan = await svc.plan({
      destination: '目的地',
      destinationLatLng: g,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 40 }), // 予算100分
      origin: o,
      originName: '出発',
    });
    const walkMinutes = plan.segments
      .filter((s) => s.type === SegmentType.walk)
      .reduce((a, s) => a + s.minutes, 0);
    // ファミリA単独では ~4分が上限。B のコリドーを土台にして初めて到達できる徒歩量。
    expect(walkMinutes).toBeGreaterThan(40);
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
    // 勝者の電車区間がファミリB由来（各停線）であること＝B のコリドーから生成された証拠。
    expect(
      plan.segments.some(
        (s) => s.type === SegmentType.train && s.line === '各停線',
      ),
    ).toBe(true);
  });

  it('複数 base に広げても guidance/plan 照会は増えない（増分APIコストゼロ）', async () => {
    // base 拡張とハイブリッド生成は取得済み options と Google マトリクスだけで完結し、
    // 新規 transit 照会を発行しない。素朴に base ごと door-to-door を再照会する実装なら
    // origin 発の照会が base 数に比例して増える。乗車座標発の勝者検証照会が別途載るため、
    // 総数ではなく origin 発の本命照会数で base 比例の退行を検出する。
    // origin 発は departure 波・arrival 波（#376）の2本で固定＝base 数には比例しない。
    const log: URL[] = [];
    const svc = service(
      mock({ transit: guidance([familyA(), familyB()]), log }),
    );
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
        u.pathname.includes('guidance/plan') &&
        u.searchParams.get('from') === 'geo:35.0,139.0',
    ).length;
    expect(mainCalls).toEqual(2);
    const guidanceCalls = log.filter((u) =>
      u.pathname.includes('guidance/plan'),
    ).length;
    expect(guidanceCalls).toBeLessThanOrEqual(6);
  });

  it('路線名を欠く別コリドーも別ファミリとして徒歩多め候補を生む', async () => {
    // routeName を持たない leg 2種（急行=2点コリドー / 各停=3点コリドー、端点は共有）。
    // 空文字で畳むと同一ファミリ扱いで最速1本へ退行するが、コリドー形状で区別すれば
    // 各停コリドー由来の徒歩多め候補（徒歩82分）が生成される（Codex 指摘の反証）。
    const unnamed = (stops: number[][], arr: number): JsonMap => ({
      journey: {
        departureSecs: 32580, // 09:03
        arrivalSecs: arr,
        durationSecs: arr - 32580 + 240,
        accessWalkSecs: 120,
        egressWalkSecs: 120,
        legs: [
          {
            kind: 'transit',
            mode: 'rail', // routeName なし＝RouteSegment.line は null
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
          mapSeg('walk', 'origin', 'u:board', 'osmWalk', [
            [35.0, 139.0],
            stops[0],
          ]),
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
          ), // 急行 09:08
          unnamed(
            [
              [35.0, 139.002],
              [35.0, 139.03],
              [35.0, 139.098],
            ],
            33480,
          ), // 各停 09:18
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

describe('basesForHybrid: 路線ファミリ別 base 選定 (#292)', () => {
  // 電車1本＋2点コリドーの最小 option。line がファミリ、minutes が総所要を決める。
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

  const lines = (os: TransitOption[]): (string | null)[] =>
    os.map((o) => first(o.segments).line);

  it('同所要のタイブレークは代表(最短)option の出現順に従う', () => {
    const svc = service(mock({ transit: guidance([]) }));
    // A(20分), B(10分), A(10分)。単一 base 選定は最短10分の初出=B を採る。
    // 素朴に「ファミリ初出位置」でタイブレークすると A(初出index0) が先に来てしまう。
    // 代表(最短)option の位置で比べれば B(index1) < A の代表(index2) で B が先。
    const bases = svc.basesForHybrid([opt('A', 20), opt('B', 10), opt('A', 10)]);
    expect(lines(bases)).toEqual(['B', 'A']);
    // ファミリ A の代表は 20分の初出ではなく 10分の option。
    expect(first(bases[1].segments).minutes).toEqual(10);
  });

  it('先頭は総所要最小のファミリ（単一ファミリ時は1本）', () => {
    const svc = service(mock({ transit: guidance([]) }));
    expect(lines(svc.basesForHybrid([opt('A', 30), opt('B', 12)]))).toEqual([
      'B',
      'A',
    ]);
    expect(lines(svc.basesForHybrid([opt('A', 30), opt('A', 12)]))).toEqual([
      'A',
    ]);
  });

  it('ファミリ数が上限を超えたら総所要の小さい代表から選ぶ', () => {
    const svc = service(mock({ transit: guidance([]) }));
    const bases = svc.basesForHybrid([
      opt('A', 40),
      opt('B', 10),
      opt('C', 20),
      opt('D', 30),
    ]);
    // 上限3本。総所要昇順で B(10),C(20),D(30) を採り A(40) は落とす。
    expect(lines(bases)).toEqual(['B', 'C', 'D']);
  });

  // 電車1本 option（コリドー座標を指定）。空/欠落 routeName の区別検証用。
  const optAt = (
    line: string | null,
    minutes: number,
    coords: GeoPoint[],
  ): TransitOption =>
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
    // 空文字を素朴に畳むと同一ファミリ化して1本へ退行する（Codex 指摘）。null も空文字も
    // 「無名」としてコリドー形状で区別すれば、別コリドーは別 base として残る。
    expect(
      svc.basesForHybrid([optAt('', 10, corridorA), optAt('', 20, corridorB)]),
    ).toHaveLength(2);
    expect(
      svc.basesForHybrid([
        optAt(null, 10, corridorA),
        optAt(null, 20, corridorB),
      ]),
    ).toHaveLength(2);
  });
});

describe('mergeHybrids: 予算内優先の上限マージ (#292)', () => {
  // 徒歩 [walkMinutes] 分の単一区間候補（polyline を [tag] で一意化し dedup キーを分ける）。
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
    // base0: 予算外(徒歩80) と 予算内(徒歩50)。base1: 予算内(徒歩40)。
    const over = cand(80, 139.1);
    const within1 = cand(50, 139.2);
    const within2 = cand(40, 139.3);
    const merged = svc.mergeHybrids(
      [[over, within1], [within2]],
      (h) => h !== over, // over のみ予算外
    );
    // 3件すべて残るが、予算内(within1/within2)が予算外(over)より前に並ぶ。
    expect(merged).toHaveLength(3);
    expect(merged.indexOf(over)).toBeGreaterThan(merged.indexOf(within1));
    expect(merged.indexOf(over)).toBeGreaterThan(merged.indexOf(within2));
  });
});

describe('plan: 崩壊判定の測定基準（#137 指摘2）', () => {
  // 標準乗換の徒歩(access+egress)を guidance は小さく見積もるが、Google 実街路は
  // 大きく出る（街路は直線の下限を上回る）。崩壊判定（isCollapse）が enrich 後の
  // 「実街路で膨らんだ徒歩」を基準にすると、予算余り・徒歩マージンの両条件が実測値で
  // 潰れて乗車駅探索（board search）が起動せず、徒歩最大化が silent に不達になる。
  // 判定は enrich 前（guidance 見積り）基準で行うべき。
  //
  // origin→goal は全徒歩が予算外、電車で高速、コリドーは3点。ハイブリッドは乗車時間が
  // 長く予算外 → 予算内候補は短徒歩の標準乗換のみ＝崩壊状況。実街路を直線の3倍で返す。
  const origin2 = new GeoPoint(35.0, 139.0);
  const goal2 = new GeoPoint(35.0, 139.5);

  // 徒歩を直線の3倍で返すモック（実街路の迂回を模す）。guidance 呼び出しを記録する。
  const inflatedMock = (
    guidanceCalls: URL[],
    o: { delay?: number } = {},
  ): HttpClient => {
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
      // 壁時計を測るテストは、遅延ゼロだと経過が 1ms 未満を切り捨てて 0 になり
      // 配線の有無を区別できない。上流1本ぶんを決定的に払わせる。
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
      arrival: new TimeValue({ h: 10, m: 0 }), // 予算60分
      origin: origin2,
      originName: '出発',
    });
    // 崩壊判定が enrich 前（guidance 見積り）基準で成立 → 乗車駅探索が引き直し
    // （guidance を複数回）する。enrich 後の膨らんだ徒歩を使うと崩壊判定が潰れ、
    // 初回 guidance 1回だけで終わってしまう（指摘2の回帰）。
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
    // board-search は乗車駅探索でマトリクスを引く → matrixCalls が立つ。
    expect(m.matrixCalls).toBeGreaterThan(0);
    // 初回 + 引き直しで guidance は複数本。合計 http は種別合計に一致する。
    expect(m.guidanceCalls).toBeGreaterThan(1);
    expect(m.httpRoundTrips).toEqual(
      m.guidanceCalls + m.walkCalls + m.matrixCalls,
    );
  });

  it('崩壊後の再選定で払った enrich も enrichMs が覆う (#309)', async () => {
    // enrich 台帳は崩壊後の再選定ぶんも積む。enrichMs が board-search 突入時点で
    // 止まったままだと、臨界パスが「覆っている区間」を超えて enrichMs より大きくなり、
    // `enrichMs − enrichCriticalMs − bestEffortMs`（計上外の残り）が負に化ける。
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
    expect(
      m.enrichCriticalMs,
      '臨界パスは enrichMs が覆う区間の部分集合',
    ).toBeLessThanOrEqual(m.enrichMs);
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

    // 電車区間に乗降駅名が入る（コリドー候補は座標のみで駅名を持たないため、
    // 確定後に乗車座標→降車座標で1回引き直して leg の実駅名を復元する）。
    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);
    expect(train.fromName).toEqual('乗車駅');
    expect(train.toName).toEqual('降車駅');

    // 乗車駅ノード（電車カード直上）の place に駅名が出る。タイムラインの place は
    // 直前・直後の徒歩区間の端点を使うため、駅名が伝播していることを確かめる。
    const places = plan.timelineNodes.map((n) => n.place);
    expect(places).toContain('乗車駅');
  });

  it('前半徒歩が単独で予算外の遠いコリドー点は guidance を引き直さない（#317）', async () => {
    // コリドー点 139.25 / 139.49 は origin(139.0) から実測徒歩だけで予算60分を大きく
    // 超過する（inflatedMock は徒歩を直線×3で返す）。到着 = t1 + t2(≥0) なので、これらは
    // 引き直すまでもなく確実に予算外。matrix プレ実測で t1 を先に測り、探索範囲を予算内の
    // 最遠点まで刈ることで、遠点への guidance 引き直しを起こさない（#317: 直列 guidance
    // 積み上げの削減）。刈らない実装では二分探索が index1(139.25) を probe して引き直す。
    const guidanceCalls: URL[] = [];
    const svc = service(inflatedMock(guidanceCalls));
    await svc.plan({
      destination: '降車駅',
      destinationLatLng: goal2,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 0 }), // 予算60分
      origin: origin2,
      originName: '出発',
    });

    const fromLng = (u: URL): number | null => {
      const f = u.searchParams.get('from');
      if (f === null) return null;
      const parsed = Number.parseFloat(f.replace('geo:', '').split(',')[1]);
      return Number.isNaN(parsed) ? null : parsed;
    };

    const queriedLngs = guidanceCalls
      .map(fromLng)
      .filter((lng): lng is number => lng !== null);
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
  // 直線推定は実街路に対し大きく楽観に倒れることがある（実機で -36分/25%）。乗車駅探索の
  // 二分探索を直線推定で駆動すると、目的地寄りの遠い乗車駅へ収束し、実街路では全部予算
  // 超過 → 固定段数の後退では真の境界（ずっと手前）に届かず null → 徒歩最小の標準乗換へ
  // 崩落して大量に余る。二分探索を実測（Google walk）で駆動すれば、予算内・徒歩最大の
  // 中庸な乗車駅を取りこぼさない。
  const origin3 = new GeoPoint(35.0, 139.0);
  const goal3 = new GeoPoint(35.0, 139.05);
  const transfer = 139.025; // 乗換駅 T（コリドー中央）
  const inflate = 6; // Google 実街路 = 直線 ×6（遠いほど直線が楽観に倒れるのを模す）

  // 基準経路は2区間（origin→T→goal）。乗車駅探索のハイブリッドは「同一区間内 b→a」しか
  // 張れないため、区間1で降りると egress(T→goal) が ×6 で予算超過、区間2で乗ると前半徒歩
  // (origin→区間2) が予算超過 → どの中庸ハイブリッドも作れない。引き直し（board-search）
  // だけが多区間を1本に繋いで中庸の乗車駅を出せる、という構造をつくる。
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

  // 基準（標準）経路：2区間を速い1本で走る。access/egress 0 で徒歩最小・大量に余る＝
  // 崩壊状況をつくる。区間A着 [aArr]・区間B着 [bArr] で所要を変えられる（既定は計20分）。
  const baseGuidance = (
    o: { aArr?: number; bArr?: number } = {},
  ): JsonMap => {
    const aArr = o.aArr ?? 33000;
    const bArr = o.bArr ?? 33600;
    return guidance([
      {
        journey: {
          departureSecs: 32400, // 09:00
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

  // 乗車駅 X からの引き直し便：乗車待ち0（dep=照会時刻）、goal までを残距離から概算した
  // 1本の電車で繋ぐ自己整合な実在便。X が goal に近いほど前半徒歩は伸びるが乗車は短い。
  const reentry = (lng: number, time: string): JsonMap => {
    const dep = secsOf(time);
    const remainMin = Math.round(
      (haversineKm(new GeoPoint(35.0, lng), goal3) * 1000) /
        trainMetersPerMinute,
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
      // サーバ MATRIX_MAX_ELEMENTS(25) を再現：超過は 400 で全滅（→直線推定のみへ縮退）。
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
        // 種別ごとに異なる遅延を入れられるようにする。プローブ内訳の計上
        // （[ProbeLatencyLedger]）は「どちらが何ミリ秒だったか」を分けて測るので、
        // 遅延ゼロのモックでは両方 0 になり配線ミスを検出できない。
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
    plan.segments
      .filter((s) => s.type === SegmentType.walk)
      .reduce((a, s) => a + s.minutes, 0);

  it('楽観推定で遠い駅へ収束せず、実測で予算内・徒歩最大の乗車駅を選ぶ', async () => {
    const svc = service(inflatedFromMock());
    const plan = await svc.plan({
      destination: '目的駅',
      destinationLatLng: goal3,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 30 }), // 予算90分
      origin: origin3,
      originName: '出発',
    });
    // 乗車駅探索が実測で中庸の乗車駅を見つけ、徒歩最小の標準乗換（徒歩~0・余り~80分）へ
    // 崩落しない。直線推定駆動だと遠い駅へ収束→実街路全滅→null→標準へ崩落し徒歩~0。
    expect(walkMinutesOf(plan)).toBeGreaterThan(50);
    expect(plan.totalMin).toBeLessThanOrEqual(90);
  });

  it('引き直しが 429 で落ちた点は予算外扱いにせず、徒歩最大化を縮めない（#333）', async () => {
    // コリドー手前の1点（139.00266）への引き直しだけが 429 で落ちる状況。予算外として
    // 扱うと、単調性の仮定によりその点より奥が探索区間から丸ごと外れる（実測ログでは
    // 区間が 0..1 へ畳まれ、より遠い＝徒歩の長い乗車駅に一度も到達しない）——境界を実測
    // ではなくレート制限が決めることになる。未評価として扱えば、同一ラウンドの他 probe が
    // 区間を右へ送るので探索は奥まで届く。
    //
    // 判定は「429 の有無で結論が変わらないこと」。閾値ではなく無失敗時の実測と突き合わせる
    // ——被害はラウンド内では出ず「探索されなかった先」に出るので、固定閾値だと
    // 同一ラウンドで既に評価済みの候補（#137 の全件返し）に隠れて偽陽性になる。
    const walkWith = async (
      rateLimit: ((lng: number) => boolean) | null,
    ): Promise<number> => {
      const plan = await service(
        inflatedFromMock({ rateLimitFrom: rateLimit }),
      ).plan({
        destination: '目的駅',
        destinationLatLng: goal3,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 30 }), // 予算90分
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

    expect(rateLimited, '前提: 429 の点が実際に probe されている').toBeGreaterThan(
      0,
    );
    expect(healthy, '前提: 無失敗なら徒歩最大化が効いている').toBeGreaterThan(50);
    expect(withFailure, '429 が徒歩最大化の境界を決めてしまっている').toEqual(
      healthy,
    );
  });

  it('絶対値の余りが大きければ相対閾値未満でも崩壊として乗車駅探索を起動する', async () => {
    // 標準乗換が予算100分で着き余り50分。予算150分なので相対閾値（0.4×150=60分）には
    // 届かないが、50分は絶対的に大きく歩ける余地がある（実機の下北沢ケース 147/97/50 相当）。
    // 相対閾値だけだと崩壊判定が起動せず徒歩~0・大余りのまま。絶対値条件で起動させる。
    const calls: URL[] = [];
    const plan = await service(
      inflatedFromMock({
        aArr: 35400, // 区間A着 09:50
        bArr: 38400, // 区間B着 10:40（標準は約100分で着く）
        guidanceCalls: calls,
      }),
    ).plan({
      destination: '目的駅',
      destinationLatLng: goal3,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 11, m: 30 }), // 予算150分
      origin: origin3,
      originName: '出発',
    });
    // 崩壊判定が絶対値の余りで成立 → board-search が複数回 guidance を引く。相対閾値のみだと
    // 初回 guidance 1回で終わり徒歩~0のまま（回帰）。
    expect(calls.length).toBeGreaterThan(1);
    expect(walkMinutesOf(plan)).toBeGreaterThan(50);
    expect(plan.totalMin).toBeLessThanOrEqual(150);
  });

  it('コリドーが密で25点超でも matrix を分割して投げる（MATRIX_MAX_ELEMENTS・#317 レビュー）', async () => {
    // leg1+leg2 で最大60点のコリドー。単発 matrix は要素数超過で 400 全滅し、board-search の
    // t1 プレ実測が直線推定のみへ縮退する（実測で予算外の近点を刈れず guidance を無駄に引く）。
    // 目的地を25以下ずつに分割すれば実測が通る。
    const dests: number[] = [];
    const svc = service(
      inflatedFromMock({ matrixDests: dests, enforceMatrixLimit: true }),
    );
    await svc.plan({
      destination: '目的駅',
      destinationLatLng: goal3,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 30 }), // 予算90分（崩壊→board-search 起動）
      origin: origin3,
      originName: '出発',
    });

    expect(dests).not.toHaveLength(0);
    expect(
      dests.every((c) => c <= 25),
      'matrix 目的地が MATRIX_MAX_ELEMENTS(25) を超えている（400 全滅の原因）',
    ).toBe(true);
    // board-search の t1 プレ実測が実際に走った担保（ハイブリッドの ≤11 と区別できる分割）。
    expect(
      dests.some((c) => c > 11),
      '前提: board-search の matrix プレ実測が走る',
    ).toBe(true);
  });

  it('enrich を「パス本数」と「1候補の直列段数」に分けて計上する', async () => {
    // #318 Option A が潰すのは本数、潰せないのは段数。1つの ms に混ぜると、
    // 「Option A が効いているのに enrich が重い」を説明できず削る対象を取り違える。
    let captured: RouteSearchMetrics | null = null;
    // 遅延ゼロのモックだと1候補の連鎖が 1ms 未満に収まり criticalMs が 0 になる
    // （配線の有無と区別できない）。上流に最低限の遅延を入れて決定的にする。
    const svc = service(
      inflatedFromMock({ walkDelay: 10, guidanceDelay: 20 }),
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
    const m = captured!;
    // 引き直し便が実 depTime を持つこの fixture では段数は 0（＝正しい値）。段数が
    // 立つ経路の固定は approach A のテスト群が持つ。
    expect(m.enrichResolveDepth).toEqual(0);
    expect(m.enrichPasses).toBeGreaterThan(0);
    expect(m.enrichCandidates).toBeGreaterThanOrEqual(m.enrichPasses);
    // 臨界パスはフェーズ全体を超えない。**0 でも正しい**——この fixture の測定候補は
    // 徒歩がレッグキャッシュに当たり引き直しも0段なので上流 I/O をまったく払わない。
    // 「実測したら必ず >0」は成り立たず、それを固定するのは I/O が走る approach A 側。
    expect(
      m.enrichCriticalMs,
      '崩壊時の再選定は boardSearchMs 側に計上されるため両方を上界に採る',
    ).toBeLessThanOrEqual(m.enrichMs + m.boardSearchMs);
  });

  it('ラウンドごとの徒歩推移を記録し、最終徒歩と突き合わせられるようにする', async () => {
    // 「63秒かける価値があるか」＝「ラウンド N で止めたら徒歩が短くなるか」を判定する材料。
    // 系列は単調非減少で、頭打ちの位置が打ち切ってよいラウンドを意味する。
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
    // 単調非減少：評価済みの最大なので下がることはない。下がるなら畳み方が壊れている。
    for (let i = 1; i < m.boardSearchWalkByRound.length; i++) {
      expect(m.boardSearchWalkByRound[i]).toBeGreaterThanOrEqual(
        m.boardSearchWalkByRound[i - 1],
      );
    }
    // 最終徒歩が指標に載る（profile では [route] ログが出ないため必須）。
    expect(m.finalWalkMinutes).toBeGreaterThan(0);
    // 勝者のラウンド由来が引ける。この fixture は board-search 候補が勝つので N≥1。
    // -1（未起動）でも 0（由来でない/特定不能）でもない値が出ることを固定する。
    expect(
      m.boardSearchWinnerRound,
      '前提: board-search 候補が確定し、同一性で引けている',
    ).toBeGreaterThanOrEqual(1);
    expect(
      m.boardSearchWinnerRound,
      'ラウンド番号は実際に回した数を超えない',
    ).toBeLessThanOrEqual(m.boardSearchRounds);
  });

  it('プローブ内の「徒歩実測→引き直し」の直列を、同一 run の反実仮想として計上する', async () => {
    // 直列を解く改修（matrix が既に測った t1 で boardAt を組み、徒歩実測をジオメトリ用に
    // 並行させる）が何秒縮めるかを、実装前に判定するための計上。上流のばらつきは
    // serial/parallel の両方へ等しく乗るので、同一 run の差だけを見れば別 run の A/B が
    // 抱える識別不能（#332）を避けられる。
    let captured: RouteSearchMetrics | null = null;
    const svc = service(
      inflatedFromMock({ walkDelay: 30, guidanceDelay: 60 }),
      { onMetrics: (m) => (captured = m) },
    );
    await svc.plan({
      destination: '目的駅',
      destinationLatLng: goal3,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 30 }), // 予算90分（崩壊→board-search 起動）
      origin: origin3,
      originName: '出発',
    });
    const m = captured!;
    expect(m.boardSearchActivated, '前提: board-search が走る').toBe(true);
    // 徒歩ぶんが serial にだけ乗る＝改修で消える上限が正の値として現れる。両方を同じ
    // 台帳から採らないとこの差は意味を持たない。
    expect(m.boardSearchProbeSerialMs).toBeGreaterThan(
      m.boardSearchProbeParallelMs,
    );
    // ラウンドは直列に積むので、各ラウンドの最遅プローブ（≥30+60ms）の和以上になる。
    // endRound の配線を落とすと1ラウンドぶんしか出ず、ここが落ちる。
    expect(m.boardSearchProbeSerialMs).toBeGreaterThanOrEqual(
      m.boardSearchRounds * 90,
    );
  });

  it('matrix プレ実測のチャンクを並列に投げる（#317 レビュー）', async () => {
    // コリドー60点 → scan は 25/25/10 の3チャンク。>11 の2チャンクが互いの到達まで
    // ブロックする関門を張り、直列（1本目が関門で止まり2本目が発行されない）なら
    // デッドロック→timeout で fail する。ハイブリッドのアクセス徒歩 matrix は ≤11 で素通り。
    const probeA = deferred<void>();
    const probeB = deferred<void>();
    const barrier = (): Promise<unknown> =>
      Promise.all([probeA.promise, probeB.promise]);
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
        return json(
          Math.abs(lng - 139.0) < 1e-6 ? baseGuidance() : reentry(lng, time),
        );
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

    expect(
      probeA.isCompleted && probeB.isCompleted,
      '前提: 2チャンクが並列に発火する',
    ).toBe(true);
  });

  describe('検索の締切 (#300)', () => {
    /// 初期 guidance が発行された直後に予算を使い切る締切。実機の「必須の1本は間に合った
    /// が、引き直しの途中で待ち時間の上限に達した」を決定的に再現する。締切を最初から
    /// 期限切れにすると必須の初期照会まで落ちてしまい、再現したい状況とは別物になる。
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
      // shouldContinue は「新しいラウンドを起こす前」にしか呼ばれない。締切が
      // ラウンド実行中に切れると probe は TIMEOUT →「予算外」と解釈されて区間が尽き、
      // shouldContinue を再び通らずにループが自然終了する＝打ち切りを取りこぼす。
      //
      // それを再現するため、**探索が全ラウンドを回し終えた後**に切れる締切を作る。
      // 締切なしで同じ検索を1回流して guidance の総本数を数え、その本数に達した
      // 時点で切らせれば、shouldContinue は一度も false を返さない。この条件で
      // truncated が立つかどうかが、探索後チェックの有無をそのまま反証する。
      const baseline: URL[] = [];
      await serviceWith(
        inflatedFromMock({ guidanceCalls: baseline }),
        SearchDeadline.none(),
      ).plan({
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
      // 締切が絡んだ探索の境界は「実測で確定した境界」ではなく、締切で手前に
      // 止まった値であり得る。probe 配置の判断材料（境界位置の分布）へ確定値として
      // 混ぜないよう、印を残すことを固定する。
      //
      // ラウンド実行中に締切が切れた場合、probe は TIMEOUT →「予算外」と解釈されて
      // 区間が尽き、shouldContinue を再び通らずにループを抜ける。つまり「新ラウンドを
      // 起こさなかった」判定だけでは取りこぼす——探索後の締切チェックが要る。
      const calls: URL[] = [];
      let captured: RouteSearchMetrics | null = null;
      const svc = serviceWith(
        inflatedFromMock({ guidanceCalls: calls }),
        // board-search が**起動した後**に予算を使い切る。起動前に切れると探索自体を
        // 起こさず縮退するので（best=-1 で集計対象外）、再現したい状況と別物になる。
        // 初期2本（departure 波＋到着アンカー波・#376）＋引き直し1本が出た時点で
        // 切らせ、探索の途中で締切に掛からせる。
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
      // 締切に掛かった以上、境界を確定値として集計へ流してはならない。
      expect(captured!.boardSearchTruncated).toBe(true);
    });

    it('締切を使い切っても確定経路は返る（引き直しの全滅で失敗させない）', async () => {
      const calls: URL[] = [];
      const svc = serviceWith(
        inflatedFromMock({ guidanceCalls: calls }),
        expiringAfterFirstGuidance(calls),
      );

      // 締切は縮退の合図であって失敗ではない。徒歩最大化は諦めても経路は返す。
      // 引き直しの TIMEOUT が plan() まで伝播したらここで throw して赤くなる。
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

      // 初期照会の2本（departure 波と到着アンカー波・#376）だけ。両波は締切が切れる前に
      // 同時発行される。締切なしの同条件（上のテスト群）では board-search が続けて複数本
      // 引く。残予算0で投げた照会は必ず打ち切られる＝上流を無駄に叩くだけなので、送る前に落とす。
      expect(calls).toHaveLength(2);
    });

    it('締切超過後は board-search の matrix プレ実測も投げない（#317 レビュー）', async () => {
      // proxy（matrix）は締切に縛られず（deadlineApplies:false）走ってしまう。締切切れなら
      // board-search 自体を起こさず、その t1 プレ実測（コリドー~60点を25以下ずつ分割＝>11 の
      // matrix 要求）を投げない。ハイブリッドのアクセス徒歩 matrix は ≤11 なので区別できる。
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
      // ハイブリッドのアクセス徒歩 matrix（≤11）は締切後も走るので空にはならない
      // （空だと every が自明成立して反証にならない）。
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
        // 使い切らない締切。ゲート・クランプが正常系を邪魔していないことの反証。
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
  // 標準乗換のアクセス徒歩は guidance 見積りで選定されるが、enrich で Google 実街路
  // （直線の数倍）に差し替わると徒歩が伸び、予定の先頭電車に乗り遅れる（駅着が発車後）
  // ことがある。予算内のままでも実際には乗れない経路なので、enrich 後に乗り遅れたら
  // 除外して乗れる次善へ選び直す。コリドーは1点（base=null）でハイブリッド／乗車駅探索が
  // 走らない純粋な標準乗換どうしの比較にする。
  const origin4 = new GeoPoint(35.0, 139.0);
  const goal4 = new GeoPoint(35.0, 139.02);
  const inflate = 2; // enrich の Google 実街路 = 直線 ×2

  // A: アクセス徒歩 5分（見積り）で 09:06 発に間に合うが、×2 で 9分に伸び乗り遅れる。
  //    徒歩見積りは B より大きいので素の選定では A が先に選ばれる。
  // B: アクセス徒歩 0（出発地で乗車）。enrich でも乗り遅れない＝乗れる次善。
  const twoOptions = (): JsonMap =>
    guidance([
      {
        journey: {
          departureSecs: 32400,
          arrivalSecs: 33660,
          durationSecs: 1260,
          accessWalkSecs: 300, // 見積り5分
          egressWalkSecs: 60,
          legs: [
            railLeg({
              route: '快速A',
              fromId: 'aBoard',
              fromName: '乗車A',
              toId: 'aAlight',
              toName: '降車A',
              dep: 32760, // 09:06
              arr: 33600, // 09:20
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
            // 1点コリドー → base=null（ハイブリッド・乗車駅探索を起こさない）。
            mapSeg('transit', 'aBoard', 'aAlight', 'stopOrder', [
              [35.0, 139.0095],
            ]),
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
              dep: 32880, // 09:08
              arr: 33780, // 09:23
            }),
          ],
        },
        map: {
          points: [],
          segments: [
            mapSeg('transit', 'bBoard', 'bAlight', 'stopOrder', [
              [35.0, 139.0099],
            ]),
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
    // 締切が実測徒歩の最終検証を飛ばすと、A は見積り（アクセス徒歩5分）のまま
    // 「09:06 発に間に合う」と判定されて確定してしまう。実街路では9分＝乗り遅れる。
    // 締切は探索を打ち切ってよいが、確定経路の検証まで飛ばしてはならない——不変条件
    // 「実測徒歩で乗り遅れる経路を確定・提示しない」（#254）は締切より優先する。
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

    // firstMissedTransit や totalMin を plan 自身へ当てても検出できない——実測を
    // 飛ばした経路は楽観値を自分で持っており、自己整合してしまう（全徒歩を「23分」と
    // 名乗る）。この fixture の地上真実「実街路＝直線×2」に照らして反証する：全徒歩は
    // 実際には46分で予算35分を超えるので、確定経路は電車を含まねばならない。
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
      arrival: new TimeValue({ h: 9, m: 35 }), // 予算35分（全徒歩は45分で予算外）
      origin: origin4,
      originName: '出発',
    });
    // 確定経路は実街路徒歩でも乗り遅れない。A を返すと駅着が発車後で実際には乗れない。
    const departureAt = dateTime(2026, 6, 27, 9, 0);
    expect(firstMissedTransit(plan.segments, departureAt)).toBeNull();
    // 電車を含む（全徒歩は予算外なので縮退していない）＝乗れる B 系へ切り替わっている。
    expect(plan.segments.some((s) => s.type === SegmentType.train)).toBe(true);
    expect(plan.totalMin).toBeLessThanOrEqual(35);
  });
});

// reject後の残り予算内候補を1並列バッチで実測（#315 B）。徒歩最大の見積り勝者が
// 楽観ハイブリッド（実測で乗り遅れ・予算超過）だと、旧実装は徒歩tier を1本ずつ直列に
// 降りて reject ごとに上流 guidance を数珠つなぎにしていた。最上位 tier が全滅したら残りを
// 1バッチで一括実測する。fake client の deferred バリア——「降下先の2候補の access 徒歩
// enrich が**両方**到達するまで応答を返さない」——で一括並列を検証する。旧の tier 直列降下は
// 徒歩最大の生存者を見つけた時点で下位候補を測らない＝下位の probe が発火せずデッドロック
// （timeout で fail）し、一括バッチ実装でのみ完走する。
describe('plan: reject後の残り候補を1並列バッチで実測 (#315 B)', () => {
  const o = new GeoPoint(35.0, 139.0);
  const g = new GeoPoint(35.0, 139.06); // 直線 ~5.5km（全徒歩 ~68分＝予算60分外）
  const topBoard = [35.0, 139.013]; // 徒歩最大の見積り勝者（ghost: ×2 enrich で乗り遅れ）
  const midBoard = [35.0, 139.009]; // 降下先・徒歩中（生存＝勝者）
  const lowBoard = [35.0, 139.006]; // 降下先・徒歩少（生存だが徒歩で mid に負ける）
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
        mapSeg('walk', 'origin', `${a.route}:board`, 'osmWalk', [
          [o.lat, o.lng],
          a.board,
        ]),
        mapSeg(
          'transit',
          `${a.route}:board`,
          `${a.route}:alight`,
          'stopOrder',
          [alight],
        ),
        mapSeg('walk', `${a.route}:alight`, 'destination', 'estimatedWalk', [
          alight,
          [g.lat, g.lng],
        ]),
      ],
    },
  });

  // T: 徒歩15分・09:16発（見積り最速で徒歩最大＝見積り勝者。×2 enrich で駅着09:30＝乗り遅れ）。
  //    見積りでは M・L を厳密支配するので先行実測フロントには載らず、winner-phase で棄却される。
  // M: 徒歩10分・09:30発（×2 enrich でも間に合う＝徒歩最大の生存者＝勝者）。
  // L: 徒歩7分・09:30発（×2 enrich でも間に合うが徒歩で M に負ける）。
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
    const barrier = (): Promise<unknown> =>
      Promise.all([probeM.promise, probeL.promise]);
    const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

    const client = mockClient(async (url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) {
        const gl = pt(url.searchParams.get('goal') ?? '0,0');
        // 降下先 M・L の access 徒歩 enrich だけを両到達までブロックする（T の access・
        // egress・全徒歩は即応答）。
        if (near(gl.lat, midBoard[0]) && near(gl.lng, midBoard[1])) {
          if (!probeM.isCompleted) probeM.complete(undefined);
          await barrier();
        } else if (near(gl.lat, lowBoard[0]) && near(gl.lng, lowBoard[1])) {
          if (!probeL.isCompleted) probeL.complete(undefined);
          await barrier();
        }
        return walkFor(url, { factor: 2.0 }); // 実街路＝直線×2（T は乗り遅れ）
      }
      if (path.includes('guidance/plan')) return json(threeOptions());
      return json({}, 404);
    });

    const plan = await withTimeout(
      service(client).plan({
        destination: '目的地',
        destinationLatLng: g,
        departure: new TimeValue({ h: 9, m: 0 }),
        arrival: new TimeValue({ h: 10, m: 0 }), // 予算60分（全徒歩は予算外）
        origin: o,
        originName: '出発',
      }),
      5000,
      () =>
        expect.fail(
          'reject 後の降下先候補が1バッチで並行実測されない（tier 直列降下でデッドロック）',
        ),
    );

    expect(
      probeM.isCompleted,
      '前提: 降下先 M の access 徒歩 enrich が発火',
    ).toBe(true);
    expect(
      probeL.isCompleted,
      '一括バッチなら徒歩最大 M が勝っても徒歩少 L も同バッチで実測される',
    ).toBe(true);
    // 退行ガード: 乗り遅れる T を棄却し、降下先で徒歩最大の生存者 M を勝者に確定する。
    const departureAt = dateTime(2026, 6, 27, 9, 0);
    expect(firstMissedTransit(plan.segments, departureAt)).toBeNull();
    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);
    expect(train.line, '降下先で徒歩最大の生存者 M が勝者のはず').toEqual('快速M');
    expect(plan.totalMin).toBeLessThanOrEqual(60);
  });
});

// Option A（#318）: 予算内にコリドー由来の楽観ハイブリッドが多い reject 多発ルートでは、
// 先行実測を「見積りフロント」から「予算内短リスト全体」へ広げ、reject 後の2パス目を1パスへ
// 畳む。発火有無は singlePassMeasure（#309 計測）で観測する。並列一括実測の並行性そのものは
// #315 の deferred バリアテストが既に担保しており、ここは merged→hybrids→prewarmFront→
// メトリクスの配線を検証する。
describe('plan: reject多発ルートは短リスト全体を1パスで先行実測する (#318 Option A)', () => {
  const o = new GeoPoint(35.0, 139.0);
  const g = new GeoPoint(35.0, 139.1); // 直線 ~8.9km

  // 8点コリドー（乗車→…→降車）。frontier の複数乗車駅から予算内ハイブリッドが生成される。
  const corridor = (): number[][] => {
    const out: number[][] = [];
    for (let i = 1; i <= 8; i++) out.push([35.0, 139.0 + 0.0115 * i]);
    return out;
  };

  // 単一 base（09:05発→09:20着の速い電車）。コリドー各点から乗るハイブリッドは access 徒歩の
  // ぶん所要が伸びるが、大きな予算では手前の複数点が予算内に収まり ≥3 件のハイブリッドが並ぶ。
  const baseOption = (): JsonMap =>
    guidance([
      {
        journey: {
          departureSecs: 32400, // 09:00
          arrivalSecs: 33600, // 09:20
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
              dep: 32700, // 09:05
              arr: 33600, // 09:20
            }),
          ],
        },
        map: {
          points: [],
          segments: [
            mapSeg('walk', 'origin', 'c:board', 'osmWalk', [
              [o.lat, o.lng],
              first(corridor()),
            ]),
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
      arrival: new TimeValue({ h: 11, m: 0 }), // 予算120分（手前の複数乗車駅が予算内）
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
    // 1点コリドー（base=null）＝ハイブリッドを生成しない純粋な標準乗換2本。
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
                mapSeg('transit', 's:board', 's:alight', 'stopOrder', [
                  [35.0, 139.08],
                ]),
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
});

describe('plan: 乗車駅探索は非単調コリドーでも徒歩最大を返す（#137）', () => {
  // 乗車駅探索の二分探索は「到着が index 単調増」を仮定して予算内の最大 index を境界に
  // するが、実街路の徒歩は非単調になり得る（後方の停車駅の方が origin に近い等）。境界
  // index だけを採ると、二分探索が途中で評価した「より手前で徒歩の多い予算内点」を取り
  // こぼす。境界ではなく評価済みの中で予算内・徒歩最大を返せば、特定ケースに依存せず
  // どの非単調コリドーでも取りこぼしを減らせる。
  const origin5 = new GeoPoint(35.0, 139.0);
  const goal5 = new GeoPoint(35.0, 139.2);

  // 2区間。区間1は origin→T の乗車候補列で、idx5 が idx6 より遠い「谷」を作る（前半徒歩が
  // 非単調）。区間1で降りると目的地まで遠く egress 予算外、区間2で乗ると前半徒歩 91分超で
  // 予算外 → ハイブリッドは作れず、乗車駅探索だけが解ける。
  const leg1Lng = [
    139.01,
    139.02,
    139.03,
    139.04,
    139.05,
    139.07, // idx5: 遠い（前半徒歩 大）
    139.06, // idx6: idx5 より origin に近い（谷）
    139.08, // idx7: 区間1終点 T
  ];
  const leg2Lng = [139.08, 139.12, 139.16, 139.2];

  const legCoords = (lngs: number[]): number[][] => lngs.map((l) => [35.0, l]);

  const baseGuidance = (leg1: number[] = leg1Lng): JsonMap =>
    guidance([
      {
        journey: {
          departureSecs: 32400, // 09:00
          arrivalSecs: 33600, // 09:20（標準は速い1本・徒歩最小で大量に余る）
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

  // 乗車駅 X からの引き直し便：乗車待ち0、goal まで残距離を 500m/分 で概算した1本。
  const reentry = (lng: number, time: string): JsonMap => {
    const dep = secsOf(time);
    const t = Math.round(
      (haversineKm(new GeoPoint(35.0, lng), goal5) * 1000) /
        trainMetersPerMinute,
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
    plan.segments
      .filter((s) => s.type === SegmentType.walk)
      .reduce((a, s) => a + s.minutes, 0);

  it('二分探索の境界(谷)ではなく評価済みの徒歩最大点を採る', async () => {
    // idx6(谷・前半徒歩~68分) が境界になるが、idx5(前半徒歩~80分) も予算内で徒歩が多い。
    // 境界だけ採ると徒歩68分、評価済み最大なら徒歩80分。
    const plan = await service(localMock()).plan({
      destination: '目的駅',
      destinationLatLng: goal5,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 50 }), // 予算110分
      origin: origin5,
      originName: '出発',
    });
    expect(walkMinutesOf(plan)).toBeGreaterThan(74);
    expect(plan.totalMin).toBeLessThanOrEqual(110);
  });

  it('boardSearchBest は探索の境界でなく評価済み予算内の最遠 index（#332 レビュー）', async () => {
    // 二分探索は「最初の予算外 probe」で結果の走査を打ち切るため、同一ラウンドで
    // それより奥に評価済みの予算内点があっても戻り値の境界には現れない。非単調は
    // この呼び出し側が明示的に扱う前提（within は全点を返す）なので、境界位置の指標
    // だけ打ち切り側の値を採ると分布が手前へ偏る——probe 配置の判断材料が歪む。
    //
    // 上の既定コリドーの谷は両側とも予算内で break を挟まないため分岐しない。ここでは
    // **予算をまたぐ谷**を置く: idx5 を大きく離して予算外にし、idx6 は予算内へ戻す。
    // ラウンド1の probe {1,2,4,5,6} で idx5 が予算外→走査打ち切り→境界は 4 になるが、
    // idx6 は評価済みかつ予算内。
    const crossingValley = [
      139.01,
      139.02,
      139.03,
      139.04,
      139.05,
      139.13, // idx5: 遠すぎて予算外
      139.06, // idx6: 予算内へ戻る（谷）
      139.08,
    ];

    let captured: RouteSearchMetrics | null = null;
    await service(localMock(crossingValley), {
      onMetrics: (m) => (captured = m),
    }).plan({
      destination: '目的駅',
      destinationLatLng: goal5,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 50 }), // 予算110分
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
    // 引き直しが 429/5xx で落ちた点は「予算外」ではなく未評価として扱い、境界を
    // どちらへも動かさない。締切とは別の原因なので truncated では拾えず、印
    // （probeFailed）を立てないと probe 配置の分布へ確定値として混ざる。
    const oneProbeFails = mockClient((url) => {
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (path.includes('guidance/plan')) {
        const from = url.searchParams.get('from') ?? '';
        const lng = Number.parseFloat(from.replace('geo:', '').split(',')[1]);
        if (Math.abs(lng - 139.0) < 1e-6) return json(baseGuidance());
        // 引き直しのうち1点だけ上流エラーにする（他は正常に引ける）。
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
    // 締切には掛かっていない＝原因を取り違えていないこと。
    expect(captured!.boardSearchTruncated).toBe(false);
  });

  it('徒歩実測が落ちて直線推定へ縮退した探索も境界を確定値扱いしない（#332 レビュー）', async () => {
    // `tryWalk` が落ちると buildAt は黙って直線推定へ縮退する。直線は実街路に対し
    // 大きく楽観に倒れる（#137 実機で -36分・25%）ので、本来予算外の遠い点が予算内に
    // 見え、境界が実測より奥へ動き得る。transit が成功している限り上流エラーの印は
    // 立たないため、徒歩側の縮退も同じ印で拾う必要がある。
    const walkProxyDown = mockClient((url) => {
      const path = url.pathname;
      // matrix は通す（探索範囲の刈り込みは成立させ、徒歩実測だけを落とす）。
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
  // 上流は `numItineraries` で最大5本返すが、先頭が最速とは限らない。引き直しが「最初に
  // transit を含む1本」を無条件に採ると、悪い1本を掴んだ地点だけが「予算外」と判定され、
  // 単調性を仮定した二分探索は break でそれより奥を丸ごと捨てる（#343 実機: 探索48点の
  // index 5 で打ち切り・予算139分中55分の使い残し）。
  const origin7 = new GeoPoint(35.0, 139.0);
  const goal7 = new GeoPoint(35.0, 139.2);

  // 乗車順に単調なコリドー（0.005度 ≒ 前半徒歩6分）。区間2は前半徒歩が予算外なので、
  // 探索範囲は区間1の15点＋区間2の起点に刈られる。
  const leg1Lng = [
    139.01, 139.015, 139.02, 139.025, 139.03, 139.035, 139.04, 139.045, 139.05,
    139.055, 139.06, 139.065, 139.07, 139.075, 139.08,
  ];
  const leg2Lng = [139.08, 139.12, 139.16, 139.2];

  const legCoords = (lngs: number[]): number[][] => lngs.map((l) => [35.0, l]);

  const baseGuidance = (): JsonMap =>
    guidance([
      {
        journey: {
          departureSecs: 32400, // 09:00
          arrivalSecs: 33600, // 09:20（標準は速い1本・徒歩最小で大量に余る＝崩壊）
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

  /// 乗車駅 X から goal まで乗り通す正常な便（乗車待ち0・残距離を 500m/分 で概算）。
  const throughOption = (lng: number, time: string): JsonMap => {
    const dep = secsOf(time);
    const t = Math.round(
      (haversineKm(new GeoPoint(35.0, lng), goal7) * 1000) /
        trainMetersPerMinute,
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

  /// 到着が発車より前の壊れた便。パーサは所要を負の分数に落とし、`arrivalMinutes` は
  /// その負値で累積を進めるので、到着が**手前へ戻って**比較に勝つ。
  const reversedOption = (lng: number, time: string): JsonMap => {
    const dep = secsOf(time) + 600;
    const arr = dep - 300; // 発車の5分前に到着（不整合データ）
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

  /// 2本目が1本目の到着前に発車する、乗り継げない便。各 leg 単体の時刻は整合するが
  /// 接続が成立しない。`arrivalMinutes` は間に合わない乗換を待ち0として畳むので速く見える。
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
            dep: dep + 120, // 1本目の到着(+300)より前に発車＝乗り継げない
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

  /// 乗降地名を部分的にしか持たない乗り通し便。上流が `from`/`to` を欠くと
  /// パーサは空文字にする。空文字を渡した側はキーごと落とす。
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
      (haversineKm(new GeoPoint(35.0, lng), goal7) * 1000) /
        trainMetersPerMinute,
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

  /// 乗換徒歩の到着が発車より前になっている便。パーサは所要を負の分数に落とすので、
  /// 累積が手前へ戻り、乗換が間に合わないはずの行程が成立して見える。
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
            arrivalSecs: dep + 120, // 出発より前に着く乗換徒歩＝所要が負
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

  /// 照会時刻より前に出てしまっている便。`arrivalMinutes` は過去発の待ちを0へ丸めるので
  /// 「待ち無しで乗れる速い便」に見えるが、実際には乗れない。
  const staleOption = (lng: number, time: string): JsonMap => {
    const dep = secsOf(time) - 3600; // 1時間前に発車済み
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

  /// #343 実測の「悪い便」: 乗り換えを失い、手前で降りて長時間歩く（到着は予算外）。
  const strandedOption = (lng: number, time: string): JsonMap => {
    const dep = secsOf(time);
    const arr = dep + 600; // 10分だけ乗る
    return {
      journey: {
        departureSecs: dep,
        arrivalSecs: arr,
        durationSecs: arr - dep + 9960,
        accessWalkSecs: 0,
        egressWalkSecs: 9960, // 降車後166分徒歩
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

  /// 発車時刻だけあり到着時刻を欠く便。パーサは所要を0分に落とすので、到着で比べると
  /// 「乗った瞬間に着く」便として最速に化ける。`depTime` はあるので幻便判定は素通りする。
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

  /// [throughOption] と徒歩量が同じで、発車だけ [delayMin] 分遅い双子の便。
  /// 徒歩で並んだときにどちらを採るかを見るために使う。
  const laterTwinOption = (
    lng: number,
    time: string,
    o: { delayMin?: number } = {},
  ): JsonMap => {
    const dep = secsOf(time) + (o.delayMin ?? 10) * 60;
    const t = Math.round(
      (haversineKm(new GeoPoint(35.0, lng), goal7) * 1000) /
        trainMetersPerMinute,
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

  /// goal 手前 139.165 で降りて歩く便。到着は [throughOption] より遅いが予算内に収まり、
  /// 徒歩は多い（徒歩最大化の目的関数ではこちらが上位）。
  const walkierOption = (lng: number, time: string): JsonMap => {
    const alight = new GeoPoint(35.0, 139.165);
    const dep = secsOf(time);
    const ride = Math.round(
      (haversineKm(new GeoPoint(35.0, lng), alight) * 1000) /
        trainMetersPerMinute,
    );
    const arr = dep + ride * 60;
    const egress = Math.round(
      (haversineKm(alight, goal7) * 1000) / walkMetersPerMinute,
    );
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

  /// 発着時刻を欠く便（幽霊便）。`arrivalMinutes` は時刻の無い区間の乗車待ちを0と見なす
  /// ので、到着だけで比べると**常に最速に見える**。
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

  /// [poisonLng] の地点だけ「悪い便が先頭・正常な便が後続」の2本を返す。
  /// [walkier] を立てると全地点で「乗り通し（到着最早）＋手前で降りて歩く便」を返す。
  /// [timelessFrom] 以遠の地点は「時刻なし便が先頭」になる。
  /// [laterTwinFirst] を立てると全地点で「徒歩は同じで発車が遅い便」が先頭に来る。
  /// [partialTimes] を立てると全地点で「発車だけあり到着を欠く便」が先頭に来る。
  /// [reversedFirst] は「到着が発車より前の便」、[staleFrom] 以遠は「発車済みの便」が
  /// 先頭に来る。
  /// いずれも無指定なら全地点で正常な便を1本だけ返す（上流が1本しか返さない条件）。
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
        const poisoned =
          o.poisonLng !== undefined && Math.abs(lng - o.poisonLng) < 1e-6;
        // 壊れた便しか返らない地点。先頭は発車済み便、2本目は到着が発車より前の便で、
        // 到着で比べると2本目（負の所要で到着が手前へ戻る）が勝つ。
        if (
          o.allMalformedFrom !== undefined &&
          lng >= o.allMalformedFrom - 1e-6
        ) {
          return json(
            guidance([staleOption(lng, time), reversedOption(lng, time)]),
          );
        }
        // 駅名を持つのは「同一路線だが到着時刻を欠く便」だけ。時刻の揃った便は
        // 名前が無い（乗り通し）か、別路線。駅名復元がどれを採るかを見る。
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
        if (
          o.brokenConnectionFrom !== undefined &&
          lng >= o.brokenConnectionFrom - 1e-6
        ) {
          options.push(brokenConnectionOption(lng, time));
        }
        if (
          o.negativeTransferFrom !== undefined &&
          lng >= o.negativeTransferFrom - 1e-6
        ) {
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
          // 最早便は降車地名だけ持つ（乗車地名が空）。5分後発の便は逆に乗車地名だけ。
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
    plan.segments
      .filter((s) => s.type === SegmentType.walk)
      .reduce((a, s) => a + s.minutes, 0);

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
      arrival: o.arrival ?? new TimeValue({ h: 10, m: 50 }), // 予算110分
      origin: origin7,
      originName: '出発',
    });

  it('悪い便が先頭に来た地点でも探索を打ち切らず、奥の乗車駅まで歩く', async () => {
    // 139.07 はラウンド1の**最も奥の probe**。ここを予算外と判定すると `nextHi` が
    // その手前へ動き、まだ一度も評価していない奥の3点がラウンド2ごと消える
    // （同一ラウンドで並列に評価済みの点はプールへ残るので、未探索領域を殺す位置
    // でなければ切り捨ての実害は出ない）。
    let captured: RouteSearchMetrics | null = null;
    const plan = await planWith(localMock({ poisonLng: 139.07 }), {
      onMetrics: (m) => (captured = m),
    });

    expect(captured!.boardSearchActivated).toBe(true);
    expect(
      captured!.boardSearchBest,
      '打ち切られると index 11 で頭打ちになり、奥の3点は評価されない',
    ).toBeGreaterThanOrEqual(13);
    expect(
      walkMinutesOf(plan),
      '奥を切り捨てると徒歩は74分で頭打ちになる',
    ).toBeGreaterThan(74);
    expect(plan.totalMin).toBeLessThanOrEqual(110);
  });

  it('駅名・実時刻の引き直しも到着最早の便から採る', async () => {
    // 時刻なし区間の実発車時刻検証（approach A）と駅名復元は同じ引き直しを通る。
    // ここで先頭1本を採ると**別経路の時刻と駅名を自分の区間へ貼る**ことになり、
    // 乗れるはずの候補が乗り遅れ・予算超過に見える。
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
        const secs =
          Number.parseInt(hm[0], 10) * 3600 + Number.parseInt(hm[1], 10) * 60;
        const dep = secs > 18000 ? secs : 18000; // 始発05:00
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
            : // 引き直しは2本。先頭は30分後発の遅い便で、採ると乗車待ちが30分増える。
              guidance([
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
      arrival: new TimeValue({ h: 7, m: 0 }), // 予算300分
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
    // 返す値は「この区間の乗降地名と実発着時刻」なので、徒歩で別駅へ回る便を採ると
    // その徒歩は捨てられ、区間の所要から丸ごと消える。乗車駅も区間ジオメトリの起点と
    // 食い違う。到着最早だけで選ぶと、歩いて速い電車へ回る便がしばしば勝ってしまう。
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
        const secs =
          Number.parseInt(hm[0], 10) * 3600 + Number.parseInt(hm[1], 10) * 60;
        const dep = secs > 18000 ? secs : 18000; // 始発05:00
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
            : // 先頭は20分歩いて別駅から速い電車に乗る便。徒歩を含めても到着は早い。
              guidance([
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
      arrival: new TimeValue({ h: 7, m: 0 }), // 予算300分
      origin: origin7,
      originName: '出発',
    });

    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);
    expect(train.fromName, '迂回便の駅名を貼らない').toEqual('区間の駅');
    expect(
      train.minutes,
      '迂回便の乗車10分を貼ると、捨てた徒歩20分が所要から消える',
    ).toEqual(30);
  });

  it('区間の引き直しは、徒歩最小より先に時刻の使えない便を落とす（レビュー指摘）', async () => {
    // 徒歩最小で絞ってから時刻の妥当性を見ると、壊れた便が最小徒歩を占めたときに
    // まともな便が先に消える。残るのは壊れた便だけなので「1本も無いならそのまま返す」
    // 縮退が働き、結局その壊れた値を貼ってしまう。順序が逆でなければならない。
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
        const secs =
          Number.parseInt(hm[0], 10) * 3600 + Number.parseInt(hm[1], 10) * 60;
        const dep = secs > 18000 ? secs : 18000; // 始発05:00
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
            : // 徒歩最小（access 1分）の便は到着が発車より前の不整合データ。
              // 徒歩3分の便だけが時刻として使える。
              guidance([
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
    // 同じ駅間を複数の路線が走ることは珍しくない（山手線と京浜東北線など）。種別と徒歩
    // だけで絞ると、速い別路線の便が勝つ。`copyWith` は区間の `line` とジオメトリを
    // 残すので、**路線名は元のまま・時刻と所要だけ別路線のもの**という表示になる。
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
        const secs =
          Number.parseInt(hm[0], 10) * 3600 + Number.parseInt(hm[1], 10) * 60;
        const dep = secs > 18000 ? secs : 18000; // 始発05:00
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
            : // 先頭は同じ駅間を走る別路線の速い便。徒歩は同じで到着だけ早い。
              guidance([
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
    // 同種別の leg が2本ある便（A→C→B）は「その種別だけで行く」条件を満たしてしまう。
    // 先頭の発車と末尾の到着を1区間へ貼ると、乗換待ちと2本目の乗車を含んだ時間が
    // 「元の路線を直通で乗った」ように見える。区間の line もジオメトリも1本のまま。
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

    /// A→C→B の乗換便。徒歩は直通便と同じで、到着だけ早い。
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
        const secs =
          Number.parseInt(hm[0], 10) * 3600 + Number.parseInt(hm[1], 10) * 60;
        const dep = secs > 18000 ? secs : 18000; // 始発05:00
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
    expect(
      train.minutes,
      '乗換待ちと2本目の乗車を含む20分を直通の所要として貼らない',
    ).toEqual(30);
  });

  it('予算内に収まる範囲では到着最早でなく徒歩の多い便を候補にする（レビュー指摘）', async () => {
    // 到着最早は「この地点が予算内か」の判定基準としては正しいが、プールへ渡す候補まで
    // それで決めると、予算内に収まる**歩く便**を捨てる。乗車地点が同じでも option ごとに
    // 降車地点は違い、手前で降りれば徒歩は増える——目的関数はそちらを採るべき。
    const plan = await planWith(localMock({ walkier: true }), {
      arrival: new TimeValue({ h: 11, m: 20 }), // 予算140分
    });
    expect(
      walkMinutesOf(plan),
      '到着最早で潰すと乗り通し（徒歩91分以下）で確定してしまう',
    ).toBeGreaterThan(100);
    expect(plan.totalMin).toBeLessThanOrEqual(140);
  });

  it('時刻を欠く便は到着最早の比較で最速に化けさせない（レビュー指摘）', async () => {
    // 時刻なし区間は `arrivalMinutes` が乗車待ちを0と見なすため、到着だけで比べると
    // 必ず勝つ。掴んだ候補は幽霊便として確定から除外されるので、同じ地点にあった
    // **実時刻付きの便**もろとも失う。
    const plan = await planWith(localMock({ timelessFrom: 139.06 }));
    expect(
      walkMinutesOf(plan),
      '時刻なし便を採ると奥の地点が確定できず手前へ落ちる',
    ).toBeGreaterThan(74);
    expect(plan.totalMin).toBeLessThanOrEqual(110);
  });

  it('徒歩が並んだ便は上流の並び順でなく到着最早で決める（レビュー指摘）', async () => {
    // 徒歩最大で選ぶとき、同点の扱いを決めないと「上流が先に返した方」が残る。
    // それは並び順に意味があるという前提そのもので、この issue が否定したもの。
    // 下流の `selectBestRoute` は同徒歩なら到着最早を採るので、probe 側でも揃える。
    const plan = await planWith(localMock({ laterTwinFirst: true }), {
      arrival: new TimeValue({ h: 11, m: 20 }), // 予算140分
    });
    expect(
      plan.totalMin,
      '上流順で残すと10分後発の双子が確定し、到着がその分遅れる',
    ).toBeLessThan(120);
  });

  it('到着時刻を欠く便も到着最早の比較で最速に化けさせない（レビュー指摘）', async () => {
    // 発車だけある便はパーサが所要0分に落とすため「乗った瞬間に着く」便になる。
    // `depTime` はあるので幻便判定（`hasUnverifiedTransit`）を素通りし、確定まで残る。
    const plan = await planWith(localMock({ partialTimes: true }));
    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);

    expect(train.arrTime, '到着時刻の無い便を確定してはならない').not.toBeNull();
    expect(
      train.minutes,
      '所要0分の便を採ると乗車時間が到着へ入らない',
    ).toBeGreaterThan(0);
    expect(plan.totalMin).toBeLessThanOrEqual(110);
  });

  it('到着が発車より前の壊れた便を比較に混ぜない（レビュー指摘）', async () => {
    // パーサは所要を負の分数にし、`arrivalMinutes` はその負値で累積を進める。つまり
    // 到着が手前へ戻るので必ず比較に勝つ。`depTime` はあるので幻便判定も通る。
    const plan = await planWith(localMock({ reversedFirst: true }));
    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);

    expect(train.minutes, '所要が負の便を確定してはならない').toBeGreaterThan(0);
    expect(
      plan.totalMin,
      '到着が徒歩の合計を下回るのは時間が巻き戻っている',
    ).toBeGreaterThanOrEqual(walkMinutesOf(plan));
  });

  it('照会時刻より前に発車済みの便を比較に混ぜない（レビュー指摘）', async () => {
    // 過去発の便は `arrivalMinutes` が待ちを0へ丸めるので「待ち無しで乗れる速い便」に
    // 見える。実際には乗れないので下流（乗り遅れ除外・実時刻の引き直し）が捨てるが、
    // そのとき同じ応答にあった乗れる便はもう無い。
    const plan = await planWith(localMock({ staleFrom: 139.06 }));
    expect(
      walkMinutesOf(plan),
      '発車済みの便を掴むと奥の地点が確定できず手前へ落ちる',
    ).toBeGreaterThan(74);
    expect(plan.totalMin).toBeLessThanOrEqual(110);
  });

  it('区間をまたいで乗り継げない便を比較に混ぜない（レビュー指摘）', async () => {
    // leg 単体の時刻が整合していても、2本目が1本目の到着前に発車する便は乗り継げない。
    // `arrivalMinutes` は間に合わない乗換を待ち0として畳むので最速に見えるが、下流の
    // `firstMissedTransit` が捨てる。捨てられた時点で同じ応答の乗れる便はもう無い。
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
    // transit の時刻だけ検証しても、乗換徒歩が負の所要なら累積は手前へ戻る。
    // index 14/15（139.08）は乗り通し便なら到着113分＝予算外だが、負の乗換を持つ便を
    // 置くと到着101分に見え、**予算外の地点が予算内に化けて**境界が奥へ動く。
    //
    // 確定経路には出ない——徒歩実測（enrich）が乗換徒歩を測り直して負を潰すため。
    // ただし徒歩実測は fail-open（§2.4）なので、上流が落ちた run では潰れずに残る。
    // ここで測るのは、実測に救われる前の**探索境界そのもの**が汚れていないこと。
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
    // 駅名復元が読むのは乗降地名だけ。到着最早だけで選ぶと名前の無い便を掴み、
    // 空文字を書き戻して駅名が付かないまま確定する。
    const plan = await planWith(localMock({ unnamedEarliest: true }));
    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);

    expect(train.fromName, '名前の無い便を採ると駅名が空のまま残る').toEqual(
      '名前つき乗車駅',
    );
    expect(plan.totalMin).toBeLessThanOrEqual(110);
  });

  it('駅名復元は、欠けている側を埋められる便を採る（レビュー指摘）', async () => {
    // 片側だけ欠けた区間に「両側とも名前を持つ便」を要求すると、必要な側だけを持つ便を
    // 捨ててしまう。捨てた結果、必要な側が空のままの便が最早として勝ち、駅名は埋まらない。
    const plan = await planWith(localMock({ oneSidedNames: true }));
    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);

    expect(train.fromName, '欠けている乗車地名を埋められる便を採るべき').toEqual(
      '名前つき乗車駅',
    );
    expect(train.toName, '既に埋まっている側は上書きしない').toEqual('着駅A');
  });

  it('壊れた便しか無い地点では、それらを並べて選び直さない（レビュー指摘）', async () => {
    // 到着を信じられないと判定した便を、その到着で順位付けしては筋が通らない。
    // 縮退の約束は「従来どおり1本を返す」＝上流の先頭であって、「壊れた候補群から
    // 到着最早を選ぶ」ではない。並べて選ぶと、負の所要で到着が手前へ戻る便が勝ち、
    // 修正前より悪い結果（この PR が保証する「必ず現状以上」の破れ）になる。
    const plan = await planWith(localMock({ allMalformedFrom: 139.06 }));
    expect(
      plan.segments.every((s) => s.minutes >= 0),
      '壊れた候補群を到着で並べ替えると負の所要の便が勝つ',
    ).toBe(true);
  });

  it('駅名復元は時刻の欠落で候補を捨てない（レビュー指摘）', async () => {
    // 駅名復元は `dep`/`arr` を一切読まない。時刻の妥当性で絞ると、**名前は正しいが
    // 時刻を欠く同一路線の便**が落ち、別路線の便や名前の無い便しか残らない。
    // 時刻が要るのは実時刻検証の側だけ。
    const plan = await planWith(localMock({ namedSameLineHasNoArrival: true }));
    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);

    expect(
      train.fromName,
      '時刻を欠くだけの同一路線の便を、駅名の候補から外してはならない',
    ).toEqual('同一路線の駅');
    expect(
      train.arrTime,
      '駅名を借りても、区間の時刻は時刻の揃った便のまま',
    ).not.toBeNull();
  });

  it('上流が1本しか返さない地点でも従来どおり徒歩最大へ収束する', async () => {
    const plan = await planWith(localMock());
    expect(walkMinutesOf(plan)).toBeGreaterThan(74);
    expect(plan.totalMin).toBeLessThanOrEqual(110);
  });
});

describe('plan: 時刻なしハイブリッドの実発車時刻検証（approach A・深夜の幽霊便対策）', () => {
  // ハイブリッド電車区間はコリドー座標を距離で割った概算 minutes だけを持ち depTime を
  // 欠く。すると乗車待ちが 0 になり、運行時間外（終電後・始発前）でも「待ち0で今すぐ
  // 乗れる」と評価され、走っていない電車が予算内へ化ける（#137 実機・深夜02:41）。
  // approach A：採用候補の時刻なし電車区間を、実 boardAt で guidance 引き直しして実発着
  // 時刻を当て、乗車待ち（始発までの長い待ち）を到着へ反映する。
  const origin6 = new GeoPoint(35.0, 139.0);
  const goal6 = new GeoPoint(35.0, 139.3); // 全徒歩は約340分で予算外

  // 始発 firstTrainSecs（05:00）固定。照会時刻が始発前なら始発に張り付き、以降なら
  // 照会時刻以降の最初の便を返す（実機 Transit API と同じ正直な挙動）。
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
      // 遅延ゼロだと経過が 1ms 未満を切り捨てて 0 になり、壁時計の配線を
      // 「測っていない」と区別できない。上流1本ぶんを決定的に払わせる。
      if (o.delay !== undefined) await delay(o.delay);
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) {
        // 型違いの応答＝パースで例外。上流の壊れた応答を候補単位で落とす経路を作る。
        if (o.breakWalk?.(url) ?? false) {
          return json({ routes: 3 });
        }
        return walkFor(url);
      }
      if (path.includes('guidance/plan')) {
        const time = url.searchParams.get('time') ?? '00:00';
        const hm = time.split(':');
        const secs =
          Number.parseInt(hm[0], 10) * 3600 + Number.parseInt(hm[1], 10) * 60;
        const body = guidance([optionFor(secs)]);
        body['date'] = url.searchParams.get('date');
        return json(body);
      }
      return json({}, 404);
    });
  };

  const nightService = (client: HttpClient): TransitRouteService =>
    new TransitRouteService({
      transitClient: client,
      proxyClient: client,
      transitBaseUrl: transitBase,
      proxyBaseUrl: proxyBase,
      clock: () => dateTime(2026, 6, 27, 2, 0),
    });

  it('深夜のハイブリッドは始発05:00の実発車時刻が当たり乗車待ちが到着へ入る', async () => {
    const plan = await nightService(nightMock()).plan({
      destination: '終着駅',
      destinationLatLng: goal6,
      departure: new TimeValue({ h: 2, m: 0 }),
      arrival: new TimeValue({ h: 7, m: 0 }), // 予算300分
      origin: origin6,
      originName: '出発',
    });
    const train = firstWhere(plan.segments, (s) => s.type === SegmentType.train);
    // 時刻なし距離概算のままだと depTime は null。approach A で実時刻が当たる。
    expect(train.depTime, '実発車時刻が当たるべき').not.toBeNull();
    expect(train.depTime!.getHours(), '02:00出発でも始発05:00より前には乗れない').toEqual(
      5,
    );
    // 02:00出発で05:00乗車＝最低180分の乗車待ちが到着に反映される。
    expect(plan.totalMin).toBeGreaterThanOrEqual(180);
  });

  it('縮退はプール全体を解決し、それを bestEffort* が計上する（測定口の外）', async () => {
    // enrichCriticalMs は単一測定口しか見ないので、この経路は構造的に見えない。
    // 実機では enrichMs 58.2s のうち 4.9s しか臨界パスに現れず、残りがここだった。
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
      arrival: new TimeValue({ h: 2, m: 50 }), // 予算50分＝予算内皆無で縮退へ落ちる
      origin: origin6,
      originName: '出発',
    });
    const m = captured!;
    expect(m.bestEffortEntries, '前提: 縮退へ落ちる').toBeGreaterThan(0);
    // 短リスト上限（13）ではなく候補プール全体を解決するため、幅はそれを超え得る。
    expect(m.bestEffortCandidates).toBeGreaterThan(0);
    // 遅延を注入したモックなので、配線されていれば必ず 1ms 以上が乗る。
    expect(m.bestEffortMs).toBeGreaterThan(0);
  });

  it('実測が例外で落ちた候補も enrich 台帳へ計上する (#309)', async () => {
    // 壊れた応答で落ちた候補も、await した壁時計は払っている。計上しないと
    // 「上流が壊れているときほど臨界パスが小さく出る」逆向きの歪みが入る。
    // 健全な対照と同じ幅になることで、落ちた候補が数えられていると分かる。
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
    // コリドー途中点に触る徒歩だけ壊す（全徒歩の縮退先は健全に残すので plan は完走する）。
    const broken = await run({
      breakWalk: (url) => {
        const legs = [
          url.searchParams.get('start') ?? '',
          url.searchParams.get('goal') ?? '',
        ].join(' ');
        return legs.includes('139.075') || legs.includes('139.15');
      },
    });
    expect(healthy.enrichCandidates, '前提: 実測している').toBeGreaterThan(0);
    // 壊れた側は同じ短リストを測ったうえで、落ちたぶん次善候補まで測り足す。
    // 落ちた候補を数えないと逆に健全な対照より小さくなる（修正前は 4 < 11）。
    expect(
      broken.enrichCandidates,
      '例外で落ちた候補も測定の幅に数える',
    ).toBeGreaterThanOrEqual(healthy.enrichCandidates);
    expect(broken.enrichCriticalMs, '払った壁時計を計上する').toBeGreaterThan(0);
  });

  it('時刻なし区間の引き直しを enrichResolveDepth が段数として数える', async () => {
    // 段数は「1候補が実時刻の引き直しで直列に積んだ guidance の本数」。
    // 実 depTime を持つ候補では 0 のままなので、引き直しが実際に走るこの経路で固定する
    // （既存の崩壊 fixture は引き直し便が実時刻付きで返るため 0 になり、配線の退行を
    // 検出できない）。
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
    // 段数が立つ＝引き直しの上流 I/O を実際に払っているので、臨界パスも積まれる
    // （遅延注入により 1ms 未満の切り捨てに依存しない）。
    expect(captured!.enrichCriticalMs).toBeGreaterThan(0);
  });

  it('予算外で best-effort へ落ちても始発前の幻バス便を提示しない', async () => {
    // 予算50分では何も予算内に収まらず best-effort 縮退。時刻なしハイブリッドは
    // maxBoardingWait=0 で「今夜乗れる」と誤判定され、始発前（02:00乗車）の幻便を
    // best-effort が拾っていた（実機の洗足→新代田 森91 02:27）。approach A を
    // best-effort にも通せば、実発車時刻=05:00（待ち180分>予算）で除外され、
    // 走っていない電車を含まない全徒歩へ正しく縮退する。
    const plan = await nightService(nightMock()).plan({
      destination: '終着駅',
      destinationLatLng: goal6,
      departure: new TimeValue({ h: 2, m: 0 }),
      arrival: new TimeValue({ h: 2, m: 50 }), // 予算50分（何も予算内に入らない）
      origin: origin6,
      originName: '出発',
    });
    // 提示する電車区間は必ず実発車時刻を持つ（時刻なしの幻便を出さない）。
    const ghostTrains = plan.segments.filter(
      (s) => s.type === SegmentType.train && s.depTime === null,
    );
    expect(ghostTrains, '時刻なしの幻電車を提示してはならない').toHaveLength(0);
  });

  // コリドー座標から短いバス区間を引き直すと、API が all-walk だけ返して電車便を
  // 返さないことがある（実機の都立大学→学芸大学 森91 01:08）。このとき実時刻を当てられず
  // depTime=null のまま maxBoardingWait=0 で best-effort を素通りしていた。実時刻を確認
  // できない時刻なし電車を含む候補は best-effort から除外する。
  // over-budget だが乗車・降車の各徒歩は予算内（frontier が乗降点を採れる）幾何。
  // origin(139.0)→乗車139.027(徒歩~31分)→降車139.10→goal139.127(徒歩~31分)、
  // 計徒歩~62分>予算50分。乗車点は origin と別 lng なので引き直しは all-walk＝ep null。
  const localOrigin = new GeoPoint(35.0, 139.0);
  const localGoal = new GeoPoint(35.0, 139.127);

  const nightMockNoReentryTrain = (
    o: { firstTrainSecs?: number } = {},
  ): HttpClient => {
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

    // コリドー点からの引き直しは all-walk のみ（電車便を返さない）。
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
        const secs =
          Number.parseInt(hm[0], 10) * 3600 + Number.parseInt(hm[1], 10) * 60;
        // origin(139.0)からは電車基準経路、コリドー点からは all-walk のみ。
        const body =
          Math.abs(lng - 139.0) < 1e-6
            ? guidance([trainBase(secs)])
            : guidance([walkOnly()]);
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
      arrival: new TimeValue({ h: 2, m: 50 }), // 予算50分（best-effort へ）
      origin: localOrigin,
      originName: '出発',
    });
    const ghostTrains = plan.segments.filter(
      (s) => s.type === SegmentType.train && s.depTime === null,
    );
    expect(
      ghostTrains,
      '実時刻を確認できない時刻なし電車を提示してはならない',
    ).toHaveLength(0);
  });

  it('予算内に見えても引き直しで便を確認できない時刻なし電車は確定しない', async () => {
    // 予算を広く取り、時刻なしハイブリッド（楽観arr）が予算内に見えるケース。引き直しで
    // all-walk しか返らない＝その時間に便が無いなら、予算内に見えても確定させない。
    const plan = await nightService(nightMockNoReentryTrain()).plan({
      destination: '終着駅',
      destinationLatLng: localGoal,
      departure: new TimeValue({ h: 2, m: 0 }),
      arrival: new TimeValue({ h: 4, m: 30 }), // 予算150分（ハイブリッドは楽観で予算内）
      origin: localOrigin,
      originName: '出発',
    });
    const ghostTrains = plan.segments.filter(
      (s) => s.type === SegmentType.train && s.depTime === null,
    );
    expect(
      ghostTrains,
      '予算内でも未確認の時刻なし電車を確定してはならない',
    ).toHaveLength(0);
  });
});

describe('plan: バス last-resort 再照会 (#250)', () => {
  // origin→goal は直線 ~11.6km（全徒歩 ~145分）。乗車点は origin・降車点は goal に
  // 重ね、アクセス徒歩ゼロのバス便にする（enrich で徒歩が伸びて乗り遅れる余地を消す）。
  const busOrigin = new GeoPoint(35.0, 139.0);
  const busGoal = new GeoPoint(35.0, 139.127);

  /// 電車のみの主照会が返す option。列車は 09:50 発 10:20 着で、予算60分（10:00 着）に
  /// 間に合わない。コリドー点からの引き直しは all-walk のみ＝ハイブリッドも確定しない。
  const slowTrainOption = (): JsonMap => {
    const stops = [
      [35.0, 139.027],
      [35.0, 139.05],
      [35.0, 139.075],
      [35.0, 139.1],
    ];
    return {
      journey: {
        departureSecs: 35400, // 09:50
        arrivalSecs: 37200, // 10:20
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

  /// バス許容照会が返す door-to-door option。[dep]/[arr] を null にすると
  /// `departureSecs`/`arrivalSecs` を欠く「時刻の無いバス便」＝幽霊バスになる。
  const busOption = (
    o: { dep?: number | null; arr?: number | null } = {},
  ): JsonMap => {
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

  /// コリドー点 [lng] → goal を返す電車 option（board-search の引き直し用）。
  /// 09:10 発なので、前半徒歩31分（09:31 に乗車駅着）では乗り遅れる。到着だけ見れば
  /// 予算内（31+10=41分）なので board-search は候補として返し、enrich の乗り遅れ除外で
  /// 落ちる——「board-search が候補を返したのに全滅する」状況を作る。
  const corridorTrainOption = (lng: number): JsonMap => ({
    journey: {
      departureSecs: 33000, // 09:10
      arrivalSecs: 33600, // 09:20
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

  /// 見積り徒歩1分・実測徒歩31分の標準乗換（`accessWalkSecs` が所要分を決め、polyline が
  /// enrich 後の実測を決める parser の性質を使う）。09:20 発なので見積り（09:01 駅着）では
  /// 乗れるが、実測（09:31 駅着）では乗り遅れる。それでも到着は 31+10=41分で予算内に
  /// 収まるため、`giveUp` が到着だけで判定すると「乗れない経路」を予算内と誤認する。
  const missedTrainOption = (): JsonMap => ({
    journey: {
      departureSecs: 33600, // 09:20
      arrivalSecs: 34200, // 09:30
      durationSecs: 660,
      accessWalkSecs: 60, // 見積りでは徒歩1分（実 polyline は 2.5km ≒ 31分）
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

  /// all-walk のみを返す option（コリドー点からの引き直し用）。
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

  /// avoidModes でバス許容照会を判別するモック。バス許容なら [busOption] を、電車のみなら
  /// origin 起点は [originOption]（既定＝低速電車）・コリドー点起点は [corridorOption]
  /// （既定＝all-walk＝引き直し失敗）を返す。
  const busMock = (a: {
    busOption: JsonMap;
    originOption?: JsonMap;
    corridorOption?: (lng: number) => JsonMap;
    log?: URL[];
    busDelay?: number;
    corridorDelay?: number;
  }): HttpClient =>
    mockClient(async (url) => {
      a.log?.push(url);
      const path = url.pathname;
      if (path.includes('googleWalkMatrixProxy')) return matrixFor(url);
      if (path.includes('googleWalkProxy')) return walkFor(url);
      if (path.includes('guidance/plan')) {
        const allowsBus = !(url.searchParams.get('avoidModes') ?? '').includes(
          'bus',
        );
        const from = url.searchParams.get('from') ?? '';
        const lng = Number.parseFloat(from.replace('geo:', '').split(',')[1]);
        const fromOrigin = Math.abs(lng - 139.0) < 1e-6;
        // バス照会と縮退プールの引き直しに別々の遅延を入れられるようにする。投機発行の
        // 効き目は「バス応答が縮退プールの解決中に返り切るか」なので、両者の遅延差でしか
        // 決定的に固定できない。
        if (allowsBus && (a.busDelay ?? 0) > 0) await delay(a.busDelay!);
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

  it('バス照会を縮退プール解決と並行に発行し、直列の段を消す', async () => {
    // giveUp は best-effort の結果が出るまで採用の可否を決められないが、照会自体はその
    // 結果に依存しない。直列に置くと上流1本ぶんの段が丸ごと体感に乗る（実機 12.6s）。
    // busLastResortMs は**投機で覆えなかった残りの待ち**を測るので、バス応答(60ms)が
    // プール解決(200ms)の最中に返り切れば 0 に近づく。直列なら 60ms がそのまま残る。
    let captured: RouteSearchMetrics | null = null;
    const svc = service(
      busMock({
        busOption: busOption(),
        originOption: missedTrainOption(),
        busDelay: 60,
        corridorDelay: 200,
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
      '前提: バスが採用される（lastResortBus が await される）',
    ).not.toHaveLength(0);
    expect(
      captured!.busLastResortMs,
      '投機発行が間に合っていれば残りの直列待ちはほぼ 0（直列なら 60ms 前後）',
    ).toBeLessThan(30);
  });

  it('電車が予算内なら バス許容照会は一度も発行しない（速度不変）', async () => {
    // 09:15 発にして「実測徒歩8分で駅着 → 7分待って乗車」と実際に乗れる電車にする。
    // 既定の 09:06 発だと実測徒歩が見積り5分から8分へ伸びて発車後に駅着＝乗り遅れとなり、
    // 到着(arrivalMinutes)だけ予算内に見える「乗れない電車」になってしまい、
    // 「電車で間に合うケース」を表現できない（乗り遅れは last-resort の発火条件）。
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
      arrival: new TimeValue({ h: 10, m: 0 }), // 予算60分（電車も全徒歩も届かない）
      origin: busOrigin,
    });
    const bus = firstWhere(plan.segments, (s) => s.type === SegmentType.bus);
    expect(bus.line).toEqual('渋谷01');
    expect(bus.depTime).toEqual(dateTime(2026, 6, 27, 9, 5));
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });

  it('時刻を持たないバス便は幽霊バスとして提示しない', async () => {
    // 時刻なしバスは所要0分＝予算内に見えるが、引き直しでも実発車時刻を確認できない。
    // 電車と同じ基準（unverified transit）で確定させず、全徒歩へ縮退する。
    const svc = service(
      busMock({ busOption: busOption({ dep: null, arr: null }) }),
    );
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
    // 09:00 出発・予算60分に対しバスは 10:05 発 10:15 着＝乗車待ち65分（>予算）・到着75分。
    // best-effort は「今夜乗れる候補の最早到着」を選ぶため、検証済みの標準乗換（到着81分）
    // より早いこのバスが勝ってしまう。maxBoardingWait がバスの待ちを数えて初めて
    // 「今は乗れない便」として reachableWithinBudget から外れ、電車へ縮退する
    // （#250。数えないと待ち0に見えてこのバスが提示される＝#121 と同型の退行）。
    const svc = service(
      busMock({ busOption: busOption({ dep: 36300, arr: 36900 }) }),
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
      '今夜（今日）乗れないバスを提示してはならない',
    ).toHaveLength(0);
  });

  it('collapse→board-search が全滅してもバス候補を取り下げない', async () => {
    // バスが予算内で勝つ → collapse 判定が立ち board-search が起動する。board-search は
    // 到着だけ見て候補を返すが、その電車は乗り遅れ（09:10 発／乗車駅着 09:31）なので
    // enrich で全滅する。再選定のプールにバスを引き継がないと、せっかく見つけた予算内の
    // バスを捨てて予算外の best-effort へ落ちてしまう。
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
    // 標準乗換は見積り徒歩1分で 09:20 発に間に合うが、実測徒歩31分では乗り遅れる。
    // 乗り遅れたまま到着だけ数えると41分＝予算内に見えるため、到着だけで発火判定すると
    // 「実際には乗れない電車」を提示してバス再照会を撃ち漏らす。
    const svc = service(
      busMock({ busOption: busOption(), originOption: missedTrainOption() }),
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
      '乗り遅れる電車しか無いならバスを引くべき',
    ).not.toHaveLength(0);
    expect(
      firstMissedTransit(plan.segments, dateTime(2026, 6, 27, 9, 0)),
      '乗り遅れる便を確定してはならない',
    ).toBeNull();
  });
});

// last-resort でバスが勝ったら、そのバス corridor にも徒歩最大化（途中下車・乗車駅探索）を
// フル適用する（#251）。通常照会（電車が予算内）では #249 の train-only ガードを維持する。
describe('plan: バス corridor の徒歩最大化 (#251)', () => {
  const busOrigin = new GeoPoint(35.0, 139.0);
  const busGoal = new GeoPoint(35.0, 139.127); // 直線 11.6km（全徒歩 145分）
  // バス停 A は origin から徒歩14分。バス corridor はそこから goal まで。
  const bs0 = 139.012;
  const corridor = [bs0, 139.05, 139.09, 139.11, 139.127];
  const busDep = 33300; // 09:15

  /// 迂回バスの corridor が通る緯度。勝者 corridor（lat 35.0）と区別するために使う。
  const detourLat = 35.02;

  /// バスの実ダイヤ速度（モック）。既定は見積り（[trainMetersPerMinute]）と同じにして、
  /// 「見積りが通った候補は実時刻でも通る」フィクスチャにする。[metersPerMinute] を
  /// 下げると「実ダイヤは見積りより遅い」実世界の条件を再現できる。
  const rideMin = (
    a: GeoPoint,
    b: GeoPoint,
    metersPerMinute?: number,
  ): number =>
    Math.round(
      (haversineKm(a, b) * 1000) / (metersPerMinute ?? trainMetersPerMinute),
    );

  /// 電車のみの主照会が返す option。09:50 発 10:20 着で予算65分（10:05 着）に届かない。
  /// コリドーは2点だけにして電車ハイブリッドを1本に抑える。
  const slowTrainOption = (): JsonMap => ({
    journey: {
      departureSecs: 35400, // 09:50
      arrivalSecs: 37200, // 10:20
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

  /// バス許容照会（origin 起点）が返す door-to-door option。徒歩14分でバス停 A へ出て
  /// 09:15 発のバスに乗り goal まで乗り通す（徒歩14分・到着36分）。
  const busDoorToDoor = (): JsonMap => ({
    journey: {
      departureSecs: busDep,
      arrivalSecs: busDep + rideMin(new GeoPoint(35.0, bs0), busGoal) * 60,
      durationSecs: 2160,
      accessWalkSecs: 840, // 徒歩14分
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

  /// last-resort が door-to-door と同時に返す「もう1本のバス」。徒歩0分で乗れて所要も
  /// 短い（16分）ため「最短 option」基準ではこちらが選ばれてしまうが、徒歩最大化の
  /// 勝者は徒歩14分の [busDoorToDoor] の方。corridor は北へ迂回させて（lat [detourLat]）、
  /// どちらの corridor を基準にしたかを照会ログで判別できるようにする。
  const detourBus = (): JsonMap => ({
    journey: {
      departureSecs: busDep,
      arrivalSecs: busDep + 960, // 16分乗車
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

  /// バス許容照会（コリドー点起点）が返す単一バス便。[at] 以降で最も早い便として
  /// 09:15、それを過ぎていれば [at]+5分に発車する。乗車駅探索・実時刻検証の引き直し用。
  /// [busSpeed] を渡すと実ダイヤだけを遅くできる（見積りは [trainMetersPerMinute] のまま）。
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

  /// バス許容照会が返す「電車＋バス」の混合便。バスだけの便より早く着く。
  /// バス許容 (`allowBus`) の照会は電車も許すので、上流はこういう option も返し得る。
  const trainThenBusFrom = (
    from: GeoPoint,
    to: GeoPoint,
    at: Date,
  ): JsonMap => {
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

  /// all-walk のみ（電車のみ照会をコリドー点から引いたとき＝引き直し失敗の表現）。
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

  /// [withDetourBus] を立てると last-resort が [detourBus] も返す（勝者でない最短 option）。
  /// [busSpeed] は引き直し便の実ダイヤ速度（既定は見積りと同速）。
  /// [withMixedTrainBus] を立てると、区間内（goal 以外）へのバス許容照会が「電車＋バス」の
  /// 早着便も返す——バス1区間の時刻・停留所名を復元する照会に混合便が混ざる条件。
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
        const at = dateTime(
          2026,
          6,
          27,
          Number.parseInt(hm[0], 10),
          Number.parseInt(hm[1], 10),
        );
        // 迂回 corridor は lat が違うので、緯度も含めて origin 起点かを判定する。
        const fromOrigin =
          Math.abs(from.lat - busOrigin.lat) < 1e-9 &&
          Math.abs(from.lng - busOrigin.lng) < 1e-9;
        const options: JsonMap[] = [];
        if (allowsBus) {
          if (fromOrigin) {
            options.push(busDoorToDoor());
            if (o.withDetourBus === true) options.push(detourBus());
          } else {
            if (
              o.withMixedTrainBus === true &&
              Math.abs(to.lng - busGoal.lng) > 1e-9
            ) {
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

  /// guidance/plan のうち、コリドー点（origin 以外）を起点にしたバス許容照会。
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
      arrival: new TimeValue({ h: 10, m: 5 }), // 予算65分
      origin: busOrigin,
    });

  it('バス区間の引き直しは電車混じりの早着便から時刻・停留所名を採らない（レビュー指摘）', async () => {
    // `type == bus` の照会は `allowBus` ＝電車も許すので、電車＋バスの混合便が返り得る。
    // 到着最早だけで選ぶとそれが勝ち、そこからバス leg だけ抜いた時刻・停留所名を
    // **バス1区間ぶんとして**貼ることになる——電車部分が消え、乗車地点も所要も別物になる。
    const plan = await runPlan(corridorMock({ withMixedTrainBus: true }));
    const bus = firstWhere(plan.segments, (s) => s.type === SegmentType.bus);

    expect(bus.fromName, '混合便のバス停名（M停留所）を貼ってはならない').toEqual(
      'X停留所',
    );
    expect(bus.depTime, 'バスのみの便から実発車時刻が当たるべき').not.toBeNull();
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });

  it('バスが last-resort で勝つとき、手前のバス停で降りて歩く候補を選ぶ', async () => {
    // door-to-door のバス（徒歩14分・到着36分）は予算65分に対し29分も余らせる。
    // バス corridor をハイブリッド化できれば、139.11 のバス停で降りて19分歩く候補
    // （徒歩33分・到着52分）が作れる。train-only ガードのままだとこれが生成されず、
    // 徒歩14分の乗り通しが確定してしまう。
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
    expect(
      walkMinutes,
      'door-to-door バス（徒歩14分）より歩く候補を選ぶべき',
    ).toBeGreaterThan(14);
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });

  it('バス corridor 起点の引き直しはバスを許容する', async () => {
    const log: URL[] = [];
    await runPlan(corridorMock({ log }));
    // origin 起点のバス許容照会は last-resort（#250）そのものなので除く。コリドー点
    // （バス停）を起点にした照会が出て初めて、バス corridor が徒歩最大化の基準になっている。
    expect(
      corridorBusQueries(log),
      'origin 以外（バス停）を起点にバス許容で引き直しているはず',
    ).not.toHaveLength(0);
  });

  it('基準にするのは最短のバス option ではなく徒歩最大化で勝ったバス option', async () => {
    // last-resort が2本返す: 徒歩0分・16分乗車の迂回バス（総所要が最短）と、徒歩14分・
    // 21分乗車の door-to-door バス（総所要35分）。徒歩最大化が選ぶのは後者だが、
    // base を「最短の option」で決めると前者の corridor（北へ迂回・lat 35.02）を
    // 引き直してしまい、乗車バス停探索が勝者と無関係な停留所を評価して空振りする。
    const log: URL[] = [];
    const plan = await runPlan(corridorMock({ log, withDetourBus: true }));

    const fromDetour = corridorBusQueries(log).filter((u) =>
      (u.searchParams.get('from') ?? '').startsWith(
        `geo:${dartDouble(detourLat)},`,
      ),
    );
    expect(fromDetour, '勝者でない迂回バスの corridor を基準にしてはならない').toHaveLength(
      0,
    );
    const fromWinner = corridorBusQueries(log).filter((u) =>
      (u.searchParams.get('from') ?? '').startsWith('geo:35.0,'),
    );
    expect(
      fromWinner,
      '勝ったバス option の corridor 上のバス停から引き直すはず',
    ).not.toHaveLength(0);
    expect(
      last(plan.segments).type,
      '勝者 corridor で徒歩最大化できているので手前で降りて歩く',
    ).toEqual(SegmentType.walk);
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });

  it('バスの実ダイヤが見積りより遅ければ ハイブリッドは実時刻検証で落ち乗り通しへ戻る', async () => {
    // 見積りは楽観側（[trainMetersPerMinute]）に倒し、実速度の遅さは採用前の実時刻検証が
    // 上書きして弾く、という #251 の設計の裏取り。実ダイヤを半速にすると 139.11 で降りる
    // 候補は到着70分（予算65分）で除外され、予算内で確実に乗れる door-to-door の
    // 乗り通しへ安全に戻る。
    const plan = await runPlan(
      corridorMock({ busSpeed: trainMetersPerMinute / 2 }),
    );
    const walkMinutes = plan.segments
      .filter((s) => s.type === SegmentType.walk)
      .reduce((a, s) => a + s.minutes, 0);

    expect(last(plan.segments).type, '乗り通しへ戻る').toEqual(SegmentType.bus);
    expect(walkMinutes, 'door-to-door バスのアクセス徒歩そのもの').toEqual(14);
    expect(
      plan.totalMin,
      '遅いハイブリッドを掴んで予算超過してはならない',
    ).toBeLessThanOrEqual(plan.budgetMin);
  });

  it('電車が予算内なら バス corridor 化は起きずバス許容照会も出ない', async () => {
    // #249 の train-only ガード維持。09:15 発の電車で予算内に収まるので last-resort は
    // 発火せず、コリドー引き直しは常に avoidModes=bus のまま。
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
    expect(
      plan.segments.filter((s) => s.type === SegmentType.bus),
    ).toHaveLength(0);
    const busAware = log.filter(
      (u) =>
        u.pathname.includes('guidance/plan') &&
        !(u.searchParams.get('avoidModes') ?? '').includes('bus'),
    );
    expect(busAware, '電車 corridor の引き直しはバスを除外したまま').toHaveLength(0);
  });
});

// 確定境界（best-effort 縮退・enrich ループの確定パス）で、実測徒歩による乗り遅れを
// 再判定する（#254）。選定時の乗り遅れ判定は guidance 見積り徒歩に対して走るが、確定直前の
// enrich が徒歩を Google 実街路へ伸ばすため、そこで初めて発車後に駅着＝乗れない便になり得る。
describe('plan: 確定境界の乗り遅れ再判定 (#254)', () => {
  const departureAt = dateTime(2026, 6, 27, 9, 0);

  it('best-effort 縮退は実測徒歩で乗り遅れる経路を確定しない', async () => {
    // 既定の singleTrainOption() は 09:06 発・見積りアクセス徒歩5分だが、map の walk polyline
    // を実測すると8分（09:08 着）＝発車済み。予算50分では全徒歩(69分)も電車も予算内に入らず
    // best-effort へ縮退する。縮退は enrich 前の segments で firstMissedTransit を
    // 見るため見積り5分では乗り遅れず、そのまま enrich して「乗れない電車」を確定していた。
    const svc = service(mock({ transit: guidance([singleTrainOption()]) }));
    const plan = await svc.plan({
      destination: '新宿',
      destinationLatLng: goal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 9, m: 50 }), // 予算50分（何も予算内に入らない）
      origin,
    });
    expect(
      firstMissedTransit(plan.segments, departureAt),
      '実測徒歩で発車後に駅着する便を best-effort で確定してはならない',
    ).toBeNull();
  });

  /// 停車駅2点だけの単一電車 option。コリドーが痩せてハイブリッド候補が作られないため、
  /// enrich ループのプールは「標準乗換 ＋ 全徒歩」の2件になる。
  const twoStopOption = (): JsonMap => {
    const stops = [
      [35.6812, 139.7671], // 東京（origin から直線徒歩8分）
      [35.6909, 139.7003], // 新宿（goal のほぼ隣）
    ];
    return {
      journey: {
        departureSecs: 32760, // 09:06
        arrivalSecs: 34560, // 09:36
        durationSecs: 2400,
        accessWalkSecs: 300, // 見積り徒歩5分（実測は8分×factor）
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
          mapSeg('walk', 'origin', 'jr:Tokyo', 'osmWalk', [
            [35.68, 139.76],
            stops[0],
          ]),
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
    // 予算75分。全徒歩は見積り69分で予算内＝徒歩最大として真っ先に選ばれるが、実測（×1.3）で
    // 90分へ伸び予算超過して落ちる。残る標準乗換1件は見積り徒歩5分で 09:06 発に間に合うのに、
    // 実測徒歩10分では発車後に駅着する。enrich ループは `pool.length > 1` のときしか除外できず、
    // 1件に痩せたこの候補を missedAfterEnrich のまま確定していた。
    const svc = service(
      mock({ transit: guidance([twoStopOption()]), walkFactor: 1.3 }),
    );
    const plan = await svc.plan({
      destination: '新宿',
      destinationLatLng: goal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 10, m: 15 }), // 予算75分
      origin,
    });
    expect(
      firstMissedTransit(plan.segments, departureAt),
      'プールが1件でも乗り遅れる便を確定してはならない',
    ).toBeNull();
  });

  it('乗り遅れ候補が試行上限より多くても全徒歩まで縮退しきる', async () => {
    // best-effort の除外ループに試行上限を置くと、乗り遅れ候補がそれより多いとき
    // 全徒歩へ到達する前に打ち切られ、乗り遅れる便を確定してしまう。
    // 「全徒歩は決して乗り遅れないので縮退先は必ず存在する」という #254 の不変条件は、
    // 上限を置かない（プールが1件に痩せるまで回す）ことでしか成立しない。
    // 09:06 発・実測徒歩8分で乗り遅れる電車を9本並べ、上限を確実に踏み抜かせる。
    const options: JsonMap[] = [];
    for (let i = 0; i < 9; i++) {
      // 到着だけずらし全便が乗り遅れ
      options.push(singleTrainOption({ arr: 34560 + i * 60 }));
    }
    const svc = service(mock({ transit: guidance(options) }));
    const plan = await svc.plan({
      destination: '新宿',
      destinationLatLng: goal,
      departure: new TimeValue({ h: 9, m: 0 }),
      arrival: new TimeValue({ h: 9, m: 50 }), // 予算50分（何も予算内に入らない）
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

// 独立な検索 IO の並列化（#304）。fake client の deferred バリア——「両者の照会が
// **両方**到達するまでどちらの応答も返さない」——で並行到達を検証する。逐次実装は
// 先行の応答を待ったまま後続を発行できずデッドロック（テストは timeout で fail）し、
// 並列実装でのみ完走する。タイミング依存の sleep を使わない決定的な検証。
describe('plan: 崩壊見込みの board-search を enrich と並行に起動する (#341)', () => {
  const origin4 = new GeoPoint(35.0, 139.0);
  const goal4 = new GeoPoint(35.0, 139.5);

  const geoOf = (raw: string | null): GeoPoint =>
    pt((raw ?? '0,0').replace('geo:', ''));
  const same = (a: GeoPoint, b: GeoPoint): boolean =>
    Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lng - b.lng) < 1e-6;

  /// 徒歩・マトリクスを直線の3倍で返す（実街路の迂回を模す）。[onEnrichWalk] は
  /// **origin 起点でない**徒歩実測でだけ呼ぶ——board-search の probe 徒歩は必ず
  /// origin 起点なので、これで enrich の egress 実測だけを掴める。[onBoardProbe] は
  /// コリドー点→goal の引き直し＝board-search の probe でだけ呼ぶ（駅名確定の
  /// 引き直しは乗車座標→降車座標なので to で弾ける）。
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
        if (
          !same(pt(q.get('start') ?? '0,0'), origin4) &&
          o.onEnrichWalk !== undefined
        ) {
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
      arrival: new TimeValue({ h: 10, m: 0 }), // 予算60分
      origin: origin4,
      originName: '出発',
    });

  it('board-search の引き直しと enrich の徒歩実測が同時に上流へ到達する', async () => {
    // board-search を勝者確定後に置く逐次実装では、enrich が終わるまで引き直しが1本も
    // 出ない＝両者は同時に到達できない。到達を相互待ちにすると逐次実装はデッドロックし、
    // タイムアウトで落ちる（#304 の2系統並列テストと同じ手口）。
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
    // 前倒しするのは電車系だけ。バス許容の引き直しが並行して出ていたら、勝者未確定＝
    // 基準コリドーが決まらないバス系まで投機したことになる。
    for (const u of earlyRedraws) {
      expect(
        u.searchParams.get('avoidModes') ?? '',
        'バス系 board-search は勝者確定後のまま（busBase は enrich 依存）',
      ).toContain('bus');
    }
  });

  it('崩壊すれば投機の結果を使い、徒歩最大化は実測の境界で決まる', async () => {
    // 受け入れ条件の反証側: 前倒ししても board-search の候補がプールへ入り、境界が
    // 実測（probeFailed=0）で決まっていること。probeFailed が立つ＝直線推定への縮退か
    // 上流失敗で、境界がその地点の実力から引き剥がされている印。
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

  it('崩壊しなければ結果を捨て、空振りを probe 本数で計上する', async () => {
    // 見積りでは予算内・崩壊ぎみ（→投機起動）だが、実測徒歩が20倍に膨らんで先頭電車に
    // 乗り遅れ、確定は予算外の best-effort へ縮退する＝ collapse は成立しない。投機は
    // 丸ごと無駄撃ちになるので、発火と対価を計上できていること。
    //
    // enrich 側を「最初の probe が出るまで」待たせるのは、probe 本数の観測を決定的に
    // するため（sleep で待つとロードの高い CI で揺れる）。一方向のゲートなので、
    // 投機が実装されていなければここで詰まってタイムアウトする。
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
    // 並行ファンアウトの結果を捨てる経路（`ignore` / catch）を足すとき、キャンセルまで
    // 一緒に飲みやすい。飲むと離脱後も勝者だけで完走してしまう（#316・cancellation.ts）。
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
    // #250/#251 と同型の状況: 電車は予算外 → バス last-resort が勝つ → 崩壊判定が立ち、
    // 電車 base とバス busBase の両系統で board-search が起動する。
    const o = new GeoPoint(35.0, 139.0);
    const g = new GeoPoint(35.0, 139.127); // 直線 ~11.6km（全徒歩 ~145分）
    const trainLat = 35.0;
    const busLat = 35.001; // コリドー緯度で電車系/バス系の照会を判別する
    const trainCorridorLngs = [139.02, 139.05, 139.08, 139.1];
    const busCorridorLngs = [139.012, 139.05, 139.09, 139.127];
    const busRideMin = Math.round(
      (haversineKm(
        new GeoPoint(busLat, 139.012),
        new GeoPoint(busLat, 139.127),
      ) *
        1000) /
        trainMetersPerMinute,
    );

    /// 電車のみの主照会が返す option。09:50 発 10:20 着＋徒歩2分で予算60分に届かない。
    const slowTrainOption = (): JsonMap => ({
      journey: {
        departureSecs: 35400, // 09:50
        arrivalSecs: 37200, // 10:20
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

    /// バス許容照会（origin 起点）が返す option。徒歩14分＋09:15 発で予算内に収まり
    /// 勝者になる（＝busBase が立つ）。
    const busDoorToDoor = (): JsonMap => ({
      journey: {
        departureSecs: 33300, // 09:15
        arrivalSecs: 33300 + busRideMin * 60,
        durationSecs: 840 + busRideMin * 60 + 60,
        accessWalkSecs: 840, // 徒歩14分
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

    /// all-walk のみ＝引き直しで便を確認できない応答。
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
      const toGoal =
        near(Number.parseFloat(to[0]), g.lat) &&
        near(Number.parseFloat(to[1]), g.lng);
      let body: JsonMap;
      if (fromOrigin) {
        body = guidance([allowsBus ? busDoorToDoor() : slowTrainOption()]);
      } else if (toGoal && !allowsBus && near(fromLat, trainLat)) {
        // 電車系 board-search の引き直し（崩壊フェーズ）: バス系の到達までブロック。
        if (!trainProbe.isCompleted) trainProbe.complete(undefined);
        await barrier();
        body = guidance([walkOnlyOption()]);
      } else if (toGoal && allowsBus && near(fromLat, busLat)) {
        // バス系 board-search の引き直し（崩壊フェーズ）: 電車系の到達までブロック。
        if (!busProbe.isCompleted) busProbe.complete(undefined);
        await barrier();
        body = guidance([walkOnlyOption()]);
      } else {
        // その他の引き直し（実時刻解決など）は即応答。
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
        arrival: new TimeValue({ h: 10, m: 0 }), // 予算60分
        origin: o,
        originName: '出発',
      }),
      5000,
      () =>
        expect.fail(
          '電車系とバス系の board-search 照会が同時到達しない（逐次実行でデッドロック）',
        ),
    );

    expect(trainProbe.isCompleted, '前提: 電車系 board-search が発火').toBe(true);
    expect(busProbe.isCompleted, '前提: バス系 board-search が発火').toBe(true);
    // 退行ガード: 並列化しても選定結果（予算内のバス勝者）は変わらない。
    const bus = firstWhere(plan.segments, (s) => s.type === SegmentType.bus);
    expect(bus.line).toEqual('バス01');
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
  });

  it('駅名確定は未命名 transit 区間を並列に照会する', async () => {
    // 実時刻付き・駅名なしの2連 rail leg が勝者になり、駅名確定が
    // 2区間それぞれの乗降座標で引き直す状況を作る。照会は departureAt（time=09:00）で
    // 発行される——実時刻解決（boardAt > 09:00）と判別できる。
    const o = new GeoPoint(35.68, 139.76);
    const g = new GeoPoint(35.69, 139.7);
    const a1 = [35.6812, 139.7671];
    const a2 = [35.686, 139.735];
    const a3 = [35.6909, 139.7003];

    /// 駅名の無い（from/to に name が無い）2連 rail leg の option。09:10→09:30 で
    /// 予算45分に収まる。slack 10分 < 閾値なので崩壊フォールバックは起動しない。
    const unnamedTwoLegOption = (): JsonMap => ({
      journey: {
        departureSecs: 33000, // 09:10
        arrivalSecs: 34200, // 09:30
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
          mapSeg('walk', 'x:3', 'destination', 'estimatedWalk', [
            a3,
            [35.69, 139.7],
          ]),
        ],
      },
    });

    /// 駅名復元の引き直しへ返す「実駅名付き」option。
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

    /// all-walk のみ＝時刻なしハイブリッドの実時刻解決を空振りさせる応答。
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
        // 駅名復元（departureAt 発行）の leg1 照会: leg2 の到達までブロック。
        if (!probeLeg1.isCompleted) probeLeg1.complete(undefined);
        await barrier();
        body = guidance([namedOption('駅一', '駅二', a1, a2)]);
      } else if (q.get('time') === '09:00' && near(fromLng, a2[1])) {
        // 駅名復元の leg2 照会: leg1 の到達までブロック。
        if (!probeLeg2.isCompleted) probeLeg2.complete(undefined);
        await barrier();
        body = guidance([namedOption('駅二', '駅三', a2, a3)]);
      } else {
        // 実時刻解決（boardAt > 09:00）などは即応答＝空振り。
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
        arrival: new TimeValue({ h: 9, m: 45 }), // 予算45分（崩壊は不成立）
        origin: o,
        originName: '出発',
      }),
      5000,
      () =>
        expect.fail('未命名2区間の駅名復元照会が同時到達しない（逐次実行でデッドロック）'),
    );

    expect(probeLeg1.isCompleted, '前提: leg1 の駅名復元照会が発火').toBe(true);
    expect(probeLeg2.isCompleted, '前提: leg2 の駅名復元照会が発火').toBe(true);
    // 退行ガード: 並列化しても駅名の復元・伝播は変わらない。
    const trains = plan.segments.filter((s) => s.type === SegmentType.train);
    expect(trains).toHaveLength(2);
    expect(trains[0].fromName).toEqual('駅一');
    expect(trains[0].toName).toEqual('駅二');
    expect(trains[1].fromName).toEqual('駅二');
    expect(trains[1].toName).toEqual('駅三');
  });
});

// 候補間並列（#315）の例外境界と共有レッグ再利用（#316 レビュー）。並列一括実測は
// (A) キャンセルを飲まず伝播し、(B) 非勝者の壊れた応答で plan() 全体を落とさず、
// (C) 同一徒歩レッグを in-flight でも1回に畳む——を検証する。
describe('plan: 候補間並列の例外境界と共有レッグ (#316)', () => {
  const o = new GeoPoint(35.0, 139.0);
  const g = new GeoPoint(35.0, 139.03); // 全徒歩 見積り~34分＝予算30分外
  const alight = [35.0, 139.029]; // 降車＝全候補共通（egress レッグを共有）

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
        mapSeg('walk', 'origin', `${a.route}:board`, 'osmWalk', [
          [o.lat, o.lng],
          a.board,
        ]),
        mapSeg(
          'transit',
          `${a.route}:board`,
          `${a.route}:alight`,
          'stopOrder',
          [alight],
        ),
        mapSeg('walk', `${a.route}:alight`, 'destination', 'estimatedWalk', [
          alight,
          [g.lat, g.lng],
        ]),
      ],
    },
  });

  const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-6;

  // A. 先行実測（#315 Option B＝勝者を1パスで温める）中に徒歩実測がキャンセルで倒れたら、
  //    その例外は握り潰さず plan() まで伝播させる。先行実測は「壊れた応答は候補ごとに握って
  //    落とす」fail-open だが、キャンセルだけは飲んではならない——飲むと離脱後も残りの候補で
  //    完走してしまう（#316: cancellation.ts のキャンセル境界を並列パスでも守る）。
  it('先行実測中のキャンセルは握り潰さず伝播する', async () => {
    const wBoard = [35.0, 139.01]; // 勝者W: 徒歩最大（先行実測で温められる）
    const vBoard = [35.0, 139.005]; // 早着・徒歩少の下位候補
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
        // 勝者W の access 徒歩実測（origin→W乗車駅）がキャンセルで倒れる。
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

  // B. 同tier の2候補（徒歩同・A が早着で勝者、B が下位）。B の access 徒歩実測が壊れた
  //    応答（parse 不能）で例外を上げても、B だけ落として A を返す。旧実装は tier バッチの
  //    Promise.all が非勝者 B の例外を伝播させ plan() 全体を落としていた。
  it('同tier 非勝者の壊れた応答は当該候補だけ落として勝者を返す', async () => {
    const aBoard = [35.001, 139.01]; // A: 早着で勝者
    const bBoard = [34.999, 139.01]; // B: 徒歩同（同tier）だが下位。access が壊れる
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
        // B の access 徒歩実測だけが parse 不能で倒れる（RouteException でも
        // SearchCanceledException でもない一般例外。Dart の FormatException に対応する
        // のは JSON の解析が投げる SyntaxError）。
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

  // C. 勝者W と代替V は egress（降車→目的地）を共有する。先行実測は両者を並列に測るので、
  //    完了結果しか持たない素のキャッシュでは両者とも外して googleWalkProxy を二重発行する。
  //    in-flight の Promise を単一化し、共有レッグの実測を1回に畳む。
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
      arrival: new TimeValue({ h: 10, m: 40 }), // 予算100分
      origin: o,
      originName: '出発',
    });

  const walkOf = (plan: RoutePlan): number =>
    plan.segments
      .filter((s) => s.type === SegmentType.walk)
      .reduce((a, s) => a + s.minutes, 0);

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
      (u) =>
        u.pathname.includes('guidance/plan') &&
        u.searchParams.get('type') === 'arrival',
    );
    expect(wave.searchParams.get('from')).toEqual('geo:35.0,139.0');
    expect(wave.searchParams.get('to')).toEqual('geo:35.0,139.1');
    expect(wave.searchParams.get('date')).toEqual('20260627');
    expect(wave.searchParams.get('time')).toEqual('10:40'); // 09:00 + 予算100分
    // departure 波と同じ train-only 条件（§1.1 の last-resort 構造は変えない）。
    expect(wave.searchParams.get('avoidModes')).toEqual('bus,ferry,air');
  });

  // 出発日時の日送りが経過時間の加算だと、DST のある端末タイムゾーンでは
  // spring-forward を跨ぐ壁時計が1時間ずれる（#121 と同じクラス）。フィールド加算に
  // よる暦正規化（月末・年末の繰り上げ）をここで固定する。
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
      arrival: new TimeValue({ h: 10, m: 40, dateOffset: 1 }), // 予算100分
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
    // departure 波はファミリA（コリドー2点＝徒歩は access+egress の ~4分止まり）だけ。
    // ファミリB（コリドー3点）は arrival 波にしか居ないので、第2波を合流しなければ
    // B のコリドー由来ハイブリッド（徒歩82分）は原理的に生成されない。
    const plan = await run(
      waveMock({
        departure: guidance([familyA()]),
        arrival: guidance([familyB()]),
      }),
    );
    expect(walkOf(plan)).toBeGreaterThan(40);
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
    expect(
      plan.segments.some(
        (s) => s.type === SegmentType.train && s.line === '各停線',
      ),
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
    // 両ファミリが departure 波に揃っているときの従来結果と同一。
    expect(walkOf(plan)).toBeGreaterThan(40);
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
    expect(
      plan.segments.some(
        (s) => s.type === SegmentType.train && s.line === '各停線',
      ),
    ).toBe(true);
  });

  it('猶予内に返らない arrival 波は待たずに departure 波だけで確定する', async () => {
    // 応答は deferred で止める（実時間タイマーで「遅い応答」を作るテストは負荷で
    // フレークする）。猶予切れの側だけを見るので、gate は検証が済むまで完了しない。
    const gate = deferred<HttpResponse>();
    let captured: RouteSearchMetrics | null = null;
    const plan = await run(
      waveMock({
        departure: guidance([familyA(), familyB()]),
        onArrival: () => gate.promise,
      }),
      { onMetrics: (m) => (captured = m), arrivalWaveGrace: 20 },
    );

    // departure 波だけで従来どおり確定する。
    expect(plan.totalMin).toBeLessThanOrEqual(plan.budgetMin);
    const m = captured!;
    // 猶予切れも合流できる素材が無い点は失敗と同じだが、原因は別物として残す
    // ——集計で「間に合わなかった」と「仮説が外れた」を取り違えないため（#376）。
    expect(m.arrivalWaveOutcome).toEqual(ArrivalWaveOutcome.timeout);
    expect(m.arrivalWaveOptions).toEqual(0);
    expect(m.arrivalWaveBaseUsed).toBe(false);
    expect(m.arrivalWaveWon).toBe(false);

    // 宙に浮いた応答を閉じ、上流タイムアウトのタイマーを残さない。
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
    // arrival 波は有効な option を返す。第2波が必須波を肩代わりしてしまう実装なら
    // ここで成功してしまう。
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
    // 到着アンカーの主産物は「同じ系統の、締切ぎりぎりまで遅らせた便」なので、構造
    // （種別・路線名・乗降座標）だけで畳むと第2波の中身がまるごと消える。
    //
    // 罠: departure 波の各停は予算外（09:03→10:50 で到着114分 > 予算100分）、arrival 波の
    // 急行だけが予算内（09:30→09:50 で到着52分）。構造だけの鍵だと急行が捨てられて
    // 予算内候補が消滅し、検索は best-effort（予算外）へ落ちる。勝者の同定は seg.minutes
    // ではなく depTime/arrTime で行う（比較器は arrTime 駆動・#256）。
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
        // 各停 09:03発→10:50着（予算外）
        departure: guidance([sameLineRun({ dep: 32580, arr: 39000 })]),
        // 急行 09:30発→09:50着（予算内）。路線名も乗降座標も各停と同一。
        arrival: guidance([sameLineRun({ dep: 34200, arr: 35400 })]),
      }),
      { onMetrics: (m) => (captured = m) },
    );

    expect(plan.totalMin, '急行が生き残れば予算内で確定できる').toBeLessThanOrEqual(
      plan.budgetMin,
    );
    const trains = plan.segments.filter((s) => s.type === SegmentType.train);
    expect(trains).toHaveLength(1);
    expect(first(trains).depTime).toEqual(dateTime(2026, 6, 27, 9, 30));
    expect(first(trains).arrTime).toEqual(dateTime(2026, 6, 27, 9, 50));
    expect(captured!.arrivalWaveOptions, '別便なので純増1本').toEqual(1);
  });

  it('arrival 波の出発済み便は既存の不変条件が弾き確定に出ない', async () => {
    // 罠: 幽霊特急は徒歩59分（プール最大）で見積り到着69分（予算100分内）なので、
    // 乗り遅れ判定が無ければ**必ず勝つ**。08:00 発＝照会時刻 09:00 より前なので待ちが
    // 0 に丸まり、到着が楽観へ縮退する（#343 のクラス）。arrivalMinutes は arrTime 駆動
    // なので depTime/arrTime で仕込む。
    const departed = (): JsonMap => ({
      journey: {
        departureSecs: 28800, // 08:00 = departureAt(09:00) より前
        arrivalSecs: 29400, // 08:10
        durationSecs: 29400 - 28800 + 3540,
        accessWalkSecs: 3420, // origin->139.050 ≒ 57分（徒歩最大の源）
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
    expect(
      countOf(dup, 'guidance/plan'),
      'arrival 波の1本は両方に載る＝差は出ないはず',
    ).toEqual(countOf(empty, 'guidance/plan'));
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
      // 第2波の1本は既存の数え方のまま guidanceCalls に乗る。
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
      // 「仮説が外れた」唯一の形。ここだけが revert の根拠になり得るので、
      // 猶予切れ・上流エラーと同じコードに潰してはいけない（#376・§3.8）。
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
      expect(m.arrivalWaveOutcome, '応答自体は有効だった').toEqual(
        ArrivalWaveOutcome.ok,
      );
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
    // fail-soft の catch がキャンセルまで飲むと、離脱後も departure 波だけで完走して
    // 経路を返してしまう（#316 と同型）。
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
