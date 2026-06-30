import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/models/place_prediction.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/places_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
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

/// autocomplete は 1 件返すが fetchLatLng は座標を返さない（または例外）。
class _NoCoordPlacesService implements PlacesService {
  _NoCoordPlacesService({this.throwOnFetch = false});
  final bool throwOnFetch;

  @override
  Future<List<PlacePrediction>> autocomplete(
    String query, {
    GeoPoint? bias,
  }) async => const [
    PlacePrediction(placeId: 'p1', name: 'テスト目的地', address: '住所'),
  ];

  @override
  Future<List<PlacePrediction>> nearbySearch(
    String query, {
    required GeoPoint bias,
  }) async => const [];

  @override
  Future<GeoPoint?> fetchLatLng(String placeId) async {
    if (throwOnFetch) throw const PlacesException('NOT_FOUND');
    return null;
  }
}

Widget _wrap(
  ProviderContainer container, {
  SearchMode mode = SearchMode.destination,
}) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(
    theme: ArukuTheme.light(),
    home: SearchScreen(mode: mode),
  ),
);

Future<ProviderContainer> _makeContainer(
  WidgetTester tester,
  PlacesService places,
) async {
  final container = ProviderContainer(
    overrides: [
      locationServiceProvider.overrideWithValue(
        const _FakeLocationService(LocationAvailable(GeoPoint(35.0, 139.0))),
      ),
      placesServiceProvider.overrideWithValue(places),
    ],
  );
  container.read(appStateProvider.notifier);
  await tester.runAsync(() => Future<void>.delayed(Duration.zero));
  return container;
}

Future<void> _tapSuggestion(WidgetTester tester) async {
  // 候補名と一致しないクエリにしてハイライト RichText ではなく Text で描画させる。
  await tester.enterText(find.byType(TextField), 'z');
  await tester.pump(const Duration(milliseconds: 450)); // debounce
  await tester.pump(); // autocomplete 完了
  await tester.tap(find.text('テスト目的地'));
  await tester.pump(); // fetchLatLng 完了
  await tester.pump();
}

void main() {
  group('SearchScreen 座標が取れない目的地', () {
    testWidgets('fetchLatLng が null のとき確定せず再選択を促す', (tester) async {
      final container = await _makeContainer(tester, _NoCoordPlacesService());
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      await _tapSuggestion(tester);

      final state = container.read(appStateProvider);
      expect(state.destination, isNull, reason: '確定してはいけない');
      expect(state.destinationLatLng, isNull);
      expect(state.screen, isNot(Screen.home), reason: 'ホームに遷移してはいけない');
      expect(find.textContaining('別の候補'), findsOneWidget);
    });

    testWidgets('fetchLatLng が例外のときも確定せず再選択を促す', (tester) async {
      final container = await _makeContainer(
        tester,
        _NoCoordPlacesService(throwOnFetch: true),
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      await _tapSuggestion(tester);

      final state = container.read(appStateProvider);
      expect(state.destination, isNull);
      expect(state.screen, isNot(Screen.home));
      expect(find.textContaining('別の候補'), findsOneWidget);
    });
  });

  group('SearchScreen 座標が取れない出発地（origin モード）', () {
    testWidgets('fetchLatLng が null のとき確定せずバナーを表示する', (tester) async {
      final container = await _makeContainer(tester, _NoCoordPlacesService());
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container, mode: SearchMode.origin));
      await tester.pump();

      await _tapSuggestion(tester);

      final state = container.read(appStateProvider);
      expect(state.origin, isNull, reason: '確定してはいけない');
      expect(state.screen, isNot(Screen.home), reason: 'ホームに遷移してはいけない');
      expect(find.textContaining('この出発地は位置情報'), findsOneWidget);
      expect(find.textContaining('別の候補'), findsOneWidget);
    });
  });
}
