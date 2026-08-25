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
/// リプレイ保護（issue #155・#366）:
///   [requiresLimitedUseToken] が true を返すエンドポイントには
///   getLimitedUseToken() の使い捨てトークンを付与する。サーバ側は
///   verifyToken(token, {consume:true}) で消費済みを記録し、2 回目以降を
///   リプレイとして 401 で弾く。それ以外はキャッシュ可能な標準トークン getToken()。
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

  /// サーバが consume:true で検証する関数名。`shouldConsumeAppCheckToken()` の
  /// 既定（`functions/src/index.ts`）と厳密に一致させること。
  static const _replayProtectedFunctions = {
    'placesProxy',
    'googleWalkMatrixProxy',
  };

  /// このリクエストにリプレイ保護（使い捨て limited-use トークン）を要求するか。
  ///
  /// 重要（issue #155・#366）: この判定はサーバ側の consume 対象と**厳密に**一致
  ///   させること。ずれは両方向とも実害がある:
  ///   - 対象を取りこぼし標準（キャッシュ再利用）トークンを送ると、サーバは 2 回目
  ///     以降を消費済みとして 401 で拒否する → そのエンドポイントが壊れる。
  ///   - 逆に非対象へ使い捨てトークンを送ると、要求ごとに新規アテステーションが
  ///     走りクォータ（例: Play Integrity Standard は 1 日 10,000 コール）を焼く。
  ///     枯渇すると getLimitedUseToken() が throw し、下の catch がヘッダを落とし、
  ///     結局そのプロキシは全要求 401 になる。
  ///   以前は「取りこぼしにくい向きへ広めに拾う」としていたが、クォータが拘束条件に
  ///   なった #366 以降は広め方向も同じだけ危険なので、厳密一致に改めた。
  ///
  /// 関数名は URL パスの末尾セグメント（gen2 直 URL では '/placesProxy'）。パス末尾を
  /// 変えるリライト（例 '/api/places'）を入れる場合はここも更新すること。
  static bool requiresLimitedUseToken(Uri url) {
    final segments = url.pathSegments;
    if (segments.isEmpty) return false;
    return _replayProtectedFunctions.contains(segments.last);
  }

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
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
