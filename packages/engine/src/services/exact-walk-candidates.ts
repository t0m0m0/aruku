// 厳密走査 `exactWalkMax`（functions/src/exact-walk-max.ts・#459）の応答を候補にする（#460）。

import { dartRound } from '../dart-number';
import type { JsonMap } from '../json';
import { GeoPoint } from '../models/geo-point';
import { RouteSegment, SegmentType, type TimetableSource } from '../models/route-plan';
import { dateTime } from '../time';
import { haversineKm, RouteCandidate } from './hybrid-route-selector';
import { railLineLabel } from './rail-line-names';
import { kcalPerKm } from './route-plan-builder';

export interface ExactWalkEnds {
  origin: GeoPoint;
  goal: GeoPoint;
  from: string;
  to: string;
}

/// 応答の候補を `徒歩 → 電車 → 徒歩` の [RouteCandidate] にする。電車区間は実発着時刻を
/// 持つので、enrich で実時刻を引き直さずに乗り遅れ・予算超過を判定できる（§3.9）。
///
/// 形の崩れた候補は1件ずつ捨てる。厳密走査は改善であって、壊れた1件で他の候補まで
/// 失う理由が無い。
export function exactWalkCandidates(body: JsonMap, ends: ExactWalkEnds): RouteCandidate[] {
  const raw = body['candidates'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    const candidate = toCandidate(c, ends);
    return candidate === null ? [] : [candidate];
  });
}

