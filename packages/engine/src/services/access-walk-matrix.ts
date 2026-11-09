import { dartRound } from '../dart-number';
import type { GeoPoint } from '../models/geo-point';

/// 徒歩マトリクス1要求あたりの要素数（origins × destinations）の上限。サーバ側
/// `MATRIX_MAX_ELEMENTS`（functions/src/index.ts）を超えると 400 で全滅する。
export const maxWalkMatrixElements = 25;

/// 有向の徒歩レッグ [origin]→[dest] の実測値を引くキー。逆方向は別のキーになる。
export function walkCacheKey(origin: GeoPoint, dest: GeoPoint): string {
  return (
    `${origin.lat.toFixed(5)},${origin.lng.toFixed(5)}` +
    `|${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}`
  );
}

/// 1本の base が要るアクセス徒歩: origin→各乗車駅と、各降車駅→goal。
export interface AccessWalkDemand {
  readonly boardStops: readonly GeoPoint[];
  readonly alightStops: readonly GeoPoint[];
}

/// 徒歩マトリクス1要求。応答の originIndex/destinationIndex はこの配列の添字を指す。
export interface WalkMatrixRequest {
  readonly origins: readonly GeoPoint[];
  readonly dests: readonly GeoPoint[];
}

export interface AccessWalkMatrixPlan {
  readonly requests: readonly WalkMatrixRequest[];
  /// base ごとに投げた場合に測ることになるレッグ数（乗車＋origin→goal＋降車の和）。
  readonly requestedLegs: number;
  /// 集約後のユニークな有向レッグ数（実測済みで省いたものも含む）。
  readonly uniqueLegs: number;
}

/// 全 base のアクセス徒歩を1検索ぶんに集約し、要素数上限以下の要求へ分ける。
///
/// 乗車側は origin 1点×目的地 N、降車側は出発地 N×goal 1点の形に保つ。両者を1枚の
/// N×M にまとめないのは、乗車駅→goal・origin→降車駅という要らない要素まで課金されるため。
/// origin→goal（全徒歩）は乗車側の目的地に相乗りさせ、base が無くても必ず測る。
export function planAccessWalkMatrix(
  origin: GeoPoint,
  goal: GeoPoint,
  demands: readonly AccessWalkDemand[],
  isMeasured: (key: string) => boolean,
  maxElements: number = maxWalkMatrixElements,
): AccessWalkMatrixPlan {
  const boardDests = new Map<string, GeoPoint>();
  const alightOrigins = new Map<string, GeoPoint>();
  let requestedLegs = 0;
  for (const d of demands) {
    for (const s of d.boardStops) {
      const key = walkCacheKey(origin, s);
      if (!boardDests.has(key)) boardDests.set(key, s);
    }
    for (const s of d.alightStops) {
      const key = walkCacheKey(s, goal);
      if (!alightOrigins.has(key)) alightOrigins.set(key, s);
    }
    requestedLegs += d.boardStops.length + 1 + d.alightStops.length;
  }
  const allWalkKey = walkCacheKey(origin, goal);
  if (!boardDests.has(allWalkKey)) boardDests.set(allWalkKey, goal);
  if (demands.length === 0) requestedLegs = 1;

  const pending = (legs: Map<string, GeoPoint>): GeoPoint[] =>
    [...legs].filter(([key]) => !isMeasured(key)).map(([, p]) => p);
  const chunk = (ps: GeoPoint[]): GeoPoint[][] => {
    const out: GeoPoint[][] = [];
    for (let i = 0; i < ps.length; i += maxElements) {
      out.push(ps.slice(i, i + maxElements));
    }
    return out;
  };
  return {
    requests: [
      ...chunk(pending(boardDests)).map((dests) => ({ origins: [origin], dests })),
      ...chunk(pending(alightOrigins)).map((origins) => ({ origins, dests: [goal] })),
    ],
    requestedLegs,
    uniqueLegs: boardDests.size + alightOrigins.size,
  };
}

/// [request] への応答 [rows] を有向レッグ→徒歩分として [measured] へ書く。失敗（null）・
/// 添字が範囲外・所要時間が読めない要素は書かない（呼び出し側は直線推定へフォールバックする）。
export function applyWalkMatrixRows(
  request: WalkMatrixRequest,
  rows: readonly unknown[] | null,
  measured: Map<string, number>,
): void {
  if (rows === null) return;
  for (const e of rows) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) continue;
    const row = e as Record<string, unknown>;
    // proto3 の JSON は既定値 0 のフィールドを省くので、欠落は 0 番として読む。
    const oi = indexOrZero(row['originIndex']);
    const di = indexOrZero(row['destinationIndex']);
    const min = parseDurationMin(row['duration']);
    if (min === null) continue;
    if (oi < 0 || oi >= request.origins.length) continue;
    if (di < 0 || di >= request.dests.length) continue;
    measured.set(walkCacheKey(request.origins[oi], request.dests[di]), min);
  }
}

/// Routes API の `"123s"` 形式の所要時間を分へ丸める。読めなければ null。
export function parseDurationMin(duration: unknown): number | null {
  if (typeof duration !== 'string') return null;
  const digits = duration.replaceAll('s', '');
  if (!/^[+-]?\d+$/.test(digits)) return null;
  return dartRound(Number.parseInt(digits, 10) / 60);
}

function indexOrZero(value: unknown): number {
  return typeof value === 'number' ? Math.trunc(value) : 0;
}
