/// <reference types="vite/client" />

/// ビルド時に焼かれる設定。移植元は lib/core/config/app_config.dart の
/// `String.fromEnvironment`（`--dart-define`）で、Vite では `VITE_` 接頭辞の
/// 環境変数がこれに対応する。
///
/// **これらはバンドルに焼かれ、ブラウザから読める。** 秘匿値を置かないこと
/// （移植元の app_config.dart / maps_js_loader.dart と同じ前提。実際の保護は
/// リファラー制限と App Check が担う。docs/security_hardening.md）。
interface ImportMetaEnv {
  /// Cloud Functions プロキシのベース URL。
  readonly VITE_PROXY_BASE_URL?: string;

  /// 経路検索（Transit API）のベース URL。認証不要・CORS 対応でクライアントから直接叩く。
  readonly VITE_TRANSIT_API_BASE_URL?: string;
}
