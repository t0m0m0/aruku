import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/models/place_prediction.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/places_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/search/places_provider.dart';
import 'package:aruku/features/search/search_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

class _FakeLocationService implements LocationService {
  const _FakeLocationService(this.result);
  final LocationState result;

  @override
  Future<LocationState> request() async => result;

  @override
  Stream<GeoPoint> positionStream() => const Stream.empty();
}

/// autocomplete は座標なし候補、nearbySearch は座標同梱候補を返す。
/// fetchLatLng / nearbySearch の呼び出し回数を記録する。
class _RecordingPlacesService implements PlacesService {
  int autocompleteCalls = 0;
  int nearbyCalls = 0;
  int fetchCalls = 0;

  @override
  Future<List<PlacePrediction>> autocomplete(
    String query, {
    GeoPoint? bias,
  }) async {
    autocompleteCalls++;
    return const [
      PlacePrediction(placeId: 'auto_1', name: 'オートコンプリート候補', address: '住所'),
    ];
  }

  @override
  Future<List<PlacePrediction>> nearbySearch(
    String query, {
    required GeoPoint bias,
  }) async {
    nearbyCalls++;
    return const [
      PlacePrediction(
        placeId: 'near_1',
        name: 'マクドナルド店',
        address: '東京都千代田区',
        latLng: GeoPoint(35.681, 139.767),
      ),
    ];
  }

  @override
  Future<GeoPoint?> fetchLatLng(String placeId) async {
    fetchCalls++;
    return const GeoPoint(35.0, 139.0);
  }
}

Widget _wrap(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(theme: ArukuTheme.light(), home: const SearchScreen()),
);

Future<ProviderContainer> _makeContainer(
  WidgetTester tester,
  PlacesService places, {
  GeoPoint? location = const GeoPoint(35.66, 139.7),
}) async {
  final container = ProviderContainer(
    overrides: [
      locationServiceProvider.overrideWithValue(
        const _FakeLocationService(LocationAvailable(GeoPoint(35.0, 139.0))),
      ),
      placesServiceProvider.overrideWithValue(places),
      currentLocationProvider.overrideWithValue(location),
    ],
  );
  container.read(appStateProvider.notifier);
  await tester.runAsync(() => Future<void>.delayed(Duration.zero));
  return container;
}

void main() {
  group('SearchScreen 近くの店トグル', () {
    testWidgets('現在地ありのときトグルを表示する', (tester) async {
      final container = await _makeContainer(tester, _RecordingPlacesService());
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      expect(find.byKey(const ValueKey('nearby-toggle')), findsOneWidget);
      expect(find.text('近くの店'), findsOneWidget);
    });

    testWidgets('現在地が無いときトグルを表示しない', (tester) async {
      final container = await _makeContainer(
        tester,
        _RecordingPlacesService(),
        location: null,
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      expect(find.byKey(const ValueKey('nearby-toggle')), findsNothing);
    });

    testWidgets('トグル ON で検索すると nearbySearch を使う', (tester) async {
      final places = _RecordingPlacesService();
      final container = await _makeContainer(tester, places);
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      await tester.tap(find.byKey(const ValueKey('nearby-toggle')));
      await tester.pump();

      await tester.enterText(find.byType(TextField), 'zz');
      await tester.pump(const Duration(milliseconds: 450)); // debounce
      await tester.pump(); // nearbySearch 完了

      expect(places.nearbyCalls, greaterThan(0));
      expect(places.autocompleteCalls, 0);
      expect(find.text('マクドナルド店'), findsOneWidget);
    });

    testWidgets('近くの店候補は座標同梱のため確定時に details を呼ばない', (tester) async {
      final places = _RecordingPlacesService();
      final container = await _makeContainer(tester, places);
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      await tester.tap(find.byKey(const ValueKey('nearby-toggle')));
      await tester.pump();

      await tester.enterText(find.byType(TextField), 'zz');
      await tester.pump(const Duration(milliseconds: 450));
      await tester.pump();

      await tester.tap(find.text('マクドナルド店'));
      await tester.pump();
      await tester.pump();

      final state = container.read(appStateProvider);
      expect(places.fetchCalls, 0, reason: '同梱座標を使い details は呼ばない');
      expect(state.destination, 'マクドナルド店');
      expect(state.destinationLatLng, const GeoPoint(35.681, 139.767));
      expect(state.screen, Screen.home);
    });
  });
}
