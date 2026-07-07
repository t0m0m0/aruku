import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/onboarding_repository.dart';
import 'package:aruku/core/services/recents_repository.dart';
import 'package:aruku/core/services/settings_repository.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/state/settings_provider.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/home/home_screen.dart';
import 'package:aruku/features/settings/settings_screen.dart';
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

Future<ProviderContainer> _container() async {
  final prefs = await SharedPreferences.getInstance();
  return ProviderContainer(
    overrides: [
      sharedPreferencesProvider.overrideWith((ref) => prefs),
      onboardingCompletedProvider.overrideWithValue(true),
      locationServiceProvider.overrideWithValue(_FakeLocationService()),
      activityServiceProvider.overrideWithValue(_FakeActivityService()),
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

  testWidgets('主要な設定項目が表示される', (tester) async {
    final container = await _container();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    expect(find.text('設定'), findsOneWidget);
    expect(find.text('通知を受け取る'), findsOneWidget);
    expect(find.text('端末設定を開く'), findsOneWidget);
    expect(find.text('アカウント'), findsNothing);
  });

  testWidgets('通知スイッチを切ると永続化される', (tester) async {
    final container = await _container();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    await tester.tap(find.byType(Switch));
    await tester.pumpAndSettle();

    expect(
      container.read(settingsProvider).value!.notificationsEnabled,
      isFalse,
    );
  });

  testWidgets('週間目標セクションと既定選択が表示される', (tester) async {
    final container = await _container();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    expect(find.text('週間目標'), findsOneWidget);
    // 既定 10km のプリセットが選択済み。
    expect(find.byKey(const Key('goal_preset_10')), findsOneWidget);
    expect(find.byKey(const Key('goal_preset_20')), findsOneWidget);
  });

  testWidgets('週間目標プリセットをタップすると保存される', (tester) async {
    final container = await _container();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    await tester.tap(find.byKey(const Key('goal_preset_20')));
    await tester.pumpAndSettle();

    expect(container.read(settingsProvider).value!.weeklyGoalKm, 20);

    final repo = await container.read(settingsRepositoryProvider.future);
    expect(repo.load().weeklyGoalKm, 20);
  });

  testWidgets('ホームの設定ボタンで設定画面へ遷移する', (tester) async {
    final container = await _container();
    addTearDown(container.dispose);
    container.read(appStateProvider); // build() を起動

    await tester.pumpWidget(_wrap(container, const HomeScreen()));
    await tester.pumpAndSettle();

    expect(container.read(appStateProvider).screen, Screen.home);

    await tester.tap(find.byKey(const Key('home-settings-button')));
    await tester.pumpAndSettle();

    expect(container.read(appStateProvider).screen, Screen.settings);
  });
}
