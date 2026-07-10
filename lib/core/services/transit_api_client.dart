import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import '../config/app_config.dart';
import '../models/geo_point.dart';
import 'route_service.dart';

/// `/guidance/plan` へ問い合わせる際に除外する交通モード。バスは last-resort 候補と
/// してまだ実装していないため、電車のみの経路を要求する（#247）。パーサ側の
/// mode→SegmentType 写像（`_segmentTypeForMode`、bus→SegmentType.bus）とは独立の
/// 定数——パーサが bus を型として許容しても、この問い合わせ条件自体は変えない（#249）。
const _avoidModes = {'bus', 'ferry', 'air'};

/// Transit API（`/guidance/plan` 直叩き）と Google Routes プロキシへの HTTP 通信を担う
/// クライアント（#169）。[TransitRouteService] から通信の関心事を切り出し、選定ロジックを
/// トランスポートから独立させる。
///
/// 経路取得は Transit API を直叩き（認証不要・CORS）、アクセス徒歩の実測は Google Routes
/// プロキシ（App Check）を介す。タイムアウト（[TimeoutHttpClient]・#156）は注入された
/// クライアント側で適用され、無応答は `RouteException('TIMEOUT')` へ変換する。
class TransitApiClient {
  TransitApiClient({
    http.Client? transitClient,
    http.Client? proxyClient,
    String? transitBaseUrl,
    String? proxyBaseUrl,
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

  /// `/guidance/plan` で取得する候補数。
  static const int _numItineraries = 5;

  /// 正規化済みの Transit API ベース URL（テスト・観測用）。
  String get transitBaseUrl => _transitBaseUrl;

  /// Transit API のベース URL が設定済みか。未設定なら呼び出し側は `NO_TRANSIT_API`
  /// を投げる。設定知識を通信層に閉じ込め、ドメイン層が URL 文字列を覗かないための述語。
  bool get hasTransitApi => _transitBaseUrl.isNotEmpty;

  // ---- Transit API（直叩き） ----

  /// [start]→[goal] を [at] 発で `/guidance/plan` に問い合わせ、生 JSON を返す。
  /// 非200は `RouteException('HTTP <code>')`、無応答は `RouteException('TIMEOUT')`。
  Future<Map<String, dynamic>> fetchGuidanceAt(
    GeoPoint start,
    GeoPoint goal,
    DateTime at,
  ) async {
    final uri = Uri.parse('$_transitBaseUrl/api/v1/guidance/plan').replace(
      queryParameters: {
        'from': 'geo:${start.lat},${start.lng}',
        'to': 'geo:${goal.lat},${goal.lng}',
        'date': _formatDate(at),
        'time': _formatTime(at),
        'type': 'departure',
        'numItineraries': '$_numItineraries',
        'avoidModes': _avoidModes.join(','),
      },
    );
    final res = await _getOrTimeout(_transit, uri);
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
      });
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
      });

  Future<Map<String, dynamic>> _fetchProxy(
    String path,
    Map<String, String> params,
  ) async {
    final uri = Uri.parse(
      '$_proxyBaseUrl/$path',
    ).replace(queryParameters: params);
    final res = await _getOrTimeout(_proxy, uri);
    if (res.statusCode != 200) throw RouteException('HTTP ${res.statusCode}');
    return jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
  }

  Future<List<dynamic>> _fetchProxyArray(
    String path,
    Map<String, String> params,
  ) async {
    final uri = Uri.parse(
      '$_proxyBaseUrl/$path',
    ).replace(queryParameters: params);
    final res = await _getOrTimeout(_proxy, uri);
    if (res.statusCode != 200) throw RouteException('HTTP ${res.statusCode}');
    final decoded = jsonDecode(utf8.decode(res.bodyBytes));
    if (decoded is! List) throw const RouteException('MATRIX_NOT_ARRAY');
    return decoded;
  }

  /// [client] で [uri] を GET し、タイムアウト（[TimeoutHttpClient]・#156）を
  /// `RouteException('TIMEOUT')` へ変換する。これで無応答は既存の UI エラー処理と
  /// 縮退（失敗レッグは `on RouteException` で直線推定・候補スキップ）にそのまま乗る。
  Future<http.Response> _getOrTimeout(http.Client client, Uri uri) async {
    try {
      return await client.get(uri);
    } on TimeoutException {
      throw const RouteException('TIMEOUT');
    }
  }

  String _formatDate(DateTime dt) =>
      '${dt.year.toString().padLeft(4, '0')}'
      '${dt.month.toString().padLeft(2, '0')}'
      '${dt.day.toString().padLeft(2, '0')}';

  String _formatTime(DateTime dt) =>
      '${dt.hour.toString().padLeft(2, '0')}:${dt.minute.toString().padLeft(2, '0')}';
}
