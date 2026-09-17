/// 偽の上流。Transit API と Cloud Functions プロキシの応答を、要求から**その場で
/// 組み立てて**返す。
///
/// 固定のレスポンス（録画）にしないのは、エンジンが検索1回で同じ種類の要求を
/// 何本も——乗車駅を動かした引き直し・コリドー各停留所への徒歩マトリクス——
/// 発行するため。URL ごとの当てはめにすると、探索が少し変わっただけで当たらなく
/// なり、上流の不調と同じ顔（候補ドロップ・直線推定）で静かに縮退する。
///
/// 距離と所要は**エンジン自身の定数**（`walkMetersPerMinute` / `trainMetersPerMinute` /
/// `haversineKm`）で組む。packages/engine のテストが同じ形で組んでいるのと同じ理由で、
/// 偽の上流が実在の街路より速い・遅いことを主張してしまわないようにする。
import type { Page, Request } from '@playwright/test';

import { GeoPoint } from '@aruku/engine/models/geo-point';
import { haversineKm } from '@aruku/engine/services/hybrid-route-selector';
import {
  trainMetersPerMinute,
  walkMetersPerMinute,
} from '@aruku/engine/services/route-plan-builder';

import { proxyBaseUrl, transitBaseUrl, upstreamPrefix } from './endpoints';

/// 偽の路線名。`railLineLabel` は英大文字1〜3文字の路線記号コードだけを和名へ写す
/// ので、和名はそのまま画面に出る（rail-line-names.ts）。
export const fakeRailLine = 'テスト線';

/// 偽の駅名の素。座標から決まる添字で引く——乗車駅探索が駅を動かしても、同じ座標に
/// 同じ名前が付く。
const stationNames = [
  '桜川',
  '青葉台',
  '緑が丘',
  '柊町',
  '楓橋',
  '椿平',
  '欅坂',
  '楠本',
];

/// 乗車から発車までの待ち。0 にしないのは、待ちを所要へ足し忘れる退行が
/// 「待ち時間ゼロの経路」として通ってしまうため。
const boardingWaitSecs = 240;

export interface FakePlace {
  readonly placeId: string;
  readonly name: string;

  /// Places のレガシー形式の `description`（"名称, 住所…"）。画面はカンマ以降を
  /// 住所として出す。
  readonly description: string;
  readonly lat: number;
  readonly lng: number;
}

/// 受け取った要求の記録。上流との**契約**（どの URL にどのクエリで問い合わせたか）を
/// 画面側から反証するために使う。
export interface UpstreamLog {
  readonly places: URL[];
  readonly guidance: URL[];
  readonly walk: URL[];
  readonly matrix: URL[];

  /// どのハンドラにも当たらなかった上流要求。空でなければ配線か偽の上流の取りこぼし。
  readonly unmatched: URL[];
}

export interface FakeUpstreamOptions {
  /// placesProxy が返す候補。`input` を名前か description に含むものだけ返す。
  readonly places: readonly FakePlace[];
}

/// [page] に偽の上流を据える。戻り値は受け取った要求の記録（参照を保持し続ける）。
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

  // 取りこぼしの網を**先に**張る。Playwright は後から足したハンドラを先に当てるので、
  // これが最後の砦になる。500 を返して記録するのは、黙って本物のプレビューへ通すと
  // index.html が JSON として読まれ、「上流のスキーマが壊れた」ようにしか見えないため。
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

async function route(
  page: Page,
  endpoint: string,
  respond: (url: URL) => unknown,
): Promise<void> {
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

// ---- placesProxy ----

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
  const hits = places.filter(
    (p) => p.name.includes(input) || p.description.includes(input),
  );
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

// ---- Transit API /guidance/plan ----

/// 徒歩 → 電車1本 → 徒歩の option を1つだけ返す。
///
/// **到着アンカー（`type=arrival`・#376）には空の options を返す。** 出発の絶対時刻を
/// 知らないまま到着から逆算すると、発車済みの便を「乗れる」と名乗る option を
/// 作ってしまう——`arrivalMinutes` は壊れた時刻を必ず速い方向へ縮退させるので、
/// 偽の上流が嘘をつくと画面はそれを疑わずに速い経路として出す。第2波は fail-soft で、
/// 空なら departure 波だけで続行する（transit-route-service.ts の `arrivalWaveOptions`）。
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
  // 途中停留所を置く。コリドーの各停留所が乗車駅探索（徒歩最大化の主経路）の材料に
  // なるので、両端だけだと探索する先が無い。
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
            mapSegment('walk', 'origin', stationId(board), 'osmWalk', [
              from,
              board,
            ]),
            // stopOrder は「polyline の各点が停留所」を意味する（#137）。
            mapSegment(
              'transit',
              stationId(board),
              stationId(alight),
              'stopOrder',
              stops,
            ),
            mapSegment(
              'walk',
              stationId(alight),
              'destination',
              'estimatedWalk',
              [alight, to],
            ),
          ],
        },
      },
    ],
  };
}

// ---- Google Routes プロキシ ----

/// 直線距離をそのまま返す。実街路は直線より長いが、伸ばす係数はここでは掛けない
/// ——掛けると「選定時は予算内だった候補が実測で超過へ転じる」経路（#254）に入り、
/// 主導線の E2E が予算超過の画面を出すかどうかで揺れる。伸ばした上流は、その
/// 振る舞いを主題にする spec が自分で用意する。
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

// ---- 座標と時刻 ----

/// `geo:35.68,139.76` と `35.68,139.76` の両方を読む。前者は Transit API、後者は
/// プロキシのクエリ形式。
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

/// `HH:mm` をサービス日（0 時起点）の秒へ。日跨ぎで `25:10` のように 24 時を超える
/// 時刻が来る（transit-api-client.ts の `formatServiceTime`）ので時は 24 で割らない。
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

// ---- 駅 ----

function stationId(p: GeoPoint): string {
  return `stop:${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
}

/// 座標から決まる駅名。乗車駅探索が駅を動かしても同じ座標には同じ名前が付く
/// ——名前が要求ごとに揺れると、引き直しのたびに別の駅に見えて候補が増殖する。
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
