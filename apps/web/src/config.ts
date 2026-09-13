/// 移植元: lib/core/config/app_config.dart のうち Web で意味のあるもの。
///
/// 歩数・HealthKit・ローカル通知まわりの設定は移していない。Web では恒久的に
/// 動かない機能として #386 で UI ごと作らないと決めたため。

/// 経路検索（Transit API）のベース URL の既定。移植元の `transitApiBaseUrl` と同じ。
const defaultTransitApiBaseUrl = 'https://api.transit.ls8h.com';

/// Firebase Web アプリの設定。秘匿値ではない（バンドルへ焼かれ、ブラウザから読める）。
/// 実際の保護はリファラー制限と App Check が担う——docs/security_hardening.md。
export interface FirebaseConfig {
  readonly apiKey: string;
  readonly appId: string;
  readonly projectId: string;
  readonly messagingSenderId: string;
  readonly authDomain: string;
  readonly storageBucket: string;
}

export interface AppConfig {
  /// Cloud Functions プロキシのベース URL。
  ///
  /// 未設定は縮退ではなく**起動時のエラー**になる（`createRouteService`）。移植元は
  /// `Uri.parse('/googleWalkProxy')` が相対 URI を作れたが、`new URL` は投げるため
  /// 検索の途中で TypeError になり、縮退では吸収されない。
  readonly proxyBaseUrl: string;

  readonly transitApiBaseUrl: string;

  readonly firebase: FirebaseConfig;

  /// reCAPTCHA v3 のサイトキー。空だと App Check を有効化できず、プロキシは
  /// 401 を返す（＝安全側）。移植元の RECAPTCHA_SITE_KEY と同じ値。
  readonly recaptchaSiteKey: string;

  /// 開発時に Firebase Console へ登録して使うデバッグトークン。本番バンドルでは
  /// 読まれない（app-check.ts の [useDebugAppCheck] を参照）。
  readonly appCheckDebugToken: string;
}

export const appConfig: AppConfig = {
  proxyBaseUrl: import.meta.env.VITE_PROXY_BASE_URL ?? '',
  transitApiBaseUrl:
    import.meta.env.VITE_TRANSIT_API_BASE_URL ?? defaultTransitApiBaseUrl,
  firebase: {
    apiKey: import.meta.env.VITE_FIREBASE_WEB_API_KEY ?? '',
    appId: import.meta.env.VITE_FIREBASE_WEB_APP_ID ?? '',
    // 移植元 lib/firebase_options.dart の web と同じく、秘匿でない4つは直に置く。
    // 環境変数にすると設定漏れで「プロジェクトが違う」という遠い失敗になる。
    projectId: 'aruku-app',
    messagingSenderId: '174669528481',
    authDomain: 'aruku-app.firebaseapp.com',
    storageBucket: 'aruku-app.firebasestorage.app',
  },
  recaptchaSiteKey: import.meta.env.VITE_RECAPTCHA_SITE_KEY ?? '',
  appCheckDebugToken: import.meta.env.VITE_APP_CHECK_DEBUG_TOKEN ?? '',
};
