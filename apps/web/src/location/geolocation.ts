// 移植元: lib/core/services/location_service.dart。
//
// geolocator を経由しないので、あちらが Web で抱えていた不具合は移植対象ではない。
// timeLimit がマイクロ秒として渡され 10 秒指定が約 2.8 時間になる問題（#359）も、
// checkPermission が 'prompt' を denied へ写す問題も、W3C の API を直接呼べば無い。
//
// 取得全体を包むタイムアウト（timeoutWholeRequest）も運んでいない。あれは上の
// 「素通りする timeLimit」を補うためのもので、W3C の timeout は権限ダイアログの
// 待ち時間を含まないと規定されている——包むと、ユーザーが考えている間に「取得
// できず」へ落ちる副作用だけが残る。

import { GeoPoint } from '@aruku/engine/models/geo-point';

import {
  locationAvailable,
  locationDenied,
  locationUnavailable,
  type LocationState,
} from './location-state';

export interface LocationService {
  request(): Promise<LocationState>;
}

/// 現在地の単発取得を打ち切るまでの上限（ミリ秒）。
export const locationRequestTimeoutMs = 10_000;

/// W3C GeolocationPositionError.PERMISSION_DENIED。定数はエラー側のインスタンスに
/// しか生えておらず、コールバックが呼ばれない経路では参照できない。
const permissionDenied = 1;

export function browserLocationService(
  geolocation: Geolocation | undefined = globalThis.navigator?.geolocation,
  timeoutMs: number = locationRequestTimeoutMs,
): LocationService {
  return {
    request() {
      // 非セキュアコンテキストなど、この環境に API 自体が無い。再取得しても
      // 解消しないので、再試行を促す unavailable ではなく denied に寄せる
      // （移植元が PermissionDefinitionsNotFoundException をそう扱うのと同じ）。
      if (geolocation === undefined) return Promise.resolve(locationDenied);

      return new Promise<LocationState>((resolve) => {
        try {
          geolocation.getCurrentPosition(
            (position) =>
              resolve(
                locationAvailable(
                  new GeoPoint(position.coords.latitude, position.coords.longitude),
                ),
              ),
            (error) =>
              // 拒否以外（測位失敗・打ち切り・未知のコード）は権限拒否に丸めず、
              // 再試行可能な unavailable として区別する。
              resolve(error.code === permissionDenied ? locationDenied : locationUnavailable),
            { timeout: timeoutMs },
          );
        } catch {
          resolve(locationUnavailable);
        }
      });
    },
  };
}
