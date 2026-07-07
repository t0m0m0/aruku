import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/models/place_prediction.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/onboarding_repository.dart';
import 'package:aruku/core/services/places_service.dart';
import 'package:aruku/core/services/recents_repository.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/search/search_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeLocationService implements LocationService {
  @override
  Future<LocationState> request() async => const LocationDenied();

  @override
  Stream<GeoPoint> positionStream() => const Stream.empty();
}

class _FakeActivityService implements ActivityService {
  @override
  Future<bool> requestPermission() async => false;

  @override
  Stream<ActivitySnapshot> sessionActivityStream() => const Stream.empty();
}

class _FakePlacesService implements PlacesService {
  @override
  Future<List<PlacePrediction>> autocomplete(
    String query, {
    GeoPoint? bias,
  }) async => const [];

  @override
  Future<GeoPoint?> fetchLatLng(String placeId) async => null;
}

Future<ProviderContainer> _container() async {
  final prefs = await SharedPreferences.getInstance();
  return ProviderContainer(
    overrides: [
      sharedPreferencesProvider.overrideWith((ref) => prefs),
      onboardingCompletedProvider.overrideWithValue(true),
      locationServiceProvider.overrideWithValue(_FakeLocationService()),
      activityServiceProvider.overrideWithValue(_FakeActivityService()),
      placesServiceProvider.overrideWithValue(_FakePlacesService()),
    ],
  );
}

Widget _wrap(ProviderContainer container, Widget child) =>
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: ArukuTheme.light(),
        home: child,
      ),
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('戻る・入力消去のアイコンボタンにVoiceOverラベルがある', (tester) async {
    final handle = tester.ensureSemantics();
    final container = await _container();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SearchScreen()));
    await tester.pumpAndSettle();

    // 戻る（アイコンのみ）はツールチップ経由でラベルを持つ。
    expect(find.byTooltip('戻る'), findsOneWidget);

    // 入力するとクリアボタンが現れ、ラベル付きのボタンになる。
    await tester.enterText(find.byType(TextField), '渋谷');
    // 400ms のデバウンスタイマーを消化してリークを防ぐ。
    await tester.pump(const Duration(milliseconds: 500));
    await tester.pumpAndSettle();

    expect(find.bySemanticsLabel('入力を消去'), findsOneWidget);
    handle.dispose();
  });
}
