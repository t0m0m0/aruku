// 移植元: lib/core/services/route_plan_builder.dart

import type { RoutePlan, RouteSegment } from '../models/route-plan';
import type { TimeValue } from '../models/time-value';
import { notImplemented } from '../not-implemented';

/// 徒歩 1km あたりの消費カロリー。徒歩区間のみに適用する。
export const kcalPerKm = 57;

/// 徒歩の平均速度（分速メートル）。候補選定フェーズで直線距離から所要時間を
/// 概算するのに使う（不動産表示の慣行 80m/分）。
///
/// 推定は直線距離ベースで実測（道なり）より短く出る＝楽観側だが、これは意図的。
/// 採用経路は確定後に Google 実測で再判定し、超過すれば予算内へフォールバックする。
/// 再判定は「予算内と見積もった候補」を上から外す方向のみで働くため、推定を割増して
/// 足切りを厳しくすると、実測では間に合う候補を選定段階で除外しても回収できない。
export const walkMetersPerMinute = 80.0;

/// 電車の平均速度（分速メートル）。コリドー座標から合成した区間は発着時刻を持たず
/// 時刻の差で乗車時間を出せないため、折れ線長からこの速度で概算する。
export const trainMetersPerMinute = 500.0;

/// isNow のときは dateOffset を無視して当日扱い。budget 計算と epoch で共有。
export function effectiveOffset(t: TimeValue): number {
  return notImplemented(`effectiveOffset(${t.h})`);
}

/// 当日0時基準の絶対分。isNow / dateOffset を踏まえ日跨ぎ計算の共通基準にする。
export function absoluteMinutes(t: TimeValue): number {
  return notImplemented(`absoluteMinutes(${t.h})`);
}

/// 出発〜到着の予算（分）。日跨ぎ（dateOffset / isNow）を考慮する。
export function budgetMinutes(departure: TimeValue, arrival: TimeValue): number {
  return notImplemented(`budgetMinutes(${departure.h}, ${arrival.h})`);
}

/// 出発時刻 + 経過分を "h:mm" へ整形（時は24で剰余）。
export function formatClock(dep: TimeValue, addMinutes: number): string {
  return notImplemented(`formatClock(${dep.h}, ${addMinutes})`);
}

/// 出発を基点に全区間を進めた到着までの総所要分（時刻表が揃う電車区間では
/// 乗車前・乗り換え待ちを含む #65）。[departureAt] 省略時は各区間の所要分を累積する。
export function arrivalMinutes(
  segments: RouteSegment[],
  departureAt: Date | null,
): number {
  return notImplemented(`arrivalMinutes(${segments.length})`);
}

/// 徒歩実測を反映した [segments] を出発絶対時刻 [departureAt] で進め、発車時刻を持つ
/// transit 区間（電車・バス）のうち「予定の便に乗り遅れる」最初の区間の index を返す
/// （無ければ null）。判定は発車時刻のみで行う。
export function firstMissedTransit(
  segments: RouteSegment[],
  departureAt: Date,
): number | null {
  return notImplemented(`firstMissedTransit(${segments.length})`);
}

/// 実発車時刻（[RouteSegment.depTime]）を確認できていない transit 区間を含むか。
export function hasUnverifiedTransit(segments: RouteSegment[]): boolean {
  return notImplemented(`hasUnverifiedTransit(${segments.length})`);
}

/// 出発から各時刻表付き transit 区間に乗車するまでの待ち時間の最大値（分, #121 原因②）。
export function maxBoardingWait(
  segments: RouteSegment[],
  departureAt: Date,
): number {
  return notImplemented(`maxBoardingWait(${segments.length})`);
}

export interface BuildRoutePlanArgs {
  from: string;
  to: string;
  segments: RouteSegment[];
  departure: TimeValue;
  budgetMin: number;

  /// 出発の絶対時刻（時刻表データとの差で待ち時間を算出する基点）。
  /// 省略時は時刻表を使わず累積所要分でタイムラインを組む。
  departureAt?: Date | null;
}

/// 区間列から RoutePlan を構築する（合計距離・徒歩距離・kcal・徒歩比率・
/// タイムライン）。データ源に依存しない純粋関数。
export function buildRoutePlan(args: BuildRoutePlanArgs): RoutePlan {
  return notImplemented(`buildRoutePlan(${args.from} -> ${args.to})`);
}
