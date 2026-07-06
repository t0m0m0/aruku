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
import 'package:aruku/l10n/app_localizations.dart';
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
    PlacePrediction(placeId: 'p_new', name: '新候補', address: '新住所'),
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
  // recentsProvider の build を完了させる
  await tester.runAsync(() => container.read(recentsProvider.future));
  return container;
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

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('SearchScreen 最近の目的地', () {
    testWidgets('保存済みの履歴がタイルとして表示される', (tester) async {
      SharedPreferences.setMockInitialValues({
        'recents.destinations.v1': jsonEncode([
          {
            'name': '東京駅',
            'placeId': 'p1',
            'lat': 35.681,
            'lng': 139.767,
            'address': '東京都千代田区',
            'usedAt': '2026-05-28T10:00:00.000Z',
          },
        ]),
      });

      final container = await _makeContainer(tester);
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      expect(find.text('東京駅'), findsOneWidget);
      expect(find.text('東京都千代田区'), findsOneWidget);
    });

    testWidgets('履歴タイルをタップすると destination に反映してホームに遷移する', (tester) async {
      SharedPreferences.setMockInitialValues({
        'recents.destinations.v1': jsonEncode([
          {
            'name': '渋谷駅',
            'placeId': 'p2',
            'lat': 35.658,
            'lng': 139.701,
            'address': '東京都渋谷区',
          },
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

    testWidgets('候補から目的地を確定すると履歴に追加される', (tester) async {
      final container = await _makeContainer(tester);
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      // クエリは候補名と一致しないものにして RichText ではなく Text で描画させる。
      await tester.enterText(find.byType(TextField), 'z');
      await tester.pump(const Duration(milliseconds: 450));
      await tester.pump();
      await tester.tap(find.text('新候補'));
      await tester.pump();
      // 履歴追加は fire-and-forget なので非同期完了を待つ。
      await tester.runAsync(() => container.read(recentsProvider.future));

      // 保存はホーム遷移後にも反映されているはず
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString('recents.destinations.v1');
      expect(raw, isNotNull);
      expect(raw, contains('新候補'));
      expect(raw, contains('p_new'));
    });

    testWidgets('履歴タイルをタップすると最新として先頭に繰り上がる', (tester) async {
      SharedPreferences.setMockInitialValues({
        'recents.destinations.v1': jsonEncode([
          {'name': '東京駅', 'placeId': 'p1', 'lat': 35.681, 'lng': 139.767},
          {'name': '渋谷駅', 'placeId': 'p2', 'lat': 35.658, 'lng': 139.701},
        ]),
      });

      final container = await _makeContainer(tester);
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      // 2番目の「渋谷駅」をタップ。
      await tester.tap(find.text('渋谷駅'));
      await tester.pump();
      // 繰り上げの保存は fire-and-forget なので完了を待つ。
      await tester.runAsync(() async {
        await Future<void>.delayed(Duration.zero);
      });

      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString('recents.destinations.v1')!;
      final ids = (jsonDecode(raw) as List)
          .map((e) => (e as Map)['placeId'])
          .toList();
      expect(ids, ['p2', 'p1']);
    });

    testWidgets('「現在地を使う」では履歴に追加されない', (tester) async {
      final container = await _makeContainer(tester);
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container));
      await tester.pump();

      await tester.tap(find.text('現在地を使う'));
      await tester.pump();

      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString('recents.destinations.v1');
      expect(raw, anyOf(isNull, isNot(contains('現在地'))));
    });
  });
}
