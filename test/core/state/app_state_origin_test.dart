import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/models/route_plan.dart';
import 'package:aruku/core/models/time_value.dart';
import 'package:aruku/core/services/cancellation.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/route_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('AppState origin fields', () {
    test('initial state では origin と originLatLng が null', () {
      expect(AppState.initial.origin, isNull);
      expect(AppState.initial.originLatLng, isNull);
    });

    test('copyWith で origin を設定できる', () {
      final s = AppState.initial.copyWith(
        origin: '東京駅',
        originLatLng: const GeoPoint(35.681, 139.766),
      );
      expect(s.origin, '東京駅');
      expect(s.originLatLng, const GeoPoint(35.681, 139.766));
    });

    test('copyWith で origin を null にクリアできる', () {
      final s = AppState.initial
          .copyWith(
            origin: '東京駅',
            originLatLng: const GeoPoint(35.681, 139.766),
          )
          .copyWith(origin: null, originLatLng: null);
      expect(s.origin, isNull);
      expect(s.originLatLng, isNull);
    });
  });

  group('AppState.departureLabelText with origin', () {
    test('origin が設定されていればその名前を返す', () {
      final s = AppState.initial.copyWith(
        origin: '東京駅',
        locationState: const LocationAvailable(GeoPoint(35.68, 139.76)),
      );
      expect(s.departureLabelText, '東京駅');
    });

    test('origin が null のとき LocationAvailable なら「現在地」', () {
      final s = AppState.initial.copyWith(
        locationState: const LocationAvailable(GeoPoint(35.68, 139.76)),
      );
      expect(s.departureLabelText, '現在地');
    });

    test('origin が null のとき LocationLoading なら「現在地 · 取得中...」', () {
      expect(
        AppState.initial
            .copyWith(locationState: const LocationLoading())
            .departureLabelText,
        '現在地 · 取得中...',
      );
    });

    test('origin が null のとき LocationDenied なら「位置情報なし」', () {
      expect(
        AppState.initial
            .copyWith(locationState: const LocationDenied())
            .departureLabelText,
        '位置情報なし',
      );
    });
  });

  group('AppState.departureNameForRoute', () {
    test('origin が設定されていればその名前を返す', () {
      final s = AppState.initial.copyWith(
        origin: '東京駅',
        locationState: const LocationLoading(),
      );
      expect(s.departureNameForRoute, '東京駅');
    });

    test('origin が null のとき LocationAvailable なら「現在地」', () {
      final s = AppState.initial.copyWith(
        locationState: const LocationAvailable(GeoPoint(35.68, 139.76)),
      );
      expect(s.departureNameForRoute, '現在地');
    });

    test('origin が null のとき LocationLoading なら null（過渡値は渡さない）', () {
      final s = AppState.initial.copyWith(
        locationState: const LocationLoading(),
      );
      expect(s.departureNameForRoute, isNull);
    });

    test('origin が null のとき LocationDenied なら null（過渡値は渡さない）', () {
      final s = AppState.initial.copyWith(
        locationState: const LocationDenied(),
      );
      expect(s.departureNameForRoute, isNull);
    });
  });

  group('AppNotifier.setOrigin()', () {
    test('setOrigin で origin と originLatLng が設定される', () {
      final container = _makeContainer();
      container
          .read(appStateProvider.notifier)
          .setOrigin('新宿駅', latLng: const GeoPoint(35.689, 139.700));
      final s = container.read(appStateProvider);
      expect(s.origin, '新宿駅');
      expect(s.originLatLng, const GeoPoint(35.689, 139.700));
    });

    test('setOrigin(null) で現在地に戻る', () {
      final container = _makeContainer();
      final notifier = container.read(appStateProvider.notifier);
      notifier.setOrigin('新宿駅', latLng: const GeoPoint(35.689, 139.700));
      notifier.setOrigin(null);
      final s = container.read(appStateProvider);
      expect(s.origin, isNull);
      expect(s.originLatLng, isNull);
    });
  });

  group('AppNotifier.startSearch() の originLatLng 優先', () {
    test('originLatLng が設定されているとき GPS より優先して plan() に渡される', () async {
      final service = _CapturingRouteService();
      final container = ProviderContainer(
        overrides: [routeServiceProvider.overrideWithValue(service)],
      );
      addTearDown(container.dispose);

      container
          .read(appStateProvider.notifier)
          .setOrigin('新宿駅', latLng: const GeoPoint(35.689, 139.700));
      await container.read(appStateProvider.notifier).startSearch();

      expect(service.capturedOrigin, const GeoPoint(35.689, 139.700));
      // 手動出発地は出発ノード表示名として plan() に渡る
      expect(service.capturedOriginName, '新宿駅');
    });

    test('GPS 現在地利用時は originName に「現在地」を渡す', () async {
      final routeSvc = _CapturingRouteService();
      const locationSvc = _FakeLocationService(
        LocationAvailable(GeoPoint(35.681, 139.766)),
      );
      final container = ProviderContainer(
        overrides: [
          routeServiceProvider.overrideWithValue(routeSvc),
          locationServiceProvider.overrideWithValue(locationSvc),
        ],
      );
      addTearDown(container.dispose);

      final notifier = container.read(appStateProvider.notifier);
      await Future<void>.delayed(Duration.zero);
      await notifier.startSearch();

      expect(routeSvc.capturedOriginName, '現在地');
    });

    test('originLatLng が null のとき GPS 位置を使う', () async {
      final routeSvc = _CapturingRouteService();
      const locationSvc = _FakeLocationService(
        LocationAvailable(GeoPoint(35.681, 139.766)),
      );
      final container = ProviderContainer(
        overrides: [
          routeServiceProvider.overrideWithValue(routeSvc),
          locationServiceProvider.overrideWithValue(locationSvc),
        ],
      );
      addTearDown(container.dispose);

      // build() を起動して _fetchLocation() を開始させてから完了を待つ
      final notifier = container.read(appStateProvider.notifier);
      await Future<void>.delayed(Duration.zero);
      await notifier.startSearch();

      expect(routeSvc.capturedOrigin, const GeoPoint(35.681, 139.766));
    });
  });
}

const _dummyPlan = RoutePlan(
  from: 'A',
  to: 'B',
  totalKm: 1,
  totalMin: 10,
  budgetMin: 10,
  kcal: 50,
  walkKm: 1,
  walkRatio: 1,
  segments: [],
  timelineNodes: [],
);

class _FakeLocationService implements LocationService {
  const _FakeLocationService(this.result);
  final LocationState result;

  @override
  Future<LocationState> request() async => result;
}

class _CapturingRouteService implements RouteService {
  GeoPoint? capturedOrigin;
  String? capturedOriginName;

  @override
  Future<RoutePlan> plan({
    required String? destination,
    required GeoPoint? destinationLatLng,
    required TimeValue departure,
    required TimeValue arrival,
    GeoPoint? origin,
    String? originName,
    void Function(RoutePhase)? onProgress,
    CancellationToken? cancellation,
  }) async {
    capturedOrigin = origin;
    capturedOriginName = originName;
    return _dummyPlan;
  }
}

ProviderContainer _makeContainer() {
  return ProviderContainer();
}
