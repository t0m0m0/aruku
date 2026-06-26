import 'dart:convert';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/services/places_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _baseUrl = 'https://transit.example.com';

http.Response _jsonResponse(Object body, int status) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status);

Map<String, dynamic> _place({
  required String id,
  required String name,
  required double lat,
  required double lon,
  String kind = 'place',
  String source = 'osm',
  num weight = 30,
  num score = 3,
  String? description,
}) => {
  'id': id,
  'endpoint': 'geo:$lat,$lon',
  'name': name,
  'kind': kind,
  'source': source,
  'lat': lat,
  'lon': lon,
  'weight': weight,
  'score': score,
  'description': ?description,
};

void main() {
  group('TransitPlacesService.autocomplete', () {
    test('places/suggest を直接呼び出し座標付き候補を返す', () async {
      final client = MockClient((request) async {
        expect(request.method, 'GET');
        expect(
          request.url.toString(),
          startsWith('$_baseUrl/api/v1/places/suggest'),
        );
        expect(request.url.queryParameters['q'], '東京タワー');
        return _jsonResponse({
          'places': [
            _place(
              id: 'osm:node:1',
              name: '東京タワー',
              lat: 35.6586,
              lon: 139.7454,
              description: '施設',
            ),
          ],
        }, 200);
      });

      final service = TransitPlacesService(client: client, baseUrl: _baseUrl);
      final results = await service.autocomplete('東京タワー');

      expect(results, hasLength(1));
      expect(results.first.placeId, 'osm:node:1');
      expect(results.first.name, '東京タワー');
      expect(results.first.latLng, const GeoPoint(35.6586, 139.7454));
      expect(results.first.kind, 'place');
    });

    test('places が空のとき空リストを返す', () async {
      final client = MockClient(
        (_) async => _jsonResponse({'places': []}, 200),
      );
      final service = TransitPlacesService(client: client, baseUrl: _baseUrl);
      expect(await service.autocomplete('xyzxyz'), isEmpty);
    });

    test('クエリが空のときネットワークを叩かず空リストを返す', () async {
      final client = MockClient((_) async => throw Exception('called'));
      final service = TransitPlacesService(client: client, baseUrl: _baseUrl);
      expect(await service.autocomplete(''), isEmpty);
    });

    test('HTTP エラーで PlacesException をスローする', () async {
      final client = MockClient((_) async => http.Response('boom', 500));
      final service = TransitPlacesService(client: client, baseUrl: _baseUrl);
      expect(
        () => service.autocomplete('test'),
        throwsA(isA<PlacesException>()),
      );
    });

    test('同名・同座標の駅候補（feed別重複）を1件に dedup する', () async {
      final client = MockClient(
        (_) async => _jsonResponse({
          'places': [
            _place(
              id: 'feed-a:Tokyo',
              name: '東京',
              lat: 35.681236,
              lon: 139.767125,
              kind: 'station',
              source: 'transit',
              weight: 80,
            ),
            _place(
              id: 'feed-b:Tokyo',
              name: '東京',
              lat: 35.681236,
              lon: 139.767125,
              kind: 'station',
              source: 'transit',
              weight: 70,
            ),
          ],
        }, 200),
      );

      final service = TransitPlacesService(client: client, baseUrl: _baseUrl);
      final results = await service.autocomplete('東京');

      expect(results, hasLength(1), reason: '同名・同座標は1件に畳む');
      expect(results.first.placeId, 'feed-a:Tokyo', reason: '重みの高い方を残す');
    });

    test('kind 優先度（station > stop > place）と weight で並べ替える', () async {
      final client = MockClient(
        (_) async => _jsonResponse({
          'places': [
            _place(
              id: 'place-low',
              name: 'A',
              lat: 1,
              lon: 1,
              kind: 'place',
              weight: 35,
            ),
            _place(
              id: 'station',
              name: 'B',
              lat: 2,
              lon: 2,
              kind: 'station',
              weight: 10,
            ),
            _place(
              id: 'stop',
              name: 'C',
              lat: 3,
              lon: 3,
              kind: 'stop',
              weight: 50,
            ),
            _place(
              id: 'place-high',
              name: 'D',
              lat: 4,
              lon: 4,
              kind: 'place',
              weight: 90,
            ),
          ],
        }, 200),
      );

      final service = TransitPlacesService(client: client, baseUrl: _baseUrl);
      final results = await service.autocomplete('x');

      expect(results.map((p) => p.placeId).toList(), [
        'station',
        'stop',
        'place-high',
        'place-low',
      ], reason: 'kind 優先度→weight 降順の安定ソート');
    });

    test('baseUrl 末尾スラッシュを除去して組み立てる', () async {
      late Uri captured;
      final client = MockClient((request) async {
        captured = request.url;
        return _jsonResponse({'places': []}, 200);
      });
      final service = TransitPlacesService(
        client: client,
        baseUrl: '$_baseUrl/',
      );
      await service.autocomplete('x');
      expect(
        captured.toString(),
        startsWith('$_baseUrl/api/v1/places/suggest'),
      );
    });
  });
}