/// `transferCandidates` を `徒歩 → 電車 → 徒歩 → 電車 → 徒歩` の [RouteCandidate] にする
/// （#474）。同じ駅の乗換は2本の電車を直結する。
///
/// 応答に無ければ空。Functions と Web は別々にデプロイされるので、古い応答もある。
export function exactWalkTransferCandidates(
  body: JsonMap,
  ends: ExactWalkEnds,
): RouteCandidate[] {
  const raw = body['transferCandidates'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((c) => {
    const candidate = toTransferCandidate(c, ends);
    return candidate === null ? [] : [candidate];
  });
}

/// 応答の `feeds` を、選定に使った時刻表の取得日時にする（#461）。形の崩れたフィードは
/// 1件ずつ捨てる（候補と同じ）。
export function timetableSources(body: JsonMap): TimetableSource[] {
  const raw = body['feeds'];
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((f) => {
    if (!isMap(f) || typeof f['id'] !== 'string') return [];
    const fetchedAt = instant(f['fetchedAt']);
    return fetchedAt === null ? [] : [{ feedId: f['id'], fetchedAt }];
  });
}

function toCandidate(raw: unknown, ends: ExactWalkEnds): RouteCandidate | null {
  if (!isMap(raw)) return null;
  const ride = toRide(raw);
  const access = walk(raw['accessWalk']);
  const egress = walk(raw['egressWalk']);
  if (ride === null || access === null || egress === null) return null;
  return withEndWalks(ends, access, ride, [ride.segment], ride, egress);
}

function toTransferCandidate(raw: unknown, ends: ExactWalkEnds): RouteCandidate | null {
  if (!isMap(raw)) return null;
  const legs = raw['legs'];
  const sameStation = raw['sameStation'];
  if (!Array.isArray(legs) || legs.length !== 2 || typeof sameStation !== 'boolean') return null;
  const first = toRide(legs[0]);
  const second = toRide(legs[1]);
  const access = walk(raw['accessWalk']);
  const transfer = walk(raw['transferWalk']);
  const egress = walk(raw['egressWalk']);
  if (
    first === null ||
    second === null ||
    access === null ||
    transfer === null ||
    egress === null
  ) {
    return null;
  }
  // 別の駅への徒歩は0分でも落とさない。enrich が測るのは segments に在る徒歩だけなので、
  // 落とすと実測されず、firstMissedTransit が2本を直結とみなして乗れない接続を通す。
  const between = sameStation
    ? []
    : [
        walkSegment(
          first.alight.coord,
          second.board.coord,
          first.alight.name,
          second.board.name,
          transfer,
        ),
      ];
  return withEndWalks(
    ends,
    access,
    first,
    [first.segment, ...between, second.segment],
    second,
    egress,
  );
}

interface Ride {
  board: Station;
  alight: Station;
  segment: RouteSegment;
}

function toRide(raw: unknown): Ride | null {
  if (!isMap(raw)) return null;
  const board = station(raw['board']);
  const alight = station(raw['alight']);
  const boardAt = jstWallClock(raw['boardAt']);
  const alightAt = jstWallClock(raw['alightAt']);
  const stops = Array.isArray(raw['stops']) ? raw['stops'].map(point) : [];
  if (
    board === null ||
    alight === null ||
    boardAt === null ||
    alightAt === null ||
    alightAt.getTime() < boardAt.getTime() ||
    stops.length < 2 ||
    stops.some((p) => p === null)
  ) {
    return null;
  }
  const polyline = stops as GeoPoint[];
  let rideKm = 0;
  for (let i = 1; i < polyline.length; i++) {
    rideKm += haversineKm(polyline[i - 1], polyline[i]);
  }
  const route = typeof raw['route'] === 'string' ? raw['route'] : '';
  return {
    board,
    alight,
    segment: new RouteSegment({
      type: SegmentType.train,
      fromName: board.name,
      toName: alight.name,
      minutes: Math.trunc((alightAt.getTime() - boardAt.getTime()) / 60000),
      km: rideKm,
      line: railLineLabel(route.length === 0 ? null : route),
      stops: polyline.length - 1,
      polyline,
      depTime: boardAt,
      arrTime: alightAt,
    }),
  };
}

function withEndWalks(
  ends: ExactWalkEnds,
  access: Walk,
  first: Ride,
  middle: RouteSegment[],
  last: Ride,
  egress: Walk,
): RouteCandidate {
  const accessWalk = walkSegment(
    ends.origin,
    first.board.coord,
    ends.from,
    first.board.name,
    access,
  );
  const egressWalk = walkSegment(last.alight.coord, ends.goal, last.alight.name, ends.to, egress);
  return new RouteCandidate({
    from: ends.from,
    to: ends.to,
    // 0分の徒歩を落とすのはコリドー由来のハイブリッドと同じ（buildMeasuredHybrids）。
    segments: [
      ...(accessWalk.minutes > 0 ? [accessWalk] : []),
      ...middle,
      ...(egressWalk.minutes > 0 ? [egressWalk] : []),
    ],
  });
}

interface Walk {
  minutes: number;
  km: number;
}

/// 端点を直線で結ぶ。街路のジオメトリは採用前の enrich で Google 実測に置き換わる。
function walkSegment(
  a: GeoPoint,
  b: GeoPoint,
  fromName: string,
  toName: string,
  w: Walk,
): RouteSegment {
  return new RouteSegment({
    type: SegmentType.walk,
    fromName,
    toName,
    minutes: w.minutes,
    km: w.km,
    kcal: dartRound(w.km * kcalPerKm),
    polyline: [a, b],
  });
}

interface Station {
  name: string;
  coord: GeoPoint;
}

function station(raw: unknown): Station | null {
  if (!isMap(raw) || typeof raw['name'] !== 'string') return null;
  const coord = point(raw);
  return coord === null ? null : { name: raw['name'], coord };
}

function point(raw: unknown): GeoPoint | null {
  if (!isMap(raw)) return null;
  const { lat, lng } = raw;
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  return new GeoPoint(lat, lng);
}

const jstOffsetMs = 9 * 3600 * 1000;

/// 時差つきの時刻を、実際の時刻の `Date` にする。時差の無い文字列は `Date.parse` が
/// 端末の時刻として読むので受けない。
function instant(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/// 時差つきの時刻を、JST の壁時計を表す naive な `Date` にする（§4 #121。guidance の
/// `transitSecsToJst` と同じ表現）。実際の時刻のまま持つと、naive な出発アンカーとの差が
/// 端末の時差ぶんずれる。
function jstWallClock(raw: unknown): Date | null {
  const at = instant(raw);
  if (at === null) return null;
  const jst = new Date(at.getTime() + jstOffsetMs);
  return dateTime(
    jst.getUTCFullYear(),
    jst.getUTCMonth() + 1,
    jst.getUTCDate(),
    jst.getUTCHours(),
    jst.getUTCMinutes(),
    jst.getUTCSeconds(),
  );
}

// 分への丸めは guidance の徒歩（`(secs / 60).round()`）と揃える。
function walk(raw: unknown): Walk | null {
  if (!isMap(raw)) return null;
  const { durationSec, distanceMeters } = raw;
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec)) return null;
  if (typeof distanceMeters !== 'number' || !Number.isFinite(distanceMeters)) return null;
  return { minutes: dartRound(durationSec / 60), km: distanceMeters / 1000 };
}

function isMap(raw: unknown): raw is JsonMap {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}
