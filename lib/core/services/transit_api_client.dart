import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config/app_config.dart';
import '../models/geo_point.dart';
import 'cancellation.dart';
import 'route_service.dart';
import 'search_deadline.dart';

/// `/guidance/plan` の既定の除外モード。バス優勢な区間では `numItineraries` の枠が
/// バス経路で埋まり電車候補が消えるため、主照会は電車のみを要求する（#247）。
const _avoidModesTrainOnly = {'bus', 'ferry', 'air'};

/// バスを許容する照会（last-resort 再照会・#250）の除外モード。`ferry`/`air` は
/// [SegmentType] で表現できずパーサが option ごと落とすため、除外したままにする。
const _avoidModesAllowBus = {'ferry', 'air'};

/// Transit API（`/guidance/plan` 直叩き）と Google Routes プロキシへの HTTP 通信を担う
/// クライアント（#169）。[TransitRouteService] から通信の関心事を切り出し、選定ロジックを
/// トランスポートから独立させる。
///
/// 経路取得は Transit API を直叩き（認証不要・CORS）、アクセス徒歩の実測は Google Routes
/// プロキシ（App Check）を介す。タイムアウト（[TimeoutHttpClient]・#156）は注入された
/// クライアント側で適用され、無応答は `RouteException('TIMEOUT')` へ変換する。
///
/// [cancellation] を渡すと検索単位で中断できる（#259）。クライアントは検索1回分の
/// 寿命で所有され、[close] で in-flight のソケットごと落とす。
class TransitApiClient {
  TransitApiClient({
    http.Client? transitClient,
    http.Client? proxyClient,
    String? transitBaseUrl,
    String? proxyBaseUrl,
    this.cancellation,
    this.deadline = const SearchDeadline.none(),
  }) : _transit = transitClient ?? http.Client(),
       _proxy = proxyClient ?? http.Client(),
       _transitBaseUrl = (transitBaseUrl ?? AppConfig.transitApiBaseUrl)
           .replaceAll(RegExp(r'/+$'), ''),
       _proxyBaseUrl = (proxyBaseUrl ?? AppConfig.proxyBaseUrl).replaceAll(
         RegExp(r'/+$'),
         '',
       );

  final http.Client _transit;
  final http.Client _proxy;
  final String _transitBaseUrl;
  final String _proxyBaseUrl;

  /// 検索1回分のキャンセル境界（#259）。null なら中断不能（既定）。
  final CancellationToken? cancellation;

  /// 検索1回分の締切（#300）。既定（[SearchDeadline.none]）は無期限。
  final SearchDeadline deadline;

  /// `/guidance/plan` で取得する候補数。
  static const int _numItineraries = 5;

  // 上流 HTTP 往復本数の実測（#309）。「実際に GET を発行した回数」を種別ごとに数える。
  // 締切切れ・キャンセルで発行前に落ちた要求は往復していないので数えない（[_getOrTimeout]
  // が発行直前にだけ [onIssued] を呼ぶ）。成功・失敗は問わない——本数は叩いた回数であって
  // 成功回数ではない（マトリクスの null 縮退でも往復はしている）。
  int _guidanceCalls = 0;
  int _walkCalls = 0;
  int _matrixCalls = 0;

  /// `/guidance/plan` の実 HTTP 往復本数（初回＋引き直し）。
  int get guidanceCalls => _guidanceCalls;

  /// Google 徒歩ルート（enrich）の実 HTTP 往復本数。
  int get walkCalls => _walkCalls;

  /// Google 徒歩マトリクスの実 HTTP 往復本数。
  int get matrixCalls => _matrixCalls;

  /// 全種別の実 HTTP 往復本数の合計（1検索あたりの上流負荷の実測）。
  int get roundTrips => _guidanceCalls + _walkCalls + _matrixCalls;

  /// 正規化済みの Transit API ベース URL（テスト・観測用）。
  String get transitBaseUrl => _transitBaseUrl;

