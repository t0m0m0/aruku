import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/models/place_prediction.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/places_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/search/places_provider.dart';
import 'package:aruku/features/search/search_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
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

/// C案: autocomplete が distanceMeters 付き候補を返す（座標は持たない）。
/// fetchLatLng / autocomplete の呼び出し回数を記録する。
class _RecordingPlacesService implements PlacesService {
  int autocompleteCalls = 0;
  int fetchCalls = 0;

  @override
  Future<List<PlacePrediction>> autocomplete(
    String query, {
    GeoPoint? bias,
  }) async {
    autocompleteCalls++;
    // 関連度順では遠い店が先。距離で再ソートされると近い店が先に来るはず。
    return const [
      PlacePrediction(
        placeId: 'far',
        name: '遠いマクドナルド',
        address: '東京都A',
        distanceMeters: 1800,
      ),
      PlacePrediction(
        placeId: 'near',
        name: '近いマクドナルド',
        address: '東京都B',
        distanceMeters: 160,
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
  child: MaterialApp(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    theme: ArukuTheme.light(),
    home: const SearchScreen(),
  ),
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

    testWidgets('トグル ON で autocomplete を距離昇順に並べ替える（C案）', (tester) async {
      final places = _RecordingPlacesService();
      final container = await _makeContainer(tester, places);
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      await tester.tap(find.byKey(const ValueKey('nearby-toggle')));
      await tester.pump();

      await tester.enterText(find.byType(TextField), 'zz');
      await tester.pump(const Duration(milliseconds: 450)); // debounce
      await tester.pump(); // autocomplete 完了

      // Text Search は使わず autocomplete のまま。
      expect(places.autocompleteCalls, greaterThan(0));
      // 近い店が遠い店より上に並ぶ。
      final nearY = tester.getTopLeft(find.text('近いマクドナルド')).dy;
      final farY = tester.getTopLeft(find.text('遠いマクドナルド')).dy;
      expect(nearY, lessThan(farY));
    });

    testWidgets('C案候補は座標を持たないため確定時に details を呼ぶ', (tester) async {
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

      await tester.tap(find.text('近いマクドナルド'));
      await tester.pump();
      await tester.pump();

      final state = container.read(appStateProvider);
      // Autocomplete 由来は座標を持たないので details(fetchLatLng) で補う。
      expect(places.fetchCalls, greaterThan(0));
      expect(state.destination, '近いマクドナルド');
      expect(state.destinationLatLng, const GeoPoint(35.0, 139.0));
      expect(state.screen, Screen.home);
    });
  });
}
