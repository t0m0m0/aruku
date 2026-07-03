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
///
/// リプレイ保護（issue #155）:
///   [requiresLimitedUseToken] が true を返すエンドポイント（既定では要素数課金の
///   googleWalkMatrixProxy）には getLimitedUseToken() の使い捨てトークンを付与する。
///   サーバ側は verifyToken(token, {consume:true}) で消費済みを記録し、2 回目以降を
///   リプレイとして 401 で弾く。それ以外はキャッシュ可能な標準トークン getToken() を
///   使い、追加アテステーションのコストを高単価エンドポイントに限定する。
class AppCheckHttpClient extends http.BaseClient {
  AppCheckHttpClient(
    this._inner, {
    AppCheckTokenProvider? tokenProvider,
    AppCheckTokenProvider? limitedUseTokenProvider,
  }) : _tokenProvider = tokenProvider ?? _defaultTokenProvider,
       _limitedUseTokenProvider =
           limitedUseTokenProvider ?? _defaultLimitedUseTokenProvider;

  final http.Client _inner;
  final AppCheckTokenProvider _tokenProvider;
  final AppCheckTokenProvider _limitedUseTokenProvider;

  static Future<String?> _defaultTokenProvider() =>
      FirebaseAppCheck.instance.getToken();

  static Future<String?> _defaultLimitedUseTokenProvider() =>
      FirebaseAppCheck.instance.getLimitedUseToken();

  /// このリクエストにリプレイ保護（使い捨て limited-use トークン）を要求するか。
  ///
  /// フェイルセーフの向き（issue #155 の設計方針）:
  ///   誤って false に倒れても「保護が一段弱まる」だけで機能は壊れない。逆に
  ///   全リクエストを true に倒すと他プロキシまで毎回新規アテステーションを
  ///   強制されコスト増・性能劣化を招く。よって保護対象は明示的に列挙する向きで
  ///   判定する（高単価エンドポイントだけを true にする）。
  ///
  /// 現状は要素数課金の googleWalkMatrixProxy のみが対象。関数名は URL パスの末尾に
  /// 付く（gen2 直 URL では '/googleWalkMatrixProxy'）ため endsWith で判定する。
  /// 厳密一致だとリライト等でパスに余分が付いたとき保護が静かに抜けるため、取りこぼし
  /// にくい末尾一致を採る（フェイルセーフの向き）。対象が増えたら集合照合へ拡張する。
  static bool requiresLimitedUseToken(Uri url) {
    return url.path.endsWith('googleWalkMatrixProxy');
  }

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    // 高単価エンドポイントは使い捨てトークン、それ以外はキャッシュ可能な標準トークン。
    final provider = requiresLimitedUseToken(request.url)
        ? _limitedUseTokenProvider
        : _tokenProvider;
    // getToken/getLimitedUseToken はプラットフォーム未登録（例: iOS デバッグで
    // App Check 未設定）等で例外を投げうる。ここで握りつぶしてもプロキシ側が本番では
    // トークンを必須化しており（未トークンは 401）、安全側に倒れる。例外を伝播させると
    // リクエスト自体が落ち、エミュレータ等の検証免除環境まで巻き添えになる。
    String? token;
    try {
      token = await provider();
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
