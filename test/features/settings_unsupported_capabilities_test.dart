import 'package:aruku/core/config/platform_capabilities.dart';
import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/notification_service.dart';
import 'package:aruku/core/services/onboarding_repository.dart';
import 'package:aruku/core/services/recents_repository.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/settings/settings_screen.dart';
import 'package:aruku/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeLocationService implements LocationService {
  @override
  Future<LocationState> request() async => const LocationDenied();
}

class _FakeActivityService implements ActivityService {
  @override
  Future<bool> requestPermission() async => false;

  @override
  Stream<ActivitySnapshot> sessionActivityStream() => const Stream.empty();
}

Future<void> _pumpSettings(
  WidgetTester tester, {
  bool notificationsSupported = true,
  bool osSettingsAvailable = true,
}) async {
  final prefs = await SharedPreferences.getInstance();
  final container = ProviderContainer(
    overrides: [
      sharedPreferencesProvider.overrideWith((ref) => prefs),
      onboardingCompletedProvider.overrideWithValue(true),
      locationServiceProvider.overrideWithValue(_FakeLocationService()),
      activityServiceProvider.overrideWithValue(_FakeActivityService()),
      localNotificationsSupportedProvider.overrideWithValue(
        notificationsSupported,
      ),
      canOpenOsSettingsProvider.overrideWithValue(osSettingsAvailable),
    ],
  );
  addTearDown(container.dispose);

  await tester.pumpWidget(
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: ArukuTheme.light(),
        home: const SettingsScreen(),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  testWidgets('通知が非対応なら理由を出し、操作できるスイッチは出さない', (tester) async {
    await _pumpSettings(tester, notificationsSupported: false);

    expect(
      find.byKey(const Key('settings-notifications-unsupported')),
      findsOneWidget,
    );
    // スイッチを残すと、既定が有効なので「オンなのに何も起きない」状態を
    // ユーザーが自分で永続化できてしまう（#359 Phase 2）。
    expect(find.byKey(const Key('switch_notifications')), findsNothing);
  });

  testWidgets('対応環境ではスイッチを出し、非対応の断り書きは出さない', (tester) async {
    await _pumpSettings(tester, notificationsSupported: true);

    expect(find.byKey(const Key('switch_notifications')), findsOneWidget);
    expect(
      find.byKey(const Key('settings-notifications-unsupported')),
      findsNothing,
    );
  });

  testWidgets('OS 設定を開けない環境なら権限の導線を理由へ差し替える', (tester) async {
    await _pumpSettings(tester, osSettingsAvailable: false);

    expect(
      find.byKey(const Key('settings-os-settings-unavailable')),
      findsOneWidget,
    );
    // 押しても無反応の導線を残すと、権限を変えられない理由が画面から復元できない。
    expect(find.text('端末設定を開く'), findsNothing);
  });

  testWidgets('OS 設定を開ける環境では権限の導線を出す', (tester) async {
    await _pumpSettings(tester, osSettingsAvailable: true);

    expect(find.text('端末設定を開く'), findsOneWidget);
    expect(
      find.byKey(const Key('settings-os-settings-unavailable')),
      findsNothing,
    );
  });
}
