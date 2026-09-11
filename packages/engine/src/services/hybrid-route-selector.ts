// 移植元: lib/core/services/hybrid_route_selector.dart

import type { GeoPoint } from '../models/geo-point';
import type { RouteSegment } from '../models/route-plan';
import { notImplemented } from '../not-implemented';

export interface RouteCandidateInit {
  from: string;
  to: string;
  segments: RouteSegment[];
}

/// 経路候補（全徒歩・ハイブリッド・標準乗換のいずれか）。データ源に依存しない。
export class RouteCandidate {
  constructor(init: RouteCandidateInit) {
    this.from = init.from;
    this.to = init.to;
    this.segments = init.segments;
  }

  readonly from: string;
  readonly to: string;
  readonly segments: RouteSegment[];

  get totalMin(): number {
    return notImplemented('RouteCandidate.totalMin');
  }

  get walkMinutes(): number {
    return notImplemented('RouteCandidate.walkMinutes');
  }

  get transferCount(): number {
    return notImplemented('RouteCandidate.transferCount');
  }

  get totalKm(): number {
    return notImplemented('RouteCandidate.totalKm');
  }

  get walkKm(): number {
    return notImplemented('RouteCandidate.walkKm');
  }
}

export interface SelectBestRouteArgs {
  candidates: RouteCandidate[];
  budgetMin: number;
  origin?: GeoPoint | null;
  goal?: GeoPoint | null;
  departureAt?: Date | null;
  maxBacktrackRatio?: number;
}

/// 予算内で「徒歩時間最大」の候補を選ぶ。予算内が無ければ最短（ベストエフォート）。
///
/// [origin]/[goal] を渡すと、電車区間が出発地より進行方向の後方へ
/// [maxBacktrackRatio] × 直線距離(origin→goal) を超えて戻る「逆戻り迂回」候補を
/// 選定前に除外する。全候補が逆戻りなら除外せず最短へ縮退する。
///
/// [departureAt] を渡すと、予算内判定・タイブレーク・縮退のすべてで totalMin ではなく
/// 時刻表の待ちを含む実到着（[arrivalMinutes]）を用いる。
export function selectBestRoute(args: SelectBestRouteArgs): RouteCandidate {
  return notImplemented(`selectBestRoute(${args.candidates.length})`);
}

/// best-effort 選定で「今夜乗れる」候補に絞る。該当が無ければ null を返し、
/// 呼び出し側は元の全候補へ縮退する。
export function reachableWithinBudget(
  candidates: RouteCandidate[],
  budgetMin: number,
  departureAt: Date,
): RouteCandidate[] | null {
  return notImplemented(`reachableWithinBudget(${candidates.length})`);
}

/// 出発地より進行方向の後方へ [maxBacktrackRatio] × 直線距離(origin→goal) を超えて戻る
/// 「逆戻り迂回」候補を除いた前方プールを返す。全候補が逆戻りならそのまま返す。
export function forwardCandidates(
  candidates: RouteCandidate[],
  origin: GeoPoint | null,
  goal: GeoPoint | null,
  options: { maxBacktrackRatio?: number } = {},
): RouteCandidate[] {
  return notImplemented(
    `forwardCandidates(${candidates.length}, ${String(options.maxBacktrackRatio)})`,
  );
}

export interface MeasureShortlistArgs {
  candidates: RouteCandidate[];
  budgetMin: number;
  departureAt: Date;
  origin?: GeoPoint | null;
  goal?: GeoPoint | null;
}

/// 見積り予算内候補を実測する短リスト（#315/#318）。逆戻り除外の上で見積り実到着が
/// 予算内の候補だけを、徒歩降順→実到着昇順→乗換少ない順で返す（cap は掛けない）。
export function measureShortlist(
  args: MeasureShortlistArgs,
): RouteCandidate[] {
  return notImplemented(`measureShortlist(${args.candidates.length})`);
}

export interface PrewarmFrontArgs {
  shortlist: RouteCandidate[];
  chosen: RouteCandidate;
  hybrids: Set<RouteCandidate>;
  singlePassHybridThreshold: number;
  maxMeasureShortlist: number;
  allowSinglePass?: boolean;
}

export interface PrewarmFront {
  prewarm: RouteCandidate[];
  singlePass: boolean;
}

/// 非崩壊ルートで先行実測（キャッシュ温め・#315）する候補集合と single-pass 発火有無を返す。
export function prewarmFront(args: PrewarmFrontArgs): PrewarmFront {
  return notImplemented(`prewarmFront(${args.shortlist.length})`);
}

export interface MaxWalkBoardingIndexArgs {
  count: number;
  budgetMin: number;
  evaluate: (index: number) => Promise<number>;
}

/// 乗車駅探索（docs/spec/route-optimization.md §3.6）：乗車駅候補について
/// 「到着が予算内の最遠 index ＝ 総徒歩最大」を二分探索で返す。
/// 先頭すら予算外・[count] が 0 なら null（[count] 0 では [evaluate] を一度も呼ばない）。
export function maxWalkBoardingIndex(
  args: MaxWalkBoardingIndexArgs,
): Promise<number | null> {
  return notImplemented(`maxWalkBoardingIndex(${args.count})`);
}

export interface MaxWalkBoardingIndexParallelArgs {
  count: number;
  budgetMin: number;

  /// null は「未評価」——到着が予算内かを判定できなかった（上流の 429・タイムアウト等）
  /// ことを表し、境界の更新に一切使わない（#333）。
  evaluate: (index: number) => Promise<number | null>;
  fanout?: number;
  shouldContinue?: () => boolean;
  onRound?: () => void;
}

/// [maxWalkBoardingIndex] のk分割並列版（#163）。ラウンド数は
/// O(log_{fanout+1} count)、壁時計は「ラウンド数 × 最遅1評価」になる。
///
/// 残り全 index が [fanout] 本以内に収まるラウンドは内点分割をやめ1ラウンドで評価する
/// （#332）。1ラウンドの同時発行は [fanout] 本を超えない。
/// ラウンドの probe が全て未評価なら探索を打ち切る。
export function maxWalkBoardingIndexParallel(
  args: MaxWalkBoardingIndexParallelArgs,
): Promise<number | null> {
  return notImplemented(`maxWalkBoardingIndexParallel(${args.count})`);
}

/// 乗車駅探索の区間を「前半徒歩 t1 が予算内の最遠 index」までへ刈った探索点数を返す
/// （#317）。返り値 `n` は探索を index `[0, n)` に限ってよいことを表す。
///
/// **単調性に依存しない安全上界**：到着 = t1 + t2（t2 ≥ 0）なので `t1 > budgetMin` の
/// 点は到着も必ず予算外。刈るのは「t1 単独で既に予算外」の確実に無駄な引き直しだけ。
export function walkFeasiblePrefixCount(
  walk1Min: number[],
  budgetMin: number,
): number {
  return notImplemented(`walkFeasiblePrefixCount(${walk1Min.length})`);
}

/// [items] から先頭・末尾を含む最大 [maxCount] 点を均等に抜き出す。
export function evenSample<T>(items: T[], maxCount: number): T[] {
  return notImplemented(`evenSample(${items.length}, ${maxCount})`);
}

/// 2点間の大圏距離（km）。徒歩区間の距離概算に用いる。
export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(h)));
}

const earthRadiusKm = 6371.0088;

const toRad = (deg: number): number => (deg * Math.PI) / 180;
