import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/place_prediction.dart';
import 'package:aruku/core/services/places_service.dart';
import 'package:aruku/features/search/places_provider.dart';
import 'package:fake_async/fake_async.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakePlacesService implements PlacesService {
  _FakePlacesService(this._predictions, {List<PlacePrediction>? nearby})
    : _nearby = nearby ?? _predictions;
  final List<PlacePrediction> _predictions;
  final List<PlacePrediction> _nearby;

  /// 最後に autocomplete へ渡された位置バイアス。
  GeoPoint? lastBias;

  /// 最後に nearbySearch へ渡された位置バイアス。呼ばれなければ null のまま。
  GeoPoint? lastNearbyBias;
  int autocompleteCalls = 0;
  int nearbyCalls = 0;

  @override
  Future<List<PlacePrediction>> autocomplete(
    String query, {
    GeoPoint? bias,
  }) async {
    autocompleteCalls++;
    lastBias = bias;
    return _predictions;
  }

  @override
  Future<List<PlacePrediction>> nearbySearch(
    String query, {
    required GeoPoint bias,
  }) async {
    nearbyCalls++;
    lastNearbyBias = bias;
    return _nearby;
  }

  @override
  Future<GeoPoint?> fetchLatLng(String placeId) async =>
      const GeoPoint(35.0, 139.0);
}

class _ErrorPlacesService implements PlacesService {
  @override
  Future<List<PlacePrediction>> autocomplete(String query, {GeoPoint? bias}) =>
      Future.error(const PlacesException('REQUEST_DENIED'));

  @override
  Future<List<PlacePrediction>> nearbySearch(
    String query, {
    required GeoPoint bias,
  }) => Future.error(const PlacesException('REQUEST_DENIED'));

  @override
  Future<GeoPoint?> fetchLatLng(String placeId) async => null;
}

class _CountingService implements PlacesService {
  _CountingService(this._onCall);
  final List<PlacePrediction> Function() _onCall;

  @override
  Future<List<PlacePrediction>> autocomplete(
    String query, {
    GeoPoint? bias,
  }) async => _onCall();

  @override
  Future<List<PlacePrediction>> nearbySearch(
    String query, {
    required GeoPoint bias,
  }) async => _onCall();

  @override
  Future<GeoPoint?> fetchLatLng(String placeId) async => null;
}

