import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart' show rootBundle;
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../models/geo_point.dart';

/// 逆ジオで得た行政区画ラベル（県＋市区町村）。
@immutable
class AreaLabel {
  const AreaLabel({required this.pref, required this.city});

  final String pref;
  final String city;

  /// 表示用の連結文字列（例: 「長野県上田市」）。
  String get full => '$pref$city';

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AreaLabel && pref == other.pref && city == other.city;

  @override
  int get hashCode => Object.hash(pref, city);
}

abstract interface class ReverseGeocodingService {
  /// 座標から県＋市区町村ラベルを引く。失敗・該当なしは null。
  Future<AreaLabel?> areaForCoord(GeoPoint point);
}

/// 国土地理院（GSI）の逆ジオコーディング API で県・市区町村名を補う。
///
/// API（`LonLatToAddress`）は `muniCd`（市区町村コード）しか返さないため、
/// 事前バンドルした [muniTable]（`assets/muni_codes.json`）で県市名へ変換する。
/// 認証不要・無料・国産データのため脱 Google 方針に合致する。
///
/// 失敗時は例外を投げず null を返し、検索本体を止めない。座標は小数4桁
/// （≒10m）に丸めてメモリキャッシュし、同一地点の再照会を防ぐ。
class GsiReverseGeocodingService implements ReverseGeocodingService {
  GsiReverseGeocodingService({
    required Future<Map<String, AreaLabel>> muniTable,
    http.Client? client,
    String? baseUrl,
  }) : _muniTableFuture = muniTable,
       _client = client ?? http.Client(),
       _baseUrl = baseUrl ?? _defaultBaseUrl;

  static const String _defaultBaseUrl =
      'https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress';

  /// muniCd 変換表は非同期（アセット読み込み）。初回 [areaForCoord] で一度だけ
  /// await し、以後はキャッシュした表を使う。FutureProvider の `.value` を同期で
  /// 読む実装は読み込み完了前に null となり逆ジオ全体が無効化されるため避ける。
  final Future<Map<String, AreaLabel>> _muniTableFuture;
  Map<String, AreaLabel>? _muniTable;

  final http.Client _client;
  final String _baseUrl;

  /// 4桁丸めキー → 確定結果（該当なしは null）。HTTP/通信失敗はキャッシュしない。
  final Map<String, AreaLabel?> _cache = {};

  @override
  Future<AreaLabel?> areaForCoord(GeoPoint point) async {
    final table = _muniTable ??= await _loadTable();
    if (table.isEmpty) return null;

    final key =
        '${point.lat.toStringAsFixed(4)},${point.lng.toStringAsFixed(4)}';
    if (_cache.containsKey(key)) return _cache[key];

    final uri = Uri.parse(
      _baseUrl,
    ).replace(queryParameters: {'lat': '${point.lat}', 'lon': '${point.lng}'});

    final http.Response response;
    try {
      response = await _client.get(uri);
    } catch (_) {
      // 通信失敗は確定ではない。キャッシュせず次回再試行できるようにする。
      return null;
    }
    if (response.statusCode != 200) return null;

    final AreaLabel? area;
    try {
      final body =
          jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
      final results = body['results'];
      final muniCd = results is Map<String, dynamic>
          ? results['muniCd'] as String?
          : null;
      area = muniCd == null ? null : table[muniCd];
    } catch (_) {
      return null;
    }

    // 該当なし（海上・未知 muniCd）は確定結果なのでキャッシュしてよい。
    _cache[key] = area;
    return area;
  }

  /// 変換表を await する。読み込み失敗時は空表（逆ジオ無効）として扱う。
  Future<Map<String, AreaLabel>> _loadTable() async {
    try {
      return await _muniTableFuture;
    } catch (_) {
      return const {};
    }
  }
}

/// `assets/muni_codes.json` を読み込み muniCd → [AreaLabel] 表へ変換する。
Future<Map<String, AreaLabel>> loadMuniTable() async {
  final raw = await rootBundle.loadString('assets/muni_codes.json');
  final json = jsonDecode(raw) as Map<String, dynamic>;
  return {
    for (final entry in json.entries)
      if (entry.value case {
        'pref': final String pref,
        'city': final String city,
      })
        entry.key: AreaLabel(pref: pref, city: city),
  };
}

/// 逆ジオ Service。muniTable は Service が初回呼び出しで遅延ロードするため、
/// ここでは読み込み完了を待たずに即座に Service を返せる（null にならない）。
final reverseGeocodingServiceProvider = Provider<ReverseGeocodingService?>((
  ref,
) {
  final client = http.Client();
  ref.onDispose(client.close);
  return GsiReverseGeocodingService(muniTable: loadMuniTable(), client: client);
});
