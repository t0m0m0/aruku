// 移植元: lib/core/state/app_state.dart の getter 群。
//
// 予算（budgetMinutes）はここに無い。移植元の getter は planner への委譲でしかなく、
// その planner は既に packages/engine/src/services/route-plan-builder.ts にある。
// 呼ぶ側がエンジンの budgetMinutes を直接使えば、同じ計算が 2 箇所にならない。

import { ja } from '../i18n/ja';
import type { LocationState } from '../location/location-state';

/// 出発地の表示名。手動指定があればそれを、無ければ現在地の取得状況を出す。
///
/// denied（位置情報なし）と unavailable（取得失敗）を分けているのは、後者だけが
/// 再取得で解消し得るから——同じ「現在地が無い」でも促すべき操作が違う。
export function departureLabelText(
  origin: string | null,
  location: LocationState,
): string {
  if (origin !== null) return origin;
  switch (location.kind) {
    case 'loading':
      return ja.departureCurrentLocationLoading;
    case 'available':
      return ja.departureCurrentLocation;
    case 'denied':
      return ja.departureNoLocation;
    case 'unavailable':
      return ja.departureCurrentLocationFailed;
  }
}