ProviderContainer _makeContainer(PlacesService service, {GeoPoint? location}) {
  return ProviderContainer(
    overrides: [
      placesServiceProvider.overrideWithValue(service),
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

    test('現在地が分かるときは位置バイアスを autocomplete へ渡す', () {
      final service = _FakePlacesService(const [
        PlacePrediction(placeId: 'id1', name: 'マクドナルド', address: '東京都'),
      ]);
      final container = _makeContainer(
        service,
        location: const GeoPoint(35.66, 139.7),
      );
      addTearDown(container.dispose);

      fakeAsync((fake) {
        container.read(placesProvider.notifier).search('マクドナルド');
        fake.elapse(const Duration(milliseconds: 500));
        fake.flushMicrotasks();

        expect(service.lastBias, const GeoPoint(35.66, 139.7));
      });
    });

    test('現在地が無いときは位置バイアスを渡さない（null）', () {
      final service = _FakePlacesService(const []);
      final container = _makeContainer(service);
      addTearDown(container.dispose);

      fakeAsync((fake) {
        container.read(placesProvider.notifier).search('渋谷');
        fake.elapse(const Duration(milliseconds: 500));
        fake.flushMicrotasks();

        expect(service.lastBias, isNull);
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

    test('nearby ON は autocomplete 結果を距離昇順へ並べ替える（C案）', () {
      final service = _FakePlacesService(const [
        PlacePrediction(
          placeId: 'far',
          name: '遠い',
          address: '',
          distanceMeters: 1800,
        ),
        PlacePrediction(
          placeId: 'near',
          name: '近い',
          address: '',
          distanceMeters: 160,
        ),
        PlacePrediction(
          placeId: 'mid',
          name: '中',
          address: '',
          distanceMeters: 640,
        ),
      ]);
      final container = _makeContainer(
        service,
        location: const GeoPoint(35.66, 139.7),
      );
      addTearDown(container.dispose);

      fakeAsync((fake) {
        container.read(placesProvider.notifier).setNearby(true);
        container.read(placesProvider.notifier).search('店');
        fake.elapse(const Duration(milliseconds: 500));
        fake.flushMicrotasks();

        // Text Search は使わず autocomplete のまま、距離で再ソート。
        expect(service.autocompleteCalls, greaterThan(0));
        expect(service.nearbyCalls, 0);
        expect(
          container.read(placesProvider).suggestions.map((s) => s.placeId),
          ['near', 'mid', 'far'],
        );
      });
    });

    test('nearby OFF は並べ替えず関連度順のまま', () {
      final service = _FakePlacesService(const [
        PlacePrediction(
          placeId: 'far',
          name: '遠い',
          address: '',
          distanceMeters: 1800,
        ),
        PlacePrediction(
          placeId: 'near',
          name: '近い',
          address: '',
          distanceMeters: 160,
        ),
      ]);
      final container = _makeContainer(
        service,
        location: const GeoPoint(35.66, 139.7),
      );
      addTearDown(container.dispose);

      fakeAsync((fake) {
        container.read(placesProvider.notifier).search('店');
        fake.elapse(const Duration(milliseconds: 500));
        fake.flushMicrotasks();

        expect(
          container.read(placesProvider).suggestions.map((s) => s.placeId),
          ['far', 'near'],
        );
      });
    });

    test('距離不明の候補は末尾へ回す（元の順序保持）', () {
      final service = _FakePlacesService(const [
        PlacePrediction(
          placeId: 'near',
          name: '近い',
          address: '',
          distanceMeters: 160,
        ),
        PlacePrediction(placeId: 'unknown', name: '不明', address: ''),
        PlacePrediction(
          placeId: 'far',
          name: '遠い',
          address: '',
          distanceMeters: 1800,
        ),
      ]);
      final container = _makeContainer(
        service,
        location: const GeoPoint(35.66, 139.7),
      );
      addTearDown(container.dispose);

      fakeAsync((fake) {
        container.read(placesProvider.notifier).setNearby(true);
        container.read(placesProvider.notifier).search('店');
        fake.elapse(const Duration(milliseconds: 500));
        fake.flushMicrotasks();

        expect(
          container.read(placesProvider).suggestions.map((s) => s.placeId),
          ['near', 'far', 'unknown'],
        );
      });
    });

    test('nearby ON でも現在地が無ければ並べ替えない（関連度順）', () {
      final service = _FakePlacesService(const [
        PlacePrediction(
          placeId: 'far',
          name: '遠い',
          address: '',
          distanceMeters: 1800,
        ),
        PlacePrediction(
          placeId: 'near',
          name: '近い',
          address: '',
          distanceMeters: 160,
        ),
      ]);
      final container = _makeContainer(service); // location なし
      addTearDown(container.dispose);

      fakeAsync((fake) {
        container.read(placesProvider.notifier).setNearby(true);
        container.read(placesProvider.notifier).search('店');
        fake.elapse(const Duration(milliseconds: 500));
        fake.flushMicrotasks();

        expect(
          container.read(placesProvider).suggestions.map((s) => s.placeId),
          ['far', 'near'],
        );
      });
    });

    test('setNearby は現在のクエリで再検索して並びを切替える', () {
      final service = _FakePlacesService(const [
        PlacePrediction(
          placeId: 'far',
          name: '遠い',
          address: '',
          distanceMeters: 1800,
        ),
        PlacePrediction(
          placeId: 'near',
          name: '近い',
          address: '',
          distanceMeters: 160,
        ),
      ]);
      final container = _makeContainer(
        service,
        location: const GeoPoint(35.66, 139.7),
      );
      addTearDown(container.dispose);

      fakeAsync((fake) {
        container.read(placesProvider.notifier).search('店');
        fake.elapse(const Duration(milliseconds: 500));
        fake.flushMicrotasks();
        // OFF: 関連度順のまま。
        expect(container.read(placesProvider).suggestions.first.placeId, 'far');

        // トグル ON で同じクエリのまま距離昇順へ。
        container.read(placesProvider.notifier).setNearby(true);
        fake.elapse(const Duration(milliseconds: 500));
        fake.flushMicrotasks();

        expect(container.read(placesProvider).nearby, isTrue);
        expect(
          container.read(placesProvider).suggestions.first.placeId,
          'near',
        );
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
