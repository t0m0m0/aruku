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
}
