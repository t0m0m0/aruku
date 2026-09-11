// 移植元: lib/core/state/app_state.dart のうち、経路検索の中核。
//
// 歩数・週間実績・HealthKit・行程 handoff は運んでいない。Web で恒久的に動かない
// 機能として #386 が UI ごと作らないと決めたもの（歩数）と、その歩数同期に依存する
// もの（handoff）だから。

import type { GeoPoint } from '@aruku/engine/models/geo-point';
import type { RoutePlan } from '@aruku/engine/models/route-plan';
import type { TimeValue } from '@aruku/engine/models/time-value';
import type { RoutePhase } from '@aruku/engine/services/route-service';
import { minutes, type Duration } from '@aruku/engine/time';

/// ルート計算失敗の種別。UI の文言と復帰導線の出し分けに使う。
///
/// 例外からこの種別への分類（移植元の `classifyRouteError`）はまだ運んでいない。
/// 文言・復帰導線と対で意味を持つので、エラー画面のスライスで一緒に運ぶ。
export const RouteErrorKind = {
  network: 'network',
  timeout: 'timeout',
  noResults: 'noResults',
  noLocation: 'noLocation',
  noDestination: 'noDestination',
  unknown: 'unknown',
} as const;
export type RouteErrorKind =
  (typeof RouteErrorKind)[keyof typeof RouteErrorKind];

/// isNow（今すぐ出発）経路が失効するまでの猶予。確定時刻からこれを超えて実時間が
/// 進むと、結果の到着時刻と実際の ETA が乖離する（乗るはずだった便に乗り遅れる）。
/// この場合は経路を無効化して現在時刻での再検索を促す（#264）。
export const routeFreshness: Duration = minutes(5);

/// 起動時の初期到着時刻を「出発 + この分数」で算出する。ユーザーはホーム画面で
/// いつでも調整できるため、設定では持たず固定のシード値とする。
export const kInitialBudgetMinutes = 60;

/// 画面の表示前提になるデータ一式。
export interface RouteCore {
  destination: string | null;
  destinationLatLng: GeoPoint | null;
  origin: string | null;
  originLatLng: GeoPoint | null;
  departure: TimeValue;
  arrival: TimeValue;
  route: RoutePlan | null;

  /// isNow 経路が前提とする「現在時刻」。確定時に設定し、この時刻から
  /// [routeFreshness] を超えて実時間が進むと失効する（#264）。固定出発
  /// （isNow=false）や経路が無い間は null。[route] と寿命を揃える。
  routeAsOf: Date | null;

  routeErrorKind: RouteErrorKind | null;
  routePhase: RoutePhase | null;
}

/// isNow 経路が失効しているか。結果の到着時刻と実 ETA が乖離する境界を [now] で判定する。
///
/// 判定は [RouteCore.routeAsOf]（＝経路そのもののメタデータ）だけに依存し、現在の入力
/// フォーム（departure）は見ない。routeAsOf は「now 基準で確定した経路」にのみ設定する
/// 不変条件を保つ（固定出発の検索・リルートでは null）。フォームを見ると、now 経路を
/// 残したまま出発を固定へ変えた後などに、保持中の now 経路が失効判定から外れてしまう。
export function isNowRouteExpired(state: RouteCore, now: Date): boolean {
  return (
    state.route !== null &&
    state.routeAsOf !== null &&
    now.getTime() - state.routeAsOf.getTime() >= routeFreshness
  );
}
