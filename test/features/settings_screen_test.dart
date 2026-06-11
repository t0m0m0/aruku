import 'package:aruku/core/models/activity_snapshot.dart';
import 'package:aruku/core/models/app_settings.dart';
import 'package:aruku/core/models/auth_user.dart';
import 'package:aruku/core/models/geo_point.dart';
import 'package:aruku/core/models/location_state.dart';
import 'package:aruku/core/services/activity_service.dart';
import 'package:aruku/core/services/auth_service.dart';
import 'package:aruku/core/services/location_service.dart';
import 'package:aruku/core/services/onboarding_repository.dart';
import 'package:aruku/core/services/recents_repository.dart';
import 'package:aruku/core/services/settings_repository.dart';
import 'package:aruku/core/services/sync_service.dart';
import 'package:aruku/core/state/app_state.dart';
import 'package:aruku/core/state/auth_provider.dart';
import 'package:aruku/core/state/settings_provider.dart';
import 'package:aruku/core/theme/aruku_theme.dart';
import 'package:aruku/features/home/home_screen.dart';
import 'package:aruku/features/settings/settings_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../support/fake_auth_service.dart';
import '../support/fake_sync_service.dart';

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

Future<ProviderContainer> _container({
  AuthService? auth,
  FakeSyncService? sync,
}) async {
  final prefs = await SharedPreferences.getInstance();
  return ProviderContainer(
    overrides: [
      sharedPreferencesProvider.overrideWith((ref) => prefs),
      onboardingCompletedProvider.overrideWithValue(true),
      locationServiceProvider.overrideWithValue(_FakeLocationService()),
      activityServiceProvider.overrideWithValue(_FakeActivityService()),
      authServiceProvider.overrideWithValue(auth ?? FakeAuthService()),
      syncServiceProvider.overrideWithValue(sync ?? FakeSyncService()),
    ],
  );
}

Widget _wrap(ProviderContainer container, Widget child) =>
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(theme: ArukuTheme.light(), home: child),
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
    expect(find.text('距離の単位'), findsOneWidget);
    expect(find.text('通知を受け取る'), findsOneWidget);
    expect(find.text('端末設定を開く'), findsOneWidget);
    expect(find.text('アカウント'), findsOneWidget);
  });

  testWidgets('単位を mi に切り替えると永続化される', (tester) async {
    final container = await _container();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    await tester.tap(find.text('mi'));
    await tester.pumpAndSettle();

    expect(container.read(settingsProvider).value!.unit, DistanceUnit.miles);
    final repo = await container.read(settingsRepositoryProvider.future);
    expect(repo.load().unit, DistanceUnit.miles);
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

  testWidgets('未ログインはログイン導線を表示し、タップで認証画面へ', (tester) async {
    final container = await _container();
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    expect(find.text('ログイン / アカウント作成'), findsOneWidget);

    await tester.tap(find.text('ログイン / アカウント作成'));
    await tester.pumpAndSettle();

    expect(container.read(appStateProvider).screen, Screen.auth);
  });

  testWidgets('ログイン済みはメールとログアウトを表示する', (tester) async {
    final fake = FakeAuthService(
      initialUser: const AuthUser(uid: 'u1', email: 'a@example.com'),
    );
    addTearDown(fake.dispose);
    final container = await _container(auth: fake);
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    expect(find.text('a@example.com'), findsOneWidget);
    expect(find.text('ログアウト'), findsOneWidget);

    await tester.tap(find.text('ログアウト'));
    await tester.pumpAndSettle();

    expect(container.read(authProvider).value, isNull);
    expect(find.text('ログイン / アカウント作成'), findsOneWidget);
  });

  testWidgets('ログイン済みはクラウド同期行を表示し、タップで同期する', (tester) async {
    final fake = FakeAuthService(
      initialUser: const AuthUser(uid: 'u1', email: 'a@example.com'),
    );
    addTearDown(fake.dispose);
    final sync = FakeSyncService();
    final container = await _container(auth: fake, sync: sync);
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    expect(find.text('クラウド同期'), findsOneWidget);

    await tester.tap(find.text('今すぐ同期'));
    await tester.pumpAndSettle();

    // リモート無しなのでローカルがアップロードされる。
    expect(sync.pushCount, greaterThan(0));
  });

  testWidgets('ゲストはクラウド同期行を表示しない', (tester) async {
    final fake = FakeAuthService(initialUser: const AuthUser(uid: 'g1'));
    addTearDown(fake.dispose);
    final container = await _container(auth: fake);
    addTearDown(container.dispose);

    await tester.pumpWidget(_wrap(container, const SettingsScreen()));
    await tester.pumpAndSettle();

    expect(find.text('クラウド同期'), findsNothing);
    expect(find.text('ゲストとして利用中'), findsOneWidget);
  });
}
