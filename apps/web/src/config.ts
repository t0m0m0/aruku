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
}

// App Check のデバッグトークンはここに**置かない**。
//
// `appConfig` は生きた export なので、`import.meta.env.VITE_APP_CHECK_DEBUG_TOKEN` を
// プロパティに入れると、それを読む分岐が本番で消えても**値だけが残る**——Vite が
// ビルド時に文字列リテラルへ差し替え、esbuild は生きたオブジェクトのプロパティを
// 落とさない。実際に、実トークンを渡した本番ビルドのバンドルから平文で見つかった
// （PR #395 の Codex レビュー P1）。デバッグトークンは Firebase 自身が secret と
// 呼ぶもので、持てば App Check を迂回して課金 API を叩ける。
//
// 読むのは src/firebase/app-check.ts の `if (import.meta.env.DEV)` の**中だけ**。
// そうすれば値ごと分岐に閉じ、本番バンドルから消える。

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
};

/// 移植元: lib/core/constants/app_constants.dart の termsOfServiceUrl /
/// privacyPolicyUrl。
///
/// 値は移植元と同じプレースホルダのまま。実 URL への差し替えは #386 の範囲外で、
/// 先に本物らしい URL を置くと「配線済み」と読めてしまう。
///
/// 環境変数にしない。`appConfig` に置いているのはデプロイごとに変わる設定で、
/// これは両者とも同じ値を指す固定のリンク先——env にすると設定漏れが「規約が
/// 開かない」という遠い失敗になる。
export const termsOfServiceUrl = 'https://example.com/aruku/terms';
export const privacyPolicyUrl = 'https://example.com/aruku/privacy';
