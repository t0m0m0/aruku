import 'dart:convert';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/services/places_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

http.Response _jsonResponse(Object body, int status) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status);

void main() {
  group('GooglePlacesService.autocomplete', () {
    test('OK レスポンスで PlacePrediction リストを返す', () async {
      final client = MockClient((request) async {
        expect(request.url.path, contains('autocomplete'));
        return _jsonResponse({
          'status': 'OK',
          'predictions': [
            {
              'place_id': 'id_shibuya',
              'description': '渋谷駅, 東京都渋谷区',
              'terms': [
                {'value': '渋谷駅'},
                {'value': '東京都渋谷区'},
              ],
            },
          ],
        }, 200);
      });

      final service = GooglePlacesService(client: client, apiKey: 'test_key');
      final results = await service.autocomplete('渋谷');

      expect(results, hasLength(1));
      expect(results.first.placeId, 'id_shibuya');
      expect(results.first.name, '渋谷駅');
    });

    test('ZERO_RESULTS で空リストを返す', () async {
      final client = MockClient(
        (_) async =>
            _jsonResponse({'status': 'ZERO_RESULTS', 'predictions': []}, 200),
      );

      final service = GooglePlacesService(client: client, apiKey: 'test_key');
      final results = await service.autocomplete('xyzxyz');

      expect(results, isEmpty);
    });

    test('API エラーステータスで PlacesException をスローする', () async {
      final client = MockClient(
        (_) async =>
            _jsonResponse({'status': 'REQUEST_DENIED', 'predictions': []}, 200),
      );

      final service = GooglePlacesService(client: client, apiKey: 'test_key');
      expect(
        () => service.autocomplete('test'),
        throwsA(isA<PlacesException>()),
      );
    });

    test('HTTP 500 で PlacesException をスローする', () async {
      final client = MockClient(
        (_) async => http.Response('Internal Server Error', 500),
      );

      final service = GooglePlacesService(client: client, apiKey: 'test_key');
      expect(
        () => service.autocomplete('test'),
        throwsA(isA<PlacesException>()),
      );
    });
  });

  group('GooglePlacesService.fetchLatLng', () {
    test('OK レスポンスで GeoPoint を返す', () async {
      final client = MockClient((request) async {
        expect(request.url.path, contains('details'));
        return _jsonResponse({
          'status': 'OK',
          'result': {
            'geometry': {
              'location': {'lat': 35.658, 'lng': 139.701},
            },
          },
        }, 200);
      });

      final service = GooglePlacesService(client: client, apiKey: 'test_key');
      final point = await service.fetchLatLng('id_shibuya');

      expect(point, isNotNull);
      expect(point, equals(const GeoPoint(35.658, 139.701)));
    });

    test('status が OK 以外のとき null を返す', () async {
      final client = MockClient(
        (_) async => _jsonResponse({'status': 'NOT_FOUND', 'result': {}}, 200),
      );

      final service = GooglePlacesService(client: client, apiKey: 'test_key');
      final point = await service.fetchLatLng('bad_id');
      expect(point, isNull);
    });

    test('HTTP エラーのとき null を返す', () async {
      final client = MockClient((_) async => http.Response('error', 500));

      final service = GooglePlacesService(client: client, apiKey: 'test_key');
      final point = await service.fetchLatLng('id');
      expect(point, isNull);
    });
  });
}
