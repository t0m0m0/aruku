/// Dart の `kDebugMode` / `kReleaseMode`（`package:flutter/foundation.dart`）に対応する。
/// epic #382 が数えたエンジンの Flutter 依存のうちの前者で、#385 でビルド時定数へ置き換えた。
///
/// Dart は debug / profile / release の3値だが、バンドラが与えるのは「開発か本番か」の
/// 2値しかない。3つ目（profile＝本番ビルドだが計測を出す）は明示したモード名で表す。
/// これを潰して `PROD` だけで release を判定すると、[kReleaseMode] が profile でも真に
/// なり、**フィールド計測（#309）で集めたい定量指標が profile ビルドで一切出なくなる**
/// ——`RouteDiagnostics.metricsEnabled` の既定が `!kReleaseMode` だから。
///
/// vitest は `DEV=true` / `PROD=false` で走るので、移植したテストは Dart のテスト実行時
/// （debug ビルド）と同じ既定値を見る。

/// 本番ビルドでも定量指標を出したいときに渡すモード名（`vite build --mode profile`）。
const profileMode = 'profile';

/// 開発ビルドか。定性ログ（`RouteDiagnostics.log`）の既定の可否。
export const kDebugMode = import.meta.env.DEV;

/// リリースビルドか。**profile は含まない**（上記）。
export const kReleaseMode =
  import.meta.env.PROD && import.meta.env.MODE !== profileMode;
