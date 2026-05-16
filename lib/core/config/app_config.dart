class AppConfig {
  const AppConfig._();

  /// 実 GoogleMap を有効化するフラグ。Google Maps API キー設定後に
  /// `flutter run --dart-define=USE_REAL_MAP=true` で指定する（README 参照）。
  /// 既定 false：キー未設定でもスタイライズド地図が描画される。
  static const bool useRealMap = bool.fromEnvironment(
    'USE_REAL_MAP',
    defaultValue: false,
  );

  /// Places Autocomplete / Geocoding 用 API キー。
  /// `flutter run --dart-define=PLACES_API_KEY=<key>` で指定する。
  static const String placesApiKey = String.fromEnvironment('PLACES_API_KEY');
}
