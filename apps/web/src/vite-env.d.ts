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

  /// Firebase Web アプリの API キーとアプリ ID。移植元の FIREBASE_WEB_API_KEY /
  /// FIREBASE_WEB_APP_ID（dart_defines.json）と同じ値。
  readonly VITE_FIREBASE_WEB_API_KEY?: string;
  readonly VITE_FIREBASE_WEB_APP_ID?: string;

  /// reCAPTCHA v3 のサイトキー。App Check の本番プロバイダに要る。
  readonly VITE_RECAPTCHA_SITE_KEY?: string;

  /// Maps JavaScript API のブラウザキー。MAPS_WEB_API_KEY（dart_defines.json）と
  /// 同じ値。未設定だと作り物の地図へ倒れる。
  readonly VITE_MAPS_WEB_API_KEY?: string;

  /// App Check のデバッグトークン。開発でのみ読まれる（本番バンドルでは分岐ごと
  /// 消える。src/firebase/app-check.ts 参照）。
  readonly VITE_APP_CHECK_DEBUG_TOKEN?: string;
}
