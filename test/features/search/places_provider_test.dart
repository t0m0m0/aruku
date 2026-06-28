import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/place_prediction.dart';
import 'package:aruku/core/services/places_service.dart';
import 'package:aruku/core/services/reverse_geocoding_service.dart';
import 'package:aruku/features/search/places_provider.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakePlacesService implements PlacesService {
  _FakePlacesService(this._predictions);
  final List<PlacePrediction> _predictions;

  @override
  Future<List<PlacePrediction>> autocomplete(String query) async =>
      _predictions;
}

class _ErrorPlacesService implements PlacesService {
  @override
  Future<List<PlacePrediction>> autocomplete(String query) =>
      Future.error(const PlacesException('REQUEST_DENIED'));
}

/// 座標→ラベルを固定で返し、呼び出し座標を記録するフェイク。
class _FakeReverseGeocodingService implements ReverseGeocodingService {
  _FakeReverseGeocodingService(this._byLat);
  final Map<double, AreaLabel> _byLat;
  final calls = <GeoPoint>[];

  @override
  Future<AreaLabel?> areaForCoord(GeoPoint point) async {
    calls.add(point);
    return _byLat[point.lat];
  }
}

ProviderContainer _makeContainer(
  PlacesService service, {
  ReverseGeocodingService? reverse,
  GeoPoint? location,
}) {
  return ProviderContainer(
    overrides: [
      placesServiceProvider.overrideWithValue(service),
      reverseGeocodingServiceProvider.overrideWithValue(reverse),
      currentLocationProvider.overrideWithValue(location),
    ],
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

    test('デバウンス後に候補が取得されて success になる', () {
      const predictions = [
        PlacePrediction(placeId: 'id1', name: '渋谷駅', address: '東京都渋谷区'),
      ];
      final container = _makeContainer(_FakePlacesService(predictions));
      addTearDown(container.dispose);

      fakeAsync((fake) {
        container.read(placesProvider.notifier).search('渋谷');
        expect(container.read(placesProvider).status, SearchStatus.loading);

        // デバウンス (400ms) を経過させ、非同期処理をフラッシュ
        fake.elapse(const Duration(milliseconds: 500));
        fake.flushMicrotasks();

        final state = container.read(placesProvider);
        expect(state.status, SearchStatus.success);
        expect(state.suggestions, predictions);
      });
    });

    test('PlacesException のとき error 状態になる', () {
      final container = _makeContainer(_ErrorPlacesService());
      addTearDown(container.dispose);

      fakeAsync((fake) {
        container.read(placesProvider.notifier).search('渋谷');
        fake.elapse(const Duration(milliseconds: 500));
        fake.flushMicrotasks();

        final state = container.read(placesProvider);
        expect(state.status, SearchStatus.error);
        expect(state.errorMessage, isNotNull);
      });
    });

    test('同名衝突した候補にだけ逆ジオで県＋市区町村が付く', () {
      const predictions = [
        PlacePrediction(
          placeId: 'mac-nagano',
          name: 'マクドナルド',
          address: '施設',
          latLng: GeoPoint(36.41, 138.26),
        ),
        PlacePrediction(
          placeId: 'mac-tokyo',
          name: 'マクドナルド',
          address: '施設',
          latLng: GeoPoint(35.68, 139.76),
        ),
        PlacePrediction(
          placeId: 'tokyo-tower',
          name: '東京タワー',
          address: '施設',
          latLng: GeoPoint(35.65, 139.74),
        ),
      ];
      final reverse = _FakeReverseGeocodingService({
        36.41: const AreaLabel(pref: '長野県', city: '上田市'),
        35.68: const AreaLabel(pref: '東京都', city: '港区'),
      });
      final container = _makeContainer(
        _FakePlacesService(predictions),
        reverse: reverse,
      );
      addTearDown(container.dispose);

      fakeAsync((fake) {
        container.read(placesProvider.notifier).search('マクドナルド');
        fake.elapse(const Duration(milliseconds: 500));
        fake.flushMicrotasks();

        final suggestions = container.read(placesProvider).suggestions;
        final byId = {for (final s in suggestions) s.placeId: s};
        expect(byId['mac-nagano']!.areaLabel, '長野県上田市');
        expect(byId['mac-tokyo']!.areaLabel, '東京都港区');
        expect(byId['tokyo-tower']!.areaLabel, isNull, reason: '衝突しない候補は補完しない');
        expect(
          reverse.calls.map((p) => p.lat),
          unorderedEquals([36.41, 35.68]),
          reason: '衝突した2件だけ逆引きする',
        );
      });
    });

    test('衝突が無ければ逆ジオを一切呼ばない', () {
      const predictions = [
        PlacePrediction(
          placeId: 'a',
          name: '渋谷駅',
          address: '東京都渋谷区',
          latLng: GeoPoint(35.65, 139.70),
        ),
        PlacePrediction(
          placeId: 'b',
          name: '新宿駅',
          address: '東京都新宿区',
          latLng: GeoPoint(35.69, 139.70),
        ),
      ];
      final reverse = _FakeReverseGeocodingService({});
      final container = _makeContainer(
        _FakePlacesService(predictions),
        reverse: reverse,
      );
      addTearDown(container.dispose);

      fakeAsync((fake) {
        container.read(placesProvider.notifier).search('駅');
        fake.elapse(const Duration(milliseconds: 500));
        fake.flushMicrotasks();

        expect(reverse.calls, isEmpty, reason: '同名衝突が無いので逆ジオしない');
        expect(
          container
              .read(placesProvider)
              .suggestions
              .every((s) => s.areaLabel == null),
          isTrue,
        );
      });
    });

    test('逆ジオ Service が無くても（表ロード失敗）クラッシュせず候補を返す', () {
      const predictions = [
        PlacePrediction(
          placeId: 'mac-1',
          name: 'マクドナルド',
          address: '施設',
          latLng: GeoPoint(36.41, 138.26),
        ),
        PlacePrediction(
          placeId: 'mac-2',
          name: 'マクドナルド',
          address: '施設',
          latLng: GeoPoint(35.68, 139.76),
        ),
      ];
      final container = _makeContainer(_FakePlacesService(predictions));
      addTearDown(container.dispose);

      fakeAsync((fake) {
        container.read(placesProvider.notifier).search('マクドナルド');
        fake.elapse(const Duration(milliseconds: 500));
        fake.flushMicrotasks();

        final state = container.read(placesProvider);
        expect(state.status, SearchStatus.success);
        expect(state.suggestions, hasLength(2));
        expect(state.suggestions.every((s) => s.areaLabel == null), isTrue);
      });
    });

    test('同名衝突グループは現在地に近い順に並ぶ', () {
      // 受信順は遠い→近いだが、現在地(東京駅付近)に近い順へ並べ替える。
      const predictions = [
        PlacePrediction(
          placeId: 'far',
          name: 'マクドナルド',
          address: '施設',
          latLng: GeoPoint(36.41, 138.26), // 長野（遠い）
        ),
        PlacePrediction(
          placeId: 'near',
          name: 'マクドナルド',
          address: '施設',
          latLng: GeoPoint(35.6815, 139.7660), // 東京駅すぐ（近い）
        ),
        PlacePrediction(
          placeId: 'mid',
          name: 'マクドナルド',
          address: '施設',
          latLng: GeoPoint(35.69, 139.70), // 新宿あたり（中間）
        ),
      ];
      final container = _makeContainer(
        _FakePlacesService(predictions),
        location: const GeoPoint(35.6812, 139.7671), // 東京駅
      );
      addTearDown(container.dispose);

      fakeAsync((fake) {
        container.read(placesProvider.notifier).search('マクドナルド');
        fake.elapse(const Duration(milliseconds: 500));
        fake.flushMicrotasks();

        final ids = container
            .read(placesProvider)
            .suggestions
            .map((s) => s.placeId)
            .toList();
        expect(ids, ['near', 'mid', 'far']);
      });
    });

    test('現在地が無ければ並び替えない', () {
      const predictions = [
        PlacePrediction(
          placeId: 'far',
          name: 'マクドナルド',
          address: '施設',
          latLng: GeoPoint(36.41, 138.26),
        ),
        PlacePrediction(
          placeId: 'near',
          name: 'マクドナルド',
          address: '施設',
          latLng: GeoPoint(35.6815, 139.7660),
        ),
      ];
      final container = _makeContainer(_FakePlacesService(predictions));
      addTearDown(container.dispose);

      fakeAsync((fake) {
        container.read(placesProvider.notifier).search('マクドナルド');
        fake.elapse(const Duration(milliseconds: 500));
        fake.flushMicrotasks();

        final ids = container
            .read(placesProvider)
            .suggestions
            .map((s) => s.placeId)
            .toList();
        expect(ids, ['far', 'near'], reason: '現在地不明なら受信順を維持');
      });
    });

    test('衝突しない候補は現在地があっても順序を保つ', () {
      const predictions = [
        PlacePrediction(
          placeId: 'a',
          name: '渋谷駅',
          address: '東京都渋谷区',
          latLng: GeoPoint(36.41, 138.26), // 遠い
        ),
        PlacePrediction(
          placeId: 'b',
          name: '新宿駅',
          address: '東京都新宿区',
          latLng: GeoPoint(35.6815, 139.7660), // 近い
        ),
      ];
      final container = _makeContainer(
        _FakePlacesService(predictions),
        location: const GeoPoint(35.6812, 139.7671),
      );
      addTearDown(container.dispose);

      fakeAsync((fake) {
        container.read(placesProvider.notifier).search('駅');
        fake.elapse(const Duration(milliseconds: 500));
        fake.flushMicrotasks();

        final ids = container
            .read(placesProvider)
            .suggestions
            .map((s) => s.placeId)
            .toList();
        expect(ids, ['a', 'b'], reason: '同名衝突していない候補は距離で並べ替えない');
      });
    });

    test('連続入力でデバウンスがキャンセルされ最後の値のみ取得される', () {
      var callCount = 0;
      final service = _CountingService(() {
        callCount++;
        return [];
      });
      final container = _makeContainer(service);
      addTearDown(container.dispose);

      fakeAsync((fake) {
        // 素早く 3 回入力
        container.read(placesProvider.notifier).search('a');
        container.read(placesProvider.notifier).search('ab');
        container.read(placesProvider.notifier).search('abc');

        fake.elapse(const Duration(milliseconds: 500));
        fake.flushMicrotasks();

        expect(callCount, 1); // 最後の 1 回のみ API コール
      });
    });
  });
}

class _CountingService implements PlacesService {
  _CountingService(this._onCall);
  final List<PlacePrediction> Function() _onCall;

  @override
  Future<List<PlacePrediction>> autocomplete(String query) async => _onCall();
}
