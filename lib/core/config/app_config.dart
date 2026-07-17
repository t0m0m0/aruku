class AppConfig {
  const AppConfig._();

  /// 実 GoogleMap を有効化するフラグ。Google Maps API キー設定後に
  /// `flutter run --dart-define=USE_REAL_MAP=true` で指定する（README 参照）。
  /// 既定 false：キー未設定でもスタイライズド地図が描画される。
  static const bool useRealMap = bool.fromEnvironment(
    'USE_REAL_MAP',
    defaultValue: false,
  );

  /// Firebase Functions プロキシのベース URL。
  /// 開発時: `flutter run --dart-define=PROXY_BASE_URL=http://127.0.0.1:5001/{projectId}/asia-northeast1`
  /// 本番時: `flutter run --dart-define=PROXY_BASE_URL=https://asia-northeast1-{projectId}.cloudfunctions.net`
  static const String proxyBaseUrl = String.fromEnvironment('PROXY_BASE_URL');

  /// 地点検索（Transit API）のベース URL。
  /// 認証不要・CORS対応のためクライアントから直接呼び出す。
  /// 上書きする場合: `--dart-define=TRANSIT_API_BASE_URL=https://...`
  static const String transitApiBaseUrl = String.fromEnvironment(
    'TRANSIT_API_BASE_URL',
    defaultValue: 'https://api.transit.ls8h.com',
  );

  /// デバッグビルド用 App Check トークン。
  /// `dart_defines.json` の APP_CHECK_DEBUG_TOKEN に設定し、
  /// 同じ値を Firebase Console → App Check → デバッグトークン に登録する。
  static const String appCheckDebugToken = String.fromEnvironment(
    'APP_CHECK_DEBUG_TOKEN',
  );

  /// Android デバッグビルド用の App Check トークン。
  static const String androidAppCheckDebugToken = String.fromEnvironment(
    'ANDROID_APP_CHECK_DEBUG_TOKEN',
    defaultValue: appCheckDebugToken,
  );

  /// Apple デバッグビルド用の App Check トークン。
  static const String appleAppCheckDebugToken = String.fromEnvironment(
    'APPLE_APP_CHECK_DEBUG_TOKEN',
    defaultValue: appCheckDebugToken,
  );
}
