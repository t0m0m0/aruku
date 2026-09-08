/// Dart の `kDebugMode` / `kReleaseMode`（`package:flutter/foundation.dart`）に対応する。
/// epic #382 が「エンジンの Flutter 依存は kDebugMode / debugPrint の計7箇所だけ」と
/// 数えたうちの前者。
///
/// 値を固定しているのは Phase 1（#384）の間だけ。移植したテストは Dart のテスト実行時
/// （debug ビルド）と同じ既定値を見る必要がある。ビルド時定数（Vite の
/// `import.meta.env`）への差し替えは Phase 2（#385）で行う。
export const kDebugMode = true;
export const kReleaseMode = false;
