import 'package:aruku/core/models/place_prediction.dart';
import 'package:aruku/core/services/places_service.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/features/search/places_provider.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakePlacesService implements PlacesService {
  _FakePlacesService(this._predictions);
  final List<PlacePrediction> _predictions;

  @override
  Future<List<PlacePrediction>> autocomplete(String query) async =>
      _predictions;

  @override
  Future<GeoPoint?> fetchLatLng(String placeId) async =>
      const GeoPoint(35.0, 139.0);
}

class _ErrorPlacesService implements PlacesService {
  @override
  Future<List<PlacePrediction>> autocomplete(String query) =>
      Future.error(const PlacesException('REQUEST_DENIED'));

  @override
  Future<GeoPoint?> fetchLatLng(String placeId) async => null;
}

ProviderContainer _makeContainer(PlacesService service) {
  return ProviderContainer(
    overrides: [placesServiceProvider.overrideWithValue(service)],
  );
}

void main() {
  group('PlacesNotifier', () {
    test('初期状態は idle', () {
      final container = _makeContainer(_FakePlacesService([]));
      addTearDown(container.dispose);
      expect(container.read(placesProvider).status, SearchStatus.idle);
    });

    test('空文字で search すると idle にリセットされる', () {
      final container = _makeContainer(_FakePlacesService([]));
      addTearDown(container.dispose);

      container.read(placesProvider.notifier).search('渋谷');
      container.read(placesProvider.notifier).search('');
      expect(container.read(placesProvider).status, SearchStatus.idle);
    });

    test('デバウンス後に候補が取得されて success になる', () async {
      const predictions = [
        PlacePrediction(placeId: 'id1', name: '渋谷駅', address: '東京都渋谷区'),
      ];
      final container = _makeContainer(_FakePlacesService(predictions));
      addTearDown(container.dispose);

      container.read(placesProvider.notifier).search('渋谷');
      expect(container.read(placesProvider).status, SearchStatus.loading);

      // デバウンス (400ms) + 非同期完了を待つ
      await Future<void>.delayed(const Duration(milliseconds: 500));

      final state = container.read(placesProvider);
      expect(state.status, SearchStatus.success);
      expect(state.suggestions, predictions);
    });

    test('PlacesException のとき error 状態になる', () async {
      final container = _makeContainer(_ErrorPlacesService());
      addTearDown(container.dispose);

      container.read(placesProvider.notifier).search('渋谷');
      await Future<void>.delayed(const Duration(milliseconds: 500));

      final state = container.read(placesProvider);
      expect(state.status, SearchStatus.error);
      expect(state.errorMessage, isNotNull);
    });

    test('連続入力でデバウンスがキャンセルされ最後の値のみ取得される', () async {
      var callCount = 0;
      final service = _CountingService(() {
        callCount++;
        return [];
      });
      final container = _makeContainer(service);
      addTearDown(container.dispose);

      // 素早く 3 回入力
      container.read(placesProvider.notifier).search('a');
      container.read(placesProvider.notifier).search('ab');
      container.read(placesProvider.notifier).search('abc');

      await Future<void>.delayed(const Duration(milliseconds: 500));
      expect(callCount, 1); // 最後の 1 回のみ API コール
    });
  });
}

class _CountingService implements PlacesService {
  _CountingService(this._onCall);
  final List<PlacePrediction> Function() _onCall;

  @override
  Future<List<PlacePrediction>> autocomplete(String query) async => _onCall();

  @override
  Future<GeoPoint?> fetchLatLng(String placeId) async => null;
}
