import 'package:firebase_app_check/firebase_app_check.dart';
import 'package:http/http.dart' as http;

/// App Check トークンを取得する関数。既定では FirebaseAppCheck を用いるが、
/// テストでは Firebase に触れない fake を注入してヘッダ付与を検証できる。
typedef AppCheckTokenProvider = Future<String?> Function();

/// http.Client をラップし、各リクエストに Firebase App Check の使い捨て
/// （limited-use）トークンを X-Firebase-AppCheck ヘッダとして付与する。
/// Cloud Functions プロキシ側はこれを verifyToken(token, {consume:true}) で検証し、
/// 未認証アクセス（API 課金の濫用）と、抜き取ったトークンの再送を遮断する。
///
/// トークン取得は送信時（send）に限定する。プロバイダ構築時には Firebase へ
/// 触れないため、Firebase 未初期化のテストでもプロバイダの生成は安全。
///
/// リプレイ保護（issue #155・#366）:
///   サーバ側は課金プロキシ3本すべてで消費済みを記録し、2 回目以降を 401 で弾く。
///   なぜ URL ごとに標準トークン（getToken）と使い分けないか: このクライアントが
///   触る URL は placesProxy / googleWalkProxy / googleWalkMatrixProxy だけで、
///   いずれも consume 対象だから。Transit API はここを通らない別クライアントで叩く
///   （route_service.dart）。使い分けを持つと、判定がサーバの consume 設定と
///   ずれた瞬間に「標準トークンを送った先が 2 回目から 401」で静かに壊れる——
///   分岐を持たなければ、そのずれ自体が起こりえない。
class AppCheckHttpClient extends http.BaseClient {
  AppCheckHttpClient(
    this._inner, {
    AppCheckTokenProvider? limitedUseTokenProvider,
  }) : _limitedUseTokenProvider =
           limitedUseTokenProvider ?? _defaultLimitedUseTokenProvider;

  final http.Client _inner;
  final AppCheckTokenProvider _limitedUseTokenProvider;

  static Future<String?> _defaultLimitedUseTokenProvider() =>
      FirebaseAppCheck.instance.getLimitedUseToken();

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    // getLimitedUseToken はプラットフォーム未登録（例: iOS デバッグで App Check
    // 未設定）等で例外を投げうる。ここで握りつぶしてもプロキシ側が本番では
    // トークンを必須化しており（未トークンは 401）、安全側に倒れる。例外を伝播させると
    // リクエスト自体が落ち、エミュレータ等の検証免除環境まで巻き添えになる。
    String? token;
    try {
      token = await _limitedUseTokenProvider();
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
