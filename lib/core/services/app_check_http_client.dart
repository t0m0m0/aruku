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
  /// 重要（issue #155）: この判定はサーバ側の consume 有効化と必ず一致させること。
  ///   両者がずれた場合の影響は非対称で、matrix への「取りこぼし（false-negative）」
  ///   は機能を静かに壊す:
  ///   - 対象を false と誤判定し標準（キャッシュ再利用）トークンを matrix へ送ると、
  ///     サーバは 2 回目以降を消費済みとして 401 で拒否する → matrix が壊れる。
  ///   - 逆に非対象へ使い捨てトークンを送っても動作は壊れず、毎回新規アテステーション
  ///     の分だけコストが増えるだけ。
  ///   したがって取りこぼしにくい向きに倒す（＝対象を広めに拾う）。
  ///
  /// 現状は要素数課金の googleWalkMatrixProxy のみが対象。関数名は URL パスの末尾に
  /// 付く（gen2 直 URL では '/googleWalkMatrixProxy'）。厳密一致だとリライト等でパスに
  /// 余分が付いたとき matrix を取りこぼすため、より広く拾う endsWith を採る。ただし
  /// パス末尾を変えるリライト（例 '/api/matrix'）を入れる場合は、ここもサーバの
  /// ルーティングに合わせて更新すること。対象が増えたら集合照合へ拡張する。
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
