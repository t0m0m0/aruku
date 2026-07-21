import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
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
}

Widget _wrap(ProviderContainer container, SearchMode mode) =>
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: ArukuTheme.light(),
        home: SearchScreen(mode: mode),
      ),
    );

Future<ProviderContainer> _makeContainer(
  WidgetTester tester,
  LocationState locationState,
) async {
  final container = ProviderContainer(
    overrides: [
      locationServiceProvider.overrideWithValue(
        _FakeLocationService(locationState),
      ),
    ],
  );
  // build() を起動して _fetchLocation() を完了させる
  container.read(appStateProvider.notifier);
  await tester.runAsync(() => Future<void>.delayed(Duration.zero));
  return container;
}

void main() {
  group('SearchScreen destination mode 現在地を使う', () {
    testWidgets('LocationAvailable のとき「現在地を使う」が表示される', (tester) async {
      final container = await _makeContainer(
        tester,
        const LocationAvailable(GeoPoint(35.681, 139.766)),
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container, SearchMode.destination));
      await tester.pump();

      expect(find.text('現在地を使う'), findsOneWidget);
    });

    testWidgets('LocationDenied のとき「現在地を使う」が表示されない', (tester) async {
      final container = await _makeContainer(tester, const LocationDenied());
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container, SearchMode.destination));
      await tester.pump();

      expect(find.text('現在地を使う'), findsNothing);
    });

    testWidgets('LocationLoading のとき「現在地を使う」が表示されない', (tester) async {
      final container = await _makeContainer(tester, const LocationLoading());
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container, SearchMode.destination));
      await tester.pump();

      expect(find.text('現在地を使う'), findsNothing);
    });

    testWidgets('「現在地を使う」をタップすると destination が「現在地」になりホームに遷移する', (
      tester,
    ) async {
      const gps = GeoPoint(35.681, 139.766);
      final container = await _makeContainer(
        tester,
        const LocationAvailable(gps),
      );
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container, SearchMode.destination));
      await tester.pump();

      await tester.tap(find.text('現在地を使う'));
      await tester.pump();

      final state = container.read(appStateProvider);
      expect(state.destination, '現在地');
      expect(state.destinationLatLng, gps);
      expect(state.screen, Screen.home);
    });

    testWidgets('origin mode では LocationDenied でも「現在地を使う」が表示される', (
      tester,
    ) async {
      final container = await _makeContainer(tester, const LocationDenied());
      addTearDown(container.dispose);

      await tester.pumpWidget(_wrap(container, SearchMode.origin));
      await tester.pump();

      expect(find.text('現在地を使う'), findsOneWidget);
    });
  });
}
