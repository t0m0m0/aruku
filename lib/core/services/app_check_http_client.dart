import 'package:firebase_app_check/firebase_app_check.dart';
import 'package:http/http.dart' as http;

/// App Check トークンを取得する関数。既定では FirebaseAppCheck を用いるが、
/// テストでは Firebase に触れない fake を注入してヘッダ付与を検証できる。
typedef AppCheckTokenProvider = Future<String?> Function();

/// http.Client をラップし、各リクエストに Firebase App Check トークンを
/// X-Firebase-AppCheck ヘッダとして付与する。Cloud Functions プロキシ側は
/// このトークンを検証し、未認証アクセス（API 課金の濫用）を遮断する。
///
/// トークン取得は送信時（send）に限定する。プロバイダ構築時には Firebase へ
/// 触れないため、Firebase 未初期化のテストでもプロバイダの生成は安全。
class AppCheckHttpClient extends http.BaseClient {
  AppCheckHttpClient(this._inner, {AppCheckTokenProvider? tokenProvider})
    : _tokenProvider = tokenProvider ?? _defaultTokenProvider;

  final http.Client _inner;
  final AppCheckTokenProvider _tokenProvider;

  static Future<String?> _defaultTokenProvider() =>
      FirebaseAppCheck.instance.getToken();

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    // getToken はプラットフォーム未登録（例: iOS デバッグで App Check 未設定）
    // 等で例外を投げうる。ここで握りつぶしてもプロキシ側が本番ではトークンを
    // 必須化しており（未トークンは 401）、安全側に倒れる。例外を伝播させると
    // リクエスト自体が落ち、エミュレータ等の検証免除環境まで巻き添えになる。
    String? token;
    try {
      token = await _tokenProvider();
    } catch (_) {
      token = null;
    }
    // 空文字列は未トークンと同義（プロキシ側で検証不能）のため付与しない。
    if (token != null && token.isNotEmpty) {
      request.headers['X-Firebase-AppCheck'] = token;
    }
    return _inner.send(request);
  }

  @override
  void close() => _inner.close();
}
