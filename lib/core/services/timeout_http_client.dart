import 'dart:async';

import 'package:http/http.dart' as http;

/// http.Client を薄くラップし、全リクエストに一律のタイムアウトを付与する（issue #156）。
///
/// ルート探索は1回の検索で最大13本の HTTP をファンアウトするため、どれか1本が
/// 圏外・弱電波・サーバ無応答でハングすると、ローディング全体が無期限にフリーズし、
/// ユーザーは強制終了以外に復帰できなかった。このクライアントを噛ませて内側の
/// [send]（接続・ヘッダ受信）と、その後のボディ受信の双方に [timeout] を掛け、
/// 無応答を [TimeoutException] として打ち切る。
///
/// [send] の future はレスポンスヘッダ到着で完了するため、ヘッダだけ返して
/// ボディ送出中にストールする無応答は header タイムアウトでは拾えない。そこで
/// 返す stream にも chunk 間アイドルの [timeout] を掛け、受信中ストールも打ち切る。
///
/// タイムアウトは各サービスの最下層 fetch で `RouteException`/`PlacesException`
/// 相当のドメイン例外へ変換し、既存の UI エラーハンドリングと縮退（失敗レッグは
/// 直線推定・候補スキップ）にそのまま乗せる。
///
/// [AppCheckHttpClient] とは独立したレイヤーにするのは、App Check を通さない
/// Transit API 直叩き（ファンアウトの大半）にも一律で掛けるため。App Check を
/// 挟む経路では最外側に置き（例: `TimeoutHttpClient(AppCheckHttpClient(http.Client()))`）、
/// トークン取得（getToken）のハングも [timeout] の内側に収める。認証不要の直叩きは
/// `TimeoutHttpClient(http.Client())` と最内側で包む。
class TimeoutHttpClient extends http.BaseClient {
  TimeoutHttpClient(this._inner, {this.timeout = const Duration(seconds: 15)});

  final http.Client _inner;

  /// 1リクエストあたりの応答待ち上限。超過で [TimeoutException] を送出する。
  /// 接続・ヘッダ受信に加え、ボディ受信の chunk 間アイドルにも同じ上限を掛ける。
  final Duration timeout;

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    // 接続・ヘッダ受信（合成順が最外側なら getToken も含む）に header タイムアウト。
    final response = await _inner.send(request).timeout(timeout);
    // ヘッダ受信後のボディ送出ストールも打ち切る。get()/Response.fromStream は
    // ここで返した stream を最後まで読み切るため、chunk 間の無応答が上限を超えたら
    // TimeoutException を流す（#156）。
    return http.StreamedResponse(
      response.stream.timeout(timeout),
      response.statusCode,
      contentLength: response.contentLength,
      request: response.request,
      headers: response.headers,
      isRedirect: response.isRedirect,
      persistentConnection: response.persistentConnection,
      reasonPhrase: response.reasonPhrase,
    );
  }

  @override
  void close() => _inner.close();
}
