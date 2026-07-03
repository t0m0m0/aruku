import 'dart:async';

import 'package:http/http.dart' as http;

/// http.Client を薄くラップし、全リクエストに一律のタイムアウトを付与する（issue #156）。
///
/// ルート探索は1回の検索で最大13本の HTTP をファンアウトするため、どれか1本が
/// 圏外・弱電波・サーバ無応答でハングすると、ローディング全体が無期限にフリーズし、
/// ユーザーは強制終了以外に復帰できなかった。このクライアントを最内側に噛ませて
/// [send] に一律 [timeout] を掛け、無応答を [TimeoutException] として打ち切る。
///
/// タイムアウトは各サービスの最下層 fetch で `RouteException`/`PlacesException`
/// 相当のドメイン例外へ変換し、既存の UI エラーハンドリングと縮退（失敗レッグは
/// 直線推定・候補スキップ）にそのまま乗せる。
///
/// [AppCheckHttpClient] とは独立したレイヤーにするのは、App Check を通さない
/// Transit API 直叩き（ファンアウトの大半）にも一律で掛けるため。合成順は最内側
/// （例: `AppCheckHttpClient(TimeoutHttpClient(http.Client()))`）。
class TimeoutHttpClient extends http.BaseClient {
  TimeoutHttpClient(this._inner, {this.timeout = const Duration(seconds: 15)});

  final http.Client _inner;

  /// 1リクエストあたりの応答待ち上限。超過で [TimeoutException] を送出する。
  final Duration timeout;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) =>
      _inner.send(request).timeout(timeout);

  @override
  void close() => _inner.close();
}