  /// Transit API のベース URL が設定済みか。未設定なら呼び出し側は `NO_TRANSIT_API`
  /// を投げる。設定知識を通信層に閉じ込め、ドメイン層が URL 文字列を覗かないための述語。
  bool get hasTransitApi => _transitBaseUrl.isNotEmpty;

  // ---- Transit API（直叩き） ----

  /// [start]→[goal] を [at] 発で `/guidance/plan` に問い合わせ、生 JSON を返す。
  /// 非200は `RouteException('HTTP <code>')`、無応答は `RouteException('TIMEOUT')`。
  ///
  /// [allowBus] を立てるとバスを含む経路も要求する（#250 の last-resort 再照会）。
  /// 既定（false）はバスを除外し電車のみを要求する（#247）。
  Future<Map<String, dynamic>> fetchGuidanceAt(
    GeoPoint start,
    GeoPoint goal,
    DateTime at, {
    bool allowBus = false,
  }) async {
    final uri = Uri.parse('$_transitBaseUrl/api/v1/guidance/plan').replace(
      queryParameters: {
        'from': 'geo:${start.lat},${start.lng}',
        'to': 'geo:${goal.lat},${goal.lng}',
        'date': _formatDate(at),
        'time': _formatTime(at),
        'type': 'departure',
        'numItineraries': '$_numItineraries',
        'avoidModes': (allowBus ? _avoidModesAllowBus : _avoidModesTrainOnly)
            .join(','),
      },
    );
    final res = await _getOrTimeout(
      _transit,
      uri,
      onIssued: () => _guidanceCalls++,
    );
    if (res.statusCode != 200) throw RouteException('HTTP ${res.statusCode}');
    return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  }

  // ---- Google Routes（プロキシ） ----

  /// [origins]×[dests] の徒歩マトリクスを Google プロキシで一括実測し、生の要素配列を返す。
  /// 取得失敗（非200・タイムアウト・非配列）は null（呼び出し側は直線推定へフォールバック）。
  Future<List<dynamic>?> fetchWalkMatrix(
    List<GeoPoint> origins,
    List<GeoPoint> dests,
  ) async {
    String join(List<GeoPoint> ps) =>
        ps.map((p) => '${p.lat},${p.lng}').join(';');
    try {
      return await _fetchProxyArray('googleWalkMatrixProxy', {
        'origins': join(origins),
        'destinations': join(dests),
      }, onIssued: () => _matrixCalls++);
    } on RouteException {
      return null;
    }
  }

  /// [origin]→[dest] の徒歩を Google Routes(WALK, プロキシ経由)で取得した生ボディを返す。
  /// 非200・無応答は `RouteException`（呼び出し側が routes をパース・失敗を吸収する）。
  Future<Map<String, dynamic>> fetchWalkRoute(GeoPoint origin, GeoPoint dest) =>
      _fetchProxy('googleWalkProxy', {
        'start': '${origin.lat},${origin.lng}',
        'goal': '${dest.lat},${dest.lng}',
      }, onIssued: () => _walkCalls++);

  Future<Map<String, dynamic>> _fetchProxy(
    String path,
    Map<String, String> params, {
    required void Function() onIssued,
  }) async {
    final uri = Uri.parse(
      '$_proxyBaseUrl/$path',
    ).replace(queryParameters: params);
    final res = await _getOrTimeout(
      _proxy,
      uri,
      deadlineApplies: false,
      onIssued: onIssued,
    );
    if (res.statusCode != 200) throw RouteException('HTTP ${res.statusCode}');
    return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  }

  Future<List<dynamic>> _fetchProxyArray(
    String path,
    Map<String, String> params, {
    required void Function() onIssued,
  }) async {
    final uri = Uri.parse(
      '$_proxyBaseUrl/$path',
    ).replace(queryParameters: params);
    final res = await _getOrTimeout(
      _proxy,
      uri,
      deadlineApplies: false,
      onIssued: onIssued,
    );
    if (res.statusCode != 200) throw RouteException('HTTP ${res.statusCode}');
    final decoded = jsonDecode(utf8.decode(res.bodyBytes));
    if (decoded is! List) throw const RouteException('MATRIX_NOT_ARRAY');
    return decoded;
  }

