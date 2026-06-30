import 'dart:convert';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/services/places_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _proxyBaseUrl = 'https://proxy.example.com';

http.Response _jsonResponse(Object body, int status) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), status);

void main() {
  group('GooglePlacesService.autocomplete', () {
    test('プロキシの placesProxy エンドポイントを呼び出す', () async {
      final client = MockClient((request) async {
        expect(
          request.url.toString(),
          startsWith('$_proxyBaseUrl/placesProxy'),
        );
        expect(request.url.queryParameters['action'], 'autocomplete');
        expect(request.url.queryParameters['input'], '渋谷');
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

      final service = GooglePlacesService(
        client: client,
        proxyBaseUrl: _proxyBaseUrl,
      );
      final results = await service.autocomplete('渋谷');

      expect(results, hasLength(1));
      expect(results.first.placeId, 'id_shibuya');
      expect(results.first.name, '渋谷駅');
    });

    test('bias を渡すと現在地を lat/lon クエリとして付与する（位置バイアス）', () async {
      late Uri captured;
      final client = MockClient((request) async {
        captured = request.url;
        return _jsonResponse({
          'status': 'ZERO_RESULTS',
          'predictions': [],
        }, 200);
      });

      final service = GooglePlacesService(
        client: client,
        proxyBaseUrl: _proxyBaseUrl,
      );
      await service.autocomplete('マクドナルド', bias: const GeoPoint(35.66, 139.7));

      expect(captured.queryParameters['lat'], '35.66');
      expect(captured.queryParameters['lon'], '139.7');
    });

    test('bias が無いときは lat/lon を付与しない', () async {
      late Uri captured;
      final client = MockClient((request) async {
        captured = request.url;
        return _jsonResponse({
          'status': 'ZERO_RESULTS',
          'predictions': [],
        }, 200);
      });

      final service = GooglePlacesService(
        client: client,
        proxyBaseUrl: _proxyBaseUrl,
      );
      await service.autocomplete('渋谷');

      expect(captured.queryParameters.containsKey('lat'), isFalse);
      expect(captured.queryParameters.containsKey('lon'), isFalse);
    });

    test(
      'distance_meters を PlacePrediction.distanceMeters に取り込む（C案）',
      () async {
        final client = MockClient(
          (_) async => _jsonResponse({
            'status': 'OK',
            'predictions': [
              {
                'place_id': 'id_a',
                'description': 'A店, 東京',
                'terms': [
                  {'value': 'A店'},
                ],
                'distance_meters': 1800,
              },
              {
                'place_id': 'id_b',
                'description': 'B店, 東京',
                'terms': [
                  {'value': 'B店'},
                ],
              },
            ],
          }, 200),
        );

        final service = GooglePlacesService(
          client: client,
          proxyBaseUrl: _proxyBaseUrl,
        );
        final results = await service.autocomplete('店');

        expect(results[0].distanceMeters, 1800);
        expect(results[1].distanceMeters, isNull);
      },
    );

    test('ZERO_RESULTS で空リストを返す', () async {
      final client = MockClient(
        (_) async =>
            _jsonResponse({'status': 'ZERO_RESULTS', 'predictions': []}, 200),
      );

      final service = GooglePlacesService(
        client: client,
        proxyBaseUrl: _proxyBaseUrl,
      );
      final results = await service.autocomplete('xyzxyz');

      expect(results, isEmpty);
    });

    test('API エラーステータスで PlacesException をスローする', () async {
      final client = MockClient(
        (_) async =>
            _jsonResponse({'status': 'REQUEST_DENIED', 'predictions': []}, 200),
      );

      final service = GooglePlacesService(
        client: client,
        proxyBaseUrl: _proxyBaseUrl,
      );
      expect(
        () => service.autocomplete('test'),
        throwsA(isA<PlacesException>()),
      );
    });

    test('HTTP 500 で PlacesException をスローする', () async {
      final client = MockClient(
        (_) async => http.Response('Internal Server Error', 500),
      );

      final service = GooglePlacesService(
        client: client,
        proxyBaseUrl: _proxyBaseUrl,
      );
      expect(
        () => service.autocomplete('test'),
        throwsA(isA<PlacesException>()),
      );
    });

    test('proxyBaseUrl が空のとき空リストを返す', () async {
      final client = MockClient((_) async => throw Exception('called'));

      final service = GooglePlacesService(client: client, proxyBaseUrl: '');
      final results = await service.autocomplete('渋谷');
      expect(results, isEmpty);
    });
  });

  group('GooglePlacesService.fetchLatLng', () {
    test('プロキシの placesProxy エンドポイントを呼び出す', () async {
      final client = MockClient((request) async {
        expect(
          request.url.toString(),
          startsWith('$_proxyBaseUrl/placesProxy'),
        );
        expect(request.url.queryParameters['action'], 'details');
        expect(request.url.queryParameters['place_id'], 'id_shibuya');
        return _jsonResponse({
          'status': 'OK',
          'result': {
            'geometry': {
              'location': {'lat': 35.658, 'lng': 139.701},
            },
          },
        }, 200);
      });

      final service = GooglePlacesService(
        client: client,
        proxyBaseUrl: _proxyBaseUrl,
      );
      final point = await service.fetchLatLng('id_shibuya');

      expect(point, isNotNull);
      expect(point, equals(const GeoPoint(35.658, 139.701)));
    });

    test('status が OK 以外のとき null を返す', () async {
      final client = MockClient(
        (_) async => _jsonResponse({'status': 'NOT_FOUND', 'result': {}}, 200),
      );

      final service = GooglePlacesService(
        client: client,
        proxyBaseUrl: _proxyBaseUrl,
      );
      final point = await service.fetchLatLng('bad_id');
      expect(point, isNull);
    });

    test('HTTP エラーのとき PlacesException をスローする', () async {
      final client = MockClient((_) async => http.Response('error', 500));

      final service = GooglePlacesService(
        client: client,
        proxyBaseUrl: _proxyBaseUrl,
      );
      expect(() => service.fetchLatLng('id'), throwsA(isA<PlacesException>()));
    });
  });
}
