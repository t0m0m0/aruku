import 'dart:convert';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/services/reverse_geocoding_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

const _baseUrl = 'https://gsi.example.com/reverse-geocoder/LonLatToAddress';

const _muniTable = <String, AreaLabel>{
  '20203': AreaLabel(pref: '長野県', city: '上田市'),
  '1101': AreaLabel(pref: '北海道', city: '札幌市中央区'),
};

http.Response _jsonResponse(Object body) =>
    http.Response.bytes(utf8.encode(jsonEncode(body)), 200);

void main() {
  group('GsiReverseGeocodingService.areaForCoord', () {
    test('muniCd を県名＋市区町村名へ変換して返す', () async {
      late Uri captured;
      final client = MockClient((request) async {
        captured = request.url;
        return _jsonResponse({
          'results': {'muniCd': '20203', 'lv01Nm': '上田'},
        });
      });
      final service = GsiReverseGeocodingService(
        muniTable: _muniTable,
        client: client,
        baseUrl: _baseUrl,
      );

      final area = await service.areaForCoord(
        const GeoPoint(36.4130261, 138.2607893),
      );

      expect(area, const AreaLabel(pref: '長野県', city: '上田市'));
      expect(area!.full, '長野県上田市');
      expect(captured.queryParameters['lat'], '36.4130261');
      expect(captured.queryParameters['lon'], '138.2607893');
    });

    test('未知の muniCd は null を返す', () async {
      final client = MockClient(
        (_) async => _jsonResponse({
          'results': {'muniCd': '99999', 'lv01Nm': '謎'},
        }),
      );
      final service = GsiReverseGeocodingService(
        muniTable: _muniTable,
        client: client,
        baseUrl: _baseUrl,
      );

      expect(await service.areaForCoord(const GeoPoint(1, 1)), isNull);
    });

    test('results が無い応答（海上など）は null を返す', () async {
      final client = MockClient((_) async => _jsonResponse(const {}));
      final service = GsiReverseGeocodingService(
        muniTable: _muniTable,
        client: client,
        baseUrl: _baseUrl,
      );

      expect(await service.areaForCoord(const GeoPoint(0, 0)), isNull);
    });

    test('HTTP エラーでも例外を投げず null を返す', () async {
      final client = MockClient((_) async => http.Response('boom', 500));
      final service = GsiReverseGeocodingService(
        muniTable: _muniTable,
        client: client,
        baseUrl: _baseUrl,
      );

      expect(await service.areaForCoord(const GeoPoint(1, 1)), isNull);
    });

    test('ネットワーク例外でも null を返す', () async {
      final client = MockClient((_) async => throw Exception('offline'));
      final service = GsiReverseGeocodingService(
        muniTable: _muniTable,
        client: client,
        baseUrl: _baseUrl,
      );

      expect(await service.areaForCoord(const GeoPoint(1, 1)), isNull);
    });

    test('同一座標の2回目はキャッシュを使いネットワークを叩かない', () async {
      var calls = 0;
      final client = MockClient((_) async {
        calls++;
        return _jsonResponse({
          'results': {'muniCd': '20203'},
        });
      });
      final service = GsiReverseGeocodingService(
        muniTable: _muniTable,
        client: client,
        baseUrl: _baseUrl,
      );

      const p = GeoPoint(36.4130261, 138.2607893);
      final first = await service.areaForCoord(p);
      final second = await service.areaForCoord(p);

      expect(first, const AreaLabel(pref: '長野県', city: '上田市'));
      expect(second, first);
      expect(calls, 1, reason: '4桁丸めキーでキャッシュし2回目は叩かない');
    });

    test('小数5桁目だけ違う座標は同じキャッシュにヒットする', () async {
      var calls = 0;
      final client = MockClient((_) async {
        calls++;
        return _jsonResponse({
          'results': {'muniCd': '20203'},
        });
      });
      final service = GsiReverseGeocodingService(
        muniTable: _muniTable,
        client: client,
        baseUrl: _baseUrl,
      );

      await service.areaForCoord(const GeoPoint(36.41302, 138.26078));
      await service.areaForCoord(const GeoPoint(36.41304, 138.26076));

      expect(calls, 1, reason: '4桁（≒10m）丸めで同一地点とみなす');
    });

    test('HTTP エラーはキャッシュせず再試行できる', () async {
      var fail = true;
      var calls = 0;
      final client = MockClient((_) async {
        calls++;
        if (fail) return http.Response('boom', 500);
        return _jsonResponse({
          'results': {'muniCd': '20203'},
        });
      });
      final service = GsiReverseGeocodingService(
        muniTable: _muniTable,
        client: client,
        baseUrl: _baseUrl,
      );

      const p = GeoPoint(36.4130261, 138.2607893);
      expect(await service.areaForCoord(p), isNull);
      fail = false;
      expect(await service.areaForCoord(p), isNotNull);
      expect(calls, 2, reason: '失敗は確定ではないのでキャッシュしない');
    });
  });
}
