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

  /// プロバイダからトークンを取り出す。取得できなければ null。
  ///
  /// getToken/getLimitedUseToken はプラットフォーム未登録（例: iOS デバッグで
  /// App Check 未設定）やアテステーション・クォータ枯渇で例外を投げうる。ここで
  /// 握りつぶしてもプロキシ側が本番ではトークンを必須化しており（未トークンは 401）、
  /// 安全側に倒れる。例外を伝播させるとリクエスト自体が落ち、エミュレータ等の
  /// 検証免除環境まで巻き添えになる。
  /// 空文字列は未トークンと同義（プロキシ側で検証不能）のため null に畳む。
  static Future<String?> _tokenFrom(AppCheckTokenProvider provider) async {
    try {
      final token = await provider();
      return (token == null || token.isEmpty) ? null : token;
    } catch (_) {
      return null;
    }
  }

  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) async {
    final needsLimitedUse = requiresLimitedUseToken(request.url);
    var token = await _tokenFrom(
      needsLimitedUse ? _limitedUseTokenProvider : _tokenProvider,
    );
    // 使い捨ての取得に失敗したら標準トークンへ縮退する。
    //
    // なぜ縮退させるか: アテステーション・クォータが枯渇すると getLimitedUseToken() は
    // throw する。ここで諦めるとヘッダ無し＝サーバは「トークン欠落」で 401 を返し、
    // その経路は consume 設定を一切見ない。つまりサーバ側の緊急停止
    // （APP_CHECK_CONSUME_ENDPOINTS=""）だけでは復旧できない。標準トークンへ落とせば、
    // 停止と組み合わせて完全に復旧できる。
    //
    // 停止していない場合でも劣化に留まる: 1 回目は通り、同じトークンの 2 回目以降が
    // リプレイとして 401 になる。全要求 401 よりは良い。
    if (token == null && needsLimitedUse) {
      token = await _tokenFrom(_tokenProvider);
    }
    if (token != null) {
      request.headers['X-Firebase-AppCheck'] = token;
    }
    return _inner.send(request);
  }

  @override
  void close() => _inner.close();
}
