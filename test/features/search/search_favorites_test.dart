import 'dart:convert';

import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/models/place_prediction.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/places_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/state/favorites_provider.dart';
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
  Future<List<PlacePrediction>> autocomplete(String query) async => const [];

  @override
  Future<GeoPoint?> fetchLatLng(String placeId) async => null;
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
  await tester.runAsync(() => container.read(favoritesProvider.future));
  return container;
}

Widget _wrap(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(theme: ArukuTheme.light(), home: const SearchScreen()),
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('SearchScreen お気に入り', () {
    testWidgets('保存済みのお気に入りがタイルとして表示される', (tester) async {
      SharedPreferences.setMockInitialValues({
        'favorites.places.v1': jsonEncode([
          {'name': '渋谷駅', 'placeId': 'p2', 'lat': 35.658, 'lng': 139.701},
        ]),
      });

      final container = await _makeContainer(tester);
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      expect(find.text('お気に入り'), findsOneWidget);
      expect(find.text('渋谷駅'), findsOneWidget);
    });

    testWidgets('お気に入りタイルをタップすると destination に反映してホームに遷移する', (tester) async {
      SharedPreferences.setMockInitialValues({
        'favorites.places.v1': jsonEncode([
          {'name': '渋谷駅', 'placeId': 'p2', 'lat': 35.658, 'lng': 139.701},
        ]),
      });

      final container = await _makeContainer(tester);
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      await tester.tap(find.text('渋谷駅'));
      await tester.pump();

      final state = container.read(appStateProvider);
      expect(state.destination, '渋谷駅');
      expect(state.destinationLatLng, const GeoPoint(35.658, 139.701));
      expect(state.screen, Screen.home);
    });

    testWidgets('末尾のスターをタップすると解除され、選択は発生しない', (tester) async {
      SharedPreferences.setMockInitialValues({
        'favorites.places.v1': jsonEncode([
          {'name': '渋谷駅', 'placeId': 'p2', 'lat': 35.658, 'lng': 139.701},
        ]),
      });

      final container = await _makeContainer(tester);
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      // 解除は fire-and-forget の永続化を伴うため、実 I/O を完了させる。
      await tester.runAsync(() async {
        await tester.tap(find.byKey(const ValueKey('favorite-remove-id:p2')));
        while (container.read(favoritesProvider).value?.isNotEmpty ?? false) {
          await Future<void>.delayed(const Duration(milliseconds: 1));
        }
      });
      await tester.pump();

      // 解除されてセクションごと消える。
      expect(container.read(favoritesProvider).value, isEmpty);
      expect(find.text('お気に入り'), findsNothing);
      expect(find.text('渋谷駅'), findsNothing);
      // 解除タップでは目的地選択・ホーム遷移は起きない。
      final state = container.read(appStateProvider);
      expect(state.destination, isNull);
      expect(state.screen, isNot(Screen.home));
    });

    testWidgets('お気に入りが無ければセクションは出ない', (tester) async {
      final container = await _makeContainer(tester);
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      expect(find.text('お気に入り'), findsNothing);
    });
  });
}
