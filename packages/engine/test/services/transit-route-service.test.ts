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
import { CancellationToken } from '../../src/services/cancellation';
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
  type RouteSearchMetrics,
} from '../../src/services/route-diagnostics';
import {
  firstMissedTransit,
  trainMetersPerMinute,
  walkMetersPerMinute,
} from '../../src/services/route-plan-builder';
import { RouteException, RoutePhase } from '../../src/services/route-service';
import { SearchDeadline } from '../../src/services/search-deadline';
import {
  TransitCorridor,
  TransitOption,
} from '../../src/services/transit-plan-parser';
import { TransitRouteService } from '../../src/services/transit-route-service';
import { dateTime, seconds } from '../../src/time';
import { deferred } from '../support/deferred';
import { delay } from '../support/delay';
import { expectThrowsA } from '../support/expect';
import { first, firstWhere, last, single } from '../support/iterable';
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
