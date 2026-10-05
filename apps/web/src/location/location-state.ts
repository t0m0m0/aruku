// 移植元: flutter-final:lib/core/models/location_state.dart。
//
// sealed class → discriminated union。payload を持つのは available だけだが、判別子を
// 全ケースに置く（`'position' in state` のような構造での判別にしない）。switch の
// 網羅性チェックが効く形を保つためで、これは移植元の sealed class が持っていた
// 保証と同じもの。

import type { GeoPoint } from '@aruku/engine/models/geo-point';

export type LocationState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'available'; readonly position: GeoPoint }
  | { readonly kind: 'denied' }
  /// 権限は許可済みだが、GPS の一時的な失敗（屋内・電波不良・タイムアウト等）で
  /// 現在地を取得できなかった状態。権限の見直しではなく再試行が適切。ただし経路検索の
  /// 失敗としては denied と同じ noLocation に寄り、説明文は両者で共通。
  | { readonly kind: 'unavailable' };

export const locationLoading: LocationState = { kind: 'loading' };
export const locationDenied: LocationState = { kind: 'denied' };
export const locationUnavailable: LocationState = { kind: 'unavailable' };

export function locationAvailable(position: GeoPoint): LocationState {
  return { kind: 'available', position };
}
