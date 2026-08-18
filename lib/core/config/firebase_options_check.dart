import 'package:firebase_core/firebase_core.dart' show FirebaseOptions;

/// dart-define の注入漏れで空になっている必須フィールド名を返す。
///
/// `String.fromEnvironment` は未注入でも例外を出さず空文字を返すため、そのまま
/// Firebase へ渡すと初期化が分かりにくいエラーで失敗する。呼び出し側（main.dart）が
/// debug ビルドで早期に落とすための判定をここに置く。
///
/// appId をコードに焼いていないのは Web だけ（`firebase_options.dart` 参照）。
/// ネイティブでは常に非空のため、appId の欠落が報告されるのは Web に限られる。
List<String> missingFirebaseOptionFields(FirebaseOptions options) => [
  if (options.apiKey.isEmpty) 'apiKey',
  if (options.appId.isEmpty) 'appId',
];
