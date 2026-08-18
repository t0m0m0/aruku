/// Maps JavaScript API を実行時に読み込む（#359 Phase 2b）。
///
/// google_maps_flutter_web はキーを受け取る API も動的ローダーも持たず、
/// `window.google.maps` が既に在る前提で動く。公式手順は `web/index.html` への
/// script タグ直書きだが、このリポジトリは public なのでキーを追跡ファイルへ
/// 置かない。そのため dart-define で受けた値から script タグを自前で注入する。
///
/// **これでキーが秘匿されるわけではない。** `String.fromEnvironment` は
/// コンパイル時定数なので `main.dart.js` に焼き込まれ、ブラウザから読める。
/// 実運用の防御は HTTP リファラー制限と GCP のクォータ上限であり、直書きと同じ。
/// 得られるのは「public リポジトリの履歴に残らない」ことだけ。
library;

import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../config/app_config.dart';
import 'maps_js_loader_stub.dart'
    if (dart.library.js_interop) 'maps_js_loader_web.dart';

/// script タグを注入すべきか。
///
/// ネイティブを除くのは、Maps SDK が `AndroidManifest.xml` / `Info.plist` から
/// 自前でキーを読むため。フラグとキーの両方を要求するのは、どちらが欠けても
/// 地図は出ず、読み込みが無駄な外部リクエストになるだけだから。
bool shouldLoadMapsJs({
  required bool isWeb,
  required bool flagEnabled,
  required String apiKey,
}) => isWeb && flagEnabled && apiKey.trim().isNotEmpty;

/// 読み込む script の src。
///
/// `loading=async` を付けないのは、付けると `google.maps` の初期化が script の
/// onload より後になり、読み込み完了の合図として onload が使えなくなるため。
/// `libraries` を付けないのは、使うのが polyline と legacy marker だけで、
/// どちらもコアに含まれるため（advanced marker を使うなら `marker` が要る）。
String mapsJsUrl(String apiKey) =>
    'https://maps.googleapis.com/maps/api/js?key=${Uri.encodeComponent(apiKey)}';

/// 必要なら読み込み、`google.maps` が使えるようになったかを返す。
///
/// キーが無効でも onload は発火するため true が返る。無効の通知は Google が
/// 地図領域に出すエラーオーバーレイに委ねている——ここで真偽を判定しようとすると
/// 内部 API の文言に依存することになる。
Future<bool> loadMapsJsIfNeeded({
  required bool isWeb,
  required bool flagEnabled,
  required String apiKey,
}) async {
  if (!shouldLoadMapsJs(
    isWeb: isWeb,
    flagEnabled: flagEnabled,
    apiKey: apiKey,
  )) {
    return false;
  }
  return loadMapsJs(mapsJsUrl(apiKey));
}

/// Maps JavaScript API が使えるか。地図を出す画面が最初に watch した時点で
/// 読み込みが始まる（起動時に走らせると、地図を出さない利用でも外部リクエストが
/// 1本増える）。
final mapsJsLoadedProvider = FutureProvider<bool>(
  (ref) => loadMapsJsIfNeeded(
    isWeb: kIsWeb,
    flagEnabled: AppConfig.useRealMap,
    apiKey: AppConfig.mapsWebApiKey,
  ),
);
