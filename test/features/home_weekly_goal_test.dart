import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/state/settings_provider.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/home/home_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeLocationService implements LocationService {
  @override
  Future<LocationState> request() async => const LocationDenied();
}

Widget _wrap(ProviderContainer container) => UncontrolledProviderScope(
  container: container,
  child: MaterialApp(
    localizationsDelegates: AppLocalizations.localizationsDelegates,
    supportedLocales: AppLocalizations.supportedLocales,
    theme: ArukuTheme.light(),
    home: const HomeScreen(),
  ),
);

void main() {
  testWidgets('週間目標カードのラベルが設定値に連動する', (tester) async {
    SharedPreferences.setMockInitialValues({});
    final container = ProviderContainer(
      overrides: [
        locationServiceProvider.overrideWithValue(_FakeLocationService()),
      ],
    );
    addTearDown(container.dispose);

    container.read(appStateProvider); // build() を起動
    await tester.pumpWidget(_wrap(container));
    await tester.pumpAndSettle();

    // 既定は 10km。
    expect(find.text('今週の目標 10km'), findsOneWidget);

    // 設定を変更するとホームのラベルも追従する。
    await container.read(settingsProvider.notifier).setWeeklyGoalKm(20);
    await tester.pumpAndSettle();

    expect(find.text('今週の目標 20km'), findsOneWidget);
    expect(find.text('今週の目標 10km'), findsNothing);
  });
}
