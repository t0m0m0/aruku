import 'dart:convert';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:http/http.dart' as http;

import '../config/app_config.dart';
import '../models/geo_point.dart';
import '../models/place_prediction.dart';

abstract interface class PlacesService {
  Future<List<PlacePrediction>> autocomplete(String query);
}

/// Transit API（api.transit.ls8h.com）の `places/suggest` で地点検索を行う。
///
/// 認証不要・CORS対応のためプロキシを介さずクライアントから直接呼び出す。
/// suggest が座標(`lat`/`lon`)を同梱するため、旧 Google Places の
/// autocomplete→details 2段フローは1コールに畳まれている。
class TransitPlacesService implements PlacesService {
  TransitPlacesService({http.Client? client, String? baseUrl})
    : _client = client ?? http.Client(),
      _baseUrl = (baseUrl ?? AppConfig.transitApiBaseUrl).replaceAll(
        RegExp(r'/+$'),
        '',
      );

  final http.Client _client;
  final String _baseUrl;

  static const int _limit = 10;

  /// kind の表示優先度（小さいほど上位）。
  static const Map<String, int> _kindRank = {
    'station': 0,
    'stop': 1,
    'place': 2,
    'address': 3,
  };

  @override
  Future<List<PlacePrediction>> autocomplete(String query) async {
    if (query.isEmpty || _baseUrl.isEmpty) return [];

    final uri = Uri.parse(
      '$_baseUrl/api/v1/places/suggest',
    ).replace(queryParameters: {'q': query, 'limit': '$_limit'});

    final response = await _client.get(uri);
    if (response.statusCode != 200) {
      throw PlacesException('HTTP ${response.statusCode}');
    }

    final body =
        jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
    // 成功ステータス(200)でも places 配列が無い応答はエラー封筒とみなす。
    // 空配列で握り潰すと API エラーが「結果ゼロ」に化けて隠れてしまう。
    final raw = body['places'];
    if (raw is! List) {
      throw const PlacesException('malformed response: missing places');
    }
    final places = raw
        .whereType<Map<String, dynamic>>()
        .map(_TransitPlace.tryParse)
        .whereType<_TransitPlace>()
        .toList();

    return _rankAndDedupe(places);
  }

  /// クライアント側で実用順位へ補正し、同名・同座標の重複を畳む。
  ///
  /// Transit の suggest は順位付けが粗く、駅は feed 別に重複する。
  /// kind 優先度 → weight 降順 → score 降順で並べ替える。Dart の [List.sort] は
  /// 安定でないため、全要素同点のときは受信順をタイブレークに使って決定的にする。
  /// 並べ替え後、名前＋座標（小数4桁丸め ≒ 10m）で先頭を残して dedup する。
  List<PlacePrediction> _rankAndDedupe(List<_TransitPlace> places) {
    final indexed = [for (var i = 0; i < places.length; i++) (i, places[i])]
      ..sort((a, b) {
        final pa = a.$2;
        final pb = b.$2;
        final ka = _kindRank[pa.kind] ?? 99;
        final kb = _kindRank[pb.kind] ?? 99;
        if (ka != kb) return ka.compareTo(kb);
        if (pa.weight != pb.weight) return pb.weight.compareTo(pa.weight);
        if (pa.score != pb.score) return pb.score.compareTo(pa.score);
        return a.$1.compareTo(b.$1);
      });

    final seen = <String>{};
    final out = <PlacePrediction>[];
    for (final (_, p) in indexed) {
      final key =
          '${p.name}|${p.lat.toStringAsFixed(4)},${p.lon.toStringAsFixed(4)}';
      if (!seen.add(key)) continue;
      out.add(p.toPrediction());
    }
    return out;
  }
}

/// suggest の生レスポンス1件。ランキング用に weight/score を保持する。
class _TransitPlace {
  const _TransitPlace({
    required this.id,
    required this.name,
    required this.lat,
    required this.lon,
    required this.kind,
    required this.weight,
    required this.score,
    this.description,
  });

  final String id;
  final String name;
  final double lat;
  final double lon;
  final String kind;
  final double weight;
  final double score;
  final String? description;

  static _TransitPlace? tryParse(Map<String, dynamic> json) {
    final id = json['id'];
    final name = json['name'];
    final lat = json['lat'];
    final lon = json['lon'];
    if (id is! String || name is! String || lat is! num || lon is! num) {
      return null;
    }
    return _TransitPlace(
      id: id,
      name: name,
      lat: lat.toDouble(),
      lon: lon.toDouble(),
      kind: json['kind'] as String? ?? 'place',
      weight: (json['weight'] as num?)?.toDouble() ?? 0,
      score: (json['score'] as num?)?.toDouble() ?? 0,
      description: json['description'] as String?,
    );
  }

  PlacePrediction toPrediction() => PlacePrediction(
    placeId: id,
    name: name,
    address: description ?? '',
    latLng: GeoPoint(lat, lon),
    kind: kind,
  );
}

class PlacesException implements Exception {
  const PlacesException(this.status);
  final String status;

  @override
  String toString() => 'PlacesException($status)';
}

final placesServiceProvider = Provider<PlacesService>((ref) {
  final client = http.Client();
  ref.onDispose(client.close);
  return TransitPlacesService(client: client);
});
