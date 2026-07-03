import 'dart:convert';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/models/place_prediction.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/places_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/state/recents_provider.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/search/search_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeLocationService implements LocationService {
  const _FakeLocationService(this.result);
  final LocationState result;

  @override
  Future<LocationState> request() async => result;

  @override
  Stream<GeoPoint> positionStream() => const Stream.empty();
}

class _StubPlacesService implements PlacesService {
  @override
  Future<List<PlacePrediction>> autocomplete(
    String query, {
    GeoPoint? bias,
  }) async => const [
    PlacePrediction(placeId: 'o_new', name: '新出発地', address: '新住所'),
  ];

  @override
  Future<GeoPoint?> fetchLatLng(String placeId) async =>
      const GeoPoint(35.0, 139.0);
}

Future<ProviderContainer> _makeContainer(WidgetTester tester) async {
  final container = ProviderContainer(
    overrides: [
      locationServiceProvider.overrideWithValue(
        const _FakeLocationService(LocationAvailable(GeoPoint(35.0, 139.0))),
      ),
      placesServiceProvider.overrideWithValue(_StubPlacesService()),
    ],
  );
  container.read(appStateProvider.notifier);
  await tester.runAsync(() => Future<void>.delayed(Duration.zero));
  await tester.runAsync(() => container.read(recentsProvider.future));
  await tester.runAsync(() => container.read(recentOriginsProvider.future));
  return container;
}

Widget _wrap(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(
    theme: ArukuTheme.light(),
    home: const SearchScreen(mode: SearchMode.origin),
  ),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('SearchScreen 最近の出発地', () {
    testWidgets('保存済みの出発地履歴がタイルとして表示される', (tester) async {
      SharedPreferences.setMockInitialValues({
        'recents.origins.v1': jsonEncode([
          {
            'name': '自宅',
            'placeId': 'o1',
            'lat': 35.681,
            'lng': 139.767,
            'address': '東京都品川区',
          },
        ]),
      });

      final container = await _makeContainer(tester);
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      expect(find.text('最近の出発地'), findsOneWidget);
      expect(find.text('自宅'), findsOneWidget);
      expect(find.text('東京都品川区'), findsOneWidget);
    });

    testWidgets('出発地履歴タイルをタップすると origin に反映してホームに遷移する', (tester) async {
      SharedPreferences.setMockInitialValues({
        'recents.origins.v1': jsonEncode([
          {'name': '職場', 'placeId': 'o2', 'lat': 35.658, 'lng': 139.701},
        ]),
      });

      final container = await _makeContainer(tester);
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      await tester.tap(find.text('職場'));
      await tester.pump();

      final state = container.read(appStateProvider);
      expect(state.origin, '職場');
      expect(state.originLatLng, const GeoPoint(35.658, 139.701));
      expect(state.screen, Screen.home);
    });

    testWidgets('候補から出発地を確定すると出発地履歴に追加され、目的地履歴には混ざらない', (tester) async {
      final container = await _makeContainer(tester);
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      await tester.enterText(find.byType(TextField), 'zz');
      await tester.pump(const Duration(milliseconds: 450));
      await tester.pump();
      await tester.tap(find.text('新出発地'));
      await tester.pump();
      await tester.runAsync(() => container.read(recentOriginsProvider.future));

      final prefs = await SharedPreferences.getInstance();
      final origins = prefs.getString('recents.origins.v1');
      expect(origins, isNotNull);
      expect(origins, contains('新出発地'));
      expect(origins, contains('o_new'));
      // 目的地履歴には記録されない（系統が混ざらない）。
      expect(prefs.getString('recents.destinations.v1'), isNull);
    });

    testWidgets('目的地履歴は出発地モードでは表示されない', (tester) async {
      SharedPreferences.setMockInitialValues({
        'recents.destinations.v1': jsonEncode([
          {'name': '渋谷駅', 'placeId': 'd1', 'lat': 35.658, 'lng': 139.701},
        ]),
        'recents.origins.v1': jsonEncode([
          {'name': '自宅', 'placeId': 'o1', 'lat': 35.681, 'lng': 139.767},
        ]),
      });

      final container = await _makeContainer(tester);
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      expect(find.text('自宅'), findsOneWidget);
      expect(find.text('渋谷駅'), findsNothing);
      expect(find.text('最近の目的地'), findsNothing);
    });
  });
}