  /// [client] で [uri] を GET し、タイムアウト（[TimeoutHttpClient]・#156）を
  /// `RouteException('TIMEOUT')` へ変換する。これで無応答は既存の UI エラー処理と
  /// 縮退（失敗レッグは `on RouteException` で直線推定・候補スキップ）にそのまま乗る。
  ///
  /// キャンセル判定を全 fetch の共通経路であるここへ置くのは、[fetchWalkMatrix] の
  /// ような縮退の口（`on RouteException` → null）の内側で投げても、
  /// [SearchCanceledException] が `RouteException` でない以上そこで握り潰されずに
  /// 抜けるため（#259）。
  ///
  /// [deadlineApplies] のとき [deadline] の残予算でも打ち切る（#300）。1本の上限
  /// （[TimeoutHttpClient]・35s）だけでは検索全体の最悪待ち時間が「上限 × 直列ラウンド数」
  /// に膨らむため、残予算でクランプして天井を締切へ落とす。期限切れなら HTTP を発行
  /// しない——残予算 0 で投げた照会は必ず打ち切られる＝無料・無認証の上流を無駄に叩く
  /// だけなので、送る前に落とす。
  ///
  /// **徒歩プロキシには締切を適用しない（`deadlineApplies: false`）。** 締切で切って
  /// よいのは「切っても嘘をつかない」呼び出しだけ、という非対称性がある：
  /// - Transit の引き直しは **fail-closed**。失敗すると候補が `unverified` として除外され
  ///   確証ある候補へ縮退する（§4 #137 approach A）。締切で切っても提示内容は嘘にならない。
  /// - 徒歩の実測は **fail-open**。[TransitRouteService._enrichWalkGeometry] は取得失敗時に
  ///   元の見積り（guidance / 直線）を**そのまま残す**。直線は実街路に対し大きく楽観に
  ///   倒れる（実機で -36分・25%）ため、締切で切ると「23分」と名乗る実際46分の全徒歩を
  ///   確定させ、予算超過・乗り遅れの経路を平然と提示する（#254 の不変条件を破る）。
  ///
  /// measure-first の実測は探索の**改善**ではなく確定経路の**検証**であり、締切より優先する。
  /// 探索側（乗車駅探索・代替検証）は [TransitRouteService] が締切でラウンドごと止めるので、
  /// 期限切れ後に走る徒歩実測は確定候補の検証だけ＝本数は候補の区間数で頭打ちになる。
  Future<http.Response> _getOrTimeout(
    http.Client client,
    Uri uri, {
    bool deadlineApplies = true,
    void Function()? onIssued,
  }) async {
    cancellation?.throwIfCanceled();
    final remaining = deadlineApplies ? deadline.remaining : null;
    if (remaining == Duration.zero) throw const RouteException('TIMEOUT');
    try {
      // 往復本数の計上（#309）は「発行が確定した瞬間」にだけ行う。キャンセル・締切切れで
      // 上の 2 ガードに掛かった要求は往復していないので数えない。
      onIssued?.call();
      final request = client.get(uri);
      return await (remaining == null ? request : request.timeout(remaining));
    } on TimeoutException {
      throw const RouteException('TIMEOUT');
    }
  }

  /// 保持するクライアントを閉じ、in-flight のリクエストを中断する（#259）。
  /// package:http にリクエスト単位の abort は無く、`IOClient.close()` が
  /// `HttpClient.close(force: true)` へ委譲することだけが実際の中断手段。
  void close() {
    _transit.close();
    _proxy.close();
  }

  String _formatDate(DateTime dt) =>
      '${dt.year.toString().padLeft(4, '0')}'
      '${dt.month.toString().padLeft(2, '0')}'
      '${dt.day.toString().padLeft(2, '0')}';

  String _formatTime(DateTime dt) =>
      '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
}
