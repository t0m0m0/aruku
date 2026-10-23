// 厳密走査 `exactWalkMax`（functions/src/exact-walk-max.ts・#459）の応答を候補にする（#460）。

import { dartRound } from '../dart-number';
import type { JsonMap } from '../json';
import { GeoPoint } from '../models/geo-point';
import { RouteSegment, SegmentType } from '../models/route-plan';
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
/// 持つので、enrich で実時刻を引き直さずに乗り遅れ・予算超過を判定できる。
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

function toCandidate(raw: unknown, ends: ExactWalkEnds): RouteCandidate | null {
  if (!isMap(raw)) return null;
  const board = station(raw['board']);
  const alight = station(raw['alight']);
  const boardAt = instant(raw['boardAt']);
  const alightAt = instant(raw['alightAt']);
  const access = walk(raw['accessWalk']);
  const egress = walk(raw['egressWalk']);
  const stops = Array.isArray(raw['stops']) ? raw['stops'].map(point) : [];
  if (
    board === null ||
    alight === null ||
    boardAt === null ||
    alightAt === null ||
    alightAt.getTime() < boardAt.getTime() ||
    access === null ||
    egress === null ||
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
  const segments = [
    walkSegment(ends.origin, board.coord, ends.from, board.name, access),
    new RouteSegment({
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
    walkSegment(alight.coord, ends.goal, alight.name, ends.to, egress),
  ];
  return new RouteCandidate({
    from: ends.from,
    to: ends.to,
    // 0分の徒歩を落とすのはコリドー由来のハイブリッドと同じ（buildMeasuredHybrids）。
    segments: segments.filter((s) => s.type !== SegmentType.walk || s.minutes > 0),
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

function station(raw: unknown): { name: string; coord: GeoPoint } | null {
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

function instant(raw: unknown): Date | null {
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
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
