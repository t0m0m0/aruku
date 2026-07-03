import 'dart:async';
import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../config/app_config.dart';
import '../models/geo_point.dart';
import '../models/place_prediction.dart';
import 'app_check_http_client.dart';
import 'timeout_http_client.dart';

abstract interface class PlacesService {
  /// 地点検索（typeahead）。[bias] が渡されたときは現在地周辺を優先する位置バイアス
  /// を掛ける。現在地が分かるときは proxy が origin も渡すため、各候補に現在地からの
  /// 距離（[PlacePrediction.distanceMeters]）が付く（「近くの店」モードの距離再ソート用・#146）。
  Future<List<PlacePrediction>> autocomplete(String query, {GeoPoint? bias});

  /// 候補（placeId）から座標を引く。Google autocomplete は座標を返さないため、
  /// 確定時にこの details 呼び出しで補う2段フロー。
  Future<GeoPoint?> fetchLatLng(String placeId);
}

/// Firebase Functions の placesProxy 経由で Google Places API (New) を叩く。
///
/// API キーはサーバ側に隠蔽し、App Check トークン付きで呼び出す。autocomplete は
/// 候補（placeId＋テキスト）のみ返すため、確定時に [fetchLatLng] で座標を引く。
/// [autocomplete] に [bias] を渡すと、proxy が locationBias（円）を組み立てて
/// 現在地周辺の POI を上位へ寄せる（#144）。
class GooglePlacesService implements PlacesService {
  GooglePlacesService({http.Client? client, String? proxyBaseUrl})
    : _client = client ?? http.Client(),
      _proxyBaseUrl = (proxyBaseUrl ?? AppConfig.proxyBaseUrl).replaceAll(
        RegExp(r'/+$'),
        '',
      );

  final http.Client _client;
  final String _proxyBaseUrl;

  @override
  Future<List<PlacePrediction>> autocomplete(
    String query, {
    GeoPoint? bias,
  }) async {
    if (_proxyBaseUrl.isEmpty) return [];
    final uri = Uri.parse('$_proxyBaseUrl/placesProxy').replace(
      queryParameters: {
        'action': 'autocomplete',
        'input': query,
        'language': 'ja',
        'components': 'country:jp',
        // 現在地が分かるときだけ位置バイアスを渡す。proxy 側で locationBias へ。
        if (bias != null) ...{'lat': '${bias.lat}', 'lon': '${bias.lng}'},
      },
    );

    final http.Response response;
    try {
      response = await _client.get(uri);
    } on TimeoutException {
      throw const PlacesException('TIMEOUT');
    }
    if (response.statusCode != 200) {
      throw PlacesException('HTTP ${response.statusCode}');
    }

    final body =
        jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
    final status = body['status'] as String;
    if (status == 'ZERO_RESULTS') return [];
    if (status != 'OK') throw PlacesException(status);

    final predictions = body['predictions'] as List<dynamic>;
    return predictions
        .map((p) => _toPrediction(p as Map<String, dynamic>))
        .toList();
  }

  /// レガシー prediction を [PlacePrediction] へ。proxy が origin を渡したときに付く
  /// distance_meters を距離（[PlacePrediction.distanceMeters]）として取り込む（#146 C案）。
  PlacePrediction _toPrediction(Map<String, dynamic> map) {
    final terms = map['terms'] as List<dynamic>? ?? [];
    final name = terms.isNotEmpty
        ? (terms.first as Map<String, dynamic>)['value'] as String
        : map['description'] as String;
    final description = map['description'] as String;
    // 先頭の "名称, 住所…" から住所部を取り出す。カンマ直後の空白有無に依存せず、
    // カンマが末尾でも RangeError にならないよう indexOf+1 して左空白を落とす。
    final commaIndex = description.indexOf(',');
    final address = commaIndex >= 0
        ? description.substring(commaIndex + 1).trimLeft()
        : description;
    return PlacePrediction(
      placeId: map['place_id'] as String,
      name: name,
      address: address,
      distanceMeters: (map['distance_meters'] as num?)?.toInt(),
    );
  }

  @override
  Future<GeoPoint?> fetchLatLng(String placeId) async {
    if (_proxyBaseUrl.isEmpty) return null;
    final uri = Uri.parse(
      '$_proxyBaseUrl/placesProxy',
    ).replace(queryParameters: {'action': 'details', 'place_id': placeId});

    final http.Response response;
    try {
      response = await _client.get(uri);
    } on TimeoutException {
      throw const PlacesException('TIMEOUT');
    }
    if (response.statusCode != 200) {
      throw PlacesException('HTTP ${response.statusCode}');
    }

    final body =
        jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
    if (body['status'] != 'OK') return null;

    final result = body['result'] as Map<String, dynamic>?;
    final geometry = result?['geometry'] as Map<String, dynamic>?;
    final location = geometry?['location'] as Map<String, dynamic>?;
    if (location == null) return null;

    return GeoPoint(
      (location['lat'] as num).toDouble(),
      (location['lng'] as num).toDouble(),
    );
  }
}

class PlacesException implements Exception {
  const PlacesException(this.status);
  final String status;

  @override
  String toString() => 'PlacesException($status)';
}

final placesServiceProvider = Provider<PlacesService>((ref) {
  final client = AppCheckHttpClient(TimeoutHttpClient(http.Client()));
  ref.onDispose(client.close);
  return GooglePlacesService(client: client);
});
